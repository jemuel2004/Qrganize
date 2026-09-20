import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser, getPasswordOtpChallengeId } from '@/server/auth';
import { query } from '@/server/db';
import {
  cancelPasswordChangeOtp,
  resendPasswordChangeOtp,
  startPasswordChangeOtp,
  verifyPasswordChangeOtp,
} from '@/server/loginOtp';
import { consumeRate } from '@/server/rateLimit';

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

async function instructorAccount(facultyId: number) {
  const result = await query(
    `SELECT id, username, email, google_verified
     FROM instructor_accounts
     WHERE faculty_id = $1`,
    [facultyId]
  );
  return result.rows[0] as
    | { id: number; username: string; email: string; google_verified: boolean }
    | undefined;
}

/** POST — start password-change OTP */
export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as {
      role?: string;
      faculty_id?: number;
      id?: number;
    } | null;
    if (!auth || auth.role !== 'instructor' || !auth.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const ip = clientIp(req);
    const limit = consumeRate(`pw-otp-start:${ip}`, 8, 15 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Please try again in ${limit.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const account = await instructorAccount(auth.faculty_id);
    if (!account) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    return startPasswordChangeOtp({
      accountId: Number(account.id),
      facultyId: auth.faculty_id,
      username: account.username,
      email: account.email,
    });
  } catch (error) {
    console.error('[POST /api/instructor/profile/password-otp]', error);
    return NextResponse.json({ error: 'Unable to start verification.' }, { status: 500 });
  }
}

/** PUT — verify password-change OTP and issue short-lived grant */
export async function PUT(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as {
      role?: string;
      faculty_id?: number;
      id?: number;
    } | null;
    if (!auth || auth.role !== 'instructor' || !auth.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const ip = clientIp(req);
    const limit = consumeRate(`pw-otp-verify:${ip}`, 20, 15 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Too many verification attempts. Please try again in ${limit.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const account = await instructorAccount(auth.faculty_id);
    if (!account) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    return verifyPasswordChangeOtp(
      getPasswordOtpChallengeId(req),
      (body as { code?: unknown }).code,
      Number(account.id),
      auth.faculty_id
    );
  } catch (error) {
    console.error('[PUT /api/instructor/profile/password-otp]', error);
    return NextResponse.json({ error: 'Unable to verify code.' }, { status: 500 });
  }
}

/** PATCH — resend password-change OTP */
export async function PATCH(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as {
      role?: string;
      faculty_id?: number;
      id?: number;
    } | null;
    if (!auth || auth.role !== 'instructor' || !auth.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const ip = clientIp(req);
    const limit = consumeRate(`pw-otp-resend:${ip}`, 8, 15 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Too many resend requests. Please try again in ${limit.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const account = await instructorAccount(auth.faculty_id);
    if (!account) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    return resendPasswordChangeOtp(getPasswordOtpChallengeId(req), Number(account.id));
  } catch (error) {
    console.error('[PATCH /api/instructor/profile/password-otp]', error);
    return NextResponse.json({ error: 'Unable to resend code.' }, { status: 500 });
  }
}

/** DELETE — cancel password-change OTP */
export async function DELETE(req: NextRequest) {
  const auth = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
  if (!auth || auth.role !== 'instructor' || !auth.faculty_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return cancelPasswordChangeOtp(getPasswordOtpChallengeId(req));
}
