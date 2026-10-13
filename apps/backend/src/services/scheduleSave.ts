import type { PoolClient } from 'pg';
import { query, transaction } from '@/database/db';
import { findOverlappingSessions, findScheduleConflicts, validateSessions, type ScheduleConflict } from '@/services/scheduleConflicts';
import { checkMajorLecLab, type MajorLecLabCheck } from '@/services/majorRoomRule';
import { ensureSessionTypes } from '@/services/sessionTypeRepair';
import { ensureFacultyActivitiesTable } from '@/database/facultyActivitiesSchema';
import { PATHFIT_VENUE_RULE, pathfitRoomAllowed } from '@shared/pathfitVenue';

/**
 * Saving a class's schedule. POST /api/scheduling saves one part (Lecture or
 * Laboratory) — saveSchedulePart; "Move into the school day"
 * (services/moveIntoDay.ts) also saves through here — a Major class's Lecture
 * and Laboratory together, and a class with the one that makes room for it
 * (saveScheduleClass / saveScheduleClasses, all or nothing). Every rule is checked
 * the same way: valid days and times inside the school day, the subject's own
 * part, hours equal to the curriculum, room type, PATHFIT venues, the Major
 * Lec + Lab one-room rule and faculty / block / room conflicts, under the
 * schedule-save lock. Returns the HTTP status and body the route sends.
 */

/* Run once per cold start — avoids DDL + migration overhead on every POST */
let schedSchemaReady   = false;

async function ensureSchedSchema() {
  if (schedSchemaReady) return;
  await query(`ALTER TABLE schedule_sessions ADD COLUMN IF NOT EXISTS type VARCHAR(3) DEFAULT 'lec'`);
  schedSchemaReady = true;
}

