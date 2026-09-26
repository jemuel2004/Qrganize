import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { canManageRooms, roomNameTaken, ROOM_STATUSES, validateRoom } from '@/server/rooms';

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

export async function POST(req: NextRequest) {
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

    const qrCodeId = `QR-${room_type.toUpperCase().slice(0, 3)}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const qrData = JSON.stringify({ type: 'room', code: qrCodeId, room_name });
    const qrCodeDataUrl = await QRCode.toDataURL(qrData, { width: 300 });

    const result = await query(`
      INSERT INTO rooms (room_name, room_type, capacity, building, qr_code_id, qr_code_data, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [room_name, room_type, capacity, building, qrCodeId, qrCodeDataUrl, status]);

    return NextResponse.json({ room: result.rows[0] }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/rooms]', error);
    return NextResponse.json({ error: 'Failed to create room.' }, { status: 500 });
  }
}
