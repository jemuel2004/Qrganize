import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { qrCodeFromScan } from '@/services/roomQr';
import { manilaClock } from '@/services/appTimezone';
import { roomClassesOnDay, roomReservationsToday, roomStatusNow } from '@/services/roomDay';
import { isQrCode } from '@shared/qrLink';

/**
 * GET /api/rooms/by-qr?code=<qr_code_id> — the room a QR belongs to, for the
 * room page a phone's camera opens (/room/<code>) and for Room Monitoring.
 * Any signed-in role. Read-only: it shows the room, its status right now and
 * today's classes in it; checking in still goes through POST /api/qr/scan.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string; faculty_id?: unknown } | null;
    if (!auth?.role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const raw = req.nextUrl.searchParams.get('code') ?? '';
    const code = qrCodeFromScan(raw.slice(0, 512));
    if (!isQrCode(code)) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

    const roomRes = await query(
      `SELECT id, room_name, room_type, building, capacity, qr_code_id FROM rooms WHERE qr_code_id = $1 AND status = 'Active'`,
      [code],
    );
    const room = roomRes.rows[0] as {
      id: number; room_name: string; room_type: string; building: string | null; capacity: number | null; qr_code_id: string;
    } | undefined;
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

    // Status now and today's classes (active term) — services/roomDay.ts; a class's
    // `released` = its faculty made the room available for today
    const { time, dayOfWeek } = manilaClock();
    const facultyId = auth.role === 'instructor' ? Number(auth.faculty_id) || null : null;
    const status = await roomStatusNow(room.id, facultyId);
    const today = await roomClassesOnDay(room.id, dayOfWeek, facultyId);
    // Today's room requests for this room (who reserved it, for which time)
    const reservations = await roomReservationsToday(room.id, facultyId);

    return NextResponse.json({
      room,
      status,
      today,
      reservations,
      now: time.slice(0, 5),
      day: dayOfWeek,
      viewer: { role: auth.role, faculty_id: facultyId },
    });
  } catch (error) {
    console.error('[GET /api/rooms/by-qr]', error);
    return NextResponse.json({ error: 'Could not load this room. Please try again.' }, { status: 500 });
  }
}
