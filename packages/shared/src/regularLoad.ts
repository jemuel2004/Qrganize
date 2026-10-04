/**
 * Faculty workload limits.
 *
 * Permanent faculty carry a Regular Load in workload units (lecture hours +
 * 0.75 × laboratory hours) and may add Overload up to a cap per term, and
 * Praise Load. Contractual faculty carry a Regular Load in contact hours —
 * Regular only, never Overload or Praise Load.
 *
 * The limits are department policy, set in Settings → Workload Limits
 * (defaults: 18 units, 6 units, 30 hours). Everything here takes the policy
 * explicitly, so every page and every rule works from the same current values.
 *
 * Grace: a Permanent units cap carries 0.25 unit on top of the published
 * number — 18 lets a load reach 18.25 and still count as Regular, 6 lets
 * Overload reach 6.25. People only ever see the published numbers; rules and
 * maths use the exact caps. Contractual hours have no grace.
 */

export interface WorkloadPolicy {
  /** Permanent Regular Load, as published (units) */
  regularUnits: number;
  /** Permanent Overload allowed per term, as published (units); 0 = no Overload */
  overloadUnits: number;
  /** Contractual Regular Load (contact hours) */
  contractualHours: number;
}

export type WorkloadPolicyField = keyof WorkloadPolicy;

export const DEFAULT_WORKLOAD_POLICY: Readonly<WorkloadPolicy> = Object.freeze({
  regularUnits: 18,
  overloadUnits: 6,
  contractualHours: 30,
});

/** Allowed range of each limit — used by the Settings form and the API. */
export const WORKLOAD_POLICY_LIMITS: Readonly<Record<WorkloadPolicyField, { min: number; max: number; label: string; unit: string }>> = {
  regularUnits:     { min: 1, max: 40, label: 'Regular load (Permanent)',   unit: 'units' },
  overloadUnits:    { min: 0, max: 20, label: 'Overload limit (Permanent)', unit: 'units' },
  contractualHours: { min: 1, max: 60, label: 'Regular load (Contractual)', unit: 'hours' },
};

const POLICY_FIELDS = Object.keys(WORKLOAD_POLICY_LIMITS) as WorkloadPolicyField[];

export const LOAD_GRACE_UNITS = 0.25;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Exact Permanent Regular cap the rules use — published + grace (18 → 18.25). */
export function regularUnitsCap(policy: WorkloadPolicy): number {
  return round2(policy.regularUnits + LOAD_GRACE_UNITS);
}

/** Exact Permanent Overload cap — published + grace (6 → 6.25); 0 stays 0 (no Overload). */
export function overloadUnitsCap(policy: WorkloadPolicy): number {
  return policy.overloadUnits > 0 ? round2(policy.overloadUnits + LOAD_GRACE_UNITS) : 0;
}

/** Available Permanent Regular slot = exact cap − the term's deloading, never below 0. */
export function permanentRegularLoadLimit(deductionUnits: number, policy: WorkloadPolicy): number {
  const d = Number(deductionUnits);
  return Math.max(0, round2(regularUnitsCap(policy) - (Number.isFinite(d) && d > 0 ? d : 0)));
}

/** A faculty's Regular Load limit for a term: units for Permanent, hours for Contractual. */
export function regularLoadLimit(permanent: boolean, deductionUnits: number, policy: WorkloadPolicy): number {
  return permanent ? permanentRegularLoadLimit(deductionUnits, policy) : policy.contractualHours;
}

/** Deloading can take at most the whole Regular Load (the exact cap). */
export function maxDeductionUnits(policy: WorkloadPolicy): number {
  return regularUnitsCap(policy);
}

/*
 * Display helpers — the grace is never shown. Contractual hours have no grace;
 * don't pass hours through these.
 */

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

/** Only Permanent faculty may carry Overload or Praise Load; Contractual faculty carry Regular Load only. */
export function canHaveOverloadOrPraise(employmentStatus: unknown): boolean {
  return employmentStatus === 'Permanent';
}

export const OVERLOAD_PRAISE_PERMANENT_ONLY =
  'Only Permanent faculty can have Overload or Praise Load — Contractual faculty carry Regular Load only.';

/**
 * Contractual faculty can't go past their Regular Load limit — with no Overload
 * there is nowhere for the extra hours to go, so the subject is not assigned.
 * Returns why `addHours` can't be added, or null when it fits.
 */
export function contractualLimitError(opts: {
  name: string;
  subject?: string;
  currentHours: number;
  addHours: number;
  limitHours: number;
}): string | null {
  const after = opts.currentHours + opts.addHours;
  if (after <= opts.limitHours + 0.001) return null;
  const limit = formatLoadCap(opts.limitHours);
  const what = opts.subject ? `${opts.subject} (${opts.addHours.toFixed(2)} hours)` : `${opts.addHours.toFixed(2)} more hours`;
  return `${opts.name} has ${opts.currentHours.toFixed(2)} of ${limit} hours — ${what} would make ${after.toFixed(2)}. `
    + `Contractual faculty can't go over ${limit} hours.`;
}

/* ── Reading and checking policies ────────────────────────────────────────── */

function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw);
  return Number.NaN;
}

/** Checks limits sent from the Settings form. Values are rounded to 2 decimals. */
export function parseWorkloadPolicy(input: unknown):
  { ok: true; policy: WorkloadPolicy } | { ok: false; error: string; field?: WorkloadPolicyField } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Enter the workload limits.' };
  }
  const src = input as Record<string, unknown>;
  const policy = { ...DEFAULT_WORKLOAD_POLICY };
  for (const field of POLICY_FIELDS) {
    const { min, max, label, unit } = WORKLOAD_POLICY_LIMITS[field];
    const n = toNumber(src[field]);
    if (!Number.isFinite(n)) return { ok: false, field, error: `${label}: enter a number.` };
    const value = round2(n);
    if (value < min || value > max) {
      return { ok: false, field, error: `${label} must be from ${min} to ${max} ${unit}.` };
    }
    policy[field] = value;
  }
  return { ok: true, policy };
}

/** Reads a stored policy (object or JSON text). A missing or invalid limit falls back to its default. */
export function normalizeWorkloadPolicy(stored: unknown): WorkloadPolicy {
  let src: unknown = stored;
  if (typeof stored === 'string') {
    try { src = JSON.parse(stored); } catch { src = null; }
  }
  const obj = src && typeof src === 'object' && !Array.isArray(src) ? src as Record<string, unknown> : {};
  const policy = { ...DEFAULT_WORKLOAD_POLICY };
  for (const field of POLICY_FIELDS) {
    const { min, max } = WORKLOAD_POLICY_LIMITS[field];
    const n = toNumber(obj[field]);
    if (Number.isFinite(n) && round2(n) >= min && round2(n) <= max) policy[field] = round2(n);
  }
  return policy;
}

export function sameWorkloadPolicy(a: WorkloadPolicy, b: WorkloadPolicy): boolean {
  return POLICY_FIELDS.every(f => a[f] === b[f]);
}