function addMinutesToTime(timeStr: string, minutes: number): string {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMinutes = h * 60 + m + minutes;
  const newH = Math.floor(totalMinutes / 60) % 24;
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}:00`;
}

function timeToMinutes(t: string): number {
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

const LAB_ROOM_TYPES = ['Laboratory', 'Computer Lab'];

type Part = 'lec' | 'lab';
const partName = (p: Part) => (p === 'lab' ? 'Laboratory' : 'Lecture');

/** One session as the Scheduling form sends it */
export interface SchedulePartSession {
  day: string;
  start_time: string;
  hours: number;
  end_time?: string;
  type?: string;
  room_id?: number | string | null;
}

/** The request body of POST /api/scheduling */
export interface SchedulePartBody {
  master_schedule_id?: unknown;
  day_pattern?: unknown;
  split_type?: unknown;
  component?: unknown;
  sessions?: unknown;
}

/** Both parts of a class at once: each part's sessions, saved together or not at all */
export interface ScheduleClassBody {
  master_schedule_id?: unknown;
  day_pattern?: unknown;
  split_type?: unknown;
  parts?: { component?: unknown; sessions?: unknown }[];
}

export interface SchedulePartResult { status: number; body: Record<string, unknown> }

const reply = (body: Record<string, unknown>, init?: { status?: number }): SchedulePartResult => ({ status: init?.status ?? 200, body });

/** The class being saved, as the checks need it */
interface ClassInfo {
  facultyId: number | null;
  blockId: number;
  programId: number;
  semester: string;
  academicYear: string;
  subjectCode: string;
  lecHours: number;
  labHours: number;
  totalHours: number;
}

/** Writing a part ran into a conflict or the Major rule */
interface WriteOutcome { conflicts: ScheduleConflict[]; majorRoom?: MajorLecLabCheck }

/** Rolls the whole save back — one part of a class save was refused */
class SaveRefused extends Error {
  constructor(readonly result: SchedulePartResult) { super('schedule save refused'); }
}

/** The class, its subject's hours and its term — null when there is no such class */
async function loadClass(masterScheduleId: unknown): Promise<ClassInfo | null> {
  // Get schedule and subject details
  const schedResult = await query(`
    SELECT ms.*, c.total_hours, c.lecture_hours, c.laboratory_hours, c.units, c.subject_code,
      ms.faculty_id, b.semester, b.academic_year, b.id as block_id, b.program_id,
      bs.block_id as bs_block_id
    FROM master_schedule ms
    JOIN block_subjects bs ON ms.block_subject_id = bs.id
    JOIN curriculums c ON bs.curriculum_id = c.id
    JOIN blocks b ON bs.block_id = b.id
    WHERE ms.id = $1
  `, [masterScheduleId]);
  const sched = schedResult.rows[0];
  if (!sched) return null;
  return {
    facultyId: sched.faculty_id ? Number(sched.faculty_id) : null,
    blockId: Number(sched.bs_block_id),
    programId: Number(sched.program_id),
    semester: sched.semester || '',
    academicYear: sched.academic_year || '',
    subjectCode: String(sched.subject_code ?? ''),
    lecHours: parseFloat(sched.lecture_hours) || 0,
    labHours: parseFloat(sched.laboratory_hours) || 0,
    totalHours: parseFloat(sched.total_hours),
  };
}

/** The class may be saved by this user (a Program Chair only in their program) and has a faculty */
function classRefusal(cls: ClassInfo, opts: { scopedProgramId?: number | null }): SchedulePartResult | null {
  // A Program Chair limited to one program (undefined = not limited)
  if (opts.scopedProgramId !== undefined && (opts.scopedProgramId === null || cls.programId !== opts.scopedProgramId)) {
    return reply({ error: 'Schedule not found' }, { status: 404 });
  }
  if (!cls.facultyId) return reply({ error: 'Please assign a faculty member first' }, { status: 400 });
  return null;
}

/**
 * The checks on the request itself, before the lock: valid days and times, no
 * two sessions at once, the subject's own part, hours equal to the curriculum,
 * room types and PATHFIT venues. Returns the part being saved, or the reply.
 */
async function checkPart(cls: ClassInfo, component: unknown, sessions: SchedulePartSession[]): Promise<Part | SchedulePartResult> {
  // Reject malformed sessions (unknown day, bad time, 0 hours) — they would
  // match nothing and slip past every conflict check.
  const invalidSessions = validateSessions(sessions);
  if (invalidSessions) return reply({ error: invalidSessions }, { status: 400 });

  // The same subject can't meet twice at once (e.g. Monday 8–10 entered
  // twice). The form flags this too; checked here for requests that skip it.
  const selfOverlaps = findOverlappingSessions(sessions);
  if (selfOverlaps.length > 0) {
    return reply({
      error: `Schedule conflict: ${selfOverlaps[0].message}`,
      conflicts: selfOverlaps,
    }, { status: 409 });
  }

  const { lecHours, labHours } = cls;
  const isLecLab = lecHours > 0 && labHours > 0;
  const isLabOnly = labHours > 0 && lecHours === 0;

  // The part being saved must be one the subject has, and every session is that part.
  // The form always sends it this way; a request that skips the form must not label a
  // Laboratory as a Lecture (into a lecture room) or a lecture-only subject as a Laboratory.
  const part: Part | null = component === 'lec' || component === 'lab' ? component
    : component == null || component === '' ? (isLecLab ? null : isLabOnly ? 'lab' : 'lec') : null;
  if (!part) {
    return reply({ error: 'Choose the Lecture or the Laboratory to schedule.' }, { status: 400 });
  }
  if ((part === 'lab' && labHours <= 0 && lecHours > 0) || (part === 'lec' && lecHours <= 0 && labHours > 0)) {
    return reply({ error: `This subject has no ${partName(part)}.` }, { status: 400 });
  }
  if (sessions.some((s: { type?: unknown }) => s.type != null && s.type !== '' && s.type !== part)) {
    return reply({ error: `Every session must be the ${partName(part)} being scheduled.` }, { status: 400 });
  }

  // Validate session hours match curriculum component hours
  const totalSessionHours = sessions.reduce((sum: number, s: { hours: number }) => sum + parseFloat(String(s.hours)), 0);
  let expectedTotal: number;
  if (isLecLab) {
    expectedTotal = part === 'lab' ? labHours : lecHours;
  } else {
    expectedTotal = cls.totalHours;
  }

  if (Math.abs(totalSessionHours - expectedTotal) > 0.01) {
    return reply({
      error: `Session hours must equal ${expectedTotal.toFixed(2)} hrs. Got: ${totalSessionHours.toFixed(2)} hrs`
    }, { status: 400 });
  }

  // ── Within-schedule session overlap detection (server-side) ─────────────
  // Catches overlapping sessions submitted for the same schedule even before
  // they hit the database, complementing the client-side duplicate check.
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i];
      const b = sessions[j];
      if (a.day !== b.day) continue;
      const aStart = timeToMinutes(a.start_time);
      const aEnd   = aStart + Math.round(parseFloat(String(a.hours)) * 60);
      const bStart = timeToMinutes(b.start_time);
      const bEnd   = bStart + Math.round(parseFloat(String(b.hours)) * 60);
      if (aStart < bEnd && aEnd > bStart) {
        return reply({
          error: `Sessions ${i + 1} and ${j + 1} overlap on ${a.day}. Each session on the same day must use a distinct, non-overlapping time slot.`
        }, { status: 400 });
      }
    }
  }

  // ── Room-type validation (per session, only when a room is selected) ────
  // Lab sessions may be saved without a room; room is optional.
  // When a room IS provided, validate it matches the session type.
  for (const session of sessions) {
    const sessionRoomId = session.room_id || null;
    if (!sessionRoomId) continue;
    const roomResult = await query('SELECT room_name, room_type, status FROM rooms WHERE id=$1', [sessionRoomId]);
    if (roomResult.rows.length === 0) {
      return reply({ error: 'The selected room no longer exists.' }, { status: 400 });
    }
    if (roomResult.rows[0].status && roomResult.rows[0].status !== 'Active') {
      return reply({ error: 'The selected room is not active.' }, { status: 400 });
    }
    const isLabRoom = LAB_ROOM_TYPES.includes(roomResult.rows[0].room_type);
    if (part === 'lab' && !isLabRoom) {
      return reply({ error: 'Lab sessions must use a Laboratory or Computer Lab room' }, { status: 400 });
    }
    // The Lecture of a subject that has a lab (Major + Lab) may use a lab
    // room; a pure lecture subject may not.
    if (part === 'lec' && isLabRoom && labHours <= 0) {
      return reply({ error: 'A lecture-only subject cannot use a laboratory room' }, { status: 400 });
    }
    if (!pathfitRoomAllowed(cls.subjectCode, roomResult.rows[0].room_name)) {
      return reply({ error: PATHFIT_VENUE_RULE }, { status: 400 });
    }
  }
  return part;
}

/**
 * Inside the save transaction, under the lock: the Major Lec + Lab rule, then
 * faculty / block / room conflicts, then the part's sessions are replaced.
 * Nothing is written when either check fails.
 */
async function writePart(client: PoolClient, msId: number, cls: ClassInfo, part: Part, sessions: SchedulePartSession[]): Promise<WriteOutcome> {
  // First the Major Lec + Lab rule (it is about the request itself): the same
  // days and one laboratory for both parts. A room chosen here moves the other
  // part into it too — refused when that room is not free at the other part's
  // times, or when the days differ from the other part's (services/majorRoomRule.ts).
  const majorRoom = await checkMajorLecLab(
    (text, params) => client.query(text, params),
    {
      masterScheduleId: msId,
      facultyId: cls.facultyId,
      blockId: cls.blockId,
      semester: cls.semester,
      academicYear: cls.academicYear,
      part,
      days: sessions.map((s: { day?: unknown }) => (s.day == null ? null : String(s.day))),
      roomIds: sessions.map((s: { room_id?: unknown }) => s.room_id as string | number | null),
    },
  );
  if (majorRoom.error) return { conflicts: [], majorRoom };

  // Conflict check inside the lock — same rules as /check-conflicts.
  // Only this part's own sessions are left out (saving replaces them); the other part still counts.
  const conflicts = await findScheduleConflicts(
    (text, params) => client.query(text, params),
    {
      masterScheduleId: msId,
      facultyId: cls.facultyId,
      blockId: cls.blockId,
      semester: cls.semester,
      academicYear: cls.academicYear,
      editingType: part,
      sessions,
    },
  );
  if (conflicts.length > 0) return { conflicts };

  await client.query(
    'DELETE FROM schedule_sessions WHERE master_schedule_id=$1 AND type=$2',
    [msId, part]
  );

  for (const session of sessions) {
    const sessionHoursMinutes = Math.round(parseFloat(String(session.hours)) * 60);
    const sessionEndTime = addMinutesToTime(session.start_time, sessionHoursMinutes);
    const sessionRoomId = session.room_id || null;
    await client.query(`
      INSERT INTO schedule_sessions (master_schedule_id, day_of_week, start_time, end_time, session_hours, room_id, type)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [msId, session.day, session.start_time, sessionEndTime, session.hours, sessionRoomId, part]);
  }
  if (majorRoom.move) {
    await client.query('UPDATE schedule_sessions SET room_id = $1 WHERE id = ANY($2::int[])',
      [majorRoom.move.roomId, majorRoom.move.sessionIds]);
  }
  return { conflicts: [], majorRoom };
}

