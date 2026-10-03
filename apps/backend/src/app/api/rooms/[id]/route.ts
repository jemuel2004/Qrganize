import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { canManageRooms, roomNameTaken, ROOM_STATUSES, validateRoom } from '@/services/rooms';
import { withAudit } from '@/services/audit';

function parseId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const result = await query('SELECT * FROM rooms WHERE id=$1', [id]);
    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ room: result.rows[0] });
  } catch (error) {
    console.error('[GET /api/rooms/[id]]', error);
    return NextResponse.json({ error: 'Failed to load room.' }, { status: 500 });
  }
}

/** Edit a room. Status is only changed when one is sent — editing never
 *  silently reactivates an Inactive room. */
async function PUT_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageRooms(auth.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = await req.json();
    const v = validateRoom(body);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    const status = body.status == null ? null : String(body.status);
    if (status !== null && !(ROOM_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: 'Status must be Active or Inactive.' }, { status: 400 });
    }
    const { room_name, room_type, capacity, building } = v.room;

    if (await roomNameTaken(room_name, id)) {
      return NextResponse.json({ error: `A room named "${room_name}" is already registered.` }, { status: 409 });
    }

    const result = await query(`
      UPDATE rooms SET room_name=$1, room_type=$2, capacity=$3, building=$4,
             status=COALESCE($5, status), updated_at=NOW()
      WHERE id=$6 RETURNING *
    `, [room_name, room_type, capacity, building, status, id]);

    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ room: result.rows[0] });
  } catch (error) {
    console.error('[PUT /api/rooms/[id]]', error);
    return NextResponse.json({ error: 'Failed to update room.' }, { status: 500 });
  }
}

/** Activate / deactivate a room. Inactive rooms stay on file (and on existing
 *  schedules) but can't be picked for new schedules. */
async function PATCH_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageRooms(auth.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const { status } = await req.json();
    if (!(ROOM_STATUSES as readonly string[]).includes(String(status))) {
      return NextResponse.json({ error: 'Status must be Active or Inactive.' }, { status: 400 });
    }
    const result = await query(
      'UPDATE rooms SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [status, id],
    );
    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ room: result.rows[0] });
  } catch (error) {
    console.error('[PATCH /api/rooms/[id]]', error);
    return NextResponse.json({ error: 'Failed to update room status.' }, { status: 500 });
  }
}

async function DELETE_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!canManageRooms(auth.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Clear room assignment from all schedule sessions and master schedules
    // that reference this room — schedules themselves are preserved. All or
    // nothing, so a failed delete never leaves classes without their room.
    const result = await transaction(async (client) => {
      await client.query('UPDATE schedule_sessions SET room_id = NULL WHERE room_id = $1', [id]);
      await client.query('UPDATE master_schedule   SET room_id = NULL WHERE room_id = $1', [id]);
      return client.query('DELETE FROM rooms WHERE id=$1 RETURNING id', [id]);
    });
    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/rooms/[id]]', error);
    return NextResponse.json({ error: 'Failed to delete room.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const PUT = withAudit(PUT_handler);
export const PATCH = withAudit(PATCH_handler);
export const DELETE = withAudit(DELETE_handler);
