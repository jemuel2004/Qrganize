import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await query(
      "SELECT id, room_name, room_type, building, qr_code_id, qr_code_data, capacity FROM rooms WHERE status='Active' ORDER BY room_name"
    );

    const rooms = await Promise.all(result.rows.map(async (room) => {
      let qrDataUrl: string = room.qr_code_data ?? '';

      if (!qrDataUrl.startsWith('data:image/')) {
        const payload = JSON.stringify({ type: 'room', code: room.qr_code_id, room: room.room_name });
        qrDataUrl = await QRCode.toDataURL(payload, {
          width: 400,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
          errorCorrectionLevel: 'H',
        });
      }

      return { ...room, qr_data_url: qrDataUrl };
    }));

    return NextResponse.json({ rooms });
  } catch (error) {
    console.error('[GET /api/rooms/qr-codes]', error);
    return NextResponse.json({ error: 'Failed to load QR codes.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || auth.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { room_id } = await req.json();
    if (!room_id) {
      return NextResponse.json({ error: 'room_id is required' }, { status: 400 });
    }

    const roomResult = await query(
      "SELECT id, room_name, room_type, building, capacity FROM rooms WHERE id = $1 AND status = 'Active'",
      [room_id],
    );
    if (roomResult.rows.length === 0) {
      return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    }
    const room = roomResult.rows[0];

    const prefix = (room.room_type as string).slice(0, 3).toUpperCase();
    const newQrCodeId = `QR-${prefix}-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

    const payload = JSON.stringify({ type: 'room', code: newQrCodeId, room: room.room_name });
    const qrDataUrl = await QRCode.toDataURL(payload, {
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'H',
    });

    await query(
      'UPDATE rooms SET qr_code_id = $1, qr_code_data = $2 WHERE id = $3',
      [newQrCodeId, qrDataUrl, room_id],
    );

    return NextResponse.json({
      room: {
        id: room.id,
        room_name: room.room_name,
        room_type: room.room_type,
        building: room.building,
        capacity: room.capacity,
        qr_code_id: newQrCodeId,
        qr_data_url: qrDataUrl,
      },
    });
  } catch (error) {
    console.error('[POST /api/rooms/qr-codes]', error);
    return NextResponse.json({ error: 'Failed to regenerate QR code.' }, { status: 500 });
  }
}
