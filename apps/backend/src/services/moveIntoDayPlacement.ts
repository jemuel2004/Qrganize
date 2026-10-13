import { DAY_COMBINATION_PRESETS, daysKey, sortDays, type WeekDay } from '@shared/dayCombination';
import { LUNCH_END_MIN, LUNCH_START_MIN, SCHOOL_DAY_END_MIN, SCHOOL_DAY_START_MIN } from '@shared/schoolDay';

/**
 * Where a class part can go inside the school day — the pure part of "Move into
 * the school day" (services/moveIntoDay.ts), kept free of the database so it
 * can be tested on its own.
 */

export type BusyKind = 'fac' | 'blk' | 'room';
export const WORK_DAYS: WeekDay[] = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const STEP_MIN = 30;

/** A meeting's span: an end at/after midnight counts into the next day */
export const span = (start: number, end: number) => ({ start, end: end > start ? end : end + 1440 });
/** Inside 7:00 AM–6:00 PM and clear of the lunch hour */
export const insideSchoolDay = (start: number, end: number) => {
  const s = span(start, end);
  return s.start >= SCHOOL_DAY_START_MIN && s.end <= SCHOOL_DAY_END_MIN && !(s.start < LUNCH_END_MIN && s.end > LUNCH_START_MIN);
};

/** Day sets of the same size to try, best first: the term's quick picks, then common Mon–Fri sets */
function daySetsOfSize(n: number, combos: WeekDay[][]): WeekDay[][] {
  const seen = new Set<string>();
  const out: WeekDay[][] = [];
  const pairs: WeekDay[][] = [['Monday', 'Wednesday'], ['Tuesday', 'Thursday'], ['Wednesday', 'Friday'], ['Monday', 'Friday'], ['Monday', 'Tuesday'], ['Thursday', 'Friday']];
  const singles: WeekDay[][] = WORK_DAYS.map(d => [d]);
  for (const set of [...combos, ...DAY_COMBINATION_PRESETS, ...(n === 1 ? singles : n === 2 ? pairs : [])]) {
    const days = sortDays(set.filter(d => WORK_DAYS.includes(d)));
    if (days.length !== n) continue;
    const key = daysKey(days);
    if (seen.has(key)) continue;
    seen.add(key); out.push(days);
  }
  return out;
}

export interface PlacementInput {
  /** The part's meetings in day order: the day it is on now, its length and where it starts now (minutes) */
  meetings: { day: WeekDay; minutes: number; start?: number }[];
  /** Rooms it may use, best first */
  rooms: { id: number; name: string }[];
  /** The days it must keep (a Major Lec + Lab part: its other part's days); null = may move to other days */
  lockedDays: WeekDay[] | null;
  /** The term's day combinations (quick picks) */
  combos: WeekDay[][];
  facultyId: number | null;
  blockId: number;
  /** Is this faculty / block / room taken at that time? */
  busy: (kind: BusyKind, id: number, day: string, start: number, end: number) => boolean;
}

/** Start times inside the school day for a meeting this long, the latest first */
function starts(minutes: number): number[] {
  const out: number[] = [];
  const last = SCHOOL_DAY_START_MIN + Math.floor((SCHOOL_DAY_END_MIN - minutes - SCHOOL_DAY_START_MIN) / STEP_MIN) * STEP_MIN;
  for (let t = last; t >= SCHOOL_DAY_START_MIN; t -= STEP_MIN) if (insideSchoolDay(t, t + minutes)) out.push(t);
  return out;
}

/** A new meeting: its day, minutes from midnight and room */
export interface PlacedMeeting { day: WeekDay; start: number; end: number; roomId: number }

/**
 * Times and one room inside the school day for a class part, or null. Its own
 * days first (or the locked days), then — when allowed — other day sets of the
 * same size; for each day set the rooms in order; the same time on every day
 * first, then a time per day; the free start closest to where it starts now
 * first (the latest when that isn't given).
 */
export function placeInDay(p: PlacementInput): PlacedMeeting[] | null {
  const own = sortDays(p.meetings.map(m => m.day));
  const daySets = p.lockedDays
    ? [p.lockedDays]
    : [own, ...daySetsOfSize(p.meetings.length, p.combos).filter(s => daysKey(s) !== daysKey(own))];
  const freeAt = (roomId: number, day: string, start: number, end: number) =>
    (p.facultyId == null || !p.busy('fac', p.facultyId, day, start, end))
    && !p.busy('blk', p.blockId, day, start, end) && !p.busy('room', roomId, day, start, end);
  const lengths = p.meetings.map(m => m.minutes);
  // Closest to where each meeting starts now (ties: the later one); the latest first when that isn't given
  const nearest = (list: number[], at: (number | undefined)[]) => {
    const given = at.filter((a): a is number => a != null);
    if (given.length === 0) return list;
    const far = (t: number) => given.reduce((sum, a) => sum + Math.abs(t - a), 0);
    return [...list].sort((a, b) => far(a) - far(b) || b - a);
  };
  const common = nearest(starts(Math.max(...lengths)), p.meetings.map(m => m.start));
  const eachDay = p.meetings.map((m, i) => nearest(starts(lengths[i]), [m.start]));
  for (const days of daySets) {
    if (days.length !== p.meetings.length) continue;
    for (const room of p.rooms) {
      // The same time on every day
      for (const t of common) {
        if (days.every((d, i) => freeAt(room.id, d, t, t + lengths[i]))) {
          return days.map((d, i) => ({ day: d, start: t, end: t + lengths[i], roomId: room.id }));
        }
      }
      // Otherwise a time on each day
      const perDay = days.map((d, i) => eachDay[i].find(t => freeAt(room.id, d, t, t + lengths[i])) ?? null);
      if (perDay.every(t => t !== null)) {
        return days.map((d, i) => ({ day: d, start: perDay[i] as number, end: (perDay[i] as number) + lengths[i], roomId: room.id }));
      }
    }
  }
  return null;
}

