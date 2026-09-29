import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getChairAssignedProgramId, isScopedChair } from '@/services/programScope';

/**
 * Every instructor handling a subject in a given semester — backs the eye
 * preview on the Scheduling page, so an admin can see who else teaches the
 * same subject (e.g. two instructors each handling a GE-MMW block) and open
 * each one's schedule for it. One row per assigned block (master_schedule).
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const subjectCode  = (searchParams.get('subject_code') ?? '').trim();
    const semester     = searchParams.get('semester') ?? '';
    const academicYear = searchParams.get('academic_year') ?? '';
    if (!subjectCode) return NextResponse.json({ instructors: [] });

    // Program Chairs only see blocks in their own assigned program.
    const chairProgramId = isScopedChair(auth) && auth.id
      ? await getChairAssignedProgramId(Number(auth.id))
      : null;
    if (isScopedChair(auth) && !chairProgramId) {
      return NextResponse.json({ instructors: [] });
    }

    const result = await query(
      `SELECT DISTINCT ON (ms.id)
         ms.id            AS ms_id,
         f.id             AS faculty_id,
         f.name           AS faculty_name,
         b.block_name,
         b.year_level,
         p.code           AS program_code,
         ms.day_pattern,
         ms.start_time::text AS start_time,
         ms.end_time::text   AS end_time,
         r.room_name,
         (
           SELECT COALESCE(json_agg(
             json_build_object(
               'day',        ss.day_of_week,
               'start_time', ss.start_time::text,
               'end_time',   ss.end_time::text,
               'type',       COALESCE(ss.type, 'lec'),
               'room_name',  rs.room_name
             )
             ORDER BY
               CASE ss.day_of_week
                 WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
                 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
                 WHEN 'Sunday' THEN 7 ELSE 8 END,
               ss.start_time, ss.id
           ), '[]'::json)
           FROM schedule_sessions ss
           LEFT JOIN rooms rs ON ss.room_id = rs.id
           WHERE ss.master_schedule_id = ms.id
         ) AS sessions
       FROM master_schedule ms
       JOIN block_subjects bs ON ms.block_subject_id = bs.id
       JOIN curriculums    c  ON bs.curriculum_id   = c.id
       JOIN blocks         b  ON bs.block_id        = b.id
       JOIN programs       p  ON b.program_id       = p.id
       JOIN faculty        f  ON ms.faculty_id      = f.id
       LEFT JOIN rooms     r  ON ms.room_id         = r.id
       WHERE c.subject_code = $1
         AND b.is_active = true AND c.is_active = true AND f.is_active = true
         AND ($2 = '' OR b.semester      = $2)
         AND ($3 = '' OR b.academic_year = $3)
         AND ($4::int IS NULL OR b.program_id = $4)
       ORDER BY ms.id`,
      [subjectCode, semester, academicYear, chairProgramId],
    );

    const instructors = [...result.rows].sort((a, b) =>
      String(a.faculty_name).localeCompare(String(b.faculty_name))
      || String(a.block_name).localeCompare(String(b.block_name)),
    );
    return NextResponse.json({ instructors });
  } catch (error) {
    console.error('[GET /api/scheduling/subject-instructors]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
