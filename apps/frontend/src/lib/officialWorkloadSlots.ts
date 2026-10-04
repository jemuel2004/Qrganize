/**
 * Official Instructor Workload Form timetable.
 * Fixed day/time rows match the printed school workload document. When the
 * semester has configured day combinations (Settings → Day Combinations) the
 * groups follow those combinations instead — see buildOfficialGroups().
 */

import { daysCode, daysKey, parseDays, type WeekDay } from '@shared/dayCombination';

export type OfficialDayGroup = 'mth' | 'tf' | 'wed' | 'other';

export interface OfficialSlot {
  id: string;
  timeLabel: string;
  startMin: number;
  endMin: number;
}

export interface OfficialGroup {
  id: string;
  label: string;
  /** Legacy day group, or the combination's code for configured groups */
  dayGroup: string;
  /** Canonical days of the group ("Mon/Thu") — used for exact matching */
  dayKey?: string;
  slots: OfficialSlot[];
}

/**
 * 12-hour clock with AM/PM from minutes-since-midnight.
 * Derived from the actual time value — not from Morning/Afternoon section labels.
 */
export function formatOfficialClock(mins: number): string {
  const day = 24 * 60;
  const normalized = ((Math.floor(mins) % day) + day) % day;
  const h24 = Math.floor(normalized / 60);
  const m = normalized % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** e.g. 780–960 → "1:00 PM–4:00 PM" */
export function formatOfficialMinutesRange(startMin: number, endMin: number): string {
  return `${formatOfficialClock(startMin)}–${formatOfficialClock(endMin)}`;
}

function makeSlot(groupId: string, startMin: number, endMin: number): OfficialSlot {
  return {
    id: `${groupId}::${startMin}-${endMin}`,
    timeLabel: formatOfficialMinutesRange(startMin, endMin),
    startMin,
    endMin,
  };
}

export const OFFICIAL_GROUPS: OfficialGroup[] = [
  {
    id: 'mth-am',
    label: 'MTh/Morning',
    dayGroup: 'mth',
    slots: [
      makeSlot('mth-am', 7 * 60, 10 * 60),
      makeSlot('mth-am', 7 * 60, 8 * 60),
      makeSlot('mth-am', 8 * 60 + 30, 10 * 60),
      makeSlot('mth-am', 10 * 60, 11 * 60 + 30),
    ],
  },
  {
    id: 'mth-pm',
    label: 'MTh/Afternoon',
    dayGroup: 'mth',
    slots: [
      makeSlot('mth-pm', 13 * 60, 14 * 60),
      makeSlot('mth-pm', 14 * 60, 15 * 60 + 30),
      makeSlot('mth-pm', 14 * 60 + 30, 16 * 60),
      makeSlot('mth-pm', 16 * 60, 17 * 60 + 30),
    ],
  },
  {
    id: 'tf-am',
    label: 'TF/Morning',
    dayGroup: 'tf',
    slots: [
      makeSlot('tf-am', 7 * 60, 10 * 60),
      makeSlot('tf-am', 8 * 60 + 30, 10 * 60),
      makeSlot('tf-am', 10 * 60, 11 * 60 + 30),
    ],
  },
  {
    id: 'tf-pm',
    label: 'TF/Afternoon',
    dayGroup: 'tf',
    slots: [
      makeSlot('tf-pm', 13 * 60, 14 * 60 + 30),
      makeSlot('tf-pm', 14 * 60 + 30, 16 * 60),
      makeSlot('tf-pm', 16 * 60, 17 * 60 + 30),
    ],
  },
  {
    id: 'wed-am',
    label: 'Wed/Morning',
    dayGroup: 'wed',
    slots: [
      makeSlot('wed-am', 8 * 60, 12 * 60),
    ],
  },
  {
    id: 'wed-pm',
    label: 'Wed/Afternoon',
    dayGroup: 'wed',
    slots: [
      makeSlot('wed-pm', 13 * 60, 17 * 60),
    ],
  },
];

/** Legacy groups keyed by their days, reused when a configured combination is the same set */
const LEGACY_BY_DAYS: Record<string, OfficialGroup[]> = {
  'Mon/Thu': OFFICIAL_GROUPS.filter(g => g.dayGroup === 'mth'),
  'Tue/Fri': OFFICIAL_GROUPS.filter(g => g.dayGroup === 'tf'),
  'Wed':     OFFICIAL_GROUPS.filter(g => g.dayGroup === 'wed'),
};

/** Template rows of a configured combination's Morning / Afternoon sections */
const GENERIC_AM: [number, number][] = [
  [7 * 60, 8 * 60], [8 * 60, 9 * 60 + 30], [9 * 60 + 30, 10 * 60 + 30], [10 * 60 + 30, 11 * 60 + 30],
];
const GENERIC_PM: [number, number][] = [
  [13 * 60, 14 * 60], [14 * 60, 15 * 60], [15 * 60, 16 * 60], [16 * 60, 17 * 60], [17 * 60, 18 * 60],
];

/**
 * The form's groups for a semester. No active configured combinations →
 * the fixed OFFICIAL_GROUPS (unchanged form). Otherwise one Morning and one
 * Afternoon group per active combination, in the configured order, labelled
 * with its code ("MWF/Morning"); MTh / TF / Wed keep their official rows.
 */
export function buildOfficialGroups(
  combos: readonly { days: readonly WeekDay[]; is_active?: boolean }[] | null | undefined,
  /**
   * Day patterns of the classes shown on the form. A class scheduled on days
   * that aren't a configured combination (e.g. Mon/Thu, set before the term's
   * combinations changed) still gets its own section instead of falling into
   * "Needs Classification" — it is already assigned and scheduled.
   */
  classDayPatterns: readonly (string | null | undefined)[] = [],
): OfficialGroup[] {
  const active = (combos ?? []).filter(c => c.is_active !== false && c.days.length > 0);
  if (active.length === 0) return OFFICIAL_GROUPS;
  const groups: OfficialGroup[] = [];
  const seen = new Set<string>();
  const addDays = (days: readonly WeekDay[]) => {
    const key = daysKey(days);
    if (seen.has(key)) return;
    seen.add(key);
    const legacy = LEGACY_BY_DAYS[key];
    if (legacy) {
      groups.push(...legacy.map(g => ({ ...g, dayKey: key })));
      return;
    }
    const code = daysCode(days);
    const id = code.toLowerCase();
    groups.push(
      { id: `${id}-am`, label: `${code}/Morning`, dayGroup: code, dayKey: key, slots: GENERIC_AM.map(([s, e]) => makeSlot(`${id}-am`, s, e)) },
      { id: `${id}-pm`, label: `${code}/Afternoon`, dayGroup: code, dayKey: key, slots: GENERIC_PM.map(([s, e]) => makeSlot(`${id}-pm`, s, e)) },
    );
  };
  for (const c of active) addDays(c.days);
  for (const pattern of classDayPatterns) {
    const days = parseDays(pattern);
    if (days && days.length > 0) addDays(days);
  }
  return groups;
}

/**
 * Every day pattern the form's rows sit on. Each Lecture / Laboratory row is
 * placed by its own days, and by the class's day_pattern only when it has none
 * — so the same rule picks the sections. The class's day_pattern can hold both
 * parts' days together (Lec Mon/Thu + Lab Tue/Fri → "Mon/Tue/Thu/Fri", as the
 * workload import saves it); no row is on that set, so it gets no section.
 */
export function loadDayPatterns(
  loads: readonly {
    day_pattern?: string | null; lec_day_pattern?: string | null; lab_day_pattern?: string | null;
    lecture_hours?: number | string | null; laboratory_hours?: number | string | null;
  }[] | null | undefined,
): string[] {
  const out = new Set<string>();
  for (const l of loads ?? []) {
    const lec = parseFloat(String(l.lecture_hours)) || 0;
    const lab = parseFloat(String(l.laboratory_hours)) || 0;
    // The parts that get rows, as on the form: both for a Lec + Lab subject, else its one part
    const parts: ('lec' | 'lab')[] = lec > 0 && lab > 0 ? ['lec', 'lab'] : [lec > 0 ? 'lec' : 'lab'];
    for (const part of parts) {
      const p = (part === 'lec' ? l.lec_day_pattern : l.lab_day_pattern) ?? l.day_pattern;
      if (p) out.add(p);
    }
  }
  return [...out];
}

function normalizeDayToken(tok: string): string {
  const t = tok.toLowerCase().replace(/\./g, '');
  if (['m', 'mon', 'monday'].includes(t)) return 'mon';
  if (['t', 'tue', 'tues', 'tuesday'].includes(t)) return 'tue';
  if (['w', 'wed', 'weds', 'wednesday'].includes(t)) return 'wed';
  if (['th', 'thu', 'thur', 'thurs', 'thursday'].includes(t)) return 'thu';
  if (['f', 'fri', 'friday'].includes(t)) return 'fri';
  if (['s', 'sat', 'saturday'].includes(t)) return 'sat';
  if (['su', 'sun', 'sunday'].includes(t)) return 'sun';
  return t;
}

export function classifyOfficialDayGroup(dayPattern: string | null | undefined): OfficialDayGroup {
  if (!dayPattern) return 'other';
  const raw = dayPattern.toLowerCase().replace(/\s+/g, '');
  if (!raw || raw === 'tba' || raw === 'unscheduled') return 'other';
  if (raw === 'sat' || raw === 'saturday' || raw.startsWith('sat')) return 'other';
  if (raw === 'w' || raw === 'wed' || raw === 'wednesday' || raw === 'weds') return 'wed';
  if (
    raw === 'tf' || raw === 't/f' ||
    raw === 'tth' || raw === 't/th' ||
    raw === 'fri' || raw === 'friday' || raw === 'f' ||
    /^t(ue|ues)?\/?f(ri)?$/.test(raw) ||
    /^t(ue|ues)?\/?th(u|ur|urs)?$/.test(raw)
  ) return 'tf';
  if (
    raw === 'mth' || raw === 'm/th' || raw === 'mt' || raw === 'm/t' ||
    raw === 'mw' || raw === 'm/w' || raw === 'mwf' || raw === 'm/w/f'
  ) return 'mth';

  const tokens = raw.split(/[/,+&-]+/).filter(Boolean).map(normalizeDayToken);
  const set = new Set(tokens);
  if (set.has('sat') && !set.has('mon') && !set.has('tue') && !set.has('wed') && !set.has('thu') && !set.has('fri')) {
    return 'other';
  }
  if (set.size === 1 && set.has('wed')) return 'wed';
  if (set.has('tue') && set.has('fri')) return 'tf';
  if (set.has('tue') && set.has('thu')) return 'tf';
  if (set.has('fri') && !set.has('mon') && !set.has('wed') && !set.has('thu')) return 'tf';
  if (set.has('mon') || set.has('thu')) return 'mth';
  if (set.has('wed')) return 'mth';
  return 'other';
}

export function parseTimeMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const parts = t.trim().split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1] || '0', 10);
  if (Number.isNaN(h)) return null;
  return h * 60 + (Number.isNaN(m) ? 0 : m);
}

