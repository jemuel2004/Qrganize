import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { ensureRoomOccupancy, expireStaleOccupancy } from '@/services/ensureRoomOccupancy';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';

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
    // 00:00–23:59 only — "25:99" passed the pattern and reached Postgres as a 500
    const [hh, mm] = time.split(':').map(Number);
    if (!/^\d{1,2}:\d{2}$/.test(time) || hh > 23 || mm > 59) {
      return NextResponse.json({ error: 'Invalid time format — use HH:MM' }, { status: 400 });
    }

    await ensureRoomOccupancy();
    await expireStaleOccupancy();
    // Only live classes of the active school year + semester take a room
    const period = await getActiveAcademicPeriod();

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
          JOIN   master_schedule ms ON ms.id = ss.master_schedule_id
          JOIN   block_subjects  bs ON bs.id = ms.block_subject_id
          JOIN   blocks          b  ON b.id  = bs.block_id
          WHERE  ss.room_id     = r.id
            AND  ss.day_of_week = $1
            AND  $2::time BETWEEN ss.start_time AND ss.end_time
            AND  ms.status IN ('Assigned', 'Scheduled', 'Completed')
            AND  ($3 = '' OR b.academic_year = $3)
            AND  ($4 = '' OR b.semester      = $4)
        )

      ORDER BY r.room_type, r.room_name
    `, [day, time, period.schoolYear ?? '', period.semester ?? '']);

    return NextResponse.json({ rooms: result.rows, time, day });
  } catch (error) {
    console.error('[GET /api/instructor/rooms/find]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
