import { ensureFacultyActivitiesTable } from '@/database/facultyActivitiesSchema';
import { saveScheduleClasses } from '@/services/scheduleSave';
import { parseDays, shortDay, sortDays, type WeekDay } from '@shared/dayCombination';
import {
  WORK_DAYS, insideSchoolDay, placeClassInDay, placeInDay, span, type BusyKind, type PlacedMeeting,
} from '@/services/moveIntoDayPlacement';
import { isPathfitSubject, isPathfitVenue } from '@shared/pathfitVenue';
import { SCHOOL_DAY_LABEL, minutesHHMM } from '@shared/schoolDay';
import { needsOneRoomSql } from '@shared/subjectCategory';
import { roomKey } from '@shared/workloadImport';

/**
 * "Move into the school day" (Room Utilization → Room Planning). A class with any
 * meeting outside 7:00 AM–6:00 PM, or over the 12:00–1:00 PM lunch, gets new
 * times inside the day, found automatically: the same days first, the latest
 * free time closest to where it was (for a late class, the latest), its own room when that is free,
 * otherwise a free room of the right kind — a lecture room for a Lecture, a
 * laboratory for a Laboratory. A Major subject keeps its Lecture and
 * Laboratory in one laboratory on the same days: when its late part can't move
 * on its own, both parts move together. Every meeting keeps its length.
 *
 * When a class fits nowhere because its faculty or block has no free time
 * that matches a free room, one other class of the same faculty or block may
 * move to make room, by the same rules — a lecture-only class keeps its days
 * and only its clashing meetings move; a Major class keeps whatever part is
 * not in the way, and its Lecture and Laboratory may not end up more than 2
 * hours further apart. The pair that changes the fewest meetings is chosen; never a
 * class with a room request or a freed-room date in progress, never PATHFIT.
 * The two are saved together or not at all.
 *
 * Moves are saved through the Scheduling save (services/scheduleSave.ts), so
 * faculty / block / room conflicts, room types, PATHFIT venues and the Major
 * Lec + Lab one-room rule are checked exactly as on the Scheduling page.
 * Classes that can't be placed are listed with why.
 */

type Q = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type Part = 'lec' | 'lab';

const LAB_TYPES = ['Laboratory', 'Computer Lab'];
/** Room requests still in progress — their class is never moved to make room */
const LIVE_REQUEST = `('Pending', 'Pending Confirmation', 'Approved', 'In-Use')`;

export interface MoveMeeting { day: string; start: string; end: string; room: string | null }
/** One part of a class that moves: where it meets now, and where it goes (null = no free time and room) */
export interface MovePart { part: Part; from: MoveMeeting[]; to: MoveMeeting[] | null }
export interface MovePlan {
  msId: number;
  subjectCode: string;
  subjectName: string;
  block: string;
  facultyId: number | null;
  facultyName: string | null;
  employmentStatus: string | null;
  /** The parts that move: the one outside the school day — or both, for a Major Lec + Lab class moving together */
  parts: MovePart[];
  /** Set when this class (inside the school day) moves only to make room for that class */
  makesRoomFor: { msId: number; subjectCode: string; block: string } | null;
  /** Why it can't be moved automatically (null = every part has a new place) */
  reason: string | null;
}
export interface MoveResult extends MovePlan {
  moved: boolean;
}
type Placed = { part: Part; meetings: PlacedMeeting[] }[];
/** A plan with each part's new meetings and rooms, for saving; plans of one group are saved together */
interface PlannedMove extends MovePlan { save: Placed | null; group: number }

interface SessionRow {
  id: number; ms: number; part: Part; day: string; start: number; end: number;
  roomId: number | null; roomName: string | null; facultyId: number | null; blockId: number;
}
interface ClassRow {
  id: number; facultyId: number | null; blockId: number; programId: number | null;
  subjectCode: string; subjectName: string; lec: number; lab: number; oneRoom: boolean;
  block: string; facultyName: string | null; employmentStatus: string | null;
}

/** The plan for every class with a meeting outside the school day (read only) */
export async function planMovesIntoDay(q: Q, term: { semester: string; schoolYear: string }, opts: { programId?: number | null } = {}): Promise<MovePlan[]> {
  return (await planMoves(q, term, opts)).map(withoutSave);
}

