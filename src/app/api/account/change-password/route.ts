import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, clearAuthCookie } from '@/server/auth';
import { query } from '@/server/db';
import bcrypt from 'bcryptjs';
import { clearTrustedDeviceCookie, revokeAccountAccess } from '@/server/trustedDevices';

// POST /api/account/change-password — change own password (admin or department_chair)
export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { current_password, new_password, confirm_password } = await req.json();

    if (!current_password) return NextResponse.json({ error: 'Current password is required.' }, { status: 400 });
    if (!new_password) return NextResponse.json({ error: 'New password is required.' }, { status: 400 });
    if (new_password.length < 8) return NextResponse.json({ error: 'New password must be at least 8 characters.' }, { status: 400 });
    if (new_password !== confirm_password) {
      return NextResponse.json({ error: 'New passwords do not match.' }, { status: 400 });
    }
    if (current_password === new_password) {
      return NextResponse.json(
        { error: 'Your new password must be different from your current password.' },
        { status: 400 }
      );
    }

    const row = await query(`SELECT password_hash FROM users WHERE id = $1`, [auth.id]);
    if (row.rows.length === 0) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

    const valid = await bcrypt.compare(current_password, row.rows[0].password_hash);
    if (!valid) return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 400 });

    const newHash = await bcrypt.hash(new_password, 12);
    await query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [newHash, auth.id]);
    await revokeAccountAccess('user', Number(auth.id));

    const response = NextResponse.json({ success: true, reauth: true });
    clearAuthCookie(response);
    clearTrustedDeviceCookie(response);
    return response;
  } catch (error) {
    console.error('[POST /api/account/change-password]', error);
    return NextResponse.json({ error: 'Failed to change password.' }, { status: 500 });
  }
}
