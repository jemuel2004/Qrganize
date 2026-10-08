import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { withAudit } from '@/services/audit';
import { parseId } from '@/database/ids';
import { bumpNotifications } from '@/services/realtime';

async function PATCH_handler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getAuthUser(req) as {
      role?: string; faculty_id?: number; id?: number;
    } | null;

    if (!authUser?.role) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const nid = parseId(id);
    if (nid === null) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    let updated = 0;
    if (authUser.role === 'admin') {
      updated = (await query(`
        UPDATE notifications SET is_read = true
        WHERE id = $1 AND is_read = false AND recipient_role = 'admin'
      `, [nid])).rowCount ?? 0;
    } else if (authUser.role === 'department_chair') {
      updated = (await query(`
        UPDATE notifications SET is_read = true
        WHERE id = $1 AND is_read = false AND recipient_role = 'department_chair'
      `, [nid])).rowCount ?? 0;
    } else if (authUser.role === 'program_chair' && authUser.id) {
      updated = (await query(`
        UPDATE notifications SET is_read = true
        WHERE id = $1 AND is_read = false AND recipient_role = 'program_chair' AND recipient_id = $2
      `, [nid, authUser.id])).rowCount ?? 0;
    } else if (authUser.role === 'instructor' && authUser.faculty_id) {
      updated = (await query(`
        UPDATE notifications SET is_read = true
        WHERE id = $1 AND is_read = false AND recipient_role = 'instructor' AND recipient_id = $2
      `, [nid, authUser.faculty_id])).rowCount ?? 0;
    } else {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // The reader's other tabs (and fellow admins sharing the inbox) update too
    if (updated > 0) {
      bumpNotifications(authUser.role, authUser.role === 'instructor' ? authUser.faculty_id : authUser.id);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[PATCH /api/notifications/[id]]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const PATCH = withAudit(PATCH_handler);
