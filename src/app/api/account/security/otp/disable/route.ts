import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getAuthUser, getDisableOtpChallengeId } from '@/server/auth';
import { query } from '@/server/db';
import { ensureUsersSchema } from '@/server/ensure-users-schema';
import {
  cancelDisableOtpChallenge,
  resendDisableOtpChallenge,
  startDisableOtpChallenge,
  verifyDisableOtpChallenge,
} from '@/server/loginOtp';
import {
  ensureOtpEnabledColumn,
  getOtpPreferenceSnapshot,
  type OtpAccountKind,
} from '@/server/otpPreference';
import { consumeRate } from '@/server/rateLimit';

type AuthPayload = {
  role?: string;
  id?: number;
  faculty_id?: number;
};

function resolveAccount(
  auth: AuthPayload
): { accountKind: OtpAccountKind; accountId: number; role: string } | null {
  if (!auth.role || !auth.id) return null;
  if (auth.role === 'admin' || auth.role === 'department_chair' || auth.role === 'program_chair') {
    return { accountKind: 'user', accountId: Number(auth.id), role: auth.role };
  }
  if (auth.role === 'instructor') {
    return { accountKind: 'instructor', accountId: Number(auth.id), role: 'instructor' };
  }
  return null;
}

async function verifyCurrentPassword(
  accountKind: OtpAccountKind,
  accountId: number,
  currentPassword: string
): Promise<boolean> {
  if (accountKind === 'instructor') {
    const row = await query(`SELECT password_hash FROM instructor_accounts WHERE id = $1`, [accountId]);
    if (!row.rows[0]?.password_hash) return false;
    return bcrypt.compare(currentPassword, row.rows[0].password_hash);
  }
  const row = await query(`SELECT password_hash FROM users WHERE id = $1`, [accountId]);
  if (!row.rows[0]?.password_hash) return false;
  return bcrypt.compare(currentPassword, row.rows[0].password_hash);
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

async function authContext(req: NextRequest) {
  await ensureUsersSchema();
  await ensureOtpEnabledColumn();
  const auth = (await getAuthUser(req)) as AuthPayload | null;
  const resolved = auth ? resolveAccount(auth) : null;
  return resolved;
}

/**
 * POST — Stage 1: verify current password, then send a fresh disable-OTP code.
 * Does not set otp_enabled = false.
 */
export async function POST(req: NextRequest) {
  try {
    const resolved = await authContext(req);
    if (!resolved) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const ip = clientIp(req);
    const limit = consumeRate(`disable-otp-start:${ip}:${resolved.accountKind}:${resolved.accountId}`, 8, 15 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Please try again in ${limit.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const snapshot = await getOtpPreferenceSnapshot(
      resolved.accountKind,
      resolved.accountId,
      resolved.role
    );
    if (!snapshot) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }
    if (!snapshot.otp_enabled) {
      return NextResponse.json(
        { error: 'Two-Step Verification is already turned off.', otp_enabled: false },
        { status: 400 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const currentPassword = String((body as { current_password?: unknown }).current_password ?? '');
    if (!currentPassword) {
      return NextResponse.json(
        { error: 'Enter your current password to continue.' },
        { status: 400 }
      );
    }

    const valid = await verifyCurrentPassword(
      resolved.accountKind,
      resolved.accountId,
      currentPassword
    );
    if (!valid) {
      return NextResponse.json({ error: 'Incorrect password.' }, { status: 400 });
    }

    if (!snapshot.email) {
      return NextResponse.json(
        { error: 'A verified email is required to confirm this change.' },
        { status: 400 }
      );
    }

    return startDisableOtpChallenge({
      accountKind: resolved.accountKind,
      accountId: resolved.accountId,
      role: resolved.role,
      email: snapshot.email,
    });
  } catch (error) {
    console.error('[POST /api/account/security/otp/disable]', error);
    return NextResponse.json({ error: 'Unable to start verification.' }, { status: 500 });
  }
}

/**
 * PUT — Stage 2: verify fresh disable-OTP code, then disable OTP + clear trusted devices.
 */
export async function PUT(req: NextRequest) {
  try {
    const resolved = await authContext(req);
    if (!resolved) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const ip = clientIp(req);
    const limit = consumeRate(`disable-otp-verify:${ip}:${resolved.accountKind}:${resolved.accountId}`, 20, 15 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Too many verification attempts. Please try again in ${limit.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({}));
    return verifyDisableOtpChallenge({
      challengeId: getDisableOtpChallengeId(req),
      rawCode: (body as { code?: unknown }).code,
      accountKind: resolved.accountKind,
      accountId: resolved.accountId,
    });
  } catch (error) {
    console.error('[PUT /api/account/security/otp/disable]', error);
    return NextResponse.json({ error: 'Unable to verify code.' }, { status: 500 });
  }
}

/** PATCH — resend disable-OTP code (existing cooldown rules). */
export async function PATCH(req: NextRequest) {
  try {
    const resolved = await authContext(req);
    if (!resolved) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const ip = clientIp(req);
    const limit = consumeRate(`disable-otp-resend:${ip}:${resolved.accountKind}:${resolved.accountId}`, 8, 15 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Too many resend requests. Please try again in ${limit.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    return resendDisableOtpChallenge({
      challengeId: getDisableOtpChallengeId(req),
      accountKind: resolved.accountKind,
      accountId: resolved.accountId,
    });
  } catch (error) {
    console.error('[PATCH /api/account/security/otp/disable]', error);
    return NextResponse.json({ error: 'Unable to resend code.' }, { status: 500 });
  }
}

/** DELETE — cancel in-progress disable challenge. */
export async function DELETE(req: NextRequest) {
  const resolved = await authContext(req);
  if (!resolved) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return cancelDisableOtpChallenge(getDisableOtpChallengeId(req));
}