function withAfternoonGuess(startMin: number, endMin: number | null): { start: number; end: number | null } {
  if (startMin >= 60 && startMin < 7 * 60) {
    return {
      start: startMin + 12 * 60,
      end: endMin != null && endMin < 7 * 60 ? endMin + 12 * 60 : endMin,
    };
  }
  return { start: startMin, end: endMin };
}

function pickSlot(slots: OfficialSlot[], startMin: number, endMin: number | null): OfficialSlot | null {
  if (endMin != null) {
    const exact = slots.find(
      s => Math.abs(s.startMin - startMin) <= 2 && Math.abs(s.endMin - endMin) <= 2,
    );
    if (exact) return exact;
  }
  const sameStart = slots.filter(s => Math.abs(s.startMin - startMin) <= 2);
  if (sameStart.length === 1) return sameStart[0];
  if (sameStart.length > 1 && endMin != null) {
    return sameStart.reduce((best, s) =>
      Math.abs(s.endMin - endMin) < Math.abs(best.endMin - endMin) ? s : best,
    );
  }
  if (endMin != null) {
    let best: OfficialSlot | null = null;
    let bestOverlap = 0;
    for (const s of slots) {
      const ov = Math.max(0, Math.min(s.endMin, endMin) - Math.max(s.startMin, startMin));
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = s;
      }
    }
    if (best && bestOverlap >= 20) return best;
  }
  const containing = slots.filter(s => startMin >= s.startMin && startMin < s.endMin);
  if (containing.length === 1) return containing[0];
  if (containing.length > 1) {
    return containing.reduce((a, b) =>
      (b.endMin - b.startMin) < (a.endMin - a.startMin) ? b : a,
    );
  }
  return sameStart[0] ?? null;
}

