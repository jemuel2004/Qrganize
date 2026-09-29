import { query } from '@/database/db';

/**
 * Per faculty: how many of their assigned classes this term still have no
 * time slot (no schedule session with a day and start time). Drives the
 * "needs a schedule" badges in Scheduling.
 */
export async function loadUnscheduledByFaculty(opts: {
  semester: string; academicYear: string; programId?: number | string | null;
}): Promise<Record<number, number>> {
  const res = await query(`
    SELECT il.faculty_id, COUNT(DISTINCT ms.id)::int AS n
    FROM instructor_loads il
    JOIN master_schedule ms ON ms.id = il.master_schedule_id
    JOIN faculty f ON f.id = il.faculty_id AND f.is_active = true
    WHERE ($1 = '' OR il.semester = $1)
      AND ($2 = '' OR il.academic_year = $2)
      AND ($3::int IS NULL OR f.program_id = $3)
      AND NOT EXISTS (
        SELECT 1 FROM schedule_sessions ss
        WHERE ss.master_schedule_id = ms.id AND ss.day_of_week IS NOT NULL AND ss.start_time IS NOT NULL
      )
    GROUP BY il.faculty_id
  `, [opts.semester || '', opts.academicYear || '', opts.programId ? Number(opts.programId) : null]);
  return Object.fromEntries((res.rows as { faculty_id: number; n: number }[]).map(r => [Number(r.faculty_id), Number(r.n)]));
}
