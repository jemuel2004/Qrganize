/*
 * Day combinations — the common meeting-day sets of a semester (e.g. MWF,
 * TTh, MTh). Quick picks and form sections only, never a limit. One definition
 * shared by the backend, Settings, Scheduling, Class Program and the workload
 * form (print/Excel).
 *
 * A class component's combination is the set of days its sessions meet on
 * (Mon + Thu sessions → "Mon/Thu"). Stored canonically as short day names in
 * week order joined by "/" — the same format as master_schedule.day_pattern.
 */

export const WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

const SHORT: Record<WeekDay, string> = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
};
/** Letter codes as used on school forms: M T W Th F S Su */
const CODE: Record<WeekDay, string> = {
  Monday: 'M', Tuesday: 'T', Wednesday: 'W', Thursday: 'Th', Friday: 'F', Saturday: 'S', Sunday: 'Su',
};

const ALIASES: Record<string, WeekDay> = {};
for (const [day, names] of [
  ['Monday', ['m', 'mon', 'monday']],
  ['Tuesday', ['t', 'tu', 'tue', 'tues', 'tuesday']],
  ['Wednesday', ['w', 'wed', 'weds', 'wednesday']],
  ['Thursday', ['th', 'thu', 'thur', 'thurs', 'thursday']],
  ['Friday', ['f', 'fri', 'friday']],
  ['Saturday', ['s', 'sa', 'sat', 'saturday']],
  ['Sunday', ['su', 'sun', 'sunday']],
] as [WeekDay, string[]][]) for (const n of names) ALIASES[n] = day;

/** "Thu" / "thursday" / "Th" → "Thursday"; unknown → null */
export function normalizeDay(token: string): WeekDay | null {
  return ALIASES[token.trim().toLowerCase().replace(/\./g, '')] ?? null;
}

/** Split a compact code ("MWF", "TThS", "MTWThF") into day names */
function splitCode(code: string): WeekDay[] | null {
  const out: WeekDay[] = [];
  let rest = code.trim();
  while (rest) {
    const two = rest.slice(0, 2).toLowerCase();
    if (two === 'th' || two === 'su') { out.push(two === 'th' ? 'Thursday' : 'Sunday'); rest = rest.slice(2); continue; }
    const d = normalizeDay(rest[0]);
    if (!d) return null;
    out.push(d);
    rest = rest.slice(1);
  }
  return out;
}

/** Days in week order, without duplicates */
export function sortDays(days: Iterable<WeekDay>): WeekDay[] {
  const set = new Set(days);
  return WEEK_DAYS.filter(d => set.has(d));
}

/**
 * Parse a day list or pattern — "Mon/Wed/Fri", "MWF", ["Tuesday", "Thursday"] —
 * into canonical week-ordered days. Returns null when empty or unreadable.
 */
export function parseDays(input: string | readonly string[] | null | undefined): WeekDay[] | null {
  if (input == null) return null;
  const tokens = Array.isArray(input)
    ? (input as readonly string[])
    : String(input).split(/[/,+&\s-]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const days: WeekDay[] = [];
  for (const t of tokens) {
    const d = normalizeDay(t);
    if (d) { days.push(d); continue; }
    const split = splitCode(t);
    if (!split) return null;
    days.push(...split);
  }
  return days.length ? sortDays(days) : null;
}

/** Canonical stored key — "Mon/Wed/Fri" (same style as day_pattern) */
export const daysKey = (days: readonly WeekDay[]) => days.map(d => SHORT[d]).join('/');
/** Form code — "MWF", "TTh", "MTh" */
export const daysCode = (days: readonly WeekDay[]) => days.map(d => CODE[d]).join('');
/** Short label — "Mon / Wed / Fri" */
export const daysLabel = (days: readonly WeekDay[]) => days.map(d => SHORT[d]).join(' / ');
export const shortDay = (d: WeekDay) => SHORT[d];

/** A semester's configured combination */
export interface DayCombination {
  id?: number;
  days: WeekDay[];
  is_active: boolean;
}

/** Common combinations offered as one-click additions in Settings */
export const DAY_COMBINATION_PRESETS: WeekDay[][] = [
  ['Monday', 'Thursday'],
  ['Tuesday', 'Friday'],
  ['Wednesday'],
  ['Saturday'],
  ['Monday', 'Wednesday', 'Friday'],
  ['Tuesday', 'Thursday'],
  ['Monday', 'Wednesday'],
  ['Tuesday', 'Thursday', 'Saturday'],
  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
];

const sameDays = (a: readonly WeekDay[], b: readonly WeekDay[]) =>
  a.length === b.length && a.every((d, i) => d === b[i]);

/** The active combination a set of session days matches, or null */
export function matchCombination<T extends { days: readonly WeekDay[]; is_active?: boolean }>(
  sessionDays: readonly string[], combos: readonly T[],
): T | null {
  const days = parseDays(sessionDays);
  if (!days) return null;
  return combos.find(c => c.is_active !== false && sameDays(c.days, days)) ?? null;
}
