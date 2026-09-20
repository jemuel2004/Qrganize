import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/server/db';
import {
  adminLoginResponse,
  chairLoginResponse,
  clearOtpCookie,
  instructorLoginResponse,
  setOtpCookie,
  setPasswordOtpCookie,
  clearPasswordOtpCookie,
  setDisableOtpCookie,
  clearDisableOtpCookie,
  signShortToken,
  setPasswordChangeGrantCookie,
  clearPasswordChangeGrantCookie,
  verifyToken,
} from '@/server/auth';
import { isMailConfigured, sendLoginOtpEmail } from '@/server/mailer';
import { ensureOtpPurposeColumn } from '@/server/schema-guard';
import { getRequiredHmacSecret } from '@/lib/authSecret';
import { getAccountOtpEnabled, disableAccountOtp, type OtpAccountKind } from '@/server/otpPreference';
import { revokeAllTrustedDevices } from '@/server/trustedDevices';

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 60;
export const OTP_CODE_LENGTH = 6;

export type SessionPayload =
  | { kind: 'admin'; id: number; username: string }
  | { kind: 'department_chair'; id: number; username: string; program_id?: number | null }
  | {
      kind: 'instructor';
      account_id: number;
      username: string;
      faculty_id: number;
      first_name: string | null;
      last_name: string | null;
      name: string | null;
    };

type ChallengeRow = {
  id: string;
  account_kind: 'user' | 'instructor';
  account_id: number;
  role: string;
  email: string;
  code_hash: string;
  session_payload: SessionPayload;
  expires_at: Date;
  attempt_count: number;
  used_at: Date | null;
  last_sent_at: Date;
  purpose?: string;
};

function hmacSecret(): string {
  return getRequiredHmacSecret();
}

function hashCode(challengeId: string, code: string): string {
  return createHmac('sha256', hmacSecret()).update(`${challengeId}:${code}`).digest('hex');
}

function codesMatch(challengeId: string, code: string, storedHash: string): boolean {
  const a = Buffer.from(hashCode(challengeId, code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const MISSING_REGISTERED_EMAIL =
  'Your account does not have a registered email. Please contact the administrator.';

const PLACEHOLDER_EMAIL_DOMAINS = new Set(['placeholder.local']);

export function isUsableRegisteredEmail(value: unknown): boolean {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  const domain = email.split('@')[1] ?? '';
  if (PLACEHOLDER_EMAIL_DOMAINS.has(domain)) return false;
  return true;
}

export function pickRegisteredEmail(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const email = String(candidate ?? '').trim().toLowerCase();
    if (isUsableRegisteredEmail(email)) return email;
  }
  return '';
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain || !local) return '****';
  const keep = Math.min(2, local.length);
  return `${local.slice(0, keep)}****@${domain}`;
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(OTP_CODE_LENGTH, '0');
}

function asSessionPayload(raw: unknown): SessionPayload | null {
  try {
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!data || typeof data !== 'object') return null;
    const kind = (data as SessionPayload).kind;
    if (kind !== 'admin' && kind !== 'department_chair' && kind !== 'instructor') return null;
    return data as SessionPayload;
  } catch {
    return null;
  }
}

async function cleanupOldChallenges() {
  await query(
    `DELETE FROM login_otp_challenges
     WHERE expires_at < NOW() - INTERVAL '1 day'
        OR (used_at IS NOT NULL AND used_at < NOW() - INTERVAL '1 day')`
  ).catch(() => {});
}

async function invalidateActive(accountKind: string, accountId: number, purpose = 'login') {
  await query(
    `UPDATE login_otp_challenges
     SET used_at = NOW()
     WHERE account_kind = $1 AND account_id = $2 AND used_at IS NULL AND purpose = $3`,
    [accountKind, accountId, purpose]
  );
}

async function instructorGoogleVerified(accountId: number): Promise<boolean> {
  const result = await query(
    `SELECT google_verified FROM instructor_accounts WHERE id = $1`,
    [accountId]
  ).catch(() => ({ rows: [] as Array<{ google_verified?: boolean }> }));
  return result.rows[0]?.google_verified === true;
}

async function chairGoogleVerified(accountId: number): Promise<boolean> {
  const result = await query(
    `SELECT google_verified FROM users WHERE id = $1 AND role = 'department_chair'`,
    [accountId]
  ).catch(() => ({ rows: [] as Array<{ google_verified?: boolean }> }));
  return result.rows[0]?.google_verified === true;
}

const OTP_REQUIRES_VERIFIED_GMAIL =
  'Google email verification is required before a login code can be sent.';

const OTP_DISABLED_FOR_ACCOUNT =
  'Two-step verification is turned off for this account.';

export const OTP_PURPOSE_LOGIN = 'login';
export const OTP_PURPOSE_PASSWORD_CHANGE = 'password_change';
export const OTP_PURPOSE_DISABLE_OTP = 'disable_otp';

