import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { ensureRoomOccupancy, expireStaleOccupancy } from '@/services/ensureRoomOccupancy';

/**
 * GET /api/instructor/available-rooms?day=Monday&start_time=08:00&end_time=09:00&room_type=all
 *
 * Returns all Active rooms with their current occupancy and schedule-conflict
 * status for the requested day + time window.
 */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureRoomOccupancy();
    await expireStaleOccupancy();

    const { searchParams } = new URL(req.url);
    const day       = searchParams.get('day');
    const startTime = searchParams.get('start_time');
    const endTime   = searchParams.get('end_time');
    const roomType  = searchParams.get('room_type') ?? 'all';
    // Room request form: ignore the class being moved (its own current room isn't a clash)
    const excludeMs = Number(searchParams.get('exclude_ms')) || 0;

    // Fetch all active rooms
    let roomsQuery = `SELECT id, room_name, room_type, capacity, building FROM rooms WHERE status = 'Active'`;
    const roomsParams: unknown[] = [];
    if (roomType && roomType !== 'all') {
      roomsQuery += ` AND room_type = $1`;
      roomsParams.push(roomType);
    }
    roomsQuery += ' ORDER BY room_name';
    const roomsResult = await query(roomsQuery, roomsParams);

    // For each room, check live occupancy and schedule conflicts
    const rooms = await Promise.all(roomsResult.rows.map(async room => {
      // Live occupancy (Pending or Occupied right now)
      const occRes = await query(`
        SELECT ro.status, CONCAT_WS(' ', f.first_name, f.last_name) AS faculty_name
        FROM room_occupancy ro
        JOIN faculty f ON ro.faculty_id = f.id
        WHERE ro.room_id = $1 AND ro.status IN ('Pending', 'Occupied')
        LIMIT 1
      `, [room.id]);
      const occupancy = occRes.rows[0] ?? null;

      // Schedule conflict: any class assigned to this room at the requested day/time
      let scheduleConflict = null;
      if (day && startTime && endTime) {
        const conflictRes = await query(`
          SELECT
            c.subject_code, c.subject_name,
            b.block_name, b.year_level,
            p.code AS program_code,
            CONCAT_WS(' ', f2.first_name, f2.last_name) AS faculty_name,
            ss.start_time::text, ss.end_time::text
          FROM schedule_sessions ss
          JOIN master_schedule ms ON ss.master_schedule_id = ms.id
          JOIN block_subjects  bs ON ms.block_subject_id = bs.id
          JOIN curriculums      c ON bs.curriculum_id = c.id
          JOIN blocks           b ON bs.block_id = b.id
          JOIN programs         p ON b.program_id = p.id
          LEFT JOIN faculty    f2 ON ms.faculty_id = f2.id
          WHERE ss.room_id = $1
            AND ms.status IN ('Assigned', 'Scheduled')
            AND ss.day_of_week = $2
            AND ss.start_time  < $3::time
            AND ss.end_time    > $4::time
            AND ms.id <> $5
          LIMIT 1
        `, [room.id, day, endTime, startTime, excludeMs]);
        scheduleConflict = conflictRes.rows[0] ?? null;
      }

      const isAvailable = !occupancy && !scheduleConflict;

      return {
        ...room,
        occupancy,
        schedule_conflict: scheduleConflict,
        is_available: isAvailable,
      };
    }));

    return NextResponse.json({ rooms });
  } catch (error) {
    console.error('[GET /api/instructor/available-rooms]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