/** The reply for a refused write (null = it was written) */
function writeRefusal(outcome: WriteOutcome, label = ''): SchedulePartResult | null {
  if (outcome.conflicts.length > 0) {
    return reply({
      error: `${label}Schedule conflict: ${outcome.conflicts[0].message}`,
      conflicts: outcome.conflicts,
    }, { status: 409 });
  }
  if (outcome.majorRoom?.error) {
    return reply({ error: `${label}${outcome.majorRoom.error}`, room_rule_error: true }, { status: outcome.majorRoom.status ?? 400 });
  }
  return null;
}

/**
 * Inside the save transaction, after the sessions are written: the class's
 * status and its master_schedule times (from the sessions saved — the Lecture's
 * first when both parts are saved).
 */
async function finishSave(client: PoolClient, msId: number, cls: ClassInfo, sessions: SchedulePartSession[], dayPattern: unknown, splitType: unknown) {
  const isLecLab = cls.lecHours > 0 && cls.labHours > 0;

  // ── Compute master_schedule time fields ─────────────────────────────────
  const firstLecSession = sessions.find((s: { type?: string }) => (s.type || 'lec') === 'lec') || sessions[0];
  const firstStartTime = firstLecSession.start_time;
  const firstHoursMinutes = Math.round(parseFloat(String(firstLecSession.hours)) * 60);
  const firstEndTime = addMinutesToTime(firstStartTime, firstHoursMinutes);

  // For same-day Lec+Lab, extend master end_time to cover the full continuous block
  const isSameDayLecLab = isLecLab && sessions.length === 2 && sessions[0].day === sessions[1].day;
  let masterEndTime = firstEndTime;
  if (isSameDayLecLab) {
    const lastSession = [...sessions].sort(
      (a: { start_time: string }, b: { start_time: string }) => a.start_time.localeCompare(b.start_time)
    ).pop()!;
    const lastMins = Math.round(parseFloat(String(lastSession.hours)) * 60);
    masterEndTime = addMinutesToTime(lastSession.start_time, lastMins);
  }

  // Persist first session's room to master_schedule for workload queries
  const masterRoomId = sessions[0]?.room_id || null;

  // For Lec+Lab subjects, only mark 'Scheduled' when both components have sessions.
  // Single-component subjects are always 'Scheduled' after saving.
  let newStatus = 'Scheduled';
  if (isLecLab) {
    const lecCheck = await client.query(
      `SELECT 1 FROM schedule_sessions WHERE master_schedule_id=$1 AND type='lec' LIMIT 1`,
      [msId]
    );
    const labCheck = await client.query(
      `SELECT 1 FROM schedule_sessions WHERE master_schedule_id=$1 AND type='lab' LIMIT 1`,
      [msId]
    );
    newStatus = (lecCheck.rows.length > 0 && labCheck.rows.length > 0) ? 'Scheduled' : 'Assigned';
  }

  await client.query(`
    UPDATE master_schedule SET
      day_pattern=$1, start_time=$2, end_time=$3, room_id=$4,
      split_type=$5, status=$6, updated_at=NOW()
    WHERE id=$7
  `, [dayPattern, firstStartTime, masterEndTime, masterRoomId, splitType || 'Manual', newStatus, msId]);

  await client.query(
    `UPDATE block_subjects SET status=$1
     WHERE id=(SELECT block_subject_id FROM master_schedule WHERE id=$2)`,
    [newStatus, msId]
  );
}