const OTP_CODE_PATTERN = new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`);

export async function startLoginOtp(params: {
  accountKind: 'user' | 'instructor';
  accountId: number;
  role: SessionPayload['kind'];
  email: string;
  payload: SessionPayload;
}): Promise<NextResponse> {
  if (!(await getAccountOtpEnabled(params.accountKind, params.accountId))) {
    return NextResponse.json({ error: OTP_DISABLED_FOR_ACCOUNT }, { status: 403 });
  }
  const email = pickRegisteredEmail(params.email);
  if (!email) {
    return NextResponse.json({ error: MISSING_REGISTERED_EMAIL }, { status: 400 });
  }
  if (params.accountKind === 'instructor' && !(await instructorGoogleVerified(params.accountId))) {
    return NextResponse.json({ error: OTP_REQUIRES_VERIFIED_GMAIL }, { status: 403 });
  }
  if (params.role === 'department_chair' && !(await chairGoogleVerified(params.accountId))) {
    return NextResponse.json({ error: OTP_REQUIRES_VERIFIED_GMAIL }, { status: 403 });
  }
  if (!isMailConfigured()) {
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  await cleanupOldChallenges();

  const recent = await query(
    `SELECT last_sent_at FROM login_otp_challenges
     WHERE account_kind = $1 AND account_id = $2
     ORDER BY last_sent_at DESC LIMIT 1`,
    [params.accountKind, params.accountId]
  );
  const lastSent = recent.rows[0]?.last_sent_at as Date | string | undefined;
  if (lastSent) {
    const wait = OTP_RESEND_SECONDS - Math.floor((Date.now() - new Date(lastSent).getTime()) / 1000);
    if (wait > 0) {
      return NextResponse.json(
        { error: `Please wait ${wait} seconds before requesting another code.`, resend_after: wait },
        { status: 429 }
      );
    }
  }

  await invalidateActive(params.accountKind, params.accountId, OTP_PURPOSE_LOGIN);

  const id = randomUUID();
  const code = generateCode();
  const codeHash = hashCode(id, code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await ensureOtpPurposeColumn();
  await query(
    `INSERT INTO login_otp_challenges
       (id, account_kind, account_id, role, email, code_hash, session_payload, expires_at, last_sent_at, purpose)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), $9)`,
    [id, params.accountKind, params.accountId, params.role, email, codeHash, JSON.stringify(params.payload), expiresAt, OTP_PURPOSE_LOGIN]
  );

  try {
    await sendLoginOtpEmail(email, code);
  } catch (err) {
    await query(`DELETE FROM login_otp_challenges WHERE id = $1`, [id]).catch(() => {});
    if (process.env.NODE_ENV !== 'production') {
      console.error('[login-otp] mail send failed:', (err as Error).message);
    }
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  const response = NextResponse.json({
    OTP_REQUIRED: true,
    requiresOtp: true,
    mfa_required: true,
    maskedEmail: maskEmail(email),
    masked_email: maskEmail(email),
    expiresIn: Math.floor(OTP_TTL_MS / 1000),
    expires_in: Math.floor(OTP_TTL_MS / 1000),
    resend_after: OTP_RESEND_SECONDS,
  });
  setOtpCookie(response, id);
  return response;
}

export async function getOtpStatus(challengeId: string | undefined) {
  if (!challengeId) return null;
  await ensureOtpPurposeColumn();
  const result = await query(
    `SELECT id, account_kind, account_id, role, email, expires_at, used_at, last_sent_at, purpose
     FROM login_otp_challenges WHERE id = $1`,
    [challengeId]
  );
  const row = result.rows[0] as Pick<ChallengeRow, 'id' | 'account_kind' | 'account_id' | 'role' | 'email' | 'expires_at' | 'used_at' | 'last_sent_at' | 'purpose'> | undefined;
  if (!row || row.used_at) return null;
  if ((row.purpose ?? OTP_PURPOSE_LOGIN) !== OTP_PURPOSE_LOGIN) return null;
  if (!(await getAccountOtpEnabled(row.account_kind, row.account_id))) {
    await query(
      `UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
      [row.id]
    );
    return null;
  }
  if (row.account_kind === 'instructor' && !(await instructorGoogleVerified(row.account_id))) {
    await query(
      `UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
      [row.id]
    );
    return null;
  }
  if (row.role === 'department_chair' && !(await chairGoogleVerified(row.account_id))) {
    await query(
      `UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
      [row.id]
    );
    return null;
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await query(
      `UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
      [row.id]
    );
    return null;
  }
  const lastSent = new Date(row.last_sent_at).getTime();
  const resendIn = Math.max(0, OTP_RESEND_SECONDS - Math.floor((Date.now() - lastSent) / 1000));
  return {
    pending: true as const,
    masked_email: maskEmail(row.email),
    maskedEmail: maskEmail(row.email),
    resend_in: resendIn,
    expires_in: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
    role: row.role,
  };
}

export async function verifyOtpCode(req: NextRequest, challengeId: string | undefined, rawCode: unknown): Promise<NextResponse> {
  const code = String(rawCode ?? '').replace(/\D/g, '');
  if (!challengeId) {
    return NextResponse.json(
      { error: 'Verification attempt expired. Please login again.' },
      { status: 401 }
    );
  }
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: 'Invalid verification code.' }, { status: 400 });
  }

  await ensureOtpPurposeColumn();
  const outcome = await transaction(async (client) => {
    const locked = await client.query(
      `SELECT id, account_kind, account_id, role, email, code_hash, session_payload,
              expires_at, attempt_count, used_at, last_sent_at, purpose
       FROM login_otp_challenges
       WHERE id = $1
       FOR UPDATE`,
      [challengeId]
    );
    const row = locked.rows[0] as ChallengeRow | undefined;
    if (!row || row.used_at) {
      return { kind: 'gone' as const };
    }
    if ((row.purpose ?? OTP_PURPOSE_LOGIN) !== OTP_PURPOSE_LOGIN) {
      return { kind: 'gone' as const };
    }
    const otpOn = await getAccountOtpEnabled(row.account_kind, row.account_id);
    if (!otpOn) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'gone' as const };
    }
    if (row.account_kind === 'instructor') {
      const gv = await client.query(
        `SELECT google_verified FROM instructor_accounts WHERE id = $1`,
        [row.account_id]
      );
      if (gv.rows[0]?.google_verified !== true) {
        await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
        return { kind: 'unverified' as const };
      }
    }
    if (row.role === 'department_chair') {
      const gv = await client.query(
        `SELECT google_verified FROM users WHERE id = $1 AND role = 'department_chair'`,
        [row.account_id]
      );
      if (gv.rows[0]?.google_verified !== true) {
        await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
        return { kind: 'unverified' as const };
      }
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'expired' as const };
    }
    if (row.attempt_count >= OTP_MAX_ATTEMPTS) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'locked' as const };
    }

    if (!codesMatch(row.id, code, row.code_hash)) {
      const next = await client.query(
        `UPDATE login_otp_challenges
         SET attempt_count = attempt_count + 1
         WHERE id = $1 AND used_at IS NULL
         RETURNING attempt_count`,
        [row.id]
      );
      const attempts = Number(next.rows[0]?.attempt_count ?? row.attempt_count + 1);
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
        return { kind: 'locked' as const };
      }
      return { kind: 'invalid' as const };
    }

    const consumed = await client.query(
      `UPDATE login_otp_challenges
       SET used_at = NOW()
       WHERE id = $1 AND used_at IS NULL
       RETURNING id`,
      [row.id]
    );
    if (consumed.rows.length === 0) {
      return { kind: 'gone' as const };
    }
    const payload = asSessionPayload(row.session_payload);
    if (!payload) return { kind: 'gone' as const };
    return { kind: 'ok' as const, payload };
  });

  if (outcome.kind === 'expired') {
    const res = NextResponse.json(
      { error: 'This verification code has expired. Please request a new code.' },
      { status: 401 }
    );
    clearOtpCookie(res);
    return res;
  }
  if (outcome.kind === 'locked') {
    const res = NextResponse.json(
      { error: 'Too many verification attempts. Please login again.' },
      { status: 429 }
    );
    clearOtpCookie(res);
    return res;
  }
  if (outcome.kind === 'gone') {
    const res = NextResponse.json(
      { error: 'Verification attempt expired. Please login again.' },
      { status: 401 }
    );
    clearOtpCookie(res);
    return res;
  }
  if (outcome.kind === 'unverified') {
    const res = NextResponse.json({ error: OTP_REQUIRES_VERIFIED_GMAIL }, { status: 403 });
    clearOtpCookie(res);
    return res;
  }
  if (outcome.kind === 'invalid') {
    return NextResponse.json({ error: 'Invalid verification code.' }, { status: 401 });
  }

  const payload = outcome.payload;
  const loginOpts = { req, registerDevice: true };
  let response: NextResponse;
  if (payload.kind === 'admin') {
    response = await adminLoginResponse(payload, loginOpts);
  } else if (payload.kind === 'department_chair') {
    response = await chairLoginResponse(payload, loginOpts);
  } else {
    response = await instructorLoginResponse(payload, loginOpts);
  }
  clearOtpCookie(response);
  return response;
}

export async function resendOtp(challengeId: string | undefined): Promise<NextResponse> {
  if (!challengeId) {
    return NextResponse.json(
      { error: 'Verification attempt expired. Please login again.' },
      { status: 401 }
    );
  }
  if (!isMailConfigured()) {
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  await ensureOtpPurposeColumn();
  const prepared = await transaction(async (client) => {
    const locked = await client.query(
      `SELECT id, account_kind, account_id, role, email, code_hash, session_payload,
              expires_at, attempt_count, used_at, last_sent_at, purpose
       FROM login_otp_challenges
       WHERE id = $1
       FOR UPDATE`,
      [challengeId]
    );
    const row = locked.rows[0] as ChallengeRow | undefined;
    if (!row || row.used_at) return { kind: 'gone' as const };
    if ((row.purpose ?? OTP_PURPOSE_LOGIN) !== OTP_PURPOSE_LOGIN) return { kind: 'gone' as const };
    if (!(await getAccountOtpEnabled(row.account_kind, row.account_id))) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'gone' as const };
    }
    if (row.account_kind === 'instructor') {
      const gv = await client.query(
        `SELECT google_verified FROM instructor_accounts WHERE id = $1`,
        [row.account_id]
      );
      if (gv.rows[0]?.google_verified !== true) {
        await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
        return { kind: 'unverified' as const };
      }
    }
    if (row.role === 'department_chair') {
      const gv = await client.query(
        `SELECT google_verified FROM users WHERE id = $1 AND role = 'department_chair'`,
        [row.account_id]
      );
      if (gv.rows[0]?.google_verified !== true) {
        await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
        return { kind: 'unverified' as const };
      }
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'expired' as const };
    }
    const wait = OTP_RESEND_SECONDS - Math.floor((Date.now() - new Date(row.last_sent_at).getTime()) / 1000);
    if (wait > 0) return { kind: 'cooldown' as const, wait };

    const code = generateCode();
    const codeHash = hashCode(row.id, code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    await client.query(
      `UPDATE login_otp_challenges
       SET code_hash = $2, expires_at = $3, attempt_count = 0, last_sent_at = NOW()
       WHERE id = $1 AND used_at IS NULL`,
      [row.id, codeHash, expiresAt]
    );
    return { kind: 'ok' as const, email: row.email, code };
  });

  if (prepared.kind === 'gone' || prepared.kind === 'expired') {
    const res = NextResponse.json(
      { error: 'This verification code has expired. Please login again.' },
      { status: 401 }
    );
    clearOtpCookie(res);
    return res;
  }
  if (prepared.kind === 'unverified') {
    const res = NextResponse.json({ error: OTP_REQUIRES_VERIFIED_GMAIL }, { status: 403 });
    clearOtpCookie(res);
    return res;
  }
  if (prepared.kind === 'cooldown') {
    return NextResponse.json(
      { error: `Resend available in ${prepared.wait} seconds.`, resend_after: prepared.wait },
      { status: 429 }
    );
  }

  try {
    await sendLoginOtpEmail(prepared.email, prepared.code);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[login-otp] resend mail failed:', (err as Error).message);
    }
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  return NextResponse.json({
    success: true,
    masked_email: maskEmail(prepared.email),
    maskedEmail: maskEmail(prepared.email),
    resend_after: OTP_RESEND_SECONDS,
  });
}

export async function startPasswordChangeOtp(params: {
  accountId: number;
  facultyId: number;
  username: string;
  email: string;
}): Promise<NextResponse> {
  await ensureOtpPurposeColumn();
  if (!(await instructorGoogleVerified(params.accountId))) {
    return NextResponse.json(
      { error: 'Verify your Google account before changing your password.' },
      { status: 403 }
    );
  }
  const email = pickRegisteredEmail(params.email);
  if (!email) {
    return NextResponse.json({ error: MISSING_REGISTERED_EMAIL }, { status: 400 });
  }
  if (!isMailConfigured()) {
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  await cleanupOldChallenges();

  const recent = await query(
    `SELECT last_sent_at FROM login_otp_challenges
     WHERE account_kind = 'instructor' AND account_id = $1 AND purpose = $2
     ORDER BY last_sent_at DESC LIMIT 1`,
    [params.accountId, OTP_PURPOSE_PASSWORD_CHANGE]
  );
  const lastSent = recent.rows[0]?.last_sent_at as Date | string | undefined;
  if (lastSent) {
    const wait = OTP_RESEND_SECONDS - Math.floor((Date.now() - new Date(lastSent).getTime()) / 1000);
    if (wait > 0) {
      return NextResponse.json(
        { error: `Please wait ${wait} seconds before requesting another code.`, resend_after: wait },
        { status: 429 }
      );
    }
  }

  await invalidateActive('instructor', params.accountId, OTP_PURPOSE_PASSWORD_CHANGE);

  const id = randomUUID();
  const code = generateCode();
  const codeHash = hashCode(id, code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const payload = {
    kind: 'instructor',
    account_id: params.accountId,
    username: params.username,
    faculty_id: params.facultyId,
    first_name: null,
    last_name: null,
    name: null,
  };

  await query(
    `INSERT INTO login_otp_challenges
       (id, account_kind, account_id, role, email, code_hash, session_payload, expires_at, last_sent_at, purpose)
     VALUES ($1, 'instructor', $2, 'instructor', $3, $4, $5::jsonb, $6, NOW(), $7)`,
    [id, params.accountId, email, codeHash, JSON.stringify(payload), expiresAt, OTP_PURPOSE_PASSWORD_CHANGE]
  );

  try {
    await sendLoginOtpEmail(email, code, OTP_PURPOSE_PASSWORD_CHANGE);
  } catch (err) {
    await query(`DELETE FROM login_otp_challenges WHERE id = $1`, [id]).catch(() => {});
    if (process.env.NODE_ENV !== 'production') {
      console.error('[password-otp] mail send failed:', (err as Error).message);
    }
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  const response = NextResponse.json({
    OTP_REQUIRED: true,
    maskedEmail: maskEmail(email),
    masked_email: maskEmail(email),
    expiresIn: Math.floor(OTP_TTL_MS / 1000),
    resend_after: OTP_RESEND_SECONDS,
  });
  setPasswordOtpCookie(response, id);
  clearPasswordChangeGrantCookie(response);
  return response;
}

export async function verifyPasswordChangeOtp(
  challengeId: string | undefined,
  rawCode: unknown,
  accountId: number,
  facultyId: number
): Promise<NextResponse> {
  const code = String(rawCode ?? '').replace(/\D/g, '');
  if (!challengeId) {
    return NextResponse.json(
      { error: 'Verification attempt expired. Please request a new code.' },
      { status: 401 }
    );
  }
  if (!/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: 'Invalid verification code.' }, { status: 400 });
  }

  await ensureOtpPurposeColumn();
  const outcome = await transaction(async (client) => {
    const locked = await client.query(
      `SELECT id, account_kind, account_id, role, email, code_hash, session_payload,
              expires_at, attempt_count, used_at, last_sent_at, purpose
       FROM login_otp_challenges
       WHERE id = $1
       FOR UPDATE`,
      [challengeId]
    );
    const row = locked.rows[0] as ChallengeRow | undefined;
    if (!row || row.used_at) return { kind: 'gone' as const };
    if (row.purpose !== OTP_PURPOSE_PASSWORD_CHANGE) return { kind: 'gone' as const };
    if (row.account_kind !== 'instructor' || Number(row.account_id) !== Number(accountId)) {
      return { kind: 'gone' as const };
    }
    if (!(await instructorGoogleVerified(row.account_id))) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'unverified' as const };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'expired' as const };
    }
    if (row.attempt_count >= OTP_MAX_ATTEMPTS) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'locked' as const };
    }
    if (!codesMatch(row.id, code, row.code_hash)) {
      const next = await client.query(
        `UPDATE login_otp_challenges
         SET attempt_count = attempt_count + 1
         WHERE id = $1 AND used_at IS NULL
         RETURNING attempt_count`,
        [row.id]
      );
      const attempts = Number(next.rows[0]?.attempt_count ?? row.attempt_count + 1);
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
        return { kind: 'locked' as const };
      }
      return { kind: 'invalid' as const };
    }
    await client.query(
      `UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
      [row.id]
    );
    return { kind: 'ok' as const, challengeId: row.id };
  });

  if (outcome.kind === 'expired') {
    const res = NextResponse.json(
      { error: 'This verification code has expired. Please request a new code.' },
      { status: 401 }
    );
    clearPasswordOtpCookie(res);
    return res;
  }
  if (outcome.kind === 'locked') {
    const res = NextResponse.json(
      { error: 'Too many verification attempts. Please try again later.' },
      { status: 429 }
    );
    clearPasswordOtpCookie(res);
    return res;
  }
  if (outcome.kind === 'gone' || outcome.kind === 'unverified') {
    const res = NextResponse.json(
      { error: outcome.kind === 'unverified'
        ? OTP_REQUIRES_VERIFIED_GMAIL
        : 'Verification attempt expired. Please request a new code.' },
      { status: outcome.kind === 'unverified' ? 403 : 401 }
    );
    clearPasswordOtpCookie(res);
    return res;
  }
  if (outcome.kind === 'invalid') {
    return NextResponse.json({ error: 'Invalid verification code.' }, { status: 401 });
  }

  const grant = await signShortToken({
    typ: 'pw_change',
    id: accountId,
    fid: facultyId,
    cid: outcome.challengeId,
  }, '10m');
  const response = NextResponse.json({ success: true, authorized: true });
  clearPasswordOtpCookie(response);
  setPasswordChangeGrantCookie(response, grant);
  return response;
}