export function matchOfficialSlot(
  dayPattern: string | null | undefined,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  /** The semester's groups (buildOfficialGroups); defaults to the fixed form */
  groups: OfficialGroup[] = OFFICIAL_GROUPS,
): string | null {
  const startMin = parseTimeMinutes(startTime);
  if (startMin == null) return null;
  const endMin = parseTimeMinutes(endTime);
  let slots: OfficialSlot[];
  if (groups === OFFICIAL_GROUPS) {
    // Fixed form: the long-standing tolerant day-group rules
    const dayGroup = classifyOfficialDayGroup(dayPattern);
    if (dayGroup === 'other') return null;
    slots = OFFICIAL_GROUPS.filter(g => g.dayGroup === dayGroup).flatMap(g => g.slots);
  } else {
    // Configured combinations: the class's exact day set must match a group
    const days = parseDays(dayPattern);
    if (!days) return null;
    const key = daysKey(days);
    slots = groups.filter(g => g.dayKey === key).flatMap(g => g.slots);
    if (slots.length === 0) return null;
  }
  const first = pickSlot(slots, startMin, endMin);
  if (first) return first.id;
  const alt = withAfternoonGuess(startMin, endMin);
  if (alt.start !== startMin) {
    const second = pickSlot(slots, alt.start, alt.end);
    if (second) return second.id;
  }
  return null;
}

