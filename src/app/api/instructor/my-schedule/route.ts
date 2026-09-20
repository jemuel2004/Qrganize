import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';

/**
 * GET /api/instructor/my-schedule?semester=X&academic_year=Y
 *
 * Returns the authenticated instructor's schedules in the same structure
 * as the admin /api/faculty-schedules endpoint, enriched with per-day
 * sessions, room occupancy, and room request state for QR badge rendering.
 *
 * Security: faculty_id is derived from the JWT — never from request params.
 */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as {
      role?: string; faculty_id?: number;
    } | null;

    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const facultyId = authUser.faculty_id;
    const { searchParams } = new URL(req.url);
    const semester     = searchParams.get('semester')      || '';
    const academicYear = searchParams.get('academic_year') || '';

    const conditions = ['f.id = $1', "ms.status IN ('Assigned', 'Scheduled')"];
    const values: (string | number)[] = [facultyId];
    let idx = 2;

    if (semester)     { conditions.push(`b.semester      = $${idx++}`); values.push(semester); }
    if (academicYear) { conditions.push(`b.academic_year = $${idx++}`); values.push(academicYear); }

    const where = conditions.join(' AND ');

    // Main schedule rows — same structure as admin faculty-schedules
    const result = await query(`
      SELECT
        f.id              AS faculty_id,
        f.name            AS faculty_name,
        f.employee_id,
        f.position,
        f.employment_status,
        p.id              AS program_id,
        p.code            AS program_code,
        p.name            AS program_name,
        il.id             AS load_id,
        il.load_category,
        il.units,
        il.hours,
        COALESCE(
          (SELECT SUM(o2.units) FROM overloads o2
           WHERE o2.faculty_id = il.faculty_id
             AND o2.master_schedule_id = il.master_schedule_id), 0
        )                 AS split_overload_units,
        c.subject_code,
        c.subject_name,
        c.units           AS curriculum_units,
        c.total_hours,
        c.lecture_hours,
        c.laboratory_hours,
        b.block_name,
        b.year_level,
        b.semester,
        b.academic_year,
        ms.id             AS master_schedule_id,
        ms.day_pattern,
        ms.start_time::text,
        ms.end_time::text,
        ms.status,
        COALESCE(
          (SELECT r2.room_name
           FROM   schedule_sessions ss2
           JOIN   rooms r2 ON ss2.room_id = r2.id
           WHERE  ss2.master_schedule_id = ms.id
           ORDER  BY ss2.id LIMIT 1),
          r.room_name
        )                 AS room_name,
        ms.room_id,
        (
          SELECT json_agg(json_build_object(
            'day',       ss.day_of_week,
            'start_time',ss.start_time::text,
            'end_time',  ss.end_time::text,
            'room_name', sr.room_name,
            'room_id',   ss.room_id
          ) ORDER BY ss.start_time)
          FROM   schedule_sessions ss
          LEFT JOIN rooms sr ON ss.room_id = sr.id
          WHERE  ss.master_schedule_id = ms.id
        )                 AS sessions
      FROM instructor_loads il
      JOIN faculty          f   ON il.faculty_id          = f.id
      JOIN master_schedule  ms  ON il.master_schedule_id  = ms.id
      JOIN block_subjects   bs  ON ms.block_subject_id    = bs.id
      JOIN curriculums      c   ON bs.curriculum_id       = c.id
      JOIN blocks           b   ON bs.block_id            = b.id
      JOIN programs         p   ON b.program_id           = p.id
      LEFT JOIN rooms       r   ON ms.room_id             = r.id
      WHERE ${where}
      ORDER BY b.academic_year DESC, b.semester, il.load_category, c.subject_code
    `, values);

    const schedules = result.rows;

    /* Collect unique room IDs across all sessions */
    const roomIdSet = new Set<number>();
    for (const s of schedules) {
      if (s.room_id) roomIdSet.add(s.room_id);
      for (const sess of (s.sessions ?? [])) {
        if (sess.room_id) roomIdSet.add(Number(sess.room_id));
      }
    }
    const roomIds = [...roomIdSet];

    /* Current room occupancy */
    const occupancyMap: Record<number, { status: string; is_self: boolean }> = {};
    if (roomIds.length > 0) {
      const occRes = await query(`
        SELECT ro.room_id, ro.status, ro.faculty_id
        FROM   room_occupancy ro
        WHERE  ro.room_id = ANY($1::int[])
          AND  ro.status IN ('Pending', 'Occupied')
      `, [roomIds]);
      for (const row of occRes.rows) {
        occupancyMap[row.room_id] = {
          status:  row.status,
          is_self: Number(row.faculty_id) === facultyId,
        };
      }
    }

    /* Room change requests for this instructor */
    const requestMap: Record<number, string> = {}; // master_schedule_id → status
    const reqRes = await query(`
      SELECT master_schedule_id, status
      FROM   room_change_requests
      WHERE  faculty_id = $1
        AND  status IN ('Pending', 'Pending Confirmation', 'Approved', 'In-Use')
      ORDER  BY updated_at DESC
    `, [facultyId]);
    for (const row of reqRes.rows) {
      if (row.master_schedule_id && !(row.master_schedule_id in requestMap)) {
        requestMap[row.master_schedule_id] = row.status;
      }
    }

    /* Distinct academic years for period selector */
    const yearsRes = await query(`
      SELECT DISTINCT b.academic_year
      FROM   instructor_loads il
      JOIN   master_schedule ms ON il.master_schedule_id = ms.id
      JOIN   block_subjects  bs ON ms.block_subject_id   = bs.id
      JOIN   blocks          b  ON bs.block_id           = b.id
      WHERE  il.faculty_id = $1
        AND  b.academic_year IS NOT NULL
      ORDER  BY b.academic_year DESC
    `, [facultyId]);

    return NextResponse.json({
      schedules,
      room_occupancy: occupancyMap,
      room_requests:  requestMap,
      academic_years: yearsRes.rows.map(r => r.academic_year),
    });
  } catch (error) {
    console.error('[GET /api/instructor/my-schedule]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