/** Ensure type column + legacy migration run once per cold start, not per request */
async function ensureSaveSchema() {
  await ensureSchedSchema();
  await ensureSessionTypes();
  await ensureFacultyActivitiesTable();
}

export async function saveSchedulePart(
  body: SchedulePartBody,
  opts: { scopedProgramId?: number | null } = {},
): Promise<SchedulePartResult> {
  // sessions: [{ day, start_time, hours, type: 'lec'|'lab', room_id: string|null }]
  // component: 'lec' | 'lab' — which component of a Lec+Lab subject is being scheduled
  const { master_schedule_id, day_pattern, split_type, component } = body;
  const sessions = Array.isArray(body.sessions) ? body.sessions as SchedulePartSession[] : null;

  if (!master_schedule_id || !day_pattern || !sessions || sessions.length === 0) {
    return reply({ error: 'Schedule ID, day pattern, and sessions are required' }, { status: 400 });
  }

  const cls = await loadClass(master_schedule_id);
  if (!cls) return reply({ error: 'Schedule not found' }, { status: 404 });
  const refused = classRefusal(cls, opts);
  if (refused) return refused;

  const part = await checkPart(cls, component, sessions);
  if (typeof part !== 'string') return part;

  await ensureSaveSchema();
  const msId = Number(master_schedule_id);

  // ── Atomic save (transaction) ───────────────────────────────────────────
  // DELETE + INSERT + UPDATE are all-or-nothing: a mid-save failure rolls
  // back entirely instead of leaving the schedule in a partial state.
  // For Lec+Lab subjects, only sessions of the current component type are
  // deleted so the other component's sessions are preserved independently.
  const outcome = await transaction<WriteOutcome>(async (client) => {
    // One schedule save at a time: without this, two admins saving at the
    // same moment could both pass the conflict check and double-book an
    // instructor, room or block. Released automatically at COMMIT/ROLLBACK.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('qrganize:schedule-save'))`);
    const written = await writePart(client, msId, cls, part, sessions);
    if (writeRefusal(written)) return written;
    await finishSave(client, msId, cls, sessions, day_pattern, split_type);
    return written;
  });

  const notSaved = writeRefusal(outcome);
  if (notSaved) return notSaved;

  const moved = outcome.majorRoom?.move;
  return reply({
    success: true,
    message: 'Schedule saved successfully',
    // The other part followed into the same room (Major subject)
    moved: moved ? { part: moved.part, room_name: moved.roomName } : null,
  });
}

