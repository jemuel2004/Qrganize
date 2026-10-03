import { codeKey, roomKey } from '@shared/workloadImport';
import { findScheduleConflicts } from '@/services/scheduleConflicts';

/**
 * Classes without a room — finding them, suggesting a room, and setting one
 * (GET / POST /api/rooms/unassigned, Room Management → "Classes Without a Room").
 *
 * A room is only used when no class is booked in it at that time — checked
 * with the shared conflict rules (findScheduleConflicts, the same room rule as
 * Scheduling's save). Room types follow Scheduling too: a Lab session needs a
 * laboratory; a lecture-only subject can't use one; the Lecture of a Lec + Lab
 * subject may use either. Rooms are tried best first:
 *   1. the room the same class already uses for this part on its other days
 *   2. the teacher's usual room (for this subject first)
 *   3. where this subject is usually held
 *   4. the general Lecture-N / Laboratory-N rooms, in number order
 * Special rooms (a gym, a robotics lab — any name other than Lecture-N /
 * Lab-N, as in the workload import) are only picked for a class that already
 * uses them or whose subject is held there; they stay in the manual list.
 * The suggestion shown on screen and the assignment pick the same way.
 */

type Queryable = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const DAY_ORDER = `ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']`;
const LIVE = `('Assigned', 'Scheduled', 'Completed')`;

const isLab = (t: string) => t === 'Laboratory' || t === 'Computer Lab';
const byName = (a: { room_name: string }, b: { room_name: string }) =>
  a.room_name.localeCompare(b.room_name, undefined, { numeric: true });
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };

export interface Room { id: number; room_name: string; room_type: string }

/** Roomless class meetings of a term, in the order they are given rooms ($1 semester, $2 school year) */
const ROOMLESS_SQL = `
  SELECT ss.id, ss.day_of_week AS day, ss.start_time::text AS start_time, ss.end_time::text AS end_time,
         COALESCE(ss.type, 'lec') AS type, COALESCE(c.laboratory_hours, 0)::float AS lab_hours,
         ms.id AS ms_id, ms.faculty_id, bs.block_id, b.semester, b.academic_year,
         COALESCE(NULLIF(TRIM(f.name), ''), NULLIF(TRIM(CONCAT_WS(' ', f.first_name, f.last_name)), ''), 'Unassigned faculty') AS faculty_name,
         f.employee_id, c.subject_code, c.subject_name,
         p.code AS program_code, b.year_level, b.block_name,
         (SELECT ss2.room_id FROM schedule_sessions ss2
           WHERE ss2.master_schedule_id = ms.id AND ss2.room_id IS NOT NULL
             AND COALESCE(ss2.type, 'lec') = COALESCE(ss.type, 'lec')
           ORDER BY ss2.id LIMIT 1) AS class_room_id
  FROM schedule_sessions ss
  JOIN master_schedule ms ON ms.id = ss.master_schedule_id
  JOIN block_subjects bs ON bs.id = ms.block_subject_id
  JOIN curriculums c ON c.id = bs.curriculum_id
  JOIN blocks b ON b.id = bs.block_id
  LEFT JOIN programs p ON p.id = b.program_id
  LEFT JOIN faculty f ON f.id = ms.faculty_id
  WHERE ss.room_id IS NULL
    AND ss.day_of_week IS NOT NULL AND ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
    AND ms.status IN ${LIVE}
    AND ($1 = '' OR b.semester = $1) AND ($2 = '' OR b.academic_year = $2)`;
const ROOMLESS_ORDER = `ORDER BY faculty_name, array_position(${DAY_ORDER}, ss.day_of_week), ss.start_time, ss.id`;

/** How often each room is used in a term, per teacher and subject ("usual rooms") */
const USUAL_ROOMS_SQL = `
  SELECT ms.faculty_id, c.subject_code, ss.room_id, COUNT(*)::int AS n
  FROM schedule_sessions ss
  JOIN master_schedule ms ON ms.id = ss.master_schedule_id
  JOIN block_subjects bs ON bs.id = ms.block_subject_id
  JOIN curriculums c ON c.id = bs.curriculum_id
  JOIN blocks b ON b.id = bs.block_id
  WHERE ss.room_id IS NOT NULL AND ms.status IN ${LIVE}
    AND ($1 = '' OR b.semester = $1) AND ($2 = '' OR b.academic_year = $2)
  GROUP BY ms.faculty_id, c.subject_code, ss.room_id`;