export function formatOfficialNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  return Math.abs(n % 1) < 0.001 ? String(Math.round(n)) : n.toFixed(2);
}

/** Summary totals (No. of Units, Total No. of Units): always two decimals — 28.25, 32.00 — as on the official form. */
export function formatOfficialTotal(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

/**
 * Official form TIME/DAY cell — uses saved DB start/end (24h → 12h with AM/PM).
 * Example: 13:00–16:00 → "1:00 PM–4:00 PM"; 11:00–13:00 → "11:00 AM–1:00 PM".
 */
export function formatOfficialTimeRange(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): string {
  const startMin = parseTimeMinutes(startTime);
  if (startMin == null) return '';
  const endMin = parseTimeMinutes(endTime);
  if (endMin == null) return formatOfficialClock(startMin);
  return formatOfficialMinutesRange(startMin, endMin);
}

/** Actual occupied schedule interval (minutes from midnight). */
export type OccupiedTimeRange = { startMin: number; endMin: number };

/**
 * Half-open overlap: [aStart, aEnd) vs [bStart, bEnd).
 * Touching at an endpoint (e.g. class ends 4:00, next slot starts 4:00) is NOT overlap.
 */
export function officialRangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** True when an empty template slot lies inside any occupied schedule range. */
export function isEmptySlotCoveredByOccupied(
  slot: OfficialSlot,
  occupied: OccupiedTimeRange[],
): boolean {
  if (occupied.length === 0) return false;
  return occupied.some(r =>
    officialRangesOverlap(slot.startMin, slot.endMin, r.startMin, r.endMin),
  );
}

/**
 * Build occupied ranges from saved schedule times (DB source of truth).
 * Applies the same afternoon 12h guess used by slot matching when needed.
 */
export function occupiedRangeFromScheduleTimes(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): OccupiedTimeRange | null {
  let startMin = parseTimeMinutes(startTime);
  if (startMin == null) return null;
  let endMin = parseTimeMinutes(endTime);
  const alt = withAfternoonGuess(startMin, endMin);
  startMin = alt.start;
  endMin = alt.end;
  if (endMin == null || endMin <= startMin) return null;
  return { startMin, endMin };
}