/** A class ready to write: its checked parts (Lecture first) and the fields for master_schedule */
interface PreparedClass {
  msId: number;
  cls: ClassInfo;
  parts: { part: Part; sessions: SchedulePartSession[] }[];
  /** Every session saved, the Lecture's first */
  all: SchedulePartSession[];
  dayPattern: unknown;
  splitType: unknown;
}

/** The refusal with the class it is about (for saves of several classes) */
const aboutClass = (r: SchedulePartResult, msId: unknown): SchedulePartResult =>
  ({ ...r, body: { ...r.body, ms_id: Number(msId) || null } });

/** The checks on one class of a class save, before the lock — the reply when it is refused */
async function prepareClass(body: ScheduleClassBody, opts: { scopedProgramId?: number | null }): Promise<PreparedClass | SchedulePartResult> {
  const { master_schedule_id, day_pattern, split_type } = body;
  const raw = Array.isArray(body.parts) ? body.parts : [];
  if (!master_schedule_id || !day_pattern || raw.length === 0
    || raw.some(p => !Array.isArray(p?.sessions) || (p.sessions as unknown[]).length === 0)) {
    return reply({ error: 'Schedule ID, day pattern, and sessions are required' }, { status: 400 });
  }

  const cls = await loadClass(master_schedule_id);
  if (!cls) return reply({ error: 'Schedule not found' }, { status: 404 });
  const refused = classRefusal(cls, opts);
  if (refused) return refused;

  const label = (p: Part) => (raw.length > 1 ? `${partName(p)}: ` : '');
  const parts: { part: Part; sessions: SchedulePartSession[] }[] = [];
  for (const p of raw) {
    const sessions = p.sessions as SchedulePartSession[];
    const part = await checkPart(cls, p.component, sessions);
    if (typeof part !== 'string') {
      const component = p.component === 'lab' ? 'lab' : 'lec';
      return { ...part, body: { ...part.body, error: `${label(component)}${String(part.body.error ?? '')}` } };
    }
    if (parts.some(x => x.part === part)) {
      return reply({ error: `The ${partName(part)} is listed twice.` }, { status: 400 });
    }
    parts.push({ part, sessions });
  }
  // Lecture first: it sets the class's master_schedule times, as on the Scheduling page
  parts.sort((a, b) => Number(a.part === 'lab') - Number(b.part === 'lab'));

  // The parts can't meet at the same time as each other (one faculty, one block)
  const all = parts.flatMap(p => p.sessions.map(s => ({ ...s, type: p.part })));
  const clash = findOverlappingSessions(all)[0];
  if (clash) {
    return reply({ error: `The Lecture and the Laboratory would meet at the same time on ${clash.day}.` }, { status: 409 });
  }
  return { msId: Number(master_schedule_id), cls, parts, all, dayPattern: day_pattern, splitType: split_type };
}

