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

/** Contractual faculty regular contact-hours cap (unchanged). */
export const CONTRACTUAL_REGULAR_HOURS_LIMIT = 30;

/** Available Permanent teaching slot = base max − semester deductions. */
export function permanentRegularLoadLimit(deductionUnits: number): number {
  const d = Number(deductionUnits);
  return REGULAR_LOAD_MAX_UNITS - (Number.isFinite(d) ? d : 0);
}

export function computeRegularLoadStatus(currentLoad: number, limit: number): string {
  // Exceeded only when load is strictly greater than the limit.
  // 18.25 on an 18.25 limit is complete/regular, not exceeded.
  if (currentLoad > limit) return 'Regular load exceeded';
  if (currentLoad >= limit) return 'Regular load complete';
  return 'Has remaining load';
}
