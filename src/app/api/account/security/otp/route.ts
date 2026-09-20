import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { ensureUsersSchema } from '@/server/ensure-users-schema';
import {
  ensureOtpEnabledColumn,
  getOtpPreferenceSnapshot,
  type OtpAccountKind,
} from '@/server/otpPreference';

type AuthPayload = {
  role?: string;
  id?: number;
  faculty_id?: number;
};

function resolveAccount(auth: AuthPayload): { accountKind: OtpAccountKind; accountId: number; role: string } | null {
  if (!auth.role || !auth.id) return null;
  if (auth.role === 'admin' || auth.role === 'department_chair') {
    return { accountKind: 'user', accountId: Number(auth.id), role: auth.role };
  }
  if (auth.role === 'instructor') {
    return { accountKind: 'instructor', accountId: Number(auth.id), role: 'instructor' };
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    await ensureUsersSchema();
    await ensureOtpEnabledColumn();
    const auth = (await getAuthUser(req)) as AuthPayload | null;
    const resolved = auth ? resolveAccount(auth) : null;
    if (!resolved) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const snapshot = await getOtpPreferenceSnapshot(
      resolved.accountKind,
      resolved.accountId,
      resolved.role
    );
    if (!snapshot) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    return NextResponse.json({
      otp_enabled: snapshot.otp_enabled,
      google_verified: snapshot.google_verified,
      email: snapshot.email,
      can_enable: snapshot.can_enable,
      requires_google_verification: snapshot.requires_google_verification,
    });
  } catch (error) {
    console.error('[GET /api/account/security/otp]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Enable Two-Step Verification only.
 * Disabling requires POST/PUT /api/account/security/otp/disable (password + fresh OTP).
 */
export async function PUT(req: NextRequest) {
  try {
    await ensureUsersSchema();
    await ensureOtpEnabledColumn();
    const auth = (await getAuthUser(req)) as AuthPayload | null;
    const resolved = auth ? resolveAccount(auth) : null;
    if (!resolved) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    if (body?.otp_enabled === false) {
      return NextResponse.json(
        {
          error:
            'Turning off Two-Step Verification requires password and email verification. Use the secure disable flow.',
        },
        { status: 400 }
      );
    }
    if (body?.otp_enabled !== true) {
      return NextResponse.json({ error: 'otp_enabled must be true to enable Two-Step Verification.' }, { status: 400 });
    }

    const snapshot = await getOtpPreferenceSnapshot(
      resolved.accountKind,
      resolved.accountId,
      resolved.role
    );
    if (!snapshot) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    if (snapshot.otp_enabled) {
      return NextResponse.json({
        otp_enabled: true,
        google_verified: snapshot.google_verified,
        email: snapshot.email,
        can_enable: snapshot.can_enable,
        requires_google_verification: snapshot.requires_google_verification,
      });
    }
    if (!snapshot.can_enable) {
      const message = snapshot.requires_google_verification
        ? 'Verify your Google email account before enabling Two-Step Verification.'
        : 'Add a valid email address to your account before enabling Two-Step Verification.';
      return NextResponse.json({ error: message }, { status: 400 });
    }

    if (resolved.accountKind === 'instructor') {
      await query(
        `UPDATE instructor_accounts SET otp_enabled = TRUE, updated_at = NOW() WHERE id = $1`,
        [resolved.accountId]
      );
    } else {
      await query(
        `UPDATE users SET otp_enabled = TRUE, updated_at = NOW() WHERE id = $1`,
        [resolved.accountId]
      );
    }

    const next = await getOtpPreferenceSnapshot(
      resolved.accountKind,
      resolved.accountId,
      resolved.role
    );
    return NextResponse.json({
      otp_enabled: next?.otp_enabled === true,
      google_verified: next?.google_verified === true,
      email: next?.email ?? null,
      can_enable: next?.can_enable === true,
      requires_google_verification: next?.requires_google_verification === true,
    });
  } catch (error) {
    console.error('[PUT /api/account/security/otp]', error);
    return NextResponse.json({ error: 'Failed to update Two-Step Verification.' }, { status: 500 });
  }
}
