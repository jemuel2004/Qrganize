import { needsOneRoomSql } from '@shared/subjectCategory';
import { isLabRoomType } from '@shared/classroomDemand';
import { roomKey } from '@shared/workloadImport';
import { daysKey, parseDays } from '@shared/dayCombination';
import { findScheduleConflicts, timeToMinutes } from '@/services/scheduleConflicts';

/**
 * Major subject with a Lecture and a Laboratory = one room and one day
 * combination. Every Lecture and Laboratory session of the class uses the same
 * room, and it is a laboratory (the Laboratory needs one); both parts meet on
 * the same days (e.g. Tue/Fri), at whatever times. Minor subjects and subjects
 * with only a Lecture or only a Laboratory keep their own rules.
 *
 * Scheduling's save (POST /api/scheduling) and its conflict preview both run
 * checkMajorLecLab, so the preview and the save never disagree. Once one part
 * has a room, the other part must use that same room — a different room is
 * refused, never moved. A part with no room yet takes the room given to its
 * other part, only when it is free at its times (otherwise nothing is saved).
 * Rooms → Classes Without a Room, the Excel workload import and faculty room
 * requests keep to the same rule (needsOneRoomSql / needsOneRoom).
 */

type Queryable = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type Part = 'lec' | 'lab';

const partName = (p: Part) => (p === 'lab' ? 'Laboratory' : 'Lecture');

export interface MajorLecLabCheck {
  /** The class is a Major subject with a Lecture and a Laboratory */
  applies: boolean;
  /** Why these rooms can't be saved (null = fine) */
  error: string | null;
  /** 400 = the days or rooms chosen break the rule; 409 = the room is taken at the other part's time */
  status?: 400 | 409;
  /** The other part's sessions without a room that take this room on saving */
  move: { part: Part; roomId: number; roomName: string; sessionIds: number[] } | null;
}

/**
 * Days and rooms for one part of a class (the sessions being saved). Pass the
 * transaction client on save, under the schedule-save lock.
 */
