import { query } from '@/database/db';
import { formatLoadCap, overloadUnitsCap, shownUnitsCap } from '@shared/regularLoad';
import { getWorkloadPolicy } from '@/services/workloadPolicy';
import { ensurePraiseSplitColumn } from '@/services/praiseSplit';

/**
 * Permanent faculty may carry at most the Overload limit per term
 * (Settings → Workload Limits; 6 units by default, 6.25 with the grace).
 * Returns an error message when adding `addUnits` would go over it, else null.
 * Subjects in `replacingMsIds` are left out of the current total — their
 * overload row is about to be replaced (e.g. re-splitting the same subject).
 * Contractual faculty (hour-based) are not capped here.
 */
export async function overloadCapError(opts: {
  facultyId: number;
  isPermanent: boolean;
  semester: string;
  academicYear: string;
  addUnits: number;
  replacingMsIds?: number[];
  /** A transaction client — to check under the same lock as the save */
  q?: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}): Promise<string | null> {
  if (!opts.isPermanent || opts.addUnits <= 0.001) return null;
  await ensurePraiseSplitColumn();
  const res = await (opts.q ?? query)(
    `SELECT COALESCE(SUM(units), 0) AS total
       FROM overloads
      WHERE faculty_id = $1
        AND is_praise = false
        AND semester = $2 AND academic_year = $3
        AND NOT (master_schedule_id = ANY($4::int[]))`,
    [opts.facultyId, opts.semester, opts.academicYear, opts.replacingMsIds ?? []],
  );
  const current = parseFloat(String(res.rows[0]?.total ?? 0)) || 0;
  const after = current + opts.addUnits;
  const cap = overloadUnitsCap(await getWorkloadPolicy());
  if (after <= cap + 0.001) return null;
  if (cap === 0) return 'Overload is turned off in Settings → Workload Limits, so this subject can\'t go to Overload.';
  // Shown as 8, not 8.25 (shared display rule) — the check above keeps the exact cap
  return `Overload is already ${current.toFixed(2)} of ${formatLoadCap(shownUnitsCap(cap))} units — adding ${opts.addUnits.toFixed(2)} would make ${after.toFixed(2)}.`;
}