/**
 * Both parts of a class in one save — a Major Lec + Lab class moving to new
 * days or a new laboratory, where saving one part first would break the
 * one-room / same-days rule against the other part's old place. Every part is
 * checked exactly as saveSchedulePart checks it; the old sessions of the parts
 * being saved stop counting, the parts are written one after the other (the
 * second is checked against the first one's new times and room), and if any
 * part is refused nothing is saved.
 */
export async function saveScheduleClass(
  body: ScheduleClassBody,
  opts: { scopedProgramId?: number | null } = {},
): Promise<SchedulePartResult> {
  return saveScheduleClasses([body], opts);
}

/**
 * Several classes in one save — "Move into the school day" moving a class
 * together with the class that makes room for it. Each class is checked as
 * saveScheduleClass checks it; every part being saved gives up its old times
 * first; the classes are written in the order given, each checked against the
 * new times of the ones before it. If any part of any class is refused,
 * nothing is saved; with more than one class the refusal names the class
 * (ms_id).
 */
export async function saveScheduleClasses(
  bodies: ScheduleClassBody[],
  opts: { scopedProgramId?: number | null } = {},
): Promise<SchedulePartResult> {
  if (bodies.length === 0) return reply({ error: 'Nothing to save.' }, { status: 400 });
  const several = bodies.length > 1;
  const prepared: PreparedClass[] = [];
  for (const body of bodies) {
    const p = await prepareClass(body, opts);
    if ('status' in p) return several ? aboutClass(p, body.master_schedule_id) : p;
    if (prepared.some(x => x.msId === p.msId)) return reply({ error: 'A class is listed twice.' }, { status: 400 });
    prepared.push(p);
  }

  await ensureSaveSchema();

  try {
    const outcome = await transaction<WriteOutcome>(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('qrganize:schedule-save'))`);
      // The parts being saved give up their old times and rooms first, so none
      // is checked against where another one used to be
      for (const p of prepared) {
        await client.query(
          'DELETE FROM schedule_sessions WHERE master_schedule_id=$1 AND type = ANY($2::text[])',
          [p.msId, p.parts.map(x => x.part)],
        );
      }
      let last: WriteOutcome = { conflicts: [] };
      for (const p of prepared) {
        for (const x of p.parts) {
          last = await writePart(client, p.msId, p.cls, x.part, x.sessions);
          const notSaved = writeRefusal(last, p.parts.length > 1 ? `${partName(x.part)}: ` : '');
          if (notSaved) throw new SaveRefused(several ? aboutClass(notSaved, p.msId) : notSaved);
        }
        await finishSave(client, p.msId, p.cls, p.all, p.dayPattern, p.splitType);
      }
      return last;
    });
    const moved = several ? null : outcome.majorRoom?.move;
    return reply({
      success: true,
      message: 'Schedule saved successfully',
      moved: moved ? { part: moved.part, room_name: moved.roomName } : null,
    });
  } catch (e) {
    if (e instanceof SaveRefused) return e.result;
    throw e;
  }
}
