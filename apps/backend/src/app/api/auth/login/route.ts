import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { ensureUsersSchema } from '@/database/ensure-users-schema';
import bcrypt from 'bcryptjs';
import { pickRegisteredEmail, startLoginOtp } from '@/auth/loginOtp';
import { adminLoginResponse, chairLoginResponse, instructorLoginResponse } from '@/auth/auth';
import { findTrustedDevice } from '@/auth/trustedDevices';
import { ensureOtpEnabledColumn } from '@/auth/otpPreference';
import { checkRateLimit, clearFailures, consumeRate, recordFailure } from '@/auth/rateLimit';
import {
  EMAIL_AS_USERNAME_REQUIRES_VERIFICATION,
  isEmailOwnershipVerified,
  looksLikeEmail,
} from '@/auth/emailIdentity';
import { clearEmailVerifyCookie } from '@/auth/emailVerifyChallenge';
import { withAudit } from '@/services/audit';
import { recordPasswordStrength } from '@/auth/passwordChange';

const OTP_START_WINDOW_MS = 15 * 60 * 1000;
const OTP_START_MAX = 8;

/** Wrong passwords for one username — from any number of addresses — before it is locked for 15 minutes */
const ACCOUNT_MAX_FAILURES = 10;
/** Longest username / password accepted (bcrypt only reads the first 72 bytes) */
const MAX_LOGIN_ID = 254;
const MAX_PASSWORD = 256;
/** Sign-in messages: the username was found but the password is wrong / no such username */
const WRONG_PASSWORD = 'Incorrect password.';
const NO_SUCH_ACCOUNT = 'Username and password are incorrect.';

/** Compared when no account matches, so an unknown username takes as long as a wrong password
 *  (response time can't be used to find out which usernames exist) */
const NO_ACCOUNT_HASH = bcrypt.hashSync('qrganize-no-such-account', 12); // = HASH_ROUNDS

/** Password hash cost used for every account (older seeded hashes used 10) */
const HASH_ROUNDS = 12;

/**
 * Hashes made with a lower cost are upgraded at sign-in (the password is known
 * then), so every account is equally slow to guess offline — and an unknown
 * username, checked against NO_ACCOUNT_HASH, takes as long as a real one.
 */
