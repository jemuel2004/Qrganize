import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { canManageRooms, roomNameTaken, ROOM_STATUSES, validateRoom } from '@/services/rooms';
import { withAudit } from '@/services/audit';
import { generateRoomQr } from '@/services/roomQr';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const roomType = searchParams.get('room_type');
    const status = searchParams.get('status');

    let sql = 'SELECT * FROM rooms WHERE 1=1';
    const params: unknown[] = [];
    let idx = 1;

    if (roomType) { sql += ` AND room_type = $${idx++}`; params.push(roomType); }
    if (status) { sql += ` AND status = $${idx++}`; params.push(status); }
    sql += ' ORDER BY room_name';

    const result = await query(sql, params);
    return NextResponse.json({ rooms: result.rows });
  } catch (error) {
    console.error('[GET /api/rooms]', error);
    return NextResponse.json({ error: 'Failed to load rooms.' }, { status: 500 });
  }
}

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageRooms(auth.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json();
    const v = validateRoom(body);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    const status = body.status == null ? 'Active' : String(body.status);
    if (!(ROOM_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: 'Status must be Active or Inactive.' }, { status: 400 });
    }
    const { room_name, room_type, capacity, building } = v.room;

    if (await roomNameTaken(room_name)) {
      return NextResponse.json({ error: `A room named "${room_name}" is already registered.` }, { status: 409 });
    }

    const result = await query(`
      INSERT INTO rooms (room_name, room_type, capacity, building, status)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [room_name, room_type, capacity, building, status]);
    const room = result.rows[0];

    // Every new room gets its QR right away (same generator as QR Generator).
    // If it fails the room still exists and the QR can be generated there later.
    let qr: Awaited<ReturnType<typeof generateRoomQr>> | null = null;
    try {
      qr = await generateRoomQr({ id: room.id, room_name: room.room_name, room_type: room.room_type });
    } catch (err) {
      console.error('[POST /api/rooms] QR generation failed', err);
    }

    return NextResponse.json({
      room: qr ? { ...room, qr_code_id: qr.qr_code_id, qr_code_data: qr.qr_data_url, qr_generated_at: qr.qr_generated_at } : room,
      qr_generated: !!qr,
    }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/rooms]', error);
    return NextResponse.json({ error: 'Failed to create room.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
