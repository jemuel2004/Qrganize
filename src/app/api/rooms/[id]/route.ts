import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const result = await query('SELECT * FROM rooms WHERE id=$1', [id]);
    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ room: result.rows[0] });
  } catch (error) {
    console.error('[GET /api/rooms/[id]]', error);
    return NextResponse.json({ error: 'Failed to load room.' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const role = auth.role as string;
    if (role !== 'admin' && role !== 'department_chair') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;
    const { room_name, room_type, capacity, building, status } = await req.json();

    const result = await query(`
      UPDATE rooms SET room_name=$1, room_type=$2, capacity=$3, building=$4, status=$5, updated_at=NOW()
      WHERE id=$6 RETURNING *
    `, [room_name, room_type, capacity || 0, building, status || 'Active', id]);

    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ room: result.rows[0] });
  } catch (error) {
    console.error('[PUT /api/rooms/[id]]', error);
    return NextResponse.json({ error: 'Failed to update room.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const role = auth.role as string;
    if (role !== 'admin' && role !== 'department_chair') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;

    // Clear room assignment from all schedule sessions and master schedules
    // that reference this room — schedules themselves are preserved.
    await query('UPDATE schedule_sessions SET room_id = NULL WHERE room_id = $1', [id]);
    await query('UPDATE master_schedule   SET room_id = NULL WHERE room_id = $1', [id]);

    const result = await query('DELETE FROM rooms WHERE id=$1 RETURNING id', [id]);
    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/rooms/[id]]', error);
    return NextResponse.json({ error: 'Failed to delete room.' }, { status: 500 });
  }
}