const ACTIVE_ROOMS_SQL = `SELECT id, room_name, room_type FROM rooms WHERE status = 'Active'`;

interface Roomless {
  id: number; day: string; start_time: string; end_time: string; type: string; lab_hours: number;
  ms_id: number; faculty_id: number | null; block_id: number; semester: string; academic_year: string;
  faculty_name: string; employee_id: string | null; subject_code: string; subject_name: string;
  program_code: string | null; year_level: string | null; block_name: string | null; class_room_id: number | null;
}

type Counts = Map<string, Map<number, number>>;
/** Sessions per room: by teacher ("12"), by subject ("MATH1"), by teacher + subject ("12|MATH1") */
interface UsualRooms { byFaculty: Counts; bySubject: Counts; byFacultySubject: Counts }

function usualRooms(rows: Record<string, unknown>[]): UsualRooms {
  const add = (m: Counts, key: string, roomId: number, n: number) => {
    const inner = m.get(key) ?? new Map<number, number>();
    inner.set(roomId, (inner.get(roomId) ?? 0) + n);
    m.set(key, inner);
  };
  const usual: UsualRooms = { byFaculty: new Map(), bySubject: new Map(), byFacultySubject: new Map() };
  for (const r of rows as { faculty_id: number | null; subject_code: string; room_id: number; n: number }[]) {
    const code = codeKey(r.subject_code);
    add(usual.bySubject, code, r.room_id, r.n);
    if (r.faculty_id == null) continue;
    add(usual.byFaculty, String(r.faculty_id), r.room_id, r.n);
    add(usual.byFacultySubject, `${r.faculty_id}|${code}`, r.room_id, r.n);
  }
  return usual;
}

/** Scheduling's room-type rule for one session */
const roomFits = (r: Room, s: Roomless) =>
  s.type === 'lab' ? isLab(r.room_type) : !(isLab(r.room_type) && s.lab_hours <= 0);

/** Why a room is offered first — shown next to it on screen */
export type RoomNote = 'class' | 'faculty' | 'subject';

interface Candidate {
  room: Room;
  note: RoomNote | null;
  /** May be picked automatically (special rooms only when the class or its subject uses them) */
  auto: boolean;
}

/** Rooms that fit one class meeting, best first (see the order above) */
function roomCandidates(rooms: Room[], s: Roomless, usual: UsualRooms): Candidate[] {
  const code = codeKey(s.subject_code);
  const fs = s.faculty_id != null ? usual.byFacultySubject.get(`${s.faculty_id}|${code}`) : undefined;
  const f = s.faculty_id != null ? usual.byFaculty.get(String(s.faculty_id)) : undefined;
  const subj = usual.bySubject.get(code);
  const scored = rooms.filter(r => roomFits(r, s)).map(room => {
    const special = roomKey(room.room_name).kind === 'other';
    const score = [
      room.id === s.class_room_id ? 1 : 0,
      fs?.get(room.id) ?? 0,
      special ? 0 : f?.get(room.id) ?? 0, // a teacher's gym class doesn't make the gym their room
      subj?.get(room.id) ?? 0,
      special ? 0 : 1,
      isLab(room.room_type) === (s.type === 'lab') ? 1 : 0, // a lecture prefers a lecture room
    ];
    const note: RoomNote | null = score[0] ? 'class' : score[1] || score[2] ? 'faculty' : score[3] ? 'subject' : null;
    return { room, note, auto: !special || note !== null, score };
  });
  scored.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i];
    return byName(a.room, b.room);
  });
  return scored.map(({ room, note, auto }) => ({ room, note, auto }));
}

/* ── Listing (GET) ─────────────────────────────────────────────────────── */

