/**
 * Classroom Demand — how many regular (lecture) classrooms the class schedule
 * actually needs.
 *
 * Classrooms are shared, so demand is NOT the number of faculty or classes:
 * it is the most class meetings that need a regular classroom at the same
 * moment (peak simultaneous demand), per school day.
 *
 *  • Lab sessions are lab-room demand, not classroom demand.
 *  • A Lecture placed in an active laboratory room (allowed for subjects that
 *    have a lab) already has a room and does not use a classroom.
 *  • A meeting with no room — or whose room is now inactive — still needs a
 *    classroom, but unassigned meetings only add demand where they overlap.
 *  • Back-to-back meetings (8–9, 9–10) can share one room; times are compared
 *    in minutes as half-open ranges, and an end at/before the start means it
 *    runs past midnight (same rule as schedule conflict checks).
 *
 * Pure logic (no DB) so the rules can be tested and shared with the UI.
 */

export const DEMAND_WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** Laboratory room types (Scheduling also recognises the legacy 'Computer Lab'). */
export const LAB_ROOM_TYPES = ['Laboratory', 'Computer Lab'] as const;
export const isLabRoomType = (t: string | null | undefined) => (LAB_ROOM_TYPES as readonly string[]).includes(t ?? '');

/** One scheduled class meeting (a schedule_sessions row) of the active term. */
export interface DemandSessionInput {
  id: number;
  ms_id: number;
  day: string;
  start_time: string;
  end_time: string;
  /** 'lec' | 'lab' (missing = lec) */
  type: string | null;
  room_id: number | null;
  room_name: string | null;
  room_type: string | null;
  /** Room is usable per Room Management (status Active) */
  room_usable: boolean | null;
  subject_code: string | null;
  subject_name: string | null;
  block: string | null;
  faculty_name: string | null;
}

/** Assigned = in a usable classroom; the other two still need one. */
export type DemandClassStatus = 'Assigned' | 'Unassigned' | 'Inactive room';

export interface DemandClass {
  id: number;
  day: string;
  subject_code: string | null;
  subject_name: string | null;
  block: string | null;
  faculty_name: string | null;
  start: string;
  end: string;
  room_name: string | null;
  room_type: string | null;
  status: DemandClassStatus;
  /** Shares its room with another class at the same time (room conflict) */
  double_booked: boolean;
}

export interface DayDemand {
  day: string;
  /** Most classes needing a classroom at once */
  peak: number;
  /** Busiest window, 'HH:MM' */
  start: string;
  end: string;
  assigned: number;
  unassigned: number;
  /** Classes in the busiest window */
  classes: DemandClass[];
  /** Classes needing a classroom that day */
  total: number;
}

export type DemandVerdict = 'none' | 'shortage' | 'enough' | 'surplus';

