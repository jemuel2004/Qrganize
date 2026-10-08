import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, clearAuthCookie } from '@/auth/auth';
import { query } from '@/database/db';
import bcrypt from 'bcryptjs';
import { clearTrustedDeviceCookie, revokeAccountAccess } from '@/auth/trustedDevices';
import { withAudit } from '@/services/audit';
import { weakPasswordReason } from '@/auth/passwordPolicy';
import { ensurePasswordChangeColumns } from '@/auth/passwordChange';
import { checkRateLimit, clearFailures, recordFailure } from '@/auth/rateLimit';

// POST /api/account/change-password — change own password (admin or program_chair)
async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { current_password, new_password, confirm_password } = await req.json();

    if (!current_password) return NextResponse.json({ error: 'Current password is required.' }, { status: 400 });
    if (!new_password) return NextResponse.json({ error: 'New password is required.' }, { status: 400 });
    if (new_password.length < 8) return NextResponse.json({ error: 'New password must be at least 8 characters.' }, { status: 400 });
    const weakPw = weakPasswordReason(new_password);
    if (weakPw) return NextResponse.json({ error: weakPw }, { status: 400 });
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

    // Wrong current passwords are limited per account (a borrowed session can't guess it)
    const guessKey = `pw-change:user:${auth.id}`;
    const guessLimit = checkRateLimit(guessKey);
    if (!guessLimit.allowed) {
      return NextResponse.json(
        { error: `Too many incorrect attempts. Please try again in ${guessLimit.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }
    const valid = await bcrypt.compare(String(current_password), row.rows[0].password_hash);
    if (!valid) {
      recordFailure(guessKey);
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 400 });
    }
    clearFailures(guessKey);

    const newHash = await bcrypt.hash(new_password, 12);
    await ensurePasswordChangeColumns();
    await query(`UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2`, [newHash, auth.id]);
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

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
