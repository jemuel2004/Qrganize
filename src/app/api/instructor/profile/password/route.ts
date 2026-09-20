import { NextRequest, NextResponse } from 'next/server';
import {
  getAuthUser,
  clearAuthCookie,
  clearPasswordChangeGrantCookie,
  setAuthCookie,
  signToken,
} from '@/server/auth';
import { query } from '@/server/db';
import bcrypt from 'bcryptjs';
import {
  bumpAuthVersion,
  clearTrustedDeviceCookie,
  getAuthVersion,
  registerTrustedDevice,
  revokeAccountAccess,
  revokeOtherTrustedDevices,
} from '@/server/trustedDevices';

function passwordPolicyOk(pw: string): boolean {
  if (pw.length < 8) return false;
  const classes =
    (/[A-Z]/.test(pw) ? 1 : 0) +
    (/[a-z]/.test(pw) ? 1 : 0) +
    (/[0-9]/.test(pw) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(pw) ? 1 : 0);
  return classes >= 2;
}

/**
 * Change Instructor password.
 * Identity proof: authenticated session + current password (bcrypt).
 * Does NOT require Google/email verification or email OTP.
 */
export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as {
      role?: string;
      faculty_id?: number;
      id?: number;
      username?: string;
      name?: string;
    } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const current_password = String((body as { current_password?: unknown }).current_password ?? '');
    const new_password = String((body as { new_password?: unknown }).new_password ?? '');
    const confirm_password = String((body as { confirm_password?: unknown }).confirm_password ?? '');
    const logoutOtherDevices = Boolean((body as { logout_other_devices?: unknown }).logout_other_devices);

    if (!current_password) {
      return NextResponse.json({ error: 'Current password is required.' }, { status: 400 });
    }
    if (!new_password) {
      return NextResponse.json({ error: 'New password is required.' }, { status: 400 });
    }
    if (!confirm_password) {
      return NextResponse.json({ error: 'Please confirm your new password.' }, { status: 400 });
    }
    if (new_password !== confirm_password) {
      return NextResponse.json({ error: 'New passwords do not match.' }, { status: 400 });
    }
    if (!passwordPolicyOk(new_password)) {
      return NextResponse.json(
        { error: 'Use at least 8 characters with a mix of letters, numbers, and symbols.' },
        { status: 400 }
      );
    }
    if (current_password === new_password) {
      return NextResponse.json(
        { error: 'Your new password must be different from your current password.' },
        { status: 400 }
      );
    }

    const account = await query(
      'SELECT id, username, password_hash FROM instructor_accounts WHERE faculty_id = $1',
      [authUser.faculty_id]
    );
    if (account.rows.length === 0) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    const accountId = Number(account.rows[0].id);
    const valid = await bcrypt.compare(current_password, account.rows[0].password_hash);
    if (!valid) {
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 400 });
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await query(
      'UPDATE instructor_accounts SET password_hash = $1, updated_at = NOW() WHERE faculty_id = $2',
      [newHash, authUser.faculty_id]
    );

    /* Default: invalidate all sessions after password change.
       Optional checkbox keeps this browser signed in and revokes other trusted devices only.
       OTP preference and google_verified are not modified. */
    if (logoutOtherDevices) {
      await bumpAuthVersion('instructor', accountId);
      await revokeOtherTrustedDevices(req, 'instructor', accountId);
      const av = await getAuthVersion('instructor', accountId);
      const displayName = authUser.name || account.rows[0].username;
      const token = await signToken({
        id: accountId,
        username: account.rows[0].username,
        role: 'instructor',
        faculty_id: authUser.faculty_id,
        name: displayName,
        av,
      });
      const response = NextResponse.json({
        success: true,
        message: 'Password changed successfully.',
        reauth: false,
        kept_session: true,
      });
      setAuthCookie(response, token);
      clearPasswordChangeGrantCookie(response);
      await registerTrustedDevice({
        req,
        response,
        accountKind: 'instructor',
        accountId,
      });
      return response;
    }

    await revokeAccountAccess('instructor', accountId);
    const response = NextResponse.json({
      success: true,
      message: 'Password changed successfully.',
      reauth: true,
    });
    clearAuthCookie(response);
    clearTrustedDeviceCookie(response);
    clearPasswordChangeGrantCookie(response);
    return response;
  } catch (error) {
    console.error('[POST /api/instructor/profile/password]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