export interface RoomlessSession {
  id: number; day: string; start_time: string; end_time: string; type: string; ms_id: number;
  subject_code: string; subject_name: string; program_code: string | null; year_level: string | null; block_name: string | null;
  /** Free rooms the class may use, best first, each with why it is offered */
  free_rooms: { id: number; name: string; note: RoomNote | null }[];
  /** The room "Assign rooms automatically" would give it */
  suggested_room_id: number | null;
}

/** Classes without a room, by faculty, with their free rooms and a suggested room */
export async function listRoomlessClasses(q: Queryable, term: { semester: string; schoolYear: string }) {
  const params = [term.semester, term.schoolYear];
  const [sessRes, roomsRes, usualRes, busyRes] = await Promise.all([
    q(`${ROOMLESS_SQL} ${ROOMLESS_ORDER}`, params),
    q(ACTIVE_ROOMS_SQL),
    q(USUAL_ROOMS_SQL, params),
    // Every room booking this term (to find free rooms per slot)
    q(`
      SELECT ss.room_id, ss.day_of_week AS day, ss.start_time::text AS start_time, ss.end_time::text AS end_time
      FROM schedule_sessions ss
      JOIN master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN blocks b ON b.id = bs.block_id
      WHERE ss.room_id IS NOT NULL AND ss.day_of_week IS NOT NULL
        AND ms.status IN ${LIVE}
        AND ($1 = '' OR b.semester = $1) AND ($2 = '' OR b.academic_year = $2)
    `, params),
  ]);

  const rooms = roomsRes.rows as unknown as Room[];
  const usual = usualRooms(usualRes.rows);
  type Booking = { room_id: number; day: string; s: number; e: number };
  const busy: Booking[] = (busyRes.rows as { room_id: number; day: string; start_time: string; end_time: string }[])
    .map(b => ({ room_id: b.room_id, day: b.day, s: toMin(b.start_time), e: toMin(b.end_time) }));
  const isFree = (list: Booking[], roomId: number, day: string, s: number, e: number) =>
    !list.some(b => b.room_id === roomId && b.day === day && b.s < e && b.e > s);
  // Suggestions are made in assignment order and count each other, so two
  // classes at the same time are never both offered the same room.
  const suggestedSoFar: Booking[] = [];

  const groups = new Map<string, {
    faculty_id: number | null; faculty_name: string; employee_id: string | null; sessions: RoomlessSession[];
  }>();
  for (const r of sessRes.rows as unknown as Roomless[]) {
    const s = toMin(r.start_time);
    const e = toMin(r.end_time);
    // Free right now (no class booked in it at this time), best first
    const free = roomCandidates(rooms, r, usual).filter(c => isFree(busy, c.room.id, r.day, s, e));
    const suggested = free.find(c => c.auto && isFree(suggestedSoFar, c.room.id, r.day, s, e))?.room ?? null;
    if (suggested) suggestedSoFar.push({ room_id: suggested.id, day: r.day, s, e });

    const key = String(r.faculty_id ?? 'none');
    if (!groups.has(key)) groups.set(key, { faculty_id: r.faculty_id, faculty_name: r.faculty_name, employee_id: r.employee_id, sessions: [] });
    groups.get(key)!.sessions.push({
      id: r.id, day: r.day, start_time: r.start_time, end_time: r.end_time, type: r.type, ms_id: r.ms_id,
      subject_code: r.subject_code, subject_name: r.subject_name,
      program_code: r.program_code, year_level: r.year_level, block_name: r.block_name,
      free_rooms: free.map(c => ({ id: c.room.id, name: c.room.room_name, note: c.note })),
      suggested_room_id: suggested?.id ?? null,
    });
  }

  const faculty = [...groups.values()];
  const sessions = faculty.flatMap(f => f.sessions);
  return {
    faculty,
    total_sessions: sessions.length,
    no_room_available: sessions.filter(s => s.free_rooms.length === 0).length,
  };
}

/* ── Setting rooms (POST) ──────────────────────────────────────────────── */

