import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { ensureRoomQrColumn, generateRoomQr, hasQr } from '@/services/roomQr';
import { withAudit } from '@/services/audit';

/** Active rooms with their QR status (Generated / Not Generated) */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await ensureRoomQrColumn();

    const result = await query(`
      SELECT id, room_name, room_type, building, capacity, qr_code_id, qr_code_data, qr_generated_at
      FROM rooms WHERE status = 'Active'
      ORDER BY room_name
    `);
    const rooms = result.rows.map(r => {
      const generated = hasQr(r.qr_code_data);
      return {
        id: r.id, room_name: r.room_name, room_type: r.room_type, building: r.building, capacity: r.capacity,
        generated,
        qr_code_id: generated ? r.qr_code_id : null,
        qr_data_url: generated ? r.qr_code_data : null,
        qr_generated_at: generated ? r.qr_generated_at : null,
      };
    });
    return NextResponse.json({ rooms });
  } catch (error) {
    console.error('[GET /api/rooms/qr-codes]', error);
    return NextResponse.json({ error: 'Failed to load QR codes.' }, { status: 500 });
  }
}

/**
 * Generate (or regenerate) QR codes.
 *   { room_id }             → one room (regenerating replaces the old QR)
 *   { all_missing: true }   → every active room that has no QR yet
 */
async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || (auth.role !== 'admin' && auth.role !== 'program_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const roomId = Number(body.room_id);
    if (!body.all_missing && !Number.isInteger(roomId)) {
      return NextResponse.json({ error: 'room_id is required' }, { status: 400 });
    }

    const res = body.all_missing
      ? await query(`SELECT id, room_name, room_type, qr_code_data FROM rooms WHERE status = 'Active' ORDER BY room_name`)
      : await query(`SELECT id, room_name, room_type, qr_code_data FROM rooms WHERE id = $1 AND status = 'Active'`, [roomId]);
    const targets = body.all_missing ? res.rows.filter(r => !hasQr(r.qr_code_data)) : res.rows;
    if (!body.all_missing && targets.length === 0) {
      return NextResponse.json({ error: 'Room not found or inactive.' }, { status: 404 });
    }

    const rooms = [];
    for (const r of targets) rooms.push({ id: r.id, generated: true, ...(await generateRoomQr(r)) });
    return NextResponse.json({ rooms });
  } catch (error) {
    console.error('[POST /api/rooms/qr-codes]', error);
    return NextResponse.json({ error: 'Failed to generate QR code.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