export async function checkMajorLecLab(q: Queryable, opts: {
  masterScheduleId: number;
  facultyId: number | null;
  blockId: number;
  semester: string;
  academicYear: string;
  /** The part being saved */
  part: Part;
  /** Its sessions' days ("Tuesday") — checked once every session has one */
  days: (string | null | undefined)[];
  /** Its sessions' rooms ('' / null = no room yet) */
  roomIds: (string | number | null | undefined)[];
}): Promise<MajorLecLabCheck> {
  const info = (await q(
    `SELECT c.subject_code, ${needsOneRoomSql('c')} AS one_room
       FROM master_schedule ms
       JOIN block_subjects bs ON bs.id = ms.block_subject_id
       JOIN curriculums c ON c.id = bs.curriculum_id
      WHERE ms.id = $1`,
    [opts.masterScheduleId],
  )).rows[0];
  if (!info?.one_room) return { applies: false, error: null, move: null };
  const other: Part = opts.part === 'lab' ? 'lec' : 'lab';

  // Same day combination as the other part (once it is scheduled); times may differ
  const mine = opts.days.every(Boolean) ? parseDays(opts.days as string[]) : null;
  if (mine) {
    const theirs = parseDays((await q(
      `SELECT DISTINCT day_of_week AS day FROM schedule_sessions
        WHERE master_schedule_id = $1 AND COALESCE(type, 'lec') = $2 AND day_of_week IS NOT NULL`,
      [opts.masterScheduleId, other],
    )).rows.map(r => String(r.day)));
    if (theirs && daysKey(theirs) !== daysKey(mine)) {
      return {
        applies: true, status: 400, move: null,
        error: `${info.subject_code} is a Major subject, so its Lecture and Laboratory must meet on the same days. Its ${partName(other)} is on ${daysKey(theirs)} — schedule the ${partName(opts.part)} on ${daysKey(theirs)} too (the times may differ).`,
      };
    }
  }

  const rule = `${info.subject_code} is a Major subject, so its Lecture and Laboratory must use the same room`;
  const chosen = [...new Set(opts.roomIds.filter(v => v != null && String(v).trim() !== '').map(Number))];
  if (chosen.length > 1) {
    return { applies: true, status: 400, error: `${rule}. Choose one room for every session.`, move: null };
  }
  // No room yet — nothing to keep together
  if (chosen.length === 0) return { applies: true, error: null, move: null };

  const roomId = chosen[0];
  const otherSessions = (await q(
    `SELECT ss.id, ss.day_of_week AS day, ss.start_time::text AS start_time, ss.end_time::text AS end_time,
            ss.room_id, r.room_name
       FROM schedule_sessions ss LEFT JOIN rooms r ON r.id = ss.room_id
      WHERE ss.master_schedule_id = $1 AND COALESCE(ss.type, 'lec') = $2
      ORDER BY ss.id`,
    [opts.masterScheduleId, other],
  )).rows;
  // The other part already has a room: this part must use that same room — it is never moved
  const theirRooms = [...new Map(otherSessions.filter(s => s.room_id != null)
    .map(s => [Number(s.room_id), String(s.room_name ?? `room #${s.room_id}`)])).entries()];
  if (theirRooms.length > 1) {
    return {
      applies: true, status: 400, move: null,
      error: `${rule}. Its ${partName(other)} uses ${theirRooms.map(([, n]) => n).join(' and ')} — put it in one room first (Rooms → Lec + Lab in Two Rooms).`,
    };
  }
  if (theirRooms.length === 1 && theirRooms[0][0] !== roomId) {
    const theirs = theirRooms[0][1];
    return {
      applies: true, status: 400, move: null,
      error: `${rule}. Its ${partName(other)} is in ${theirs} — choose ${theirs} for the ${partName(opts.part)} too.`,
    };
  }

  const room = (await q('SELECT room_name, room_type FROM rooms WHERE id = $1', [roomId])).rows[0];
  if (!room) return { applies: true, status: 400, error: 'The selected room no longer exists.', move: null };
  const roomName = String(room.room_name);
  if (!isLabRoomType(String(room.room_type ?? ''))) {
    return {
      applies: true, status: 400, move: null,
      error: `${rule}, and the Laboratory needs a laboratory room — ${roomName} is a ${room.room_type} room. Choose a laboratory.`,
    };
  }

  // Its sessions with no room yet take this room
  const moving = otherSessions.filter(s => s.room_id == null);
  if (moving.length === 0) return { applies: true, error: null, move: null };

  // Only where no other class is in the room then (the shared room rule)
  const timed = moving
    .filter(s => s.day && s.start_time && s.end_time)
    .map(s => ({ s, minutes: timeToMinutes(String(s.end_time)) - timeToMinutes(String(s.start_time)) }))
    .filter(x => x.minutes > 0);
  const found = timed.length === 0 ? [] : await findScheduleConflicts(q, {
    masterScheduleId: opts.masterScheduleId,
    facultyId: opts.facultyId,
    blockId: opts.blockId,
    semester: opts.semester,
    academicYear: opts.academicYear,
    editingType: other,
    sessions: timed.map(({ s, minutes }) => ({
      day: String(s.day), start_time: String(s.start_time).slice(0, 5), hours: minutes / 60, room_id: roomId,
    })),
  });
  const clash = found.find(c => c.type === 'room');
  if (clash) {
    const when = clash.message.replace(/^Room ".*?" is already occupied/, 'occupied');
    return {
      applies: true, status: 409, move: null,
      error: `${rule}. ${roomName} is not free for the ${partName(other)} — ${when} Choose a room that is free for both.`,
    };
  }
  return { applies: true, error: null, move: { part: other, roomId, roomName, sessionIds: moving.map(s => Number(s.id)) } };
}

/* ── Classes still in two rooms (saved before this rule) ──────────────────── */

/** One class meeting, for planning: its class, part, day, minutes and room */
export interface PlanSession { ms: number; type: Part; day: string; start: number; end: number; room: number | null }
export interface PlanRoom { id: number; room_name: string; room_type: string }
/** Where a class's one room comes from: a room it already uses (its Lab's / Lecture's) or another free lab */
export type OneRoomSource = 'lab' | 'lec' | 'other';

/**
 * One laboratory for each class, never double-booking a room: first every class
 * that can keep a room it already uses (its Laboratory's, then its Lecture's),
 * then the first free general laboratory (Lab-N / Laboratory-N; special rooms
 * only for classes already in them). Only rooms change — days and times stay.
 * `sessions` = every live class meeting of the term (they are the bookings).
 * Classes are planned in the order given; null = no single lab is free at all
 * of the class's times.
 */
