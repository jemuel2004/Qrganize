import { NextRequest, NextResponse } from 'next/server';
import { transaction } from '@/server/db';
import { chairLoginResponse, instructorLoginResponse } from '@/server/auth';
import { isGoogleIdentity, verifyGoogleIdToken } from '@/server/verifyGoogleIdToken';
import { findTrustedDevice, getAuthVersion } from '@/server/trustedDevices';
import { pickRegisteredEmail, startLoginOtp } from '@/server/loginOtp';
import { ensureOtpEnabledColumn } from '@/server/otpPreference';
import { normalizeEmail } from '@/server/emailIdentity';
import {
  clearEmailVerifyCookie,
  readEmailVerifyChallenge,
} from '@/server/emailVerifyChallenge';
import { checkRateLimit, clearFailures, consumeRate } from '@/server/rateLimit';

const OTP_START_WINDOW_MS = 15 * 60 * 1000;
const OTP_START_MAX = 8;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

/**
 * Completes Google email ownership verification after a successful password check
 * that was blocked because the account was unverified. Does not accept a full session.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureOtpEnabledColumn();
    const ip = clientIp(req);
    const limitResult = checkRateLimit(ip);
    if (!limitResult.allowed) {
      return NextResponse.json(
        { error: `Too many failed attempts. Please try again in ${limitResult.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const challenge = await readEmailVerifyChallenge(req);
    if (!challenge) {
      return NextResponse.json(
        { error: 'Invalid verification request.', email_verification_required: true },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const identity = await verifyGoogleIdToken((body as { credential?: unknown }).credential);
    if (!isGoogleIdentity(identity)) {
      return NextResponse.json({ error: identity.error }, { status: identity.status });
    }

    if (identity.email !== normalizeEmail(challenge.email)) {
      return NextResponse.json(
        {
          error:
            'The Google account you selected does not match the email registered for this account.',
        },
        { status: 403 }
      );
    }

    const currentAv = await getAuthVersion(challenge.accountKind, challenge.accountId);
    if (currentAv !== challenge.av) {
      const res = NextResponse.json(
        { error: 'This verification link/code has expired. Please log in again.' },
        { status: 401 }
      );
      clearEmailVerifyCookie(res);
      return res;
    }

    if (challenge.role === 'instructor') {
      const outcome = await transaction(async client => {
        const account = await client.query<{
          id: number;
          email: string;
          google_sub: string | null;
          google_verified: boolean;
          is_active: boolean;
          otp_enabled: boolean;
          faculty_id: number;
          faculty_active: boolean;
          first_name: string | null;
          last_name: string | null;
          name: string | null;
          faculty_email: string | null;
          username: string;
        }>(
          `SELECT ia.id, ia.email, ia.google_sub, ia.google_verified, ia.is_active, ia.otp_enabled,
                  ia.username, f.id AS faculty_id, f.is_active AS faculty_active,
                  f.first_name, f.last_name, f.name, f.email AS faculty_email
           FROM instructor_accounts ia
           JOIN faculty f ON f.id = ia.faculty_id
           WHERE ia.id = $1
           FOR UPDATE`,
          [challenge.accountId]
        );
        const row = account.rows[0];
        if (!row) return { kind: 'missing' as const };
        if (!row.is_active || !row.faculty_active) return { kind: 'inactive' as const };
        if (normalizeEmail(row.email) !== identity.email) return { kind: 'mismatch' as const };
        if (row.google_verified === true && row.google_sub === identity.sub) {
          return { kind: 'already' as const, row };
        }
        if (row.google_verified === true) {
          return { kind: 'already' as const, row };
        }

        const taken = await client.query(
          `SELECT id FROM instructor_accounts WHERE google_sub = $1 AND id <> $2`,
          [identity.sub, challenge.accountId]
        );
        if (taken.rows.length > 0) return { kind: 'duplicate' as const };

        const chairTaken = await client.query(
          `SELECT id FROM users WHERE google_sub = $1`,
          [identity.sub]
        );
        if (chairTaken.rows.length > 0) return { kind: 'duplicate' as const };

        await client.query(
          `UPDATE instructor_accounts
           SET google_sub = $1,
               google_verified = TRUE,
               google_verified_at = NOW(),
               google_picture = $2,
               updated_at = NOW()
           WHERE id = $3`,
          [identity.sub, identity.picture, challenge.accountId]
        );

        return { kind: 'ok' as const, row };
      });

      if (outcome.kind === 'missing') {
        const res = NextResponse.json({ error: 'Invalid verification request.' }, { status: 401 });
        clearEmailVerifyCookie(res);
        return res;
      }
      if (outcome.kind === 'inactive') {
        return NextResponse.json(
          { error: 'This instructor account has been deactivated. Please contact the administrator.' },
          { status: 403 }
        );
      }
      if (outcome.kind === 'mismatch') {
        return NextResponse.json(
          { error: 'The Google account you selected does not match the email registered for this account.' },
          { status: 403 }
        );
      }
      if (outcome.kind === 'duplicate') {
        return NextResponse.json(
          { error: 'This Google account is already connected to another account.' },
          { status: 409 }
        );
      }

      const row = outcome.row;
      if (outcome.kind === 'already' && row.google_verified) {
        /* Continue into login below — already verified is OK. */
      }

      clearFailures(ip);
      const instructorUser = {
        account_id: row.id,
        username: row.username,
        faculty_id: row.faculty_id,
        first_name: row.first_name,
        last_name: row.last_name,
        name: row.name,
      };

      if (row.otp_enabled === true) {
        const trusted = await findTrustedDevice(req, 'instructor', row.id);
        if (trusted) {
          const res = await instructorLoginResponse(instructorUser, { req, registerDevice: true });
          clearEmailVerifyCookie(res);
          return res;
        }
        const otpLimit = consumeRate(`otp-start:${ip}`, OTP_START_MAX, OTP_START_WINDOW_MS);
        if (!otpLimit.allowed) {
          return NextResponse.json(
            { error: `Too many verification requests. Please try again in ${otpLimit.retryAfterSeconds} seconds.` },
            { status: 429 }
          );
        }
        const otpRes = await startLoginOtp({
          accountKind: 'instructor',
          accountId: row.id,
          role: 'instructor',
          email: pickRegisteredEmail(row.email, row.faculty_email),
          payload: { kind: 'instructor', ...instructorUser },
        });
        clearEmailVerifyCookie(otpRes);
        return otpRes;
      }

      const res = await instructorLoginResponse(instructorUser, { req, registerDevice: true });
      clearEmailVerifyCookie(res);
      return res;
    }

    /* Department Chair */
    const outcome = await transaction(async client => {
      const account = await client.query<{
        id: number;
        email: string;
        google_sub: string | null;
        google_verified: boolean;
        is_active: boolean;
        otp_enabled: boolean;
        username: string;
        program_id: number | null;
      }>(
        `SELECT id, email, google_sub, google_verified, is_active, otp_enabled, username, program_id
         FROM users
         WHERE id = $1 AND role = 'department_chair'
         FOR UPDATE`,
        [challenge.accountId]
      );
      const row = account.rows[0];
      if (!row) return { kind: 'missing' as const };
      if (row.is_active === false) return { kind: 'inactive' as const };
      if (normalizeEmail(row.email) !== identity.email) return { kind: 'mismatch' as const };
      if (row.google_verified === true) return { kind: 'already' as const, row };

      const taken = await client.query(
        `SELECT id FROM users WHERE google_sub = $1 AND id <> $2`,
        [identity.sub, challenge.accountId]
      );
      if (taken.rows.length > 0) return { kind: 'duplicate' as const };

      const instructorTaken = await client.query(
        `SELECT id FROM instructor_accounts WHERE google_sub = $1`,
        [identity.sub]
      );
      if (instructorTaken.rows.length > 0) return { kind: 'duplicate' as const };

      await client.query(
        `UPDATE users
         SET google_sub = $1,
             google_verified = TRUE,
             google_verified_at = NOW(),
             google_picture = $2,
             updated_at = NOW()
         WHERE id = $3 AND role = 'department_chair'`,
        [identity.sub, identity.picture, challenge.accountId]
      );

      return { kind: 'ok' as const, row };
    });

    if (outcome.kind === 'missing') {
      const res = NextResponse.json({ error: 'Invalid verification request.' }, { status: 401 });
      clearEmailVerifyCookie(res);
      return res;
    }
    if (outcome.kind === 'inactive') {
      return NextResponse.json(
        { error: 'This account has been deactivated. Please contact the administrator.' },
        { status: 403 }
      );
    }
    if (outcome.kind === 'mismatch') {
      return NextResponse.json(
        { error: 'The Google account you selected does not match the email registered for this account.' },
        { status: 403 }
      );
    }
    if (outcome.kind === 'duplicate') {
      return NextResponse.json(
        { error: 'This Google account is already connected to another account.' },
        { status: 409 }
      );
    }

    const row = outcome.row;
    clearFailures(ip);
    const chairUser = {
      id: row.id,
      username: row.username,
      program_id: row.program_id,
    };

    if (row.otp_enabled === true) {
      const trusted = await findTrustedDevice(req, 'user', row.id);
      if (trusted) {
        const res = await chairLoginResponse(chairUser, { req, registerDevice: true });
        clearEmailVerifyCookie(res);
        return res;
      }
      const otpLimit = consumeRate(`otp-start:${ip}`, OTP_START_MAX, OTP_START_WINDOW_MS);
      if (!otpLimit.allowed) {
        return NextResponse.json(
          { error: `Too many verification requests. Please try again in ${otpLimit.retryAfterSeconds} seconds.` },
          { status: 429 }
        );
      }
      const otpRes = await startLoginOtp({
        accountKind: 'user',
        accountId: row.id,
        role: 'department_chair',
        email: String(row.email ?? ''),
        payload: { kind: 'department_chair', ...chairUser },
      });
      clearEmailVerifyCookie(otpRes);
      return otpRes;
    }

    const res = await chairLoginResponse(chairUser, { req, registerDevice: true });
    clearEmailVerifyCookie(res);
    return res;
  } catch (error) {
    console.error('[auth/verify-email-google]', error);
    return NextResponse.json({ error: 'Failed to verify Google account.' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const challenge = await readEmailVerifyChallenge(req);
  if (!challenge) {
    return NextResponse.json({ pending: false });
  }
  const at = challenge.email.indexOf('@');
  const local = at > 0 ? challenge.email.slice(0, at) : '';
  const domain = at > 0 ? challenge.email.slice(at + 1) : '';
  const masked =
    local.length > 0
      ? `${local.slice(0, Math.min(2, local.length))}${'*'.repeat(Math.max(3, local.length - 2))}@${domain}`
      : 'your registered email';
  return NextResponse.json({
    pending: true,
    role: challenge.role,
    masked_email: masked,
    EMAIL_VERIFICATION_REQUIRED: true,
  });
}

export async function DELETE() {
  const res = NextResponse.json({ success: true });
  clearEmailVerifyCookie(res);
  return res;
}