const withoutSave = (p: PlannedMove): MovePlan => {
  const { save, group, ...plan } = p;
  void save; void group;
  return plan;
};

const unique = <T>(list: T[]) => [...new Set(list)];
const minutesOf = (s: { start: number; end: number }) => span(s.start, s.end).end - span(s.start, s.end).start;

async function planMoves(q: Q, term: { semester: string; schoolYear: string }, opts: { programId?: number | null }): Promise<PlannedMove[]> {
  await ensureFacultyActivitiesTable();
  const sessions = (await q(`
    SELECT ss.id, ss.master_schedule_id AS ms, COALESCE(ss.type, 'lec') AS part, ss.day_of_week AS day,
           (EXTRACT(EPOCH FROM ss.start_time) / 60)::int AS s, (EXTRACT(EPOCH FROM ss.end_time) / 60)::int AS e,
           ss.room_id, r.room_name, ms.faculty_id, bs.block_id
      FROM schedule_sessions ss
      JOIN master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN blocks b ON b.id = bs.block_id
      LEFT JOIN rooms r ON r.id = ss.room_id
     WHERE ss.day_of_week IS NOT NULL AND ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
       AND ms.faculty_id IS NOT NULL AND ms.status IN ('Assigned', 'Scheduled', 'Completed')
       AND b.semester = $1 AND b.academic_year = $2`, [term.semester, term.schoolYear])).rows.map(r => ({
    id: Number(r.id), ms: Number(r.ms), part: (r.part === 'lab' ? 'lab' : 'lec') as Part, day: String(r.day),
    start: Number(r.s), end: Number(r.e), roomId: r.room_id == null ? null : Number(r.room_id), roomName: r.room_name == null ? null : String(r.room_name),
    facultyId: r.faculty_id == null ? null : Number(r.faculty_id), blockId: Number(r.block_id),
  } satisfies SessionRow));

  const outMs = unique(sessions.filter(s => !insideSchoolDay(s.start, s.end)).map(s => s.ms));
  if (outMs.length === 0) return [];
  // Every class of the term — the late ones, and the ones that may make room for them
  const allMs = unique(sessions.map(s => s.ms));
  const classes = new Map((await q(`
    SELECT ms.id, ms.faculty_id, bs.block_id, b.program_id, c.subject_code, c.subject_name,
           COALESCE(c.lecture_hours, 0)::float AS lec, COALESCE(c.laboratory_hours, 0)::float AS lab,
           ${needsOneRoomSql('c')} AS one_room,
           TRIM(CONCAT_WS(' ', p.code, CONCAT(SUBSTRING(COALESCE(b.year_level, '') FROM '[0-9]+'), b.block_name))) AS block,
           COALESCE(NULLIF(TRIM(f.name), ''), NULLIF(TRIM(CONCAT_WS(' ', f.first_name, f.last_name)), '')) AS faculty_name,
           f.employment_status
      FROM master_schedule ms
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN blocks b ON b.id = bs.block_id
      JOIN curriculums c ON c.id = bs.curriculum_id
      LEFT JOIN programs p ON p.id = b.program_id
      LEFT JOIN faculty f ON f.id = ms.faculty_id
     WHERE ms.id = ANY($1::int[])`, [allMs])).rows.map(r => [Number(r.id), {
    id: Number(r.id), facultyId: r.faculty_id == null ? null : Number(r.faculty_id), blockId: Number(r.block_id),
    programId: r.program_id == null ? null : Number(r.program_id),
    subjectCode: String(r.subject_code ?? ''), subjectName: String(r.subject_name ?? ''),
    lec: Number(r.lec), lab: Number(r.lab), oneRoom: r.one_room === true, block: String(r.block ?? ''),
    facultyName: r.faculty_name == null ? null : String(r.faculty_name),
    employmentStatus: r.employment_status == null ? null : String(r.employment_status),
  } satisfies ClassRow]));
  const rooms = (await q(`SELECT id, room_name, room_type FROM rooms WHERE status = 'Active' ORDER BY id`)).rows
    .map(r => ({ id: Number(r.id), name: String(r.room_name), type: String(r.room_type ?? '') }));
  const activities = (await q(`
    SELECT faculty_id, day_of_week AS day, (EXTRACT(EPOCH FROM start_time) / 60)::int AS s, (EXTRACT(EPOCH FROM end_time) / 60)::int AS e
      FROM faculty_activities WHERE semester = $1 AND academic_year = $2`, [term.semester, term.schoolYear])).rows;
  const combos = (await q(`
    SELECT days FROM semester_day_combinations WHERE is_active = true AND semester = $1 AND academic_year = $2 ORDER BY sort_order, id`,
  [term.semester, term.schoolYear]).catch(() => ({ rows: [] }))).rows
    .map(r => parseDays(String(r.days))).filter((d): d is WeekDay[] => !!d);
  // Classes with a room request or a freed-room date in progress (null = unknown → nothing moves to make room)
  const inProgress = await q(`
    SELECT master_schedule_id AS ms FROM room_change_requests WHERE master_schedule_id = ANY($1::int[]) AND status IN ${LIVE_REQUEST}
    UNION
    SELECT ss.master_schedule_id FROM room_releases rr JOIN schedule_sessions ss ON ss.id = rr.session_id
     WHERE rr.release_date >= CURRENT_DATE AND ss.master_schedule_id = ANY($1::int[])`, [allMs])
    .then(r => new Set(r.rows.map(x => Number(x.ms))), () => null);

  // Who / what / which room is taken, per day — a class part gives up its old times while it is placed
  const taken = new Map<string, { start: number; end: number; owner: string }[]>();
  const key = (kind: BusyKind, id: number, day: string) => `${kind}:${id}:${day}`;
  const add = (kind: BusyKind, id: number, day: string, start: number, end: number, owner: string) => {
    const k = key(kind, id, day); if (!taken.has(k)) taken.set(k, []);
    taken.get(k)!.push({ ...span(start, end), owner });
  };
  const drop = (owner: string) => { for (const list of taken.values()) for (let i = list.length - 1; i >= 0; i--) if (list[i].owner === owner) list.splice(i, 1); };
  const book = (owner: string, facultyId: number | null, blockId: number, list: { day: string; start: number; end: number; roomId: number | null }[]) => {
    for (const m of list) {
      if (facultyId != null) add('fac', facultyId, m.day, m.start, m.end, owner);
      add('blk', blockId, m.day, m.start, m.end, owner);
      if (m.roomId != null) add('room', m.roomId, m.day, m.start, m.end, owner);
    }
  };
  for (const s of sessions) book(`${s.ms}|${s.part}`, s.facultyId, s.blockId, [s]);
  for (const a of activities) add('fac', Number(a.faculty_id), String(a.day), Number(a.s), Number(a.e), 'activity');
  const busy = (kind: BusyKind, id: number, day: string, start: number, end: number) =>
    (taken.get(key(kind, id, day)) ?? []).some(x => start < x.end && end > x.start);

  const dayOrder = (a: SessionRow, b: SessionRow) =>
    WORK_DAYS.indexOf(a.day as WeekDay) - WORK_DAYS.indexOf(b.day as WeekDay) || a.start - b.start;
  const byClass = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    const k = `${s.ms}|${s.part}`; if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k)!.push(s);
  }
  for (const list of byClass.values()) list.sort(dayOrder);
  /** A class part's meetings now, in day order */
  const meetingsOf = (ms: number, part: Part) => byClass.get(`${ms}|${part}`) ?? [];
  const lateParts = (c: ClassRow) => (['lec', 'lab'] as const).filter(part => meetingsOf(c.id, part).some(s => !insideSchoolDay(s.start, s.end)));
  const release = (c: ClassRow, part: Part) => drop(`${c.id}|${part}`);
  const restore = (c: ClassRow, part: Part) => book(`${c.id}|${part}`, c.facultyId, c.blockId, meetingsOf(c.id, part));
  const bookNew = (c: ClassRow, placed: Placed) => { for (const p of placed) book(`${c.id}|${p.part}`, c.facultyId, c.blockId, p.meetings); };

  const roomName = (id: number) => rooms.find(r => r.id === id)?.name ?? null;
  const isLabRoom = (id: number) => LAB_TYPES.includes(rooms.find(r => r.id === id)?.type ?? '');
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });
  /** Rooms of the kind given, the class's own ones first, then the others by name */
  const ownFirst = (fit: (r: { id: number; name: string; type: string }) => boolean, own: number[]) => [
    ...rooms.filter(r => own.includes(r.id) && fit(r)),
    ...rooms.filter(r => !own.includes(r.id) && fit(r)).sort(byName),
  ].map(r => ({ id: r.id, name: r.name }));
  /** A laboratory: one the class already uses, or a general one (Lab 1, Lab 2 …) — special rooms only for classes in them */
  const labFor = (own: number[]) => (r: { id: number; name: string; type: string }) =>
    LAB_TYPES.includes(r.type) && (own.includes(r.id) || roomKey(r.name).kind === 'lab');
  const lectureRoom = (r: { name: string; type: string }) => !LAB_TYPES.includes(r.type) && !isPathfitVenue(r.name);
  const roomsOf = (list: SessionRow[]) => unique(list.map(s => s.roomId).filter((id): id is number => id != null));
  const onWeekend = (c: ClassRow, parts: readonly Part[]) =>
    parts.some(part => meetingsOf(c.id, part).some(s => !WORK_DAYS.includes(s.day as WeekDay)));

  /**
   * New times for the given parts of a class (its late parts, or the parts in
   * the way of another class); its other part stays. On success they are booked
   * (their old times given up); otherwise the old times stay booked and why is
   * returned.
   */
  const placeParts = (c: ClassRow, move: readonly Part[]): { placed: Placed } | { reason: string } => {
    const lecS = meetingsOf(c.id, 'lec');
    const labS = meetingsOf(c.id, 'lab');
    // Each meeting with its length and where it starts now — new times are found closest to it
    const meetings = (list: SessionRow[]) => list.map(s => ({ day: s.day as WeekDay, minutes: minutesOf(s), start: s.start }));

    // ── A Major subject with both parts scheduled: one laboratory, the same days ──
    if (c.oneRoom && lecS.length > 0 && labS.length > 0) {
      if (onWeekend(c, ['lec', 'lab'])) return { reason: 'it meets on a weekend — set its days on the Scheduling page' };
      // 1. Only that part moves — into its other part's laboratory, on its other part's days
      if (move.length === 1) {
        const part = move[0];
        const other = part === 'lab' ? lecS : labS;
        const otherRooms = roomsOf(other);
        const otherDays = sortDays(unique(other.map(s => s.day as WeekDay)));
        if (otherRooms.length === 1 && isLabRoom(otherRooms[0]) && other.every(s => s.roomId != null) && otherDays.length === meetingsOf(c.id, part).length) {
          release(c, part);
          const placed = placeInDay({
            meetings: meetings(meetingsOf(c.id, part)), rooms: ownFirst(r => r.id === otherRooms[0], otherRooms),
            lockedDays: otherDays, combos, facultyId: c.facultyId, blockId: c.blockId, busy,
          });
          if (placed) { const out: Placed = [{ part, meetings: placed }]; bookNew(c, out); return { placed: out }; }
          restore(c, part);
        }
      }
      // 2. Both parts move together, to a laboratory free for both on the same days
      release(c, 'lec'); release(c, 'lab');
      const own = roomsOf([...lecS, ...labS]);
      const placed = placeClassInDay({
        lec: meetings(lecS), lab: meetings(labS), rooms: ownFirst(labFor(own), own), combos,
        near: { lec: lecS[0].start, lab: labS[0].start }, facultyId: c.facultyId, blockId: c.blockId, busy,
      });
      if (placed) {
        const out: Placed = [{ part: 'lec', meetings: placed.lec }, { part: 'lab', meetings: placed.lab }];
        bookNew(c, out);
        return { placed: out };
      }
      restore(c, 'lec'); restore(c, 'lab');
      return {
        reason: lecS.length !== labS.length || unique(lecS.map(s => s.day)).length !== lecS.length
          ? `its Lecture meets ${lecS.length} and its Laboratory ${labS.length} times a week — put them on the same days on the Scheduling page`
          : `no laboratory is free for both its Lecture and its Laboratory on the same days inside ${SCHOOL_DAY_LABEL} for this faculty and block (a Major subject keeps both in one laboratory)`,
      };
    }

    // ── Otherwise each part on its own: lecture rooms for a Lecture, laboratories for a Laboratory ──
    if (onWeekend(c, move)) return { reason: 'it meets on a weekend — set its days on the Scheduling page' };
    const done: Placed = [];
    const undo = (reason: string) => {
      // A class moves whole or not at all: parts already placed go back
      for (const d of done) { release(c, d.part); restore(c, d.part); }
      return { reason };
    };
    for (const part of move) {
      const mine = meetingsOf(c.id, part);
      const own = roomsOf(mine);
      const allowed = ownFirst(
        isPathfitSubject(c.subjectCode) ? r => isPathfitVenue(r.name)
          : part === 'lab' || c.oneRoom ? labFor(own)
          : lectureRoom,
        own,
      );
      if (allowed.length === 0) return undo('no active room of the right kind');
      release(c, part);
      const placed = placeInDay({ meetings: meetings(mine), rooms: allowed, lockedDays: null, combos, facultyId: c.facultyId, blockId: c.blockId, busy });
      if (!placed) { restore(c, part); return undo('no free room and time inside the school day for this faculty and block'); }
      book(`${c.id}|${part}`, c.facultyId, c.blockId, placed);
      done.push({ part, meetings: placed });
    }
    return { placed: done };
  };
  const placeClass = (c: ClassRow) => placeParts(c, lateParts(c));

  /**
   * A lecture-only class making room: its meetings that are still free stay as
   * they are; the clashing ones move on their own day (its room first, then
   * other lecture rooms) — or, failing that, the whole class at new times.
   * Called with its old times given up; books its new ones on success.
   */
  const placeAround = (x: ClassRow): PlacedMeeting[] | null => {
    const mine = meetingsOf(x.id, 'lec');
    const owner = `${x.id}|lec`;
    const lectureRooms = ownFirst(lectureRoom, roomsOf(mine));
    const free = (m: SessionRow) => (x.facultyId == null || !busy('fac', x.facultyId, m.day, m.start, m.end))
      && !busy('blk', x.blockId, m.day, m.start, m.end) && (m.roomId == null || !busy('room', m.roomId, m.day, m.start, m.end));
    const kept = mine.map(m => (m.roomId != null && free(m) ? { day: m.day as WeekDay, start: m.start, end: span(m.start, m.end).end, roomId: m.roomId } : null));
    book(owner, x.facultyId, x.blockId, kept.filter((m): m is PlacedMeeting => m !== null));
    const result: (PlacedMeeting | null)[] = [...kept];
    for (const [i, m] of mine.entries()) {
      if (result[i]) continue;
      const one = placeInDay({
        meetings: [{ day: m.day as WeekDay, minutes: minutesOf(m), start: m.start }], rooms: lectureRooms, lockedDays: [m.day as WeekDay], combos,
        facultyId: x.facultyId, blockId: x.blockId, busy,
      });
      if (!one) break;
      result[i] = one[0];
      book(owner, x.facultyId, x.blockId, one);
    }
    if (result.every(m => m !== null)) return result as PlacedMeeting[];
    drop(owner);
    const all = placeInDay({
      meetings: mine.map(m => ({ day: m.day as WeekDay, minutes: minutesOf(m), start: m.start })), rooms: lectureRooms, lockedDays: null, combos,
      facultyId: x.facultyId, blockId: x.blockId, busy,
    });
    if (all) book(owner, x.facultyId, x.blockId, all);
    return all;
  };

  /** A class part with a meeting that clashes with what is booked now */
  const clashes = (x: ClassRow, part: Part) => meetingsOf(x.id, part).some(m =>
    (x.facultyId != null && busy('fac', x.facultyId, m.day, m.start, m.end))
    || busy('blk', x.blockId, m.day, m.start, m.end) || (m.roomId != null && busy('room', m.roomId, m.day, m.start, m.end)));
  /**
   * New places for a class that makes room (called with all its old times given
   * up): a lecture-only class meeting by meeting; any other class only its
   * parts that now clash move, the others stay. Null when it fits nowhere.
   */
  const placeHelper = (x: ClassRow): Placed | null => {
    if (x.lab <= 0) {
      const around = placeAround(x);
      return around ? [{ part: 'lec', meetings: around }] : null;
    }
    const move = (['lec', 'lab'] as const).filter(part => meetingsOf(x.id, part).length > 0 && clashes(x, part));
    for (const part of (['lec', 'lab'] as const)) if (!move.includes(part)) restore(x, part);
    if (move.length === 0) return null;
    const r = placeParts(x, move);
    return 'placed' in r ? r.placed : null;
  };

  /** How much a move changes a class: meetings that change (day, time or room), then minutes moved (another day counts 12 hours) */
  const changes = (c: ClassRow, placed: Placed) => placed.reduce((n, p) => {
    const old = meetingsOf(c.id, p.part);
    for (const [i, m] of p.meetings.entries()) {
      const o = old[i];
      if (o && o.day === m.day && o.start === m.start && span(o.start, o.end).end === m.end && o.roomId === m.roomId) continue;
      n.meetings += 1;
      n.minutes += o ? Math.abs(m.start - o.start) + (o.day === m.day ? 0 : 720) : 1440;
    }
    return n;
  }, { meetings: 0, minutes: 0 });

  /** The widest gap between a class's Lecture and Laboratory on a day they share (minutes) */
  const widestGap = (lec: { day: string; start: number; end: number }[], lab: { day: string; start: number; end: number }[]) =>
    lec.reduce((w, a) => lab.filter(b => b.day === a.day).reduce((v, b) => {
      const ea = span(a.start, a.end).end; const eb = span(b.start, b.end).end;
      return Math.max(v, Math.max(a.start, b.start) - Math.min(ea, eb));
    }, w), 0);
  /** A class making room must stay sensible for its students: its Lecture and Laboratory no more than 2 hours further apart than now */
  const stillTogether = (x: ClassRow, placed: Placed) => {
    const now = (part: Part) => meetingsOf(x.id, part);
    const after = (part: Part) => placed.find(p => p.part === part)?.meetings ?? now(part);
    return widestGap(after('lec'), after('lab')) <= widestGap(now('lec'), now('lab')) + 120;
  };

  const helpers = new Set<number>();
  /**
   * One class of the same faculty or block moving out of the way so the class
   * fits — the pair that changes the fewest meetings. Both end up booked at
   * their new times; null when no such class helps.
   */
  const makeRoom = (s: ClassRow): { helper: ClassRow; helperPlaced: Placed; placed: Placed } | null => {
    if (!inProgress) return null;
    const candidates = [...classes.values()].filter(x => {
      if (x.id === s.id || helpers.has(x.id) || inProgress.has(x.id) || outMs.includes(x.id)) return false;
      if (isPathfitSubject(x.subjectCode)) return false;
      if (opts.programId != null && x.programId !== opts.programId) return false;
      if (x.blockId !== s.blockId && (s.facultyId == null || x.facultyId !== s.facultyId)) return false;
      const mine = [...meetingsOf(x.id, 'lec'), ...meetingsOf(x.id, 'lab')];
      return mine.length > 0 && (x.lab > 0 || meetingsOf(x.id, 'lab').length === 0)
        && mine.every(m => m.roomId != null && WORK_DAYS.includes(m.day as WeekDay) && insideSchoolDay(m.start, m.end));
    });
    let best: { helper: ClassRow; helperPlaced: Placed; placed: Placed; cost: { meetings: number; minutes: number } } | null = null;
    const both = ['lec', 'lab'] as const;
    for (const x of candidates) {
      for (const part of both) release(x, part);
      const r = placeClass(s);
      if ('placed' in r) {
        const helperPlaced = placeHelper(x);
        if (helperPlaced && helperPlaced.length > 0 && stillTogether(x, helperPlaced)) {
          const a = changes(s, r.placed); const b = changes(x, helperPlaced);
          const cost = { meetings: a.meetings + b.meetings, minutes: a.minutes + b.minutes };
          if (!best || cost.meetings < best.cost.meetings || (cost.meetings === best.cost.meetings && cost.minutes < best.cost.minutes)) {
            best = { helper: x, helperPlaced, placed: r.placed, cost };
          }
        }
        for (const part of both) release(x, part);
        for (const p of r.placed) { release(s, p.part); restore(s, p.part); }
      }
      for (const part of both) restore(x, part);
    }
    if (!best) return null;
    for (const part of both) release(best.helper, part);
    for (const p of best.placed) release(s, p.part);
    // The class making room: its moved parts at their new times, the others where they are
    for (const part of both) if (!best.helperPlaced.some(p => p.part === part)) restore(best.helper, part);
    bookNew(best.helper, best.helperPlaced);
    bookNew(s, best.placed);
    helpers.add(best.helper.id);
    return best;
  };

  const meetingOf = (s: SessionRow): MoveMeeting => ({ day: s.day, start: minutesHHMM(s.start % 1440), end: minutesHHMM(s.end % 1440), room: s.roomName });
  const base = (c: ClassRow) => ({
    msId: c.id, subjectCode: c.subjectCode, subjectName: c.subjectName, block: c.block,
    facultyId: c.facultyId, facultyName: c.facultyName, employmentStatus: c.employmentStatus,
  });
  const planned = (c: ClassRow, placed: Placed, group: number, forClass: ClassRow | null = null): PlannedMove => ({
    ...base(c), reason: null, save: placed, group,
    makesRoomFor: forClass ? { msId: forClass.id, subjectCode: forClass.subjectCode, block: forClass.block } : null,
    parts: placed.map(p => ({
      part: p.part, from: meetingsOf(c.id, p.part).map(meetingOf),
      to: p.meetings.map(m => ({ day: m.day, start: minutesHHMM(m.start), end: minutesHHMM(m.end), room: roomName(m.roomId) })),
    })),
  });

  // Major Lec + Lab classes first (their room and days are tied), then by class
  outMs.sort((a, b) => Number(classes.get(a)?.oneRoom !== true) - Number(classes.get(b)?.oneRoom !== true) || a - b);

  const plans: PlannedMove[] = [];
  let group = 0;
  for (const msId of outMs) {
    const c = classes.get(msId);
    if (!c) continue;
    if (opts.programId != null && c.programId !== opts.programId) continue;
    group++;
    const r = placeClass(c);
    if ('placed' in r) { plans.push(planned(c, r.placed, group)); continue; }
    const chain = makeRoom(c);
    if (chain) {
      plans.push(planned(chain.helper, chain.helperPlaced, group, c), planned(c, chain.placed, group));
      continue;
    }
    const both = c.oneRoom && meetingsOf(c.id, 'lec').length > 0 && meetingsOf(c.id, 'lab').length > 0;
    plans.push({
      ...base(c), reason: r.reason, save: null, group, makesRoomFor: null,
      parts: (both ? (['lec', 'lab'] as const) : lateParts(c)).map(part => ({ part, from: meetingsOf(c.id, part).map(meetingOf), to: null })),
    });
  }
  return plans;
}