export async function resendPasswordChangeOtp(
  challengeId: string | undefined,
  accountId: number
): Promise<NextResponse> {
  if (!challengeId) {
    return NextResponse.json(
      { error: 'Verification attempt expired. Please request a new code.' },
      { status: 401 }
    );
  }
  if (!isMailConfigured()) {
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }
  await ensureOtpPurposeColumn();
  const prepared = await transaction(async (client) => {
    const locked = await client.query(
      `SELECT id, account_kind, account_id, role, email, code_hash, session_payload,
              expires_at, attempt_count, used_at, last_sent_at, purpose
       FROM login_otp_challenges
       WHERE id = $1
       FOR UPDATE`,
      [challengeId]
    );
    const row = locked.rows[0] as ChallengeRow | undefined;
    if (!row || row.used_at) return { kind: 'gone' as const };
    if (row.purpose !== OTP_PURPOSE_PASSWORD_CHANGE) return { kind: 'gone' as const };
    if (row.account_kind !== 'instructor' || Number(row.account_id) !== Number(accountId)) {
      return { kind: 'gone' as const };
    }
    if (!(await instructorGoogleVerified(row.account_id))) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'unverified' as const };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'expired' as const };
    }
    const wait = OTP_RESEND_SECONDS - Math.floor((Date.now() - new Date(row.last_sent_at).getTime()) / 1000);
    if (wait > 0) return { kind: 'cooldown' as const, wait };
    const code = generateCode();
    const codeHash = hashCode(row.id, code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    await client.query(
      `UPDATE login_otp_challenges
       SET code_hash = $2, expires_at = $3, attempt_count = 0, last_sent_at = NOW()
       WHERE id = $1 AND used_at IS NULL`,
      [row.id, codeHash, expiresAt]
    );
    return { kind: 'ok' as const, email: row.email, code };
  });

  if (prepared.kind === 'gone' || prepared.kind === 'expired') {
    const res = NextResponse.json(
      { error: 'This verification code has expired. Please request a new code.' },
      { status: 401 }
    );
    clearPasswordOtpCookie(res);
    return res;
  }
  if (prepared.kind === 'unverified') {
    const res = NextResponse.json({ error: OTP_REQUIRES_VERIFIED_GMAIL }, { status: 403 });
    clearPasswordOtpCookie(res);
    return res;
  }
  if (prepared.kind === 'cooldown') {
    return NextResponse.json(
      { error: `Resend available in ${prepared.wait} seconds.`, resend_after: prepared.wait },
      { status: 429 }
    );
  }

  try {
    await sendLoginOtpEmail(prepared.email, prepared.code, OTP_PURPOSE_PASSWORD_CHANGE);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[password-otp] resend mail failed:', (err as Error).message);
    }
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  return NextResponse.json({
    success: true,
    masked_email: maskEmail(prepared.email),
    maskedEmail: maskEmail(prepared.email),
    resend_after: OTP_RESEND_SECONDS,
  });
}

