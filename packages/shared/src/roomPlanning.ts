/**
 * Room Planning — are there enough rooms of each kind for the class schedule?
 *
 * Rooms are shared, so demand is never the number of faculty or of classes: it
 * is the most class meetings that need a room of one kind at the same moment,
 * compared with the usable (Active) rooms of that kind. A faculty member with
 * five classes at different times needs one room at a time.
 *
 * Kinds of room follow Class Assignment's rules:
 *  • PATHFIT → only the PATHFIT venues (CCA Gym, SAO Room)
 *  • a Laboratory part, and both parts of a Major subject with Lecture +
 *    Laboratory (one room, a laboratory) → laboratories
 *  • the Lecture of another subject with lab hours → a lecture room or a lab
 *  • a lecture-only subject → a lecture room, never a laboratory
 * The PATHFIT venues are counted on their own, not as lecture rooms.
 *
 * A meeting counts toward the kind of room it is in when that room suits it;
 * otherwise (no room, an inactive room, the wrong kind) toward the kind it
 * needs. A room is never counted twice at the same moment: back-to-back
 * meetings (8–9, 9–10) share one room — times are half-open, in minutes, and
 * an end at/before the start runs past midnight (as in the conflict checks).
 *
 * "Fully booked" (every room of a kind in use) is not a shortage; a shortage
 * is more meetings needing a kind at once than there are rooms of it.
 *
 * Each kind needs the larger of its busiest moment and its busiest day's class
 * hours ÷ 10 (classes fit 7:00 AM–6:00 PM with lunch free, so one room holds
 * 10 hours a day). "Now" compares that with the usable rooms. The projection
 * adds the class parts with no day and time yet (their curriculum hours) and
 * compares them with the room hours still free in the school week — a lower
 * bound, because it assumes every free hour can be used.
 *
 * Pure logic (no DB) so the rules can be tested and shared with the UI.
 */

import { isPathfitSubject, isPathfitVenue } from './pathfitVenue';
import { LUNCH_END_MIN, LUNCH_START_MIN, SCHOOL_DAY_CLASS_MIN, SCHOOL_DAY_END_MIN, SCHOOL_DAY_START_MIN } from './schoolDay';

export const PLANNING_WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
/** Always part of the school week; Saturday and Sunday only when the term has classes then */
const SCHOOL_WEEK_DAYS = 5;

/** Laboratory room types (Scheduling also recognises the legacy 'Computer Lab'). */
export const LAB_ROOM_TYPES = ['Laboratory', 'Computer Lab'] as const;
export const isLabRoomType = (t: string | null | undefined) => (LAB_ROOM_TYPES as readonly string[]).includes(t ?? '');

export const ROOM_POOLS = ['lecture', 'laboratory', 'pathfit'] as const;
export type RoomPool = (typeof ROOM_POOLS)[number];

export const ROOM_POOL_LABEL: Record<RoomPool, string> = {
  lecture: 'Lecture rooms',
  laboratory: 'Laboratories',
  pathfit: 'PATHFIT venues',
};

/** The kind of room this is — the PATHFIT venues are counted on their own */
export function roomPoolOf(room: { room_name: string | null; room_type: string | null }): RoomPool {
  if (isPathfitVenue(room.room_name)) return 'pathfit';
  return isLabRoomType(room.room_type) ? 'laboratory' : 'lecture';
}

const isLabPart = (part: string | null | undefined) => String(part ?? '').toLowerCase() === 'lab';

/** Kinds of room a class meeting may use (Class Assignment's rules); the first is the kind it needs when it has none */
export function allowedPools(m: { part: string | null; subject_code: string | null; has_lab: boolean; one_room: boolean }): RoomPool[] {
  if (isPathfitSubject(m.subject_code)) return ['pathfit'];
  if (isLabPart(m.part) || m.one_room) return ['laboratory'];
  // A lecture room is any room that isn't a laboratory — the PATHFIT venues included
  return m.has_lab ? ['lecture', 'laboratory', 'pathfit'] : ['lecture', 'pathfit'];
}

/* ─── Input ───────────────────────────────────────────────────────────────── */

export interface PlanningRoomInput {
  id: number;
  room_name: string;
  room_type: string | null;
  /** Usable per Room Management (status Active) */
  active: boolean;
}