export interface AssignRoomsOptions {
  term: { semester: string; schoolYear: string };
  /** true = pick rooms automatically; false = put `sessionId` in `roomId` */
  auto: boolean;
  sessionId?: number | null;
  roomId?: number | null;
  /** auto only: just this faculty's classes (null = classes with no faculty) */
  faculty?: { id: number | null };
}

interface ClassBrief { session_id: number; subject_code: string; day: string; start_time: string }
export interface AssignRoomsResult {
  /** No such roomless class (one-class mode) */
  missing: boolean;
  assigned: (ClassBrief & { room_name: string })[];
  skipped: (ClassBrief & { reason: string })[];
}

const brief = (s: Roomless): ClassBrief =>
  ({ session_id: s.id, subject_code: s.subject_code, day: s.day, start_time: s.start_time.substring(0, 5) });

/**
 * Give classes without a room a room. Call inside a transaction that holds
 * the schedule-save lock (pg_advisory_xact_lock 'qrganize:schedule-save'),
 * so every check sees the rooms set just before it.
 */
export async function assignRooms(q: Queryable, opts: AssignRoomsOptions): Promise<AssignRoomsResult> {
  const byFaculty = opts.auto && opts.faculty !== undefined;
  const sessions = (await q(
    `${ROOMLESS_SQL}
       AND ($3::int IS NULL OR ss.id = $3)
       AND ($4::boolean IS FALSE OR ms.faculty_id IS NOT DISTINCT FROM $5::int)
     ${ROOMLESS_ORDER}`,
    [opts.term.semester, opts.term.schoolYear, opts.auto ? null : opts.sessionId ?? null, byFaculty, opts.faculty?.id ?? null],
  )).rows as unknown as Roomless[];
  if (!opts.auto && sessions.length === 0) return { missing: true, assigned: [], skipped: [] };

  const rooms = (await q(ACTIVE_ROOMS_SQL)).rows as unknown as Room[];
  const usual = usualRooms((await q(USUAL_ROOMS_SQL, [opts.term.semester, opts.term.schoolYear])).rows);

  const result: AssignRoomsResult = { missing: false, assigned: [], skipped: [] };
  for (const s of sessions) {
    let candidates: Room[];
    if (opts.auto) {
      candidates = roomCandidates(rooms, s, usual).filter(c => c.auto).map(c => c.room);
    } else {
      const chosen = rooms.find(r => r.id === opts.roomId);
      if (!chosen || !roomFits(chosen, s)) {
        result.skipped.push({ ...brief(s), reason: !chosen ? 'That room is no longer available.'
          : s.type === 'lab' ? 'Lab classes need a laboratory room.'
          : 'A lecture-only subject cannot use a laboratory room.' });
        continue;
      }
      candidates = [chosen];
    }

    const start = s.start_time.substring(0, 5);
    const hours = (toMin(s.end_time) - toMin(s.start_time)) / 60;
    let picked: Room | null = null;
    for (const room of candidates) {
      // The shared room rule: no other class in this room at this time (any faculty)
      const found = await findScheduleConflicts(q, {
        masterScheduleId: s.ms_id,
        facultyId: null,
        blockId: s.block_id,
        semester: s.semester,
        academicYear: s.academic_year,
        editingType: s.type === 'lab' ? 'lab' : 'lec',
        sessions: [{ day: s.day, start_time: start, hours, room_id: room.id }],
      });
      if (!found.some(c => c.type === 'room')) { picked = room; break; }
    }

    if (!picked) {
      result.skipped.push({ ...brief(s), reason: opts.auto
        ? 'No suitable room is free at this time.'
        : 'Another class is already in that room at this time.' });
      continue;
    }

    await q(`UPDATE schedule_sessions SET room_id = $1 WHERE id = $2 AND room_id IS NULL`, [picked.id, s.id]);
    // The class's room on Workload / Class Program, when it has none yet
    await q(`UPDATE master_schedule SET room_id = $1, updated_at = NOW() WHERE id = $2 AND room_id IS NULL`, [picked.id, s.ms_id]);
    result.assigned.push({ ...brief(s), room_name: picked.room_name });
  }
  return result;
}
