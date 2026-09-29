import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { withAudit } from '@/services/audit';

async function PATCH_handler(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as {
      role?: string; faculty_id?: number; id?: number;
    } | null;

    if (!authUser?.role) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (authUser.role === 'admin') {
      await query(`
        UPDATE notifications SET is_read = true
        WHERE  recipient_role = 'admin' AND is_read = false
      `, []);
    } else if (authUser.role === 'department_chair') {
      await query(`
        UPDATE notifications SET is_read = true
        WHERE  recipient_role = 'department_chair' AND is_read = false
      `, []);
    } else if (authUser.role === 'program_chair' && authUser.id) {
      await query(`
        UPDATE notifications SET is_read = true
        WHERE  recipient_role = 'program_chair'
          AND  recipient_id   = $1
          AND  is_read        = false
      `, [authUser.id]);
    } else if (authUser.role === 'instructor' && authUser.faculty_id) {
      await query(`
        UPDATE notifications SET is_read = true
        WHERE  recipient_role = 'instructor'
          AND  recipient_id   = $1
          AND  is_read        = false
      `, [authUser.faculty_id]);
    } else {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const PATCH = withAudit(PATCH_handler);
