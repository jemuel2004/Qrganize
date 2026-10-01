/**
 * Permanent faculty Regular Load cap (workload units).
 *
 * Rule:
 *   totalUnits <= REGULAR_LOAD_MAX_UNITS  → Regular Load (complete when equal)
 *   totalUnits >  REGULAR_LOAD_MAX_UNITS  → Exceeded Regular Load
 *
 * Example: 18.00 and 18.25 are Regular; 18.50+ is Exceeded.
 * Lecture/Lab formulas are unchanged — only this threshold.
 */
export const REGULAR_LOAD_MAX_UNITS = 18.25;

/** Permanent faculty Overload cap per term (workload units). */
export const OVERLOAD_MAX_UNITS = 6.25;

/** Contractual faculty regular contact-hours cap (unchanged). */
export const CONTRACTUAL_REGULAR_HOURS_LIMIT = 30;

/*
 * Display rule: the caps above carry a 0.25 grace (18.25 still counts as Regular,
 * 6.25 as Overload), but people only ever see the published 18 / 6. Rules and
 * maths always use the exact caps — these helpers are for what is shown.
 * Contractual hours have no grace; don't pass hours through them.
 */
export const LOAD_GRACE_UNITS = 0.25;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A Permanent units cap as shown — without the grace (18.25 → 18, 15.25 → 15, 6.25 → 6). */
export function shownUnitsCap(cap: number): number {
  return Math.max(0, round2((Number(cap) || 0) - LOAD_GRACE_UNITS));
}

/** Units still open, as shown — the grace isn't offered as room (18.25 → 18, 0.25 → 0). */
export function shownUnitsLeft(left: number): number {
  return Math.max(0, round2((Number(left) || 0) - LOAD_GRACE_UNITS));
}

/** How far a total is past a cap, as shown: 0 until the exact cap is really passed
 *  (18.25 is not over), then measured from the shown cap (20.25 → 2.25 over 18). */
export function shownUnitsOver(total: number, cap: number): number {
  return total > cap + 0.001 ? round2(total - shownUnitsCap(cap)) : 0;
}

/** A cap for display: "18" when whole, otherwise "16.50". */
export function formatLoadCap(n: number): string {
  return Number.isInteger(round2(n)) ? String(round2(n)) : n.toFixed(2);
}

/** Available Permanent teaching slot = base max − semester deductions. */
export function permanentRegularLoadLimit(deductionUnits: number): number {
  const d = Number(deductionUnits);
  return REGULAR_LOAD_MAX_UNITS - (Number.isFinite(d) ? d : 0);
}

/** Regular load is complete once it reaches the shown cap: 18 counts for Permanent
 *  (18.25 is the grace on top). Contractual hours must reach the exact cap. */
export function isRegularLoadComplete(remaining: number, permanent: boolean): boolean {
  return remaining <= (permanent ? LOAD_GRACE_UNITS : 0) + 0.001;
}

export function computeRegularLoadStatus(currentLoad: number, limit: number, permanent = false): string {
  // Exceeded only when load is strictly greater than the limit.
  // 18.25 on an 18.25 limit is complete/regular, not exceeded.
  if (currentLoad > limit) return 'Regular load exceeded';
  if (isRegularLoadComplete(limit - currentLoad, permanent)) return 'Regular load complete';
  return 'Has remaining load';
}