/** One scheduled class meeting (a schedule_sessions row with a day and time) */
export interface PlanningSessionInput {
  id: number;
  ms_id: number;
  day: string;
  start_time: string;
  end_time: string;
  /** 'lab' = the Laboratory part; anything else = the Lecture */
  part: string | null;
  room_id: number | null;
  subject_code: string | null;
  subject_name: string | null;
  block: string | null;
  faculty_id: number | null;
  faculty_name: string | null;
  /** The subject has laboratory hours */
  has_lab: boolean;
  /** Major subject with Lecture + Laboratory: one laboratory for both parts */
  one_room: boolean;
}

/** A class part with no day and time yet — the projection's input */
export interface PlanningPendingInput {
  ms_id: number;
  part: 'lec' | 'lab';
  /** Weekly class minutes (curriculum hours × 60) */
  minutes: number;
  subject_code: string | null;
  has_lab: boolean;
  one_room: boolean;
  /** A faculty member is assigned (otherwise it can't be scheduled yet) */
  has_faculty: boolean;
}

/* ─── Output ──────────────────────────────────────────────────────────────── */

/** Why a class's room doesn't suit it (after_hours is about its time, not its room) */
export type RoomIssue =
  | 'no_room' | 'inactive_room' | 'wrong_type' | 'not_pathfit_venue'
  | 'double_booked' | 'split_rooms' | 'after_hours';

export const ROOM_ISSUE_LABEL: Record<RoomIssue, string> = {
  no_room: 'No room yet',
  inactive_room: 'Room is inactive',
  wrong_type: 'Wrong kind of room',
  not_pathfit_venue: 'Not in a PATHFIT venue',
  double_booked: 'Room double-booked',
  split_rooms: 'Lecture and Lab in different rooms',
  after_hours: 'Outside 7:00 AM–6:00 PM',
};

/** Issues meaning the class has no suitable room */
export const isRoomProblem = (issue: RoomIssue) => issue !== 'after_hours';

/** 'HH:MM' times */
export interface PlanningWindow { day: string; start: string; end: string }

/** One kind of room at the busiest moment of a time slot */
export interface PlanningCell {
  /** Class meetings needing this kind of room at once */
  needed: number;
  /** Rooms of this kind in use then (a double-booked room counts once) */
  in_use: number;
  usable: number;
  /** Meetings with no room of this kind left */
  short: number;
  /** All rooms only: the rooms in use of each kind at that same moment (they add up to in_use) —
   *  so a chart of all rooms can colour each kind without mixing moments */
  by_pool?: Record<RoomPool, number>;
}

export interface PoolPlan {
  pool: RoomPool;
  /** Active rooms of this kind */
  usable: number;
  /** Class meetings per week counted toward this kind */
  meetings: number;
  /** Most meetings needing this kind at once, and when */
  peak: number;
  peak_at: PlanningWindow | null;
  /** Rooms the busiest day's class hours need (10 hours a room) */
  rooms_by_hours: number;
  hours_day: string | null;
  hours_day_minutes: number;
  /** The larger of peak and rooms_by_hours — what the schedule needs now */
  required: number;
  /** Most meetings of this kind with no room left at the same moment */
  max_short: number;
  /** Rooms to add for the current schedule: required − usable (never below 0) */
  additional: number;
  /** Hour slots where every room is needed (fully booked) / more than every room */
  full_slots: number;
  short_slots: number;
  /** Class minutes inside the school week's class hours, and the room minutes left */
  booked_minutes: number;
  free_minutes: number;
  /** Class parts not scheduled yet, the minutes they need, and the rooms to add once all are (at least) */
  projected: { classes: number; minutes: number; additional: number };
}

export interface PlanningMeeting {
  id: number;
  day: string;
  start: string;
  end: string;
  room_name: string | null;
  issues: RoomIssue[];
}

/** A class part (subject + block + Lecture/Laboratory) whose room or time needs attention */
export interface PlanningClass {
  key: string;
  ms_id: number;
  part: 'lec' | 'lab';
  subject_code: string | null;
  subject_name: string | null;
  block: string | null;
  faculty_id: number | null;
  faculty_name: string | null;
  /** The kind of room it needs */
  pool: RoomPool;
  issues: RoomIssue[];
  meetings: PlanningMeeting[];
}

