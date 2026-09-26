import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';

export async function PATCH(
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
    const nid = parseInt(id);
    if (isNaN(nid)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

    if (authUser.role === 'admin') {
      await query(`
        UPDATE notifications SET is_read = true
        WHERE id = $1 AND recipient_role = 'admin'
      `, [nid]);
    } else if (authUser.role === 'department_chair') {
      await query(`
        UPDATE notifications SET is_read = true
        WHERE id = $1 AND recipient_role = 'department_chair'
      `, [nid]);
    } else if (authUser.role === 'program_chair' && authUser.id) {
      await query(`
        UPDATE notifications SET is_read = true
        WHERE id = $1 AND recipient_role = 'program_chair' AND recipient_id = $2
      `, [nid, authUser.id]);
    } else if (authUser.role === 'instructor' && authUser.faculty_id) {
      await query(`
        UPDATE notifications SET is_read = true
        WHERE id = $1 AND recipient_role = 'instructor' AND recipient_id = $2
      `, [nid, authUser.faculty_id]);
    } else {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