function upgradeOldHash(table: 'users' | 'instructor_accounts', id: number, password: string, hash: string): void {
  try {
    if (bcrypt.getRounds(hash) >= HASH_ROUNDS) return;
  } catch {
    return; // not a bcrypt hash
  }
  void bcrypt.hash(password, HASH_ROUNDS)
    .then(next => query(`UPDATE ${table} SET password_hash = $1 WHERE id = $2 AND password_hash = $3`, [next, id, hash]))
    .catch(err => console.warn('[auth/login] could not upgrade the password hash:', (err as Error).message));
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

function tooManyOtpStarts(ip: string) {
  const limit = consumeRate(`otp-start:${ip}`, OTP_START_MAX, OTP_START_WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Too many verification requests. Please try again in ${limit.retryAfterSeconds} seconds.` },
      { status: 429 }
    );
  }
  return null;
}

/** Attach cookie cleanup so stale verify-email challenges never block a normal session. */
function withLoginCookies(res: NextResponse): NextResponse {
  clearEmailVerifyCookie(res);
  return res;
}

/**
 * Unverified accounts may log in with a normal username.
 * Using an email-shaped login identifier requires verified email ownership.
 */
function rejectUnverifiedEmailLogin(
  loginId: string,
  verified: boolean
): NextResponse | null {
  if (looksLikeEmail(loginId) && !verified) {
    return NextResponse.json(
      {
        error: EMAIL_AS_USERNAME_REQUIRES_VERIFICATION,
        EMAIL_AS_USERNAME_REQUIRES_VERIFICATION: true,
      },
      { status: 403 }
    );
  }
  return null;
}

async function POST_handler(req: NextRequest) {
  try {
    await ensureUsersSchema();
    await ensureOtpEnabledColumn();

    const ip = clientIp(req);
    const limitResult = checkRateLimit(ip);
    if (!limitResult.allowed) {
      return NextResponse.json(
        { error: `Too many failed login attempts. Please try again in ${limitResult.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { username, password, role } = body as Record<string, unknown>;
    const loginId = String(username ?? '').trim();

    if (!loginId || !password) {
      return NextResponse.json({ error: 'Username and password are required.' }, { status: 400 });
    }
    if (loginId.length > MAX_LOGIN_ID || String(password).length > MAX_PASSWORD) {
      recordFailure(ip);
      return NextResponse.json({ error: NO_SUCH_ACCOUNT }, { status: 401 });
    }

    if (!role || !['admin_chair', 'instructor'].includes(String(role))) {
      return NextResponse.json({ error: 'Please select a valid role.' }, { status: 400 });
    }

    /* Per-account lockout as well as per-address: guessing one account's password
       from many addresses (or a forged X-Forwarded-For) is stopped too. Counted for
       unknown usernames alike, so a lockout never reveals which accounts exist. */
    const accountKey = `login-account:${String(role)}:${loginId.toLowerCase()}`;
    const accountLimit = checkRateLimit(accountKey);
    if (!accountLimit.allowed) {
      return NextResponse.json(
        { error: `Too many failed login attempts. Please try again in ${accountLimit.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }
    const loginFailed = () => {
      recordFailure(ip);
      recordFailure(accountKey, ACCOUNT_MAX_FAILURES);
    };

    /*
     * Administrator, Department Chair, and Program Chair share one login
     * option ("Administrator / Chair"). The client never states which of the
     * three it is — the row's actual `role` column (trusted DB state, never
     * a client claim) decides which login response/permissions apply.
     */
    if (role === 'admin_chair') {
      const result = await query(
        `SELECT id, username, email, role, password_hash, is_active, program_id, google_verified, otp_enabled
         FROM users WHERE username = $1 OR email = $1`,
        [loginId]
      );

      if (result.rows.length === 0) {
        await bcrypt.compare(String(password), NO_ACCOUNT_HASH);
        loginFailed();
        return NextResponse.json({ error: NO_SUCH_ACCOUNT }, { status: 401 });
      }

      const user = result.rows[0];
      const validPassword = await bcrypt.compare(String(password), user.password_hash);
      if (!validPassword) {
        loginFailed();
        return NextResponse.json({ error: WRONG_PASSWORD }, { status: 401 });
      }
      upgradeOldHash('users', Number(user.id), String(password), String(user.password_hash));
      // A default / common password must be changed before anything else (auth/passwordChange.ts)
      await recordPasswordStrength('user', Number(user.id), String(password), user.username as string);

      const actualRole = user.role as string;
      if (!['admin', 'department_chair', 'program_chair'].includes(actualRole)) {
        loginFailed();
        return NextResponse.json(
          { error: 'This account is not allowed to login as Administrator / Chair.' },
          { status: 403 }
        );
      }

      if (user.is_active === false) {
        return NextResponse.json(
          { error: 'This account has been deactivated. Please contact the administrator.' },
          { status: 403 }
        );
      }

      if (actualRole === 'admin') {
        /* Admin: OTP only when otp_enabled (no Google verify product). */
        const otpEnabled = user.otp_enabled === true;
        if (!otpEnabled) {
          clearFailures(ip);
          clearFailures(accountKey);
          return withLoginCookies(
            await adminLoginResponse({ id: user.id, username: user.username }, { req, registerDevice: true })
          );
        }

        const trusted = await findTrustedDevice(req, 'user', user.id);
        if (trusted) {
          clearFailures(ip);
          clearFailures(accountKey);
          return withLoginCookies(
            await adminLoginResponse(
              { id: user.id, username: user.username },
              { req, registerDevice: true }
            )
          );
        }

        const blocked = tooManyOtpStarts(ip);
        if (blocked) return blocked;

        return withLoginCookies(
          await startLoginOtp({
            accountKind: 'user',
            accountId: user.id,
            role: 'admin',
            email: String(user.email ?? ''),
            payload: { kind: 'admin', id: user.id, username: user.username },
          })
        );
      }

      // department_chair or program_chair — same chair-style login flow,
      // differing only in the permissions/home page chairLoginResponse assigns.
      const chairRole = actualRole as 'department_chair' | 'program_chair';

      const emailVerified = isEmailOwnershipVerified({
        role: chairRole,
        google_verified: user.google_verified,
      });
      const blockedEmailId = rejectUnverifiedEmailLogin(loginId, emailVerified);
      if (blockedEmailId) return blockedEmailId;

      const chairUser = {
        id: user.id as number,
        username: user.username as string,
        program_id: (user.program_id as number | null) ?? null,
      };

      /* OTP only when user preference is ON and email ownership is verified. */
      const otpEnabled = user.otp_enabled === true && emailVerified;
      if (!otpEnabled) {
        clearFailures(ip);
        clearFailures(accountKey);
        return withLoginCookies(
          await chairLoginResponse(chairUser, chairRole, { req, registerDevice: true })
        );
      }

      const trusted = await findTrustedDevice(req, 'user', user.id);
      if (trusted) {
        clearFailures(ip);
        clearFailures(accountKey);
        return withLoginCookies(
          await chairLoginResponse(chairUser, chairRole, { req, registerDevice: true })
        );
      }

      const blocked = tooManyOtpStarts(ip);
      if (blocked) return blocked;

      return withLoginCookies(
        await startLoginOtp({
          accountKind: 'user',
          accountId: user.id,
          role: chairRole,
          email: String(user.email ?? ''),
          payload: { kind: chairRole, ...chairUser },
        })
      );

    } else {
      const result = await query(
        `SELECT
           ia.id AS account_id,
           ia.username, ia.email, ia.password_hash,
           ia.is_active AS account_active,
           ia.google_verified,
           ia.otp_enabled,
           f.id AS faculty_id,
           f.name, f.first_name, f.last_name, f.email AS faculty_email,
           f.is_active AS faculty_active
         FROM instructor_accounts ia
         JOIN faculty f ON ia.faculty_id = f.id
         WHERE (ia.username = $1 OR ia.email = $1)`,
        [loginId]
      );

      if (result.rows.length === 0) {
        await bcrypt.compare(String(password), NO_ACCOUNT_HASH);
        loginFailed();
        return NextResponse.json({ error: NO_SUCH_ACCOUNT }, { status: 401 });
      }

      const row = result.rows[0];

      const validPassword = await bcrypt.compare(String(password), row.password_hash);
      if (!validPassword) {
        loginFailed();
        return NextResponse.json({ error: WRONG_PASSWORD }, { status: 401 });
      }
      upgradeOldHash('instructor_accounts', Number(row.account_id), String(password), String(row.password_hash));
      await recordPasswordStrength('instructor', Number(row.account_id), String(password), row.username as string);

      if (!row.account_active || !row.faculty_active) {
        return NextResponse.json(
          { error: 'This faculty account has been deactivated. Please contact the administrator.' },
          { status: 403 }
        );
      }

      const emailVerified = isEmailOwnershipVerified({
        role: 'instructor',
        google_verified: row.google_verified,
      });
      const blockedEmailId = rejectUnverifiedEmailLogin(loginId, emailVerified);
      if (blockedEmailId) return blockedEmailId;

      const instructorUser = {
        account_id: row.account_id as number,
        username: row.username as string,
        faculty_id: row.faculty_id as number,
        first_name: row.first_name as string | null,
        last_name: row.last_name as string | null,
        name: row.name as string | null,
      };

      const otpEnabled = row.otp_enabled === true && emailVerified;

      if (!otpEnabled) {
        clearFailures(ip);
        clearFailures(accountKey);
        return withLoginCookies(
          await instructorLoginResponse(instructorUser, { req, registerDevice: true })
        );
      }

      const trusted = await findTrustedDevice(req, 'instructor', row.account_id);
      if (trusted) {
        clearFailures(ip);
        clearFailures(accountKey);
        return withLoginCookies(
          await instructorLoginResponse(instructorUser, { req, registerDevice: true })
        );
      }

      const blocked = tooManyOtpStarts(ip);
      if (blocked) return blocked;

      return withLoginCookies(
        await startLoginOtp({
          accountKind: 'instructor',
          accountId: row.account_id,
          role: 'instructor',
          email: pickRegisteredEmail(row.email, row.faculty_email),
          payload: {
            kind: 'instructor',
            ...instructorUser,
          },
        })
      );
    }

  } catch (error) {
    console.error('[auth/login]', error);
    return NextResponse.json({ error: 'A server error occurred. Please try again.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
