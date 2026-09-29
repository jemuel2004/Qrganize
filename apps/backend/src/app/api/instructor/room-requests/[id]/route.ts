import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { withAudit } from '@/services/audit';

async function DELETE_handler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const rid = parseInt(id);

    const existing = await query(
      'SELECT id, status, requested_room_id FROM room_change_requests WHERE id = $1 AND faculty_id = $2',
      [rid, authUser.faculty_id]
    );
    if (existing.rows.length === 0) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }

    const rcr = existing.rows[0];
    const status = String(rcr.status);
    const canCancel = ['Pending', 'Pending Confirmation'].includes(status);
    const canDeleteHistory = ['Approved', 'Rejected', 'Expired', 'Released'].includes(status);

    if (!canCancel && !canDeleteHistory) {
      return NextResponse.json(
        { error: 'This request cannot be removed right now.' },
        { status: 400 },
      );
    }

    // For Pending Confirmation: also release the associated room_occupancy lock
    if (status === 'Pending Confirmation' && rcr.requested_room_id) {
      await query(`
        UPDATE room_occupancy
        SET    status = 'Released', released_at = NOW()
        WHERE  room_id    = $1
          AND  faculty_id = $2
          AND  status     = 'Pending'
      `, [rcr.requested_room_id, authUser.faculty_id]).catch(() => {});
    }

    await query('DELETE FROM room_change_requests WHERE id = $1', [rid]);
    return NextResponse.json({
      success: true,
      removed: canCancel ? 'cancelled' : 'deleted',
    });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const DELETE = withAudit(DELETE_handler);
