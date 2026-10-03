import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { ensureRoomOccupancy, expireStaleOccupancy } from '@/services/ensureRoomOccupancy';
import { bumpTopics } from '@/services/realtime';
import { manilaClock } from '@/services/appTimezone';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const facultyId = authUser.faculty_id;

    await ensureRoomOccupancy();
    await expireStaleOccupancy();

    /* Restore occupancy for In-Use requests that were auto-expired while
       still waiting for the faculty to release the room. */
    const restored = await query(`
      INSERT INTO room_occupancy (room_id, faculty_id, status, reserved_at, expires_at, occupied_at)
      SELECT rcr.requested_room_id, rcr.faculty_id, 'Occupied', NOW(), NOW() + INTERVAL '4 hours', NOW()
      FROM   room_change_requests rcr
      WHERE  rcr.faculty_id        = $1
        AND  rcr.status            = 'In-Use'
        AND  rcr.requested_room_id IS NOT NULL
        AND  NOT EXISTS (
               SELECT 1 FROM room_occupancy ro
               WHERE  ro.room_id = rcr.requested_room_id
                 AND  ro.status IN ('Pending', 'Occupied')
             )
    `, [facultyId]).catch(() => null);
    if ((restored?.rowCount ?? 0) > 0) bumpTopics(['occupancy']);

    /* ── 1. My active reservation ───────────────────────────────── */
    const reservationRes = await query(`
      SELECT
        ro.id, ro.room_id, ro.faculty_id, ro.status,
        ro.reserved_at, ro.expires_at, ro.occupied_at,
        r.room_name, r.room_type, r.building, r.capacity
      FROM  room_occupancy ro
      JOIN  rooms r ON ro.room_id = r.id
      WHERE ro.faculty_id = $1
        AND ro.status IN ('Pending', 'Occupied')
      ORDER BY ro.reserved_at DESC
      LIMIT 1
    `, [facultyId]);

    /* ── 2. Room status counts ──────────────────────────────────── */
    const totalRoomsRes = await query(`
      SELECT COUNT(*)::int AS total FROM rooms WHERE status = 'Active'
    `);
    const pendingCountRes = await query(`
      SELECT COUNT(*)::int AS cnt FROM room_occupancy WHERE status = 'Pending'
    `);
    const occupiedCountRes = await query(`
      SELECT COUNT(*)::int AS cnt FROM room_occupancy WHERE status = 'Occupied'
    `);
    const totalRooms   = totalRoomsRes.rows[0]?.total ?? 0;
    const pendingCount = pendingCountRes.rows[0]?.cnt ?? 0;
    const occupiedCount = occupiedCountRes.rows[0]?.cnt ?? 0;
    const availableCount = Math.max(0, totalRooms - pendingCount - occupiedCount);

    /* ── 3. Available rooms list ────────────────────────────────── */
    const availableRes = await query(`
      SELECT r.id, r.room_name, r.room_type, r.building, r.capacity
      FROM   rooms r
      WHERE  r.status = 'Active'
        AND  NOT EXISTS (
               SELECT 1 FROM room_occupancy ro
               WHERE  ro.room_id = r.id
                 AND  ro.status IN ('Pending', 'Occupied')
             )
      ORDER BY r.room_name
    `);

    /* ── 4. Today's schedule ────────────────────────────────────── */
    // Today in Manila (the server itself may run in UTC), active term only
    const dayName = manilaClock().dayOfWeek;
    const period = await getActiveAcademicPeriod();
    const todayRes = await query(`
      SELECT
        ms.id,
        c.subject_code,
        c.subject_name,
        b.block_name,
        b.year_level,
        ms.status,
        ss.start_time::text,
        ss.end_time::text,
        COALESCE(sr.room_name, r.room_name) AS room_name
      FROM   master_schedule ms
      JOIN   block_subjects bs ON ms.block_subject_id = bs.id
      JOIN   curriculums     c  ON bs.curriculum_id    = c.id
      JOIN   blocks          b  ON bs.block_id         = b.id
      LEFT JOIN rooms        r  ON ms.room_id          = r.id
      JOIN   schedule_sessions ss ON ss.master_schedule_id = ms.id
      LEFT JOIN rooms        sr ON ss.room_id          = sr.id
      WHERE  ms.faculty_id = $1
        AND  ms.status IN ('Assigned', 'Scheduled')
        AND  ss.day_of_week = $2
        AND  ($3 = '' OR b.academic_year = $3)
        AND  ($4 = '' OR b.semester      = $4)
      ORDER  BY ss.start_time
    `, [facultyId, dayName, period.schoolYear ?? '', period.semester ?? '']);

    /* ── 5. Personal stats this month ───────────────────────────── */
    const statsRes = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('Occupied','Released'))::int AS sessions_month,
        COUNT(*) FILTER (WHERE status = 'Expired')::int                AS expired_month
      FROM  room_occupancy
      WHERE faculty_id = $1
        AND reserved_at >= date_trunc('month', NOW())
    `, [facultyId]);

    const stats = statsRes.rows[0] ?? { sessions_month: 0, expired_month: 0 };

    return NextResponse.json({
      my_reservation:  reservationRes.rows[0] ?? null,
      room_counts: {
        available: availableCount,
        pending:   pendingCount,
        occupied:  occupiedCount,
        total:     totalRooms,
      },
      available_rooms: availableRes.rows,
      today_schedule:  todayRes.rows,
      stats: {
        sessions_month: Number(stats.sessions_month),
        expired_month:  Number(stats.expired_month),
      },
    });
  } catch (error) {
    console.error('[GET /api/instructor/dashboard]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