/** One counted meeting, compact — for "which classes are on at this time" */
export interface PlanningMeetingRow {
  id: number;
  part: 'lec' | 'lab';
  day: string;
  start: string;
  end: string;
  pool: RoomPool;
  room_name: string | null;
  subject_code: string | null;
  block: string | null;
  faculty_name: string | null;
  issues: RoomIssue[];
}

/** A room in use at the busiest moment, with the class (or classes, when double-booked) in it */
export interface BusyRoom {
  room_id: number;
  room_name: string;
  pool: RoomPool;
  classes: { subject_code: string | null; block: string | null; faculty_name: string | null; part: 'lec' | 'lab'; start: string; end: string }[];
}

/** A room free at the busiest moment, and until when that day (null = the rest of the day) */
export interface FreeRoom {
  room_id: number;
  room_name: string;
  pool: RoomPool;
  until: string | null;
}

/** The rooms behind the busiest-time numbers: in use and free at that very moment */
export interface BusiestRooms {
  at: PlanningWindow | null;
  in_use: BusyRoom[];
  free: FreeRoom[];
}

export interface RoomPlanning {
  /** School week: Monday–Friday, plus Saturday / Sunday when the term has classes then */
  days: string[];
  /** Hour slots of the school day: 7 = 7–8 AM … 17 = 5–6 PM */
  hours: number[];
  /** Class minutes one room holds in the school week */
  week_minutes: number;
  pools: Record<RoomPool, PoolPlan>;
  /** [day][hour] per kind of room, and for all rooms together */
  grid: Record<RoomPool | 'all', PlanningCell[][]>;
  totals: {
    usable: number;
    /** Most meetings needing a room at once (any kind), and when */
    peak: number;
    peak_at: PlanningWindow | null;
    /** Most meetings with no suitable room left at once (kinds can't stand in for each other) */
    max_short: number;
    max_short_at: PlanningWindow | null;
    meetings: number;
    /** Class parts with at least one meeting */
    classes: number;
    /** Class parts whose room doesn't suit them */
    without_room: number;
    /** Class parts meeting outside 7:00 AM–6:00 PM */
    after_hours: number;
    /** Faculty teaching a class with a room or time issue */
    faculty_affected: number;
    additional: number;
    projected_additional: number;
    /** Classes (offerings) with a part not scheduled yet, and how many still need a faculty member */
    pending_classes: number;
    pending_without_faculty: number;
    /** Rows skipped for an invalid day or time */
    invalid: number;
  };
  /** The three busiest hour slots (all rooms), busiest first */
  busiest: { day: string; hour: number; needed: number; usable: number; short: number }[];
  /** Class parts with any issue — room problems first */
  issues: PlanningClass[];
  affected_faculty: { faculty_id: number | null; name: string; classes: number; issues: RoomIssue[] }[];
  meetings: PlanningMeetingRow[];
  /** Per kind of room (and all): which rooms are in use and which are free at the busiest moment */
  busiest_rooms: Record<RoomPool | 'all', BusiestRooms>;
}

/**
 * The hour slot the busiest-time answer reads for one kind of room (or all): the one
 * holding its busiest moment, else the slot with the most meetings — [day, hour] indexes.
 * The room lists (busiest_rooms) are taken at the same moment, so they match the numbers.
 */
export function snapshotCell(
  plan: {
    days: string[];
    hours: number[];
    grid: Record<RoomPool | 'all', PlanningCell[][]>;
    pools: Record<RoomPool, { peak_at: PlanningWindow | null }>;
    totals: { peak_at: PlanningWindow | null };
  },
  key: RoomPool | 'all',
): [number, number] | null {
  const at = key === 'all' ? plan.totals.peak_at : plan.pools[key].peak_at;
  const rows = plan.grid[key] ?? [];
  if (at) {
    const d = plan.days.indexOf(at.day);
    const h = plan.hours.indexOf(Number(at.start.slice(0, 2)));
    if (rows[d]?.[h]) return [d, h];
  }
  // Peak outside the class hours (or none): the busiest hour slot instead
  let best: [number, number] | null = null;
  for (let d = 0; d < rows.length; d++) {
    for (let h = 0; h < rows[d].length; h++) {
      if (!best || rows[d][h].needed > rows[best[0]][best[1]].needed) best = [d, h];
    }
  }
  return best;
}