export async function cancelPasswordChangeOtp(challengeId: string | undefined): Promise<NextResponse> {
  if (challengeId) {
    await query(
      `UPDATE login_otp_challenges SET used_at = NOW()
       WHERE id = $1 AND purpose = $2 AND used_at IS NULL`,
      [challengeId, OTP_PURPOSE_PASSWORD_CHANGE]
    ).catch(() => {});
  }
  const response = NextResponse.json({ success: true });
  clearPasswordOtpCookie(response);
  return response;
}

export async function consumePasswordChangeGrant(
  grantToken: string | undefined,
  accountId: number,
  facultyId: number
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (!grantToken) {
    return { ok: false, error: 'Verify your identity before changing your password.', status: 403 };
  }
  const payload = await verifyToken(grantToken);
  if (!payload || payload.typ !== 'pw_change') {
    return { ok: false, error: 'Verify your identity before changing your password.', status: 403 };
  }
  if (Number(payload.id) !== Number(accountId) || Number(payload.fid) !== Number(facultyId)) {
    return { ok: false, error: 'Verify your identity before changing your password.', status: 403 };
  }
  return { ok: true };
}

export async function cancelOtp(challengeId: string | undefined): Promise<NextResponse> {
  if (challengeId) {
    await query(
      `UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
      [challengeId]
    ).catch(() => {});
  }
  const response = NextResponse.json({ success: true });
  clearOtpCookie(response);
  return response;
}

type DisableOtpSession = {
  kind: 'disable_otp';
  account_kind: OtpAccountKind;
  account_id: number;
  role: string;
};

/**
 * Starts a fresh disable-OTP challenge after the caller has already verified the password.
 * Does NOT set otp_enabled = false.
 */
export async function startDisableOtpChallenge(params: {
  accountKind: OtpAccountKind;
  accountId: number;
  role: string;
  email: string;
}): Promise<NextResponse> {
  await ensureOtpPurposeColumn();

  if (!(await getAccountOtpEnabled(params.accountKind, params.accountId))) {
    return NextResponse.json(
      { error: 'Two-Step Verification is already turned off.' },
      { status: 400 }
    );
  }

  if (params.accountKind === 'instructor' && !(await instructorGoogleVerified(params.accountId))) {
    return NextResponse.json(
      { error: 'Verify your Google email account before turning off Two-Step Verification.' },
      { status: 403 }
    );
  }
  if (params.role === 'department_chair' && !(await chairGoogleVerified(params.accountId))) {
    return NextResponse.json(
      { error: 'Verify your Google email account before turning off Two-Step Verification.' },
      { status: 403 }
    );
  }

  const email = pickRegisteredEmail(params.email);
  if (!email) {
    return NextResponse.json({ error: MISSING_REGISTERED_EMAIL }, { status: 400 });
  }
  if (!isMailConfigured()) {
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  await cleanupOldChallenges();

  const recent = await query(
    `SELECT last_sent_at FROM login_otp_challenges
     WHERE account_kind = $1 AND account_id = $2 AND purpose = $3
     ORDER BY last_sent_at DESC LIMIT 1`,
    [params.accountKind, params.accountId, OTP_PURPOSE_DISABLE_OTP]
  );
  const lastSent = recent.rows[0]?.last_sent_at as Date | string | undefined;
  if (lastSent) {
    const wait = OTP_RESEND_SECONDS - Math.floor((Date.now() - new Date(lastSent).getTime()) / 1000);
    if (wait > 0) {
      return NextResponse.json(
        { error: `Please wait ${wait} seconds before requesting another code.`, resend_after: wait },
        { status: 429 }
      );
    }
  }

  await invalidateActive(params.accountKind, params.accountId, OTP_PURPOSE_DISABLE_OTP);

  const id = randomUUID();
  const code = generateCode();
  const codeHash = hashCode(id, code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  const payload: DisableOtpSession = {
    kind: 'disable_otp',
    account_kind: params.accountKind,
    account_id: params.accountId,
    role: params.role,
  };

  await query(
    `INSERT INTO login_otp_challenges
       (id, account_kind, account_id, role, email, code_hash, session_payload, expires_at, last_sent_at, purpose)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), $9)`,
    [
      id,
      params.accountKind,
      params.accountId,
      params.role,
      email,
      codeHash,
      JSON.stringify(payload),
      expiresAt,
      OTP_PURPOSE_DISABLE_OTP,
    ]
  );

  try {
    await sendLoginOtpEmail(email, code, OTP_PURPOSE_DISABLE_OTP);
  } catch (err) {
    await query(`DELETE FROM login_otp_challenges WHERE id = $1`, [id]).catch(() => {});
    if (process.env.NODE_ENV !== 'production') {
      console.error('[disable-otp] mail send failed:', (err as Error).message);
    }
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  const response = NextResponse.json({
    challenge: 'otp_required',
    OTP_REQUIRED: true,
    maskedEmail: maskEmail(email),
    masked_email: maskEmail(email),
    expiresIn: Math.floor(OTP_TTL_MS / 1000),
    expires_in: Math.floor(OTP_TTL_MS / 1000),
    resend_after: OTP_RESEND_SECONDS,
    code_length: OTP_CODE_LENGTH,
  });
  setDisableOtpCookie(response, id);
  return response;
}

export async function verifyDisableOtpChallenge(params: {
  challengeId: string | undefined;
  rawCode: unknown;
  accountKind: OtpAccountKind;
  accountId: number;
}): Promise<NextResponse> {
  const code = String(params.rawCode ?? '').replace(/\D/g, '');
  if (!params.challengeId) {
    return NextResponse.json(
      { error: 'Verification attempt expired. Please start again.' },
      { status: 401 }
    );
  }
  if (!OTP_CODE_PATTERN.test(code)) {
    return NextResponse.json({ error: 'Invalid verification code.' }, { status: 400 });
  }

  await ensureOtpPurposeColumn();

  if (!(await getAccountOtpEnabled(params.accountKind, params.accountId))) {
    const res = NextResponse.json({
      success: true,
      otp_enabled: false,
      message: 'Two-Step Verification is already turned off.',
    });
    clearDisableOtpCookie(res);
    return res;
  }

  const outcome = await transaction(async (client) => {
    const locked = await client.query(
      `SELECT id, account_kind, account_id, role, email, code_hash, session_payload,
              expires_at, attempt_count, used_at, last_sent_at, purpose
       FROM login_otp_challenges
       WHERE id = $1
       FOR UPDATE`,
      [params.challengeId]
    );
    const row = locked.rows[0] as ChallengeRow | undefined;
    if (!row || row.used_at) return { kind: 'gone' as const };
    if (row.purpose !== OTP_PURPOSE_DISABLE_OTP) return { kind: 'gone' as const };
    if (row.account_kind !== params.accountKind || Number(row.account_id) !== Number(params.accountId)) {
      return { kind: 'gone' as const };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'expired' as const };
    }
    if (row.attempt_count >= OTP_MAX_ATTEMPTS) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'locked' as const };
    }
    if (!codesMatch(row.id, code, row.code_hash)) {
      const next = await client.query(
        `UPDATE login_otp_challenges
         SET attempt_count = attempt_count + 1
         WHERE id = $1 AND used_at IS NULL
         RETURNING attempt_count`,
        [row.id]
      );
      const attempts = Number(next.rows[0]?.attempt_count ?? row.attempt_count + 1);
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
        return { kind: 'locked' as const };
      }
      return { kind: 'invalid' as const };
    }
    await client.query(
      `UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`,
      [row.id]
    );
    return { kind: 'ok' as const };
  });

  if (outcome.kind === 'expired') {
    const res = NextResponse.json(
      { error: 'The verification code has expired. Request a new code.' },
      { status: 401 }
    );
    clearDisableOtpCookie(res);
    return res;
  }
  if (outcome.kind === 'locked') {
    const res = NextResponse.json(
      { error: 'Too many verification attempts. Please start again.' },
      { status: 429 }
    );
    clearDisableOtpCookie(res);
    return res;
  }
  if (outcome.kind === 'gone') {
    const res = NextResponse.json(
      { error: 'Verification attempt expired. Please start again.' },
      { status: 401 }
    );
    clearDisableOtpCookie(res);
    return res;
  }
  if (outcome.kind === 'invalid') {
    return NextResponse.json({ error: 'Invalid verification code.' }, { status: 401 });
  }

  /* Both password (prior step) and fresh OTP succeeded — now disable. */
  await disableAccountOtp(params.accountKind, params.accountId);
  await revokeAllTrustedDevices(params.accountKind, params.accountId);
  await invalidateActive(params.accountKind, params.accountId, OTP_PURPOSE_DISABLE_OTP);

  if (process.env.NODE_ENV !== 'production') {
    console.info(
      `[security] Two-Step Verification disabled for ${params.accountKind}:${params.accountId}`
    );
  }

  const response = NextResponse.json({
    success: true,
    otp_enabled: false,
    message: 'Two-Step Verification Turned Off',
  });
  clearDisableOtpCookie(response);
  return response;
}

export async function resendDisableOtpChallenge(params: {
  challengeId: string | undefined;
  accountKind: OtpAccountKind;
  accountId: number;
}): Promise<NextResponse> {
  if (!params.challengeId) {
    return NextResponse.json(
      { error: 'Verification attempt expired. Please start again.' },
      { status: 401 }
    );
  }
  if (!isMailConfigured()) {
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  await ensureOtpPurposeColumn();
  const prepared = await transaction(async (client) => {
    const locked = await client.query(
      `SELECT id, account_kind, account_id, role, email, code_hash, session_payload,
              expires_at, attempt_count, used_at, last_sent_at, purpose
       FROM login_otp_challenges
       WHERE id = $1
       FOR UPDATE`,
      [params.challengeId]
    );
    const row = locked.rows[0] as ChallengeRow | undefined;
    if (!row || row.used_at) return { kind: 'gone' as const };
    if (row.purpose !== OTP_PURPOSE_DISABLE_OTP) return { kind: 'gone' as const };
    if (row.account_kind !== params.accountKind || Number(row.account_id) !== Number(params.accountId)) {
      return { kind: 'gone' as const };
    }
    if (!(await getAccountOtpEnabled(params.accountKind, params.accountId))) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'gone' as const };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(`UPDATE login_otp_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL`, [row.id]);
      return { kind: 'expired' as const };
    }
    const wait = OTP_RESEND_SECONDS - Math.floor((Date.now() - new Date(row.last_sent_at).getTime()) / 1000);
    if (wait > 0) return { kind: 'cooldown' as const, wait };

    const code = generateCode();
    const codeHash = hashCode(row.id, code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    await client.query(
      `UPDATE login_otp_challenges
       SET code_hash = $2, expires_at = $3, attempt_count = 0, last_sent_at = NOW()
       WHERE id = $1 AND used_at IS NULL`,
      [row.id, codeHash, expiresAt]
    );
    return { kind: 'ok' as const, email: row.email, code };
  });

  if (prepared.kind === 'expired') {
    const res = NextResponse.json(
      { error: 'The verification code has expired. Request a new code.' },
      { status: 401 }
    );
    clearDisableOtpCookie(res);
    return res;
  }
  if (prepared.kind === 'gone') {
    const res = NextResponse.json(
      { error: 'Verification attempt expired. Please start again.' },
      { status: 401 }
    );
    clearDisableOtpCookie(res);
    return res;
  }
  if (prepared.kind === 'cooldown') {
    return NextResponse.json(
      { error: `Resend available in ${prepared.wait} seconds.`, resend_after: prepared.wait },
      { status: 429 }
    );
  }

  try {
    await sendLoginOtpEmail(prepared.email, prepared.code, OTP_PURPOSE_DISABLE_OTP);
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[disable-otp] resend mail failed:', (err as Error).message);
    }
    return NextResponse.json(
      { error: 'Unable to send verification code. Please try again.' },
      { status: 503 }
    );
  }

  return NextResponse.json({
    success: true,
    masked_email: maskEmail(prepared.email),
    maskedEmail: maskEmail(prepared.email),
    resend_after: OTP_RESEND_SECONDS,
    code_length: OTP_CODE_LENGTH,
  });
}

export async function cancelDisableOtpChallenge(challengeId: string | undefined): Promise<NextResponse> {
  if (challengeId) {
    await query(
      `UPDATE login_otp_challenges SET used_at = NOW()
       WHERE id = $1 AND purpose = $2 AND used_at IS NULL`,
      [challengeId, OTP_PURPOSE_DISABLE_OTP]
    ).catch(() => {});
  }
  const response = NextResponse.json({ success: true });
  clearDisableOtpCookie(response);
  return response;
}

