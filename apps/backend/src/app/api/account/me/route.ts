import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { ensureUsersSchema } from '@/database/ensure-users-schema';
import { ensureOtpEnabledColumn } from '@/auth/otpPreference';
import { revokeAllTrustedDevices } from '@/auth/trustedDevices';
import {
  EMAIL_ALREADY_REGISTERED,
  assertEmailAvailable,
  claimAccountEmail,
  assertUsernameAllowed,
} from '@/auth/emailIdentity';
import { withAudit } from '@/services/audit';

// GET /api/account/me — fetch own user record (admin or program_chair)
export async function GET(req: NextRequest) {
  try {
    await ensureUsersSchema();
    await ensureOtpEnabledColumn();
    const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await query(
      `SELECT id, username, email, role, is_active, created_at, updated_at,
              program_id, google_verified, google_verified_at, google_picture, otp_enabled
       FROM users WHERE id = $1`,
      [auth.id]
    );
    if (result.rows.length === 0) return NextResponse.json({ error: 'User not found.' }, { status: 404 });

    return NextResponse.json({ user: result.rows[0] });
  } catch (error) {
    console.error('[GET /api/account/me]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH /api/account/me — update own username/email (cannot change role)
async function PATCH_handler(req: NextRequest) {
  try {
    await ensureUsersSchema();
    await ensureOtpEnabledColumn();
    const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { username, email } = await req.json();

    if (!username?.trim()) return NextResponse.json({ error: 'Username is required.' }, { status: 400 });
    if (!email?.trim()) return NextResponse.json({ error: 'Email is required.' }, { status: 400 });

    const emailCheck = await assertEmailAvailable(email, {
      accountKind: 'user',
      accountId: Number(auth.id),
    });
    if (!emailCheck.ok) {
      return NextResponse.json({ error: emailCheck.error, field: 'email' }, { status: 409 });
    }

    const before = await query(
      `SELECT email, otp_enabled, google_verified, role FROM users WHERE id = $1`,
      [auth.id]
    );
    const beforeRow = before.rows[0] as {
      email?: string;
      otp_enabled?: boolean;
      google_verified?: boolean;
      role?: string;
    } | undefined;

    const usernameCheck = assertUsernameAllowed(username, {
      emailVerified: beforeRow?.google_verified === true || beforeRow?.role === 'admin',
      verifiedEmail: emailCheck.email,
    });
    if (!usernameCheck.ok) {
      return NextResponse.json({ error: usernameCheck.error, field: 'username' }, { status: 400 });
    }

    const dupUser = await query(
      `SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2`,
      [usernameCheck.username, auth.id]
    );
    if (dupUser.rows.length > 0) {
      return NextResponse.json({ error: 'Username or email is already in use.' }, { status: 409 });
    }

    const prevEmail = String(beforeRow?.email ?? '').trim().toLowerCase();
    const nextEmail = emailCheck.email;
    const emailChanged = prevEmail !== nextEmail;
    const hadOtp = beforeRow?.otp_enabled === true;

    const claimed = await claimAccountEmail({
      email: nextEmail,
      accountKind: 'user',
      accountId: Number(auth.id),
    });
    if (!claimed.ok) {
      return NextResponse.json({ error: claimed.error, field: 'email' }, { status: 409 });
    }

    /* Changing email clears Google verification and OTP preference (no valid destination). */
    const result = await query(
      `UPDATE users SET
         username = $1,
         email = $2::varchar,
         google_sub = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN NULL ELSE google_sub END,
         google_verified = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN FALSE ELSE google_verified END,
         google_verified_at = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN NULL ELSE google_verified_at END,
         google_picture = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN NULL ELSE google_picture END,
         otp_enabled = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN FALSE ELSE otp_enabled END,
         updated_at = NOW()
       WHERE id = $3
       RETURNING id, username, email, role, is_active, created_at, updated_at,
                 program_id, google_verified, google_verified_at, google_picture, otp_enabled`,
      [usernameCheck.username, nextEmail, auth.id]
    );

    if (emailChanged) {
      await query(
        `UPDATE login_otp_challenges
         SET used_at = NOW()
         WHERE account_kind = 'user' AND account_id = $1 AND used_at IS NULL AND purpose = 'login'`,
        [auth.id]
      ).catch(() => {});
      if (hadOtp) {
        await revokeAllTrustedDevices('user', Number(auth.id));
      }
    }

    return NextResponse.json({ user: result.rows[0] });
  } catch (error) {
    const pg = error as { code?: string };
    if (pg?.code === '23505') {
      return NextResponse.json({ error: EMAIL_ALREADY_REGISTERED, field: 'email' }, { status: 409 });
    }
    console.error('[PATCH /api/account/me]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const PATCH = withAudit(PATCH_handler);
