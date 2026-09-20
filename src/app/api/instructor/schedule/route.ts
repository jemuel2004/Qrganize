import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';

/**
 * GET /api/instructor/schedule
 *
 * Returns Assigned/Scheduled master schedules for the logged-in instructor.
 * Ownership is resolved the same way as My Schedule: via instructor_loads
 * (with master_schedule.faculty_id as a fallback), so workload assignment
 * always surfaces even if faculty_id on master_schedule drifts.
 *
 * Sessions include type (lec|lab) so Lecture and Laboratory components of
 * the same Major subject remain independently visible when scheduled.
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

    const result = await query(`
      SELECT
        ms.id,
        ms.room_id,
        ms.day_pattern,
        ms.start_time::text,
        ms.end_time::text,
        ms.status,
        c.subject_code,
        c.subject_name,
        c.lecture_hours,
        c.laboratory_hours,
        c.total_hours,
        c.units,
        b.block_name,
        b.year_level,
        b.semester,
        b.academic_year,
        p.code  AS program_code,
        p.name  AS program_name,
        COALESCE(
          (SELECT r2.room_name
           FROM   schedule_sessions ss2
           JOIN   rooms r2 ON ss2.room_id = r2.id
           WHERE  ss2.master_schedule_id = ms.id
             AND  ss2.room_id IS NOT NULL
           ORDER  BY ss2.id LIMIT 1),
          r.room_name
        ) AS room_name,
        (
          SELECT COALESCE(json_agg(
            json_build_object(
              'id',         ss.id,
              'day',        ss.day_of_week,
              'start_time', ss.start_time::text,
              'end_time',   ss.end_time::text,
              'type',       COALESCE(ss.type, 'lec'),
              'room_name',  sr.room_name,
              'room_id',    ss.room_id
            )
            ORDER BY
              CASE ss.day_of_week
                WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
                WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
                WHEN 'Sunday' THEN 7 ELSE 8 END,
              ss.start_time,
              ss.id
          ), '[]'::json)
          FROM schedule_sessions ss
          LEFT JOIN rooms sr ON ss.room_id = sr.id
          WHERE ss.master_schedule_id = ms.id
        ) AS sessions
      FROM master_schedule ms
      JOIN block_subjects bs ON ms.block_subject_id = bs.id
      JOIN curriculums c ON bs.curriculum_id = c.id
      JOIN blocks b ON bs.block_id = b.id
      JOIN programs p ON b.program_id = p.id
      LEFT JOIN rooms r ON ms.room_id = r.id
      WHERE ms.status IN ('Assigned', 'Scheduled')
        AND (
          ms.faculty_id = $1
          OR EXISTS (
            SELECT 1 FROM instructor_loads il
            WHERE il.master_schedule_id = ms.id
              AND il.faculty_id = $1
          )
        )
      ORDER BY b.academic_year DESC, b.semester, c.subject_code
    `, [facultyId]);

    const schedules = result.rows.map((row: {
      sessions: unknown;
      [key: string]: unknown;
    }) => {
      let sessions = row.sessions;
      if (typeof sessions === 'string') {
        try { sessions = JSON.parse(sessions); } catch { sessions = []; }
      }
      if (!Array.isArray(sessions)) sessions = [];
      return { ...row, sessions };
    });

    /* Collect all room_ids that appear in any session */
    const roomIdSet = new Set<number>();
    for (const s of schedules) {
      for (const sess of (s.sessions as { room_id?: number }[])) {
        if (sess.room_id) roomIdSet.add(Number(sess.room_id));
      }
    }
    const roomIds = [...roomIdSet];

    const occupancyMap: Record<number, { status: string; is_self: boolean }> = {};
    if (roomIds.length > 0) {
      const occRes = await query(`
        SELECT ro.room_id, ro.status, ro.faculty_id
        FROM room_occupancy ro
        WHERE ro.room_id = ANY($1::int[])
          AND ro.status IN ('Pending', 'Occupied')
      `, [roomIds]);
      for (const row of occRes.rows) {
        occupancyMap[row.room_id] = {
          status: row.status,
          is_self: Number(row.faculty_id) === facultyId,
        };
      }
    }

    const requestMap: Record<number, string> = {};
    const reqRes = await query(`
      SELECT master_schedule_id, status
      FROM room_change_requests
      WHERE faculty_id = $1
        AND status IN ('Pending', 'Pending Confirmation', 'Approved', 'In-Use')
      ORDER BY updated_at DESC
    `, [facultyId]);
    for (const row of reqRes.rows) {
      if (row.master_schedule_id && !(row.master_schedule_id in requestMap)) {
        requestMap[row.master_schedule_id] = row.status;
      }
    }

    return NextResponse.json({ schedules, room_occupancy: occupancyMap, room_requests: requestMap });
  } catch (error) {
    console.error('[GET /api/instructor/schedule]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