export interface ClassPlacementInput {
  /** The Lecture's meetings, one per day, in day order: the day it is on now and its length */
  lec: { day: WeekDay; minutes: number }[];
  /** The Laboratory's meetings, the same way (as many as the Lecture's) */
  lab: { day: WeekDay; minutes: number }[];
  /** Laboratories it may use, best first */
  rooms: { id: number; name: string }[];
  /** The term's day combinations (quick picks) */
  combos: WeekDay[][];
  /** Where the Lecture and the Laboratory start now (first meeting, minutes) — the closest new times are taken first */
  near: { lec: number; lab: number };
  facultyId: number | null;
  blockId: number;
  /** Is this faculty / block / room taken at that time? */
  busy: (kind: BusyKind, id: number, day: string, start: number, end: number) => boolean;
}

/** Lecture and Laboratory start times that don't overlap, best first */
function pairsFor(lec: number, lab: number, near: { lec: number; lab: number }) {
  const out: { lec: number; lab: number; gap: number; far: number; order: number }[] = [];
  for (const a of starts(lec)) {
    for (const b of starts(lab)) {
      if (a < b + lab && b < a + lec) continue;
      out.push({
        lec: a, lab: b,
        gap: a < b ? b - (a + lec) : a - (b + lab),
        far: Math.abs(a - near.lec) + Math.abs(b - near.lab),
        order: (a < b) === (near.lec <= near.lab) ? 0 : 1,
      });
    }
  }
  // Closest to where they are now (for a late class: the latest) and close together — minutes away plus minutes
  // apart, so back to back wins unless it means a big jump — then the old order, then the later time
  return out.sort((x, y) => (x.far + x.gap) - (y.far + y.gap) || x.order - y.order || y.lab - x.lab);
}

/**
 * Both parts of a Major Lec + Lab class in one laboratory on the same days —
 * for a class whose late part can't move on its own. Its own days first, then
 * other day sets of the same size; for each day set the same times on every
 * day first, then times per day — the best times over all the rooms (closest
 * to where it is now, the parts close together), the room order breaking ties. Every
 * meeting keeps its length; the two parts never overlap. Null when nothing fits.
 */
export function placeClassInDay(p: ClassPlacementInput): { lec: PlacedMeeting[]; lab: PlacedMeeting[] } | null {
  const n = p.lec.length;
  if (n === 0 || p.lab.length !== n) return null;
  const own = sortDays(p.lec.map(m => m.day));
  if (own.length !== n) return null; // one meeting a day
  const daySets = [own, ...daySetsOfSize(n, p.combos).filter(s => daysKey(s) !== daysKey(own))];
  const lecLen = p.lec.map(m => m.minutes);
  const labLen = p.lab.map(m => m.minutes);
  const common = pairsFor(Math.max(...lecLen), Math.max(...labLen), p.near);
  const perDay = lecLen.map((len, i) => pairsFor(len, labLen[i], p.near));
  const free = (roomId: number, day: string, start: number, end: number) =>
    (p.facultyId == null || !p.busy('fac', p.facultyId, day, start, end))
    && !p.busy('blk', p.blockId, day, start, end) && !p.busy('room', roomId, day, start, end);
  const fits = (roomId: number, x: { lec: number; lab: number }, d: WeekDay, i: number) =>
    free(roomId, d, x.lec, x.lec + lecLen[i]) && free(roomId, d, x.lab, x.lab + labLen[i]);
  const build = (days: WeekDay[], roomId: number, pick: (i: number) => { lec: number; lab: number }) => ({
    lec: days.map((d, i) => ({ day: d, start: pick(i).lec, end: pick(i).lec + lecLen[i], roomId })),
    lab: days.map((d, i) => ({ day: d, start: pick(i).lab, end: pick(i).lab + labLen[i], roomId })),
  });
  for (const days of daySets) {
    // The same times on every day — the best pair any room has (a lower place in the list is better)
    let same: { roomId: number; rank: number } | null = null;
    for (const room of p.rooms) {
      const rank = common.findIndex(x => days.every((d, i) => fits(room.id, x, d, i)));
      if (rank >= 0 && (!same || rank < same.rank)) same = { roomId: room.id, rank };
    }
    if (same) {
      const x = common[same.rank];
      return build(days, same.roomId, () => x);
    }
    // Otherwise times per day, all in one room
    let each: { roomId: number; ranks: number[]; total: number } | null = null;
    for (const room of p.rooms) {
      const ranks = days.map((d, i) => perDay[i].findIndex(x => fits(room.id, x, d, i)));
      if (ranks.some(r => r < 0)) continue;
      const total = ranks.reduce((a, b) => a + b, 0);
      if (!each || total < each.total) each = { roomId: room.id, ranks, total };
    }
    if (each) {
      const pick = each;
      return build(days, pick.roomId, i => perDay[i][pick.ranks[i]]);
    }
  }
  return null;
}