export function planOneRoom(
  classIds: number[], sessions: PlanSession[], rooms: PlanRoom[],
): Map<number, { room: number; from: OneRoomSource } | null> {
  const isLab = (id: number | null) => id != null && isLabRoomType(rooms.find(r => r.id === id)?.room_type);
  const generalLabs = rooms
    .filter(r => isLabRoomType(r.room_type) && roomKey(r.room_name).kind !== 'other')
    .sort((a, b) => a.room_name.localeCompare(b.room_name, undefined, { numeric: true }));
  const span = (s: PlanSession) => ({ start: s.start, end: s.end > s.start ? s.end : s.end + 1440 });
  const bookings = sessions.filter(s => s.room != null).map(s => ({ ms: s.ms, room: s.room as number, day: s.day, ...span(s) }));
  const own = (ms: number) => sessions.filter(s => s.ms === ms);
  const freeFor = (ms: number, room: number) => own(ms).every(s => {
    const { start, end } = span(s);
    return !bookings.some(b => b.ms !== ms && b.room === room && b.day === s.day && b.start < end && b.end > start);
  });
  const result = new Map<number, { room: number; from: OneRoomSource } | null>();
  const move = (ms: number, room: number, from: OneRoomSource) => {
    for (let i = bookings.length - 1; i >= 0; i--) if (bookings[i].ms === ms) bookings.splice(i, 1);
    for (const s of own(ms)) bookings.push({ ms, room, day: s.day, ...span(s) });
    result.set(ms, { room, from });
  };
  const tryOwn = (ms: number) => {
    for (const part of ['lab', 'lec'] as const) {
      const room = own(ms).find(s => s.type === part && isLab(s.room))?.room ?? null;
      if (room != null && freeFor(ms, room)) { move(ms, room, part); return true; }
    }
    return false;
  };
  // Pass 1: keep a room the class already uses — before any class takes a new room
  const pending = classIds.filter(ms => !tryOwn(ms));
  // Pass 2: its own rooms again (others may have moved out), else the first free general lab
  for (const ms of pending) {
    if (tryOwn(ms)) continue;
    const lab = generalLabs.find(r => freeFor(ms, r.id));
    if (lab) move(ms, lab.id, 'other');
    else result.set(ms, null);
  }
  return result;
}

export interface SplitClass {
  ms_id: number;
  subject_code: string; subject_name: string;
  program_code: string | null; year_level: string | null; block_name: string | null;
  faculty_name: string;
  /** Its rooms now, e.g. ["Lec: Lab 2", "Lab: Lab 4"] */
  rooms: string[];
  /** The one laboratory it moves into (null = none is free at all its times) */
  room: { id: number; name: string; from: OneRoomSource } | null;
  /** Why it isn't moved (a live room request, or no free laboratory) */
  note: string | null;
}

const LIVE = `('Assigned','Scheduled','Completed')`;

/** Major Lec + Lab classes of the term in more than one room (or a lecture room), with the plan for each */
async function planSplitClasses(q: Queryable, term: { semester: string; schoolYear: string }): Promise<SplitClass[]> {
  const params = [term.semester, term.schoolYear];
  const broken = (await q(`
    SELECT ms.id AS ms_id, c.subject_code, c.subject_name, p.code AS program_code, b.year_level, b.block_name,
           COALESCE(NULLIF(TRIM(f.name), ''), TRIM(CONCAT_WS(' ', f.first_name, f.last_name))) AS faculty_name,
           array_agg(DISTINCT CASE WHEN COALESCE(ss.type, 'lec') = 'lab' THEN 'Lab: ' ELSE 'Lec: ' END || COALESCE(r.room_name, 'no room')) AS rooms,
           EXISTS (SELECT 1 FROM room_change_requests rcr WHERE rcr.master_schedule_id = ms.id
                    AND rcr.status IN ('Pending', 'Pending Confirmation', 'In-Use')) AS has_request
      FROM master_schedule ms
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN curriculums c ON c.id = bs.curriculum_id
      JOIN blocks b ON b.id = bs.block_id
      LEFT JOIN programs p ON p.id = b.program_id
      LEFT JOIN faculty f ON f.id = ms.faculty_id
      JOIN schedule_sessions ss ON ss.master_schedule_id = ms.id
      LEFT JOIN rooms r ON r.id = ss.room_id
     WHERE ms.status IN ${LIVE} AND ms.faculty_id IS NOT NULL
       AND ($1 = '' OR b.semester = $1) AND ($2 = '' OR b.academic_year = $2)
       AND ${needsOneRoomSql('c')}
     GROUP BY ms.id, c.subject_code, c.subject_name, p.code, b.year_level, b.block_name, f.name, f.first_name, f.last_name
    HAVING COUNT(DISTINCT ss.room_id) > 1 OR bool_or(ss.room_id IS NOT NULL AND r.room_type NOT IN ('Laboratory', 'Computer Lab'))
     ORDER BY faculty_name, c.subject_code, b.block_name`, params)).rows;
  const sessions: PlanSession[] = (await q(`
    SELECT ss.master_schedule_id AS ms, COALESCE(ss.type, 'lec') AS type, ss.day_of_week AS day,
           ss.start_time::text AS start_time, ss.end_time::text AS end_time, ss.room_id
      FROM schedule_sessions ss
      JOIN master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN blocks b ON b.id = bs.block_id
     WHERE ms.status IN ${LIVE} AND ms.faculty_id IS NOT NULL
       AND ss.day_of_week IS NOT NULL AND ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
       AND ($1 = '' OR b.semester = $1) AND ($2 = '' OR b.academic_year = $2)`, params)).rows
    .map(s => ({
      ms: Number(s.ms), type: s.type === 'lab' ? 'lab' : 'lec', day: String(s.day),
      start: timeToMinutes(String(s.start_time)), end: timeToMinutes(String(s.end_time)),
      room: s.room_id == null ? null : Number(s.room_id),
    }));
  const rooms: PlanRoom[] = (await q(`SELECT id, room_name, room_type FROM rooms WHERE status = 'Active'`)).rows
    .map(r => ({ id: Number(r.id), room_name: String(r.room_name), room_type: String(r.room_type) }));
  const plan = planOneRoom(broken.filter(c => !c.has_request).map(c => Number(c.ms_id)), sessions, rooms);
  return broken.map(c => {
    const pick = plan.get(Number(c.ms_id)) ?? null;
    const room = pick ? rooms.find(r => r.id === pick.room) : undefined;
    return {
      ms_id: Number(c.ms_id),
      subject_code: String(c.subject_code), subject_name: String(c.subject_name),
      program_code: c.program_code == null ? null : String(c.program_code),
      year_level: c.year_level == null ? null : String(c.year_level),
      block_name: c.block_name == null ? null : String(c.block_name),
      faculty_name: String(c.faculty_name ?? ''),
      // Lecture's rooms first, then the Laboratory's, each in number order
      rooms: [...((c.rooms as string[] | null) ?? [])].sort((a, b) =>
        Number(a.startsWith('Lab:')) - Number(b.startsWith('Lab:')) || a.localeCompare(b, undefined, { numeric: true })),
      room: pick && room ? { id: room.id, name: room.room_name, from: pick.from } : null,
      note: c.has_request ? 'A room request for this class is in progress — fix it on the Scheduling page once it ends.'
        : pick ? null : 'No laboratory is free at all of its Lecture and Laboratory times — change its time on the Scheduling page.',
    };
  });
}

