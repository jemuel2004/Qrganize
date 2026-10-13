import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { parseId } from '@/database/ids';
import { manilaCalendarDateString, manilaClock } from '@/services/appTimezone';
import { roomClassesOnDay, roomReservationsToday, roomStatusNow } from '@/services/roomDay';

const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * GET /api/instructor/rooms/:id/schedule?day=Friday — a room's details for
 * Find Available Rooms: who holds it right now and the classes meeting in it
 * on that weekday (active term), each with the dates its faculty made the room
 * available — and, when that day is today, today's room requests for it.
 * Read-only; the same data the room page shows (services/roomDay.ts).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!auth || auth.role !== 'instructor' || !auth.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const roomId = parseId((await params).id);
    if (roomId === null) return NextResponse.json({ error: 'Invalid room.' }, { status: 400 });
    const day = req.nextUrl.searchParams.get('day') ?? '';
    if (!WEEK.includes(day)) return NextResponse.json({ error: 'Choose a valid day.' }, { status: 400 });

    const room = (await query(
      `SELECT id, room_name, room_type, building, capacity FROM rooms WHERE id = $1 AND status = 'Active'`,
      [roomId],
    )).rows[0];
    if (!room) return NextResponse.json({ error: 'Room not found.' }, { status: 404 });

    const facultyId = Number(auth.faculty_id);
    const { time, dayOfWeek } = manilaClock();
    const [status, classes, reservations] = await Promise.all([
      roomStatusNow(roomId, facultyId),
      roomClassesOnDay(roomId, day, facultyId),
      day === dayOfWeek ? roomReservationsToday(roomId, facultyId) : Promise.resolve([]),
    ]);
    return NextResponse.json({
      room, status, classes, reservations, day,
      today: manilaCalendarDateString(),
      now: time.slice(0, 5),
    });
  } catch (error) {
    console.error('[GET /api/instructor/rooms/:id/schedule]', error);
    return NextResponse.json({ error: 'Could not load this room. Please try again.' }, { status: 500 });
  }
}
