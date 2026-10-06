import { query } from '@/database/db';
import { parseDays, type DayCombination } from '@shared/dayCombination';

/*
 * Semester day combinations — the one data-access point for the Settings API.
 * They are quick picks and form/timetable sections only: scheduling accepts
 * any days (programs follow their own patterns, e.g. BSIT MTh/W/TF).
 */

export interface TermDayCombination extends DayCombination {
  id: number;
  sort_order: number;
}

/** Configured combinations of a school year + semester, in display order */
export async function getTermDayCombinations(academicYear: string, semester: string): Promise<TermDayCombination[]> {
  if (!academicYear || !semester) return [];
  const res = await query(
    `SELECT id, days, is_active, sort_order
       FROM semester_day_combinations
      WHERE academic_year = $1 AND semester = $2
      ORDER BY sort_order, id`,
    [academicYear, semester],
  );
  return res.rows
    .map(r => ({ id: Number(r.id), days: parseDays(String(r.days)) ?? [], is_active: r.is_active !== false, sort_order: Number(r.sort_order) || 0 }))
    .filter(c => c.days.length > 0);
}
