import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { ensureRoomOccupancy, expireStaleOccupancy } from '@/server/ensureRoomOccupancy';

/**
 * GET /api/instructor/rooms/find?time=HH:MM&day=Monday
 *
 * Returns rooms that are:
 *   1. Active (not deleted/inactive)
 *   2. Not currently Pending or Occupied in room_occupancy
 *   3. Not scheduled for a class session at the requested time on the requested day
 *
 * This gives conflict-free room suggestions.
 */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const time = searchParams.get('time'); // HH:MM  e.g. "09:30"
    const day  = searchParams.get('day');  // Full day name e.g. "Monday"

    if (!time || !day) {
      return NextResponse.json({ error: 'time and day are required' }, { status: 400 });
    }

    // Basic time validation
    if (!/^\d{1,2}:\d{2}$/.test(time)) {
      return NextResponse.json({ error: 'Invalid time format — use HH:MM' }, { status: 400 });
    }

    await ensureRoomOccupancy();
    await expireStaleOccupancy();

    const result = await query(`
      SELECT
        r.id,
        r.room_name,
        r.room_type,
        r.building,
        r.capacity
      FROM rooms r
      WHERE r.status = 'Active'

        -- Not currently reserved or occupied
        AND NOT EXISTS (
          SELECT 1
          FROM   room_occupancy ro
          WHERE  ro.room_id = r.id
            AND  ro.status IN ('Pending', 'Occupied')
        )

        -- No scheduled class at this time on this day
        AND NOT EXISTS (
          SELECT 1
          FROM   schedule_sessions ss
          WHERE  ss.room_id     = r.id
            AND  ss.day_of_week = $1
            AND  $2::time BETWEEN ss.start_time AND ss.end_time
        )

      ORDER BY r.room_type, r.room_name
    `, [day, time]);

    return NextResponse.json({ rooms: result.rows, time, day });
  } catch (error) {
    console.error('[GET /api/instructor/rooms/find]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
