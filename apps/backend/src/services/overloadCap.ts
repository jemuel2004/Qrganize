import { query } from '@/database/db';
import { OVERLOAD_MAX_UNITS } from '@shared/regularLoad';
import { ensurePraiseSplitColumn } from '@/services/praiseSplit';

/**
 * Permanent faculty may carry at most OVERLOAD_MAX_UNITS of Overload per term.
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
}): Promise<string | null> {
  if (!opts.isPermanent || opts.addUnits <= 0.001) return null;
  await ensurePraiseSplitColumn();
  const res = await query(
    `SELECT COALESCE(SUM(units), 0) AS total
       FROM overloads
      WHERE faculty_id = $1
        AND is_praise = false
        AND semester = $2 AND academic_year = $3
        AND NOT (master_schedule_id = ANY($4::int[]))`,
    [opts.facultyId, opts.semester, opts.academicYear, opts.replacingMsIds ?? []],
  );
  const current = parseFloat(res.rows[0]?.total) || 0;
  const after = current + opts.addUnits;
  if (after <= OVERLOAD_MAX_UNITS + 0.001) return null;
  const left = Math.max(0, OVERLOAD_MAX_UNITS - current);
  return `Overload limit is ${OVERLOAD_MAX_UNITS} units. This faculty already has ${current.toFixed(2)} units of Overload `
    + `(${left.toFixed(2)} left); adding ${opts.addUnits.toFixed(2)} would make ${after.toFixed(2)}.`;
}
