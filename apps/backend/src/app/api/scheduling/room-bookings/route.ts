import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';

/**
 * Every live class session for a term, with its block and room — backs the
 * Scheduling page's Time and Room pickers so times the block already has a
 * class, and rooms already in use, show as taken before saving. Same rules
 * as findScheduleConflicts (services/scheduleConflicts): classes with an
 * instructor, active status, same semester + academic year.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const semester     = searchParams.get('semester') ?? '';
    const academicYear = searchParams.get('academic_year') ?? '';

    const result = await query(
      `SELECT ss.room_id,
              bs2.block_id,
              ss.day_of_week          AS day,
              ss.start_time::text     AS start_time,
              ss.end_time::text       AS end_time,
              ss.master_schedule_id   AS ms_id,
              COALESCE(ss.type, 'lec') AS type,
              c.subject_code,
              b2.block_name,
              p.code                  AS program_code,
              f.name                  AS faculty_name
       FROM schedule_sessions ss
       JOIN master_schedule ms2 ON ss.master_schedule_id = ms2.id
       JOIN block_subjects  bs2 ON ms2.block_subject_id  = bs2.id
       JOIN curriculums     c   ON bs2.curriculum_id     = c.id
       JOIN blocks          b2  ON bs2.block_id          = b2.id
       JOIN programs        p   ON b2.program_id         = p.id
       LEFT JOIN faculty    f   ON ms2.faculty_id        = f.id
       WHERE ms2.faculty_id IS NOT NULL
         AND ms2.status IN ('Assigned', 'Scheduled', 'Completed')
         AND ($1 = '' OR b2.semester      = $1)
         AND ($2 = '' OR b2.academic_year = $2)`,
      [semester, academicYear],
    );

    return NextResponse.json({ bookings: result.rows });
  } catch (error) {
    console.error('[GET /api/scheduling/room-bookings]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