/** Saves every planned move through the Scheduling save; returns what moved and what didn't (with why) */
export async function applyMovesIntoDay(
  q: Q, term: { semester: string; schoolYear: string },
  opts: { programId?: number | null; scopedProgramId?: number | null } = {},
): Promise<MoveResult[]> {
  const plans = await planMoves(q, term, { programId: opts.programId });
  const results: MoveResult[] = [];
  const sessionsOf = (part: Part, meetings: PlacedMeeting[]) => meetings.map(m => ({
    day: m.day, start_time: minutesHHMM(m.start), end_time: minutesHHMM(m.end),
    hours: Math.round((m.end - m.start) / 60 * 100) / 100, type: part, room_id: m.roomId,
  }));
  const dayPattern = (meetings: PlacedMeeting[]) => sortDays(unique(meetings.map(m => m.day))).map(shortDay).join('/');
  for (const g of unique(plans.map(p => p.group))) {
    const members = plans.filter(p => p.group === g);
    const shown = members.map(withoutSave);
    const saves = members.map(p => (p.reason ? null : p.save));
    if (saves.some(s => !s || s.length === 0)) { results.push(...shown.map(p => ({ ...p, moved: false }))); continue; }
    // A class and the one making room for it are saved together, or not at all
    const out = await saveScheduleClasses(members.map((p, i) => {
      const placed = saves[i] ?? [];
      return {
        master_schedule_id: p.msId, day_pattern: dayPattern(placed[0]?.meetings ?? []), split_type: 'Manual',
        parts: placed.map(x => ({ component: x.part, sessions: sessionsOf(x.part, x.meetings) })),
      };
    }), { scopedProgramId: opts.scopedProgramId });
    if (out.status === 200) { results.push(...shown.map(p => ({ ...p, moved: true }))); continue; }
    const why = String(out.body.error ?? 'It could not be saved.');
    const failed = shown.find(p => p.msId === Number(out.body.ms_id));
    results.push(...shown.map(p => ({
      ...p, moved: false, parts: p.parts.map(x => ({ ...x, to: null })),
      reason: failed && failed.msId !== p.msId ? `${failed.subjectCode} ${failed.block} could not move — ${why}` : why,
    })));
  }
  return results;
}