/** What Analytics shows: the numbers and the grid, without class or faculty lists */
export type RoomPlanningSummary = Pick<RoomPlanning, 'days' | 'hours' | 'week_minutes' | 'pools' | 'grid' | 'totals' | 'busiest'>;

/* ─── Computation ─────────────────────────────────────────────────────────── */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
function toMin(t: string): number | null {
  const m = TIME_RE.exec(String(t ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const toHm = (min: number) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** Minutes of [s, e) inside the school day's class hours (lunch excluded) */
function classHoursMinutes(s: number, e: number): number {
  const overlap = (a: number, b: number) => Math.max(0, Math.min(e, b) - Math.max(s, a));
  return overlap(SCHOOL_DAY_START_MIN, LUNCH_START_MIN) + overlap(LUNCH_END_MIN, SCHOOL_DAY_END_MIN);
}

const ISSUE_ORDER: RoomIssue[] = ['no_room', 'inactive_room', 'wrong_type', 'not_pathfit_venue', 'double_booked', 'split_rooms', 'after_hours'];
const byIssueOrder = (a: RoomIssue, b: RoomIssue) => ISSUE_ORDER.indexOf(a) - ISSUE_ORDER.indexOf(b);

interface Meeting {
  id: number;
  ms_id: number;
  part: 'lec' | 'lab';
  day: string;
  s: number;
  e: number;
  room: PlanningRoomInput | null;
  /** Its room's id and kind when that room is active (it occupies it) */
  roomId: number | null;
  roomPool: RoomPool | null;
  /** Kind of room it counts toward */
  pool: RoomPool;
  issues: Set<RoomIssue>;
  src: PlanningSessionInput;
}

const emptyCell = (usable: number): PlanningCell => ({ needed: 0, in_use: 0, usable, short: 0 });

export function computeRoomPlanning(input: {
  sessions: PlanningSessionInput[];
  rooms: PlanningRoomInput[];
  pending?: PlanningPendingInput[];
}): RoomPlanning {
  const roomById = new Map(input.rooms.map(r => [r.id, r]));
  const usable: Record<RoomPool, number> = { lecture: 0, laboratory: 0, pathfit: 0 };
  for (const r of input.rooms) if (r.active) usable[roomPoolOf(r)]++;
  const usableAll = usable.lecture + usable.laboratory + usable.pathfit;

  /* ── Meetings: valid, one per class meeting, with their issues ─────────── */
  let invalid = 0;
  const byKey = new Map<string, Meeting>();
  for (const ss of input.sessions) {
    const s = toMin(ss.start_time);
    const rawE = toMin(ss.end_time);
    if (!(PLANNING_WEEK_DAYS as readonly string[]).includes(ss.day) || s == null || rawE == null || rawE === s) {
      invalid++;
      continue;
    }
    const e = rawE < s ? rawE + 1440 : rawE;
    const part: 'lec' | 'lab' = isLabPart(ss.part) ? 'lab' : 'lec';
    const room = ss.room_id == null ? null : roomById.get(ss.room_id) ?? null;
    const roomPool = room && room.active ? roomPoolOf(room) : null;
    const allowed = allowedPools({ part, subject_code: ss.subject_code, has_lab: ss.has_lab, one_room: ss.one_room });
    const issues = new Set<RoomIssue>();
    if (!room) issues.add('no_room');
    else if (!room.active) issues.add('inactive_room');
    else if (roomPool && !allowed.includes(roomPool)) issues.add(isPathfitSubject(ss.subject_code) ? 'not_pathfit_venue' : 'wrong_type');
    if (s < SCHOOL_DAY_START_MIN || e > SCHOOL_DAY_END_MIN) issues.add('after_hours');
    const meeting: Meeting = {
      id: ss.id, ms_id: ss.ms_id, part, day: ss.day, s, e, room,
      roomId: room && roomPool ? room.id : null, roomPool,
      pool: roomPool && allowed.includes(roomPool) ? roomPool : allowed[0], issues, src: ss,
    };
    // Duplicate rows of the same class meeting count once (keep the one in an active room)
    const key = `${ss.ms_id}|${part}|${ss.day}|${s}|${e}`;
    const prev = byKey.get(key);
    if (!prev || (prev.roomPool == null && roomPool != null)) byKey.set(key, meeting);
  }
  const meetings = [...byKey.values()];
  const classKey = (m: Meeting) => `${m.ms_id}|${m.part}`;

  // The same room at the same time for two different classes
  const byRoomDay = new Map<string, Meeting[]>();
  for (const m of meetings) {
    if (m.roomId == null) continue;
    const k = `${m.day}|${m.roomId}`;
    byRoomDay.set(k, [...(byRoomDay.get(k) ?? []), m]);
  }
  for (const list of byRoomDay.values()) {
    list.sort((a, b) => a.s - b.s);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].s < list[i].e; j++) {
        if (classKey(list[i]) === classKey(list[j])) continue;
        list[i].issues.add('double_booked');
        list[j].issues.add('double_booked');
      }
    }
  }

  // Major Lecture + Laboratory share one laboratory: a Lecture elsewhere breaks it
  const labRooms = new Map<number, Set<number>>();
  for (const m of meetings) {
    if (m.src.one_room && m.part === 'lab' && m.roomId != null) {
      labRooms.set(m.ms_id, (labRooms.get(m.ms_id) ?? new Set<number>()).add(m.roomId));
    }
  }
  for (const m of meetings) {
    const rooms = labRooms.get(m.ms_id);
    if (m.src.one_room && m.part === 'lec' && m.roomId != null && rooms && !rooms.has(m.roomId)) m.issues.add('split_rooms');
  }

  /* ── School week and hour slots ────────────────────────────────────────── */
  const days: string[] = PLANNING_WEEK_DAYS.filter((d, i) => i < SCHOOL_WEEK_DAYS || meetings.some(m => m.day === d));
  const hours = Array.from({ length: (SCHOOL_DAY_END_MIN - SCHOOL_DAY_START_MIN) / 60 }, (_, i) => SCHOOL_DAY_START_MIN / 60 + i);
  const weekMinutes = days.length * SCHOOL_DAY_CLASS_MIN;

  const grid = {} as Record<RoomPool | 'all', PlanningCell[][]>;
  for (const p of ROOM_POOLS) grid[p] = days.map(() => hours.map(() => emptyCell(usable[p])));
  grid.all = days.map(() => hours.map(() => ({ ...emptyCell(usableAll), by_pool: { lecture: 0, laboratory: 0, pathfit: 0 } })));
  /** The moment (minutes) each hour slot's numbers describe — for the room lists */
  const cellAt = {} as Record<RoomPool | 'all', ({ from: number; to: number } | null)[][]>;
  for (const k of [...ROOM_POOLS, 'all'] as const) cellAt[k] = days.map(() => hours.map(() => null));

  type Peak = { n: number; day: string; from: number; to: number; ids: string };
  const poolPeak: Record<RoomPool, Peak | null> = { lecture: null, laboratory: null, pathfit: null };
  let peakAll: Peak | null = null;
  let shortAll: Peak | null = null;
  const dayMinutes: Record<RoomPool, Map<string, number>> = { lecture: new Map(), laboratory: new Map(), pathfit: new Map() };

  /** Keeps the longest run of the same busiest set (the existing Classroom Demand rule) */
  const better = (cur: Peak | null, cand: Peak, prevTo: number | null) => {
    if (!cur || cand.n > cur.n) return cand;
    if (cand.n === cur.n && cur.day === cand.day && cur.to === prevTo && cur.ids === cand.ids) return { ...cur, to: cand.to };
    return cur;
  };

  for (let di = 0; di < PLANNING_WEEK_DAYS.length; di++) {
    const day = PLANNING_WEEK_DAYS[di];
    const list = meetings.filter(m => m.day === day);
    if (list.length === 0) continue;
    const gi = days.indexOf(day);
    for (const m of list) {
      const map = dayMinutes[m.pool];
      map.set(day, (map.get(day) ?? 0) + (m.e - m.s));
    }
    const cuts = [...new Set([...list.flatMap(m => [m.s, m.e]), ...hours.map(h => h * 60), SCHOOL_DAY_END_MIN])].sort((a, b) => a - b);
    let lastTo: number | null = null;
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      const running = list.filter(m => m.s <= from && m.e >= to);
      const need: Record<RoomPool, Meeting[]> = { lecture: [], laboratory: [], pathfit: [] };
      const inUse: Record<RoomPool, Set<number>> = { lecture: new Set(), laboratory: new Set(), pathfit: new Set() };
      for (const m of running) {
        need[m.pool].push(m);
        if (m.roomId != null && m.roomPool != null) inUse[m.roomPool].add(m.roomId);
      }
      let totalNeed = 0;
      let totalShort = 0;
      let totalInUse = 0;
      for (const p of ROOM_POOLS) {
        const n = need[p].length;
        totalNeed += n;
        totalShort += Math.max(0, n - usable[p]);
        totalInUse += inUse[p].size;
        if (n > 0) {
          const ids = need[p].map(m => m.id).sort((a, b) => a - b).join(',');
          poolPeak[p] = better(poolPeak[p], { n, day, from, to, ids }, lastTo);
        }
      }
      if (running.length > 0) {
        const ids = running.map(m => m.id).sort((a, b) => a - b).join(',');
        peakAll = better(peakAll, { n: totalNeed, day, from, to, ids }, lastTo);
        if (totalShort > 0) shortAll = better(shortAll, { n: totalShort, day, from, to, ids }, lastTo);
      }
      lastTo = to;

      // Hour slot: the busiest moment inside it
      if (gi < 0 || from < SCHOOL_DAY_START_MIN || from >= SCHOOL_DAY_END_MIN) continue;
      const hi = Math.floor(from / 60) - SCHOOL_DAY_START_MIN / 60;
      for (const p of ROOM_POOLS) {
        const cell = grid[p][gi][hi];
        const n = need[p].length;
        if (n > cell.needed || (n === cell.needed && inUse[p].size > cell.in_use)) {
          grid[p][gi][hi] = { needed: n, in_use: inUse[p].size, usable: usable[p], short: Math.max(0, n - usable[p]) };
          cellAt[p][gi][hi] = { from, to };
        }
      }
      const all = grid.all[gi][hi];
      if (totalShort > all.short || (totalShort === all.short && (totalNeed > all.needed || (totalNeed === all.needed && totalInUse > all.in_use)))) {
        grid.all[gi][hi] = {
          needed: totalNeed, in_use: totalInUse, usable: usableAll, short: totalShort,
          by_pool: { lecture: inUse.lecture.size, laboratory: inUse.laboratory.size, pathfit: inUse.pathfit.size },
        };
        cellAt.all[gi][hi] = { from, to };
      }
    }
  }
  const windowOf = (p: Peak | null): PlanningWindow | null => (p ? { day: p.day, start: toHm(p.from), end: toHm(p.to) } : null);

  /* ── Projection: class parts not scheduled yet ─────────────────────────── */
  const pendingMinutes: Record<RoomPool, number> = { lecture: 0, laboratory: 0, pathfit: 0 };
  const pendingClasses: Record<RoomPool, Set<number>> = { lecture: new Set(), laboratory: new Set(), pathfit: new Set() };
  const pendingAll = new Set<number>();
  const pendingNoFaculty = new Set<number>();
  for (const c of input.pending ?? []) {
    const minutes = Math.max(0, Number(c.minutes) || 0);
    if (minutes <= 0) continue;
    const pool = allowedPools({ part: c.part, subject_code: c.subject_code, has_lab: c.has_lab, one_room: c.one_room })[0];
    pendingMinutes[pool] += minutes;
    pendingClasses[pool].add(c.ms_id);
    pendingAll.add(c.ms_id);
    if (!c.has_faculty) pendingNoFaculty.add(c.ms_id);
  }

  /* ── Each kind of room ─────────────────────────────────────────────────── */
  const pools = {} as Record<RoomPool, PoolPlan>;
  for (const p of ROOM_POOLS) {
    const mine = meetings.filter(m => m.pool === p);
    let hoursDay: string | null = null;
    let hoursDayMinutes = 0;
    for (const d of PLANNING_WEEK_DAYS) {
      const min = dayMinutes[p].get(d) ?? 0;
      if (min > hoursDayMinutes) { hoursDay = d; hoursDayMinutes = min; }
    }
    const roomsByHours = Math.ceil(hoursDayMinutes / SCHOOL_DAY_CLASS_MIN);
    const peak = poolPeak[p]?.n ?? 0;
    const required = Math.max(peak, roomsByHours);
    const additional = Math.max(0, required - usable[p]);
    let booked = 0;
    let overflow = 0; // class time outside the school day — it has to move into it
    for (const m of mine) {
      if (!days.includes(m.day)) continue;
      const inside = classHoursMinutes(m.s, m.e);
      booked += inside;
      overflow += m.e - m.s - inside;
    }
    const free = Math.max(0, usable[p] * weekMinutes - booked);
    const need = pendingMinutes[p] + overflow;
    const byHours = weekMinutes > 0 ? Math.ceil(Math.max(0, need - free) / weekMinutes) : 0;
    const cells = grid[p].flat();
    pools[p] = {
      pool: p,
      usable: usable[p],
      meetings: mine.length,
      peak,
      peak_at: windowOf(poolPeak[p]),
      rooms_by_hours: roomsByHours,
      hours_day: hoursDay,
      hours_day_minutes: hoursDayMinutes,
      required,
      max_short: Math.max(0, peak - usable[p]),
      additional,
      full_slots: cells.filter(c => c.needed > 0 && c.needed === c.usable).length,
      short_slots: cells.filter(c => c.short > 0).length,
      booked_minutes: booked,
      free_minutes: free,
      projected: { classes: pendingClasses[p].size, minutes: pendingMinutes[p], additional: Math.max(additional, byHours) },
    };
  }

  /* ── Classes and faculty that need attention ───────────────────────────── */
  const classMap = new Map<string, PlanningClass>();
  for (const m of meetings) {
    if (m.issues.size === 0) continue;
    const key = classKey(m);
    const src = m.src;
    const c = classMap.get(key) ?? {
      key, ms_id: m.ms_id, part: m.part, subject_code: src.subject_code, subject_name: src.subject_name,
      block: src.block, faculty_id: src.faculty_id, faculty_name: src.faculty_name,
      pool: allowedPools({ part: m.part, subject_code: src.subject_code, has_lab: src.has_lab, one_room: src.one_room })[0],
      issues: [], meetings: [],
    };
    for (const issue of m.issues) if (!c.issues.includes(issue)) c.issues.push(issue);
    c.meetings.push({
      id: m.id, day: m.day, start: toHm(m.s), end: toHm(m.e), room_name: m.room?.room_name ?? null, issues: [...m.issues].sort(byIssueOrder),
    });
    classMap.set(key, c);
  }
  const dayIndex = (d: string) => PLANNING_WEEK_DAYS.indexOf(d as (typeof PLANNING_WEEK_DAYS)[number]);
  const issues = [...classMap.values()]
    .map(c => ({
      ...c,
      issues: c.issues.sort(byIssueOrder),
      meetings: c.meetings.sort((a, b) => dayIndex(a.day) - dayIndex(b.day) || a.start.localeCompare(b.start)),
    }))
    .sort((a, b) => Number(!a.issues.some(isRoomProblem)) - Number(!b.issues.some(isRoomProblem))
      || byIssueOrder(a.issues[0], b.issues[0])
      || (a.faculty_name ?? '').localeCompare(b.faculty_name ?? '')
      || (a.subject_code ?? '').localeCompare(b.subject_code ?? ''));

  const facultyMap = new Map<string, { faculty_id: number | null; name: string; classes: number; issues: RoomIssue[] }>();
  for (const c of issues) {
    const key = c.faculty_id != null ? `id:${c.faculty_id}` : `name:${c.faculty_name ?? ''}`;
    const f = facultyMap.get(key) ?? { faculty_id: c.faculty_id, name: c.faculty_name || 'No faculty yet', classes: 0, issues: [] };
    f.classes++;
    for (const issue of c.issues) if (!f.issues.includes(issue)) f.issues.push(issue);
    facultyMap.set(key, f);
  }
  const affected = [...facultyMap.values()]
    .map(f => ({ ...f, issues: f.issues.sort(byIssueOrder) }))
    .sort((a, b) => b.classes - a.classes || a.name.localeCompare(b.name));

  /* ── The busiest hour slots, all rooms ─────────────────────────────────── */
  const slots: RoomPlanning['busiest'] = [];
  days.forEach((day, gi) => hours.forEach((hour, hi) => {
    const c = grid.all[gi][hi];
    if (c.needed > 0) slots.push({ day, hour, needed: c.needed, usable: c.usable, short: c.short });
  }));
  slots.sort((a, b) => b.short - a.short || b.needed - a.needed || dayIndex(a.day) - dayIndex(b.day) || a.hour - b.hour);

  /* ── The rooms behind the busiest-time numbers: in use (with their class) and free ── */
  const byName = (a: { room_name: string }, b: { room_name: string }) => a.room_name.localeCompare(b.room_name, undefined, { numeric: true });
  const peakView = { days, hours, grid, pools, totals: { peak_at: windowOf(peakAll) } };
  const busiestRooms = {} as Record<RoomPool | 'all', BusiestRooms>;
  for (const key of [...ROOM_POOLS, 'all'] as const) {
    const ofKind = (pool: RoomPool) => key === 'all' || pool === key;
    const cell = snapshotCell(peakView, key);
    const moment = cell ? cellAt[key][cell[0]][cell[1]] : null;
    const day = cell ? days[cell[0]] : null;
    const used = new Map<number, BusyRoom>();
    if (moment && day) {
      for (const m of meetings) {
        if (m.day !== day || m.s > moment.from || m.e < moment.to || m.roomId == null || m.roomPool == null || !ofKind(m.roomPool)) continue;
        const r = used.get(m.roomId) ?? { room_id: m.roomId, room_name: m.room?.room_name ?? '', pool: m.roomPool, classes: [] };
        r.classes.push({
          subject_code: m.src.subject_code, block: m.src.block, faculty_name: m.src.faculty_name,
          part: m.part, start: toHm(m.s), end: toHm(m.e),
        });
        used.set(m.roomId, r);
      }
    }
    const free: FreeRoom[] = [];
    for (const r of input.rooms) {
      const pool = roomPoolOf(r);
      if (!r.active || !ofKind(pool) || used.has(r.id)) continue;
      // Free until its next class that day (none: the rest of the day)
      let next: number | null = null;
      if (moment && day) {
        for (const m of meetings) if (m.day === day && m.roomId === r.id && m.s >= moment.to && (next == null || m.s < next)) next = m.s;
      }
      free.push({ room_id: r.id, room_name: r.room_name, pool, until: next == null ? null : toHm(next) });
    }
    busiestRooms[key] = {
      at: moment && day ? { day, start: toHm(moment.from), end: toHm(moment.to) } : null,
      in_use: [...used.values()].sort(byName),
      free: free.sort(byName),
    };
  }

  const classKeys = new Set(meetings.map(classKey));
  return {
    days,
    hours,
    week_minutes: weekMinutes,
    pools,
    grid,
    totals: {
      usable: usableAll,
      peak: peakAll?.n ?? 0,
      peak_at: windowOf(peakAll),
      max_short: shortAll?.n ?? 0,
      max_short_at: windowOf(shortAll),
      meetings: meetings.length,
      classes: classKeys.size,
      without_room: issues.filter(c => c.issues.some(isRoomProblem)).length,
      after_hours: issues.filter(c => c.issues.includes('after_hours')).length,
      faculty_affected: affected.length,
      additional: ROOM_POOLS.reduce((n, p) => n + pools[p].additional, 0),
      projected_additional: ROOM_POOLS.reduce((n, p) => n + pools[p].projected.additional, 0),
      pending_classes: pendingAll.size,
      pending_without_faculty: pendingNoFaculty.size,
      invalid,
    },
    busiest: slots.slice(0, 3),
    issues,
    affected_faculty: affected,
    meetings: meetings
      .slice()
      .sort((a, b) => dayIndex(a.day) - dayIndex(b.day) || a.s - b.s || a.id - b.id)
      .map(m => ({
        id: m.id, part: m.part, day: m.day, start: toHm(m.s), end: toHm(m.e), pool: m.pool,
        room_name: m.room?.room_name ?? null, subject_code: m.src.subject_code, block: m.src.block,
        faculty_name: m.src.faculty_name, issues: [...m.issues].sort(byIssueOrder),
      })),
    busiest_rooms: busiestRooms,
  };
}
