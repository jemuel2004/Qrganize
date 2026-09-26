import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { ensureRoomOccupancy, expireStaleOccupancy } from '@/server/ensureRoomOccupancy';
import { manilaCalendarDayRange } from '@/server/appTimezone';

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

    const today = manilaCalendarDayRange();

    const [
      totalRoomsRes,
      occupiedCountRes,
      pendingOccRes,
      pendingRequestsRes,
      todaySchedulesCountRes,
      todayScheduleRes,
      liveRoomsRes,
      recentScansRes,
      lateScansRes,
      overuseRes,
    ] = await Promise.all([
      query("SELECT COUNT(*)::int AS count FROM rooms WHERE status='Active'"),

      query(`SELECT COUNT(*)::int AS count FROM room_occupancy WHERE status = 'Occupied'`),

      query(`SELECT COUNT(*)::int AS count FROM room_occupancy WHERE status = 'Pending'`),

      query(`SELECT COUNT(*)::int AS count FROM room_change_requests WHERE status = 'Pending'`)
        .catch(() => ({ rows: [{ count: 0 }] })),

      query(`
        SELECT COUNT(DISTINCT ss.master_schedule_id)::int AS count
        FROM schedule_sessions ss
        JOIN master_schedule ms ON ss.master_schedule_id = ms.id
        WHERE ms.status = 'Scheduled'
          AND ss.day_of_week = TRIM(TO_CHAR(NOW(), 'Day'))
      `),

      query(`
        SELECT
          ss.id,
          ss.start_time::text AS start_time,
          ss.end_time::text   AS end_time,
          c.subject_code,
          c.subject_name,
          COALESCE(
            NULLIF(trim(COALESCE(f.name, '')), ''),
            NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), ''),
            '—'
          ) AS faculty_name,
          COALESCE(NULLIF(trim(sr.room_name), ''), NULLIF(trim(r.room_name), ''), '—') AS room_name
        FROM schedule_sessions ss
        JOIN master_schedule ms ON ss.master_schedule_id = ms.id
        JOIN block_subjects  bs ON ms.block_subject_id   = bs.id
        JOIN curriculums      c ON bs.curriculum_id      = c.id
        LEFT JOIN faculty     f ON ms.faculty_id         = f.id
        LEFT JOIN rooms       r ON ms.room_id            = r.id
        LEFT JOIN rooms      sr ON ss.room_id            = sr.id
        WHERE ms.status = 'Scheduled'
          AND ss.day_of_week = TRIM(TO_CHAR(NOW(), 'Day'))
          AND ss.start_time IS NOT NULL
          AND ss.end_time   IS NOT NULL
        ORDER BY ss.start_time ASC, c.subject_code ASC
      `).catch(() => ({ rows: [] })),

      query(`
        SELECT
          r.id,
          r.room_name,
          r.room_type,
          r.building,
          CASE WHEN ro.id IS NOT NULL THEN true ELSE false END AS is_occupied,
          COALESCE(ro.status, 'Available') AS occupancy_status
        FROM rooms r
        LEFT JOIN LATERAL (
          SELECT ro2.id, ro2.status
          FROM room_occupancy ro2
          WHERE ro2.room_id = r.id
            AND ro2.status IN ('Pending', 'Occupied')
          ORDER BY ro2.reserved_at DESC
          LIMIT 1
        ) ro ON true
        WHERE r.status = 'Active'
        ORDER BY
          CASE COALESCE(ro.status, 'Available')
            WHEN 'Occupied' THEN 0
            WHEN 'Pending'  THEN 1
            ELSE 2
          END,
          r.room_name
      `),

      query(`
        SELECT
          ql.id,
          r.room_name,
          COALESCE(
            NULLIF(trim(COALESCE(f.name, '')), ''),
            NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), ''),
            'Unknown'
          ) AS faculty_name,
          ql.scan_time,
          ql.scan_date,
          ql.status
        FROM qr_scan_logs ql
        JOIN rooms r ON ql.room_id = r.id
        LEFT JOIN faculty f ON ql.faculty_id = f.id
        WHERE ql.scan_time >= $1 AND ql.scan_time < $2
        ORDER BY ql.scan_time DESC
        LIMIT 5
      `, [today.start, today.end]).catch(() => ({ rows: [] })),

      query(`
        SELECT COUNT(*)::int AS count
        FROM qr_scan_logs
        WHERE status = 'Late' AND scan_time >= $1 AND scan_time < $2
      `, [today.start, today.end]).catch(() => ({ rows: [{ count: 0 }] })),

      query(`
        SELECT COUNT(*)::int AS count
        FROM qr_scan_logs
        WHERE status = 'Overuse' AND scan_time >= $1 AND scan_time < $2
      `, [today.start, today.end]).catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    const totalRooms = Number(totalRoomsRes.rows[0]?.count ?? 0);
    const occupied = Number(occupiedCountRes.rows[0]?.count ?? 0);
    const pendingOcc = Number(pendingOccRes.rows[0]?.count ?? 0);
    const availableRooms = Math.max(0, totalRooms - occupied - pendingOcc);
    const pendingRequests = Number(pendingRequestsRes.rows[0]?.count ?? 0);
    const todaySchedules = Number(todaySchedulesCountRes.rows[0]?.count ?? 0);
    const lateScans = Number(lateScansRes.rows[0]?.count ?? 0);
    const overuse = Number(overuseRes.rows[0]?.count ?? 0);
    const utilizationRate = totalRooms > 0
      ? Math.round(((occupied + pendingOcc) / totalRooms) * 100)
      : 0;

    return NextResponse.json(
      {
        user: {
          username: auth.username ?? 'Admin',
          role: auth.role ?? 'admin',
        },
        stats: {
          today_schedules: todaySchedules,
          occupied_rooms: occupied,
          available_rooms: availableRooms,
          pending_occupancy: pendingOcc,
          total_rooms: totalRooms,
          utilization_rate: utilizationRate,
          pending_requests: pendingRequests,
          late_scans_today: lateScans,
          overuse_today: overuse,
        },
        today_schedule: todayScheduleRes.rows,
        live_rooms: liveRoomsRes.rows,
        recent_scans: recentScansRes.rows,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[GET /api/dashboard]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
