import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { clearAuthCookie, getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { clearTrustedDeviceCookie, revokeAccountAccess } from '@/auth/trustedDevices';
import { ensurePasswordChangeColumns, isRecentSignIn, mustChangePassword } from '@/auth/passwordChange';
import { hasCharacterMix, weakPasswordReason } from '@/auth/passwordPolicy';
import { withAudit } from '@/services/audit';

/**
 * POST /api/auth/change-default-password — the /change-password page.
 * Body: { new_password, confirm_password }.
 *
 * For an account that must replace a default / common password. No current
 * password is asked for: the session has just proved it at sign-in. That is
 * only trusted for a fresh sign-in (isRecentSignIn) — an older session (a
 * browser left signed in) has to sign in again first, so whoever finds it
 * open can't take the account over. Every session ends afterwards.
 */
async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string; username?: string } | null;
    if (!auth?.role || !auth.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!(await mustChangePassword(auth))) {
      return NextResponse.json({ error: 'Your password does not need to be changed here.' }, { status: 409 });
    }
    if (!isRecentSignIn(auth)) {
      return NextResponse.json(
        { error: 'For your security, please sign in again to set your new password.', code: 'REAUTH_REQUIRED' },
        { status: 401 },
      );
    }

    const body = await req.json().catch(() => ({})) as { new_password?: unknown; confirm_password?: unknown };
    const newPassword = typeof body.new_password === 'string' ? body.new_password : '';
    const confirm = typeof body.confirm_password === 'string' ? body.confirm_password : '';
    if (newPassword.length < 8) {
      return NextResponse.json({ error: 'Your new password must be at least 8 characters.' }, { status: 400 });
    }
    if (newPassword !== confirm) {
      return NextResponse.json({ error: 'The new passwords do not match.' }, { status: 400 });
    }
    const weak = weakPasswordReason(newPassword, auth.username);
    if (weak) return NextResponse.json({ error: weak }, { status: 400 });
    if (!hasCharacterMix(newPassword)) {
      return NextResponse.json({ error: 'Mix letters with numbers or symbols.' }, { status: 400 });
    }

    const instructor = auth.role === 'instructor';
    const table = instructor ? 'instructor_accounts' : 'users';
    const accountId = Number(auth.id);
    const current = await query(`SELECT password_hash FROM ${table} WHERE id = $1`, [accountId]);
    const currentHash = current.rows[0]?.password_hash as string | undefined;
    if (!currentHash) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    if (await bcrypt.compare(newPassword, currentHash)) {
      return NextResponse.json({ error: 'Choose a password different from your current one.' }, { status: 400 });
    }

    await ensurePasswordChangeColumns();
    await query(
      `UPDATE ${table} SET password_hash = $1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2`,
      [await bcrypt.hash(newPassword, 12), accountId],
    );
    // Every session (and remembered device) ends — sign in again with the new password
    await revokeAccountAccess(instructor ? 'instructor' : 'user', accountId);

    const response = NextResponse.json({ success: true, reauth: true });
    clearAuthCookie(response);
    clearTrustedDeviceCookie(response);
    return response;
  } catch (error) {
    console.error('[POST /api/auth/change-default-password]', error);
    return NextResponse.json({ error: 'Could not change the password. Please try again.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