export interface ClassroomDemand {
  required: number;
  usable: number;
  additional: number;
  surplus: number;
  /** Class meetings that need a classroom but have none (separate from capacity) */
  unassigned: number;
  /** Class meetings (per week) that need a classroom */
  total_classes: number;
  /** Rows skipped for an invalid day or time */
  invalid: number;
  /** Not classroom demand: lab sessions, and lectures already in a lab room */
  excluded_lab: number;
  lec_in_lab_room: number;
  verdict: DemandVerdict;
  /** Capacity is enough but some classes still have no room */
  assignment_issue: boolean;
  peak: DayDemand | null;
  /** Days with classroom demand, Monday first */
  days: DayDemand[];
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

function toMin(t: string): number | null {
  const m = TIME_RE.exec(String(t).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const toHm = (min: number) => {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

interface Meeting extends DemandClass { room_id: number | null; s: number; e: number }

export function computeClassroomDemand(sessions: DemandSessionInput[], usableClassrooms: number): ClassroomDemand {
  const usable = Math.max(0, Math.floor(usableClassrooms) || 0);
  let invalid = 0;
  let excludedLab = 0;
  let lecInLab = 0;
  const byKey = new Map<string, Meeting>();

  for (const ss of sessions) {
    const type = (ss.type ?? 'lec').toLowerCase();
    if (type === 'lab') { excludedLab++; continue; }
    // A Lecture already in an active lab room doesn't use a classroom
    if (ss.room_id != null && ss.room_usable && isLabRoomType(ss.room_type)) { lecInLab++; continue; }

    const s = toMin(ss.start_time);
    const rawE = toMin(ss.end_time);
    if (!(DEMAND_WEEK_DAYS as readonly string[]).includes(ss.day) || s == null || rawE == null || rawE === s) {
      invalid++;
      continue;
    }
    const e = rawE < s ? rawE + 1440 : rawE;

    const status: DemandClassStatus = ss.room_id == null ? 'Unassigned' : ss.room_usable ? 'Assigned' : 'Inactive room';
    const meeting: Meeting = {
      id: ss.id, day: ss.day, subject_code: ss.subject_code, subject_name: ss.subject_name, block: ss.block,
      faculty_name: ss.faculty_name, start: toHm(s), end: toHm(e),
      room_name: ss.room_name, room_type: ss.room_type, status, double_booked: false,
      room_id: status === 'Assigned' ? ss.room_id : null, s, e,
    };
    // Duplicate rows of the same class meeting count once (keep the one with a room)
    const key = `${ss.ms_id}|${type}|${ss.day}|${s}|${e}`;
    const prev = byKey.get(key);
    if (!prev || (prev.status !== 'Assigned' && status === 'Assigned')) byKey.set(key, meeting);
  }

  const meetings = [...byKey.values()];
  const days: DayDemand[] = [];

  for (const day of DEMAND_WEEK_DAYS) {
    const list = meetings.filter(m => m.day === day);
    if (list.length === 0) continue;

    // Sweep the day's time boundaries; [t_i, t_i+1) segments
    const cuts = [...new Set(list.flatMap(m => [m.s, m.e]))].sort((a, b) => a - b);
    type Window = { from: number; to: number; ids: string; set: Meeting[] };
    let best = null as Window | null;
    let run = null as Window | null;
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      const set = list.filter(m => m.s <= from && m.e >= to);
      const ids = set.map(m => m.id).sort((a, b) => a - b).join(',');
      // Extend the window while exactly the same classes are running
      const cur: Window = run && run.to === from && run.ids === ids ? { ...run, to } : { from, to, ids, set };
      run = cur;
      if (set.length > 0 && (!best || set.length > best.set.length || (best.from === cur.from && best.ids === ids))) best = cur;
    }
    if (!best) continue;

    const roomCount = new Map<number, number>();
    for (const m of best.set) if (m.room_id != null) roomCount.set(m.room_id, (roomCount.get(m.room_id) ?? 0) + 1);
    const classes = best.set
      .map((m): DemandClass => ({
        id: m.id, day: m.day, subject_code: m.subject_code, subject_name: m.subject_name, block: m.block,
        faculty_name: m.faculty_name, start: m.start, end: m.end, room_name: m.room_name, room_type: m.room_type, status: m.status,
        double_booked: m.room_id != null && (roomCount.get(m.room_id) ?? 0) > 1,
      }))
      .sort((a, b) => Number(a.status !== 'Assigned') - Number(b.status !== 'Assigned')
        || (a.room_name ?? '').localeCompare(b.room_name ?? '', undefined, { numeric: true })
        || (a.subject_code ?? '').localeCompare(b.subject_code ?? ''));
    const assigned = classes.filter(c => c.status === 'Assigned').length;
    days.push({
      day, peak: classes.length, start: toHm(best.from), end: toHm(best.to),
      assigned, unassigned: classes.length - assigned, classes, total: list.length,
    });
  }

  // Busiest day; ties go to the earlier day of the week
  const peak = days.reduce<DayDemand | null>((p, d) => (!p || d.peak > p.peak ? d : p), null);
  const required = peak?.peak ?? 0;
  const unassigned = meetings.filter(m => m.status !== 'Assigned').length;
  const verdict: DemandVerdict = required === 0 ? 'none' : required > usable ? 'shortage' : required === usable ? 'enough' : 'surplus';

  return {
    required, usable,
    additional: Math.max(0, required - usable),
    surplus: Math.max(0, usable - required),
    unassigned, total_classes: meetings.length, invalid,
    excluded_lab: excludedLab, lec_in_lab_room: lecInLab, verdict,
    assignment_issue: verdict !== 'shortage' && unassigned > 0,
    peak, days,
  };
}