/** Rooms → "Lec + Lab in Two Rooms": every such class this term and the one laboratory it can move into */
export async function listSplitMajorClasses(q: Queryable, term: { semester: string; schoolYear: string }) {
  const classes = await planSplitClasses(q, term);
  return { classes, movable: classes.filter(c => c.room).length };
}

/**
 * Move each class into its one laboratory (rooms only — days and times stay).
 * Call inside a transaction holding the schedule-save lock
 * (pg_advisory_xact_lock 'qrganize:schedule-save'); throws — so the
 * transaction saves nothing — if a room would end up double-booked.
 */
export async function putSplitMajorClassesInOneRoom(q: Queryable, term: { semester: string; schoolYear: string }) {
  const classes = await planSplitClasses(q, term);
  const moved = classes.filter(c => c.room);
  for (const c of moved) {
    await q('UPDATE schedule_sessions SET room_id = $1 WHERE master_schedule_id = $2', [c.room!.id, c.ms_id]);
    await q('UPDATE master_schedule SET room_id = $1, updated_at = NOW() WHERE id = $2', [c.room!.id, c.ms_id]);
  }
  if (moved.length) {
    // Scheduling's room rule, checked once more on the saved rooms: no other class in the room at an overlapping time
    const clash = (await q(`
      SELECT COUNT(*)::int AS n
        FROM schedule_sessions a
        JOIN schedule_sessions b ON b.room_id = a.room_id AND b.day_of_week = a.day_of_week
             AND b.master_schedule_id <> a.master_schedule_id AND a.start_time < b.end_time AND b.start_time < a.end_time
        JOIN master_schedule mb ON mb.id = b.master_schedule_id
        JOIN block_subjects bsb ON bsb.id = mb.block_subject_id
        JOIN blocks bb ON bb.id = bsb.block_id
       WHERE a.master_schedule_id = ANY($1::int[]) AND a.room_id IS NOT NULL
         AND mb.status IN ${LIVE} AND mb.faculty_id IS NOT NULL
         AND ($2 = '' OR bb.semester = $2) AND ($3 = '' OR bb.academic_year = $3)`,
      [moved.map(c => c.ms_id), term.semester, term.schoolYear])).rows[0];
    if (Number(clash?.n) > 0) throw new Error('A room would be double-booked — nothing was moved.');
  }
  return { moved, left: classes.filter(c => !c.room) };
}
