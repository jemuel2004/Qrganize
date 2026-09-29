import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { ensureRoomOccupancy, expireStaleOccupancy } from '@/services/ensureRoomOccupancy';

/**
 * Admin / dept-chair operational dashboard.
 * Returns only what the Dashboard UI needs — not analytics or workload modules.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string; username?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureRoomOccupancy();
    await expireStaleOccupancy();

    // Today in Manila (the DB session may run in another zone)
    const TODAY = `TRIM(TO_CHAR(NOW() AT TIME ZONE 'Asia/Manila', 'FMDay'))`;
    const NOW_T = `(NOW() AT TIME ZONE 'Asia/Manila')::time`;
    const SCHEDULED = `ms.status IN ('Assigned', 'Scheduled', 'Completed')`;
    const FACULTY_NAME = `COALESCE(NULLIF(TRIM(f.name), ''), NULLIF(TRIM(CONCAT_WS(' ', f.first_name, f.last_name)), ''), '—')`;

    const [occupancyRes, pendingRequestsRes, todayScheduleRes, liveRoomsRes] = await Promise.all([
      query(`
        SELECT COUNT(*) FILTER (WHERE status = 'Occupied')::int AS occupied,
               COUNT(*) FILTER (WHERE status = 'Pending')::int  AS pending
        FROM room_occupancy WHERE status IN ('Occupied', 'Pending')
      `),
      // Same "pending" as Room Requests / notifications
      query(`SELECT COUNT(*)::int AS count FROM room_change_requests WHERE status IN ('Pending', 'Pending Confirmation')`)
        .catch(() => ({ rows: [{ count: 0 }] })),
      // Today's classes
      query(`
        SELECT ss.id, ms.id AS ms_id, ss.start_time::text AS start_time, ss.end_time::text AS end_time,
               c.subject_code, p.code AS program_code, b.year_level, b.block_name,
               ${FACULTY_NAME} AS faculty_name,
               COALESCE(NULLIF(TRIM(sr.room_name), ''), NULLIF(TRIM(r.room_name), ''), '—') AS room_name
        FROM schedule_sessions ss
        JOIN master_schedule ms ON ss.master_schedule_id = ms.id
        JOIN block_subjects  bs ON ms.block_subject_id   = bs.id
        JOIN curriculums      c ON bs.curriculum_id      = c.id
        JOIN blocks           b ON bs.block_id           = b.id
        LEFT JOIN programs    p ON b.program_id          = p.id
        LEFT JOIN faculty     f ON ms.faculty_id         = f.id
        LEFT JOIN rooms       r ON ms.room_id            = r.id
        LEFT JOIN rooms      sr ON ss.room_id            = sr.id
        WHERE ${SCHEDULED} AND ss.day_of_week = ${TODAY}
          AND ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
        ORDER BY ss.start_time, c.subject_code
      `).catch(() => ({ rows: [] })),
      // Each active room: live status + the class running now (or next today)
      query(`
        SELECT r.id, r.room_name, r.room_type,
               COALESCE(ro.status, 'Available') AS occupancy_status,
               cls.subject_code, cls.start_time, cls.end_time, cls.faculty_name, cls.is_now
        FROM rooms r
        LEFT JOIN LATERAL (
          SELECT ro2.status FROM room_occupancy ro2
          WHERE ro2.room_id = r.id AND ro2.status IN ('Pending', 'Occupied')
          ORDER BY ro2.reserved_at DESC LIMIT 1
        ) ro ON true
        LEFT JOIN LATERAL (
          SELECT c.subject_code, ss.start_time::text AS start_time, ss.end_time::text AS end_time,
                 ${FACULTY_NAME} AS faculty_name,
                 (${NOW_T} >= ss.start_time AND ${NOW_T} < ss.end_time) AS is_now
          FROM schedule_sessions ss
          JOIN master_schedule ms ON ms.id = ss.master_schedule_id
          JOIN block_subjects bs ON bs.id = ms.block_subject_id
          JOIN curriculums c ON c.id = bs.curriculum_id
          LEFT JOIN faculty f ON f.id = ms.faculty_id
          WHERE ss.room_id = r.id AND ${SCHEDULED} AND ss.day_of_week = ${TODAY} AND ss.end_time > ${NOW_T}
          ORDER BY ss.start_time LIMIT 1
        ) cls ON true
        WHERE r.status = 'Active'
        ORDER BY CASE COALESCE(ro.status, 'Available') WHEN 'Occupied' THEN 0 WHEN 'Pending' THEN 1 ELSE 2 END, r.room_name
      `),
    ]);

    const liveRooms = liveRoomsRes.rows;
    const occupied = Number(occupancyRes.rows[0]?.occupied ?? 0);
    const pendingOcc = Number(occupancyRes.rows[0]?.pending ?? 0);
    const totalRooms = liveRooms.length;
    const todayClasses = new Set(todayScheduleRes.rows.map((r: { ms_id: number }) => r.ms_id)).size;

    return NextResponse.json(
      {
        user: {
          username: auth.username ?? 'Admin',
          role: auth.role ?? 'admin',
        },
        stats: {
          today_schedules: todayClasses,
          occupied_rooms: occupied,
          available_rooms: Math.max(0, totalRooms - occupied - pendingOcc),
          pending_occupancy: pendingOcc,
          total_rooms: totalRooms,
          pending_requests: Number(pendingRequestsRes.rows[0]?.count ?? 0),
        },
        today_schedule: todayScheduleRes.rows,
        live_rooms: liveRooms,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[GET /api/dashboard]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
