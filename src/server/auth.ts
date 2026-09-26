import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  evaluateSession,
  getAuthVersion,
  registerTrustedDevice,
} from '@/server/trustedDevices';
import { getRequiredJwtSecretBytes } from '@/lib/authSecret';

const JWT_SECRET = getRequiredJwtSecretBytes();

export const SESSION_DAYS = 30;
export const SESSION_MAX_AGE = SESSION_DAYS * 24 * 60 * 60;

export async function signToken(payload: Record<string, unknown>): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return payload as Record<string, unknown>;
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[verifyToken] JWT verification failed:', err);
    }
    return null;
  }
}

export async function getPageAuthRole(): Promise<string | null> {
  try {
    const payload = await getAuthUser();
    return (payload?.role as string) ?? null;
  } catch {
    return null;
  }
}

export async function getAuthUser(req?: NextRequest) {
  let token: string | undefined;

  if (req) {
    token = req.cookies.get('auth_token')?.value;
    if (!token) {
      const raw = req.headers.get('cookie') ?? '';
      const match = /(?:^|;\s*)auth_token=([^;]+)/.exec(raw);
      if (match) token = decodeURIComponent(match[1]);
    }
  }

  if (!token) {
    try {
      const cookieStore = await cookies();
      token = cookieStore.get('auth_token')?.value;
    } catch {
      // cookies() unavailable in this context (e.g. Edge) — skip
    }
  }

  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  try {
    const session = await evaluateSession(payload);
    if (!session.live) return null;
  } catch {
    // Database briefly unavailable — keep a still-valid JWT rather than mass-logout.
  }

  return payload;
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge: SESSION_MAX_AGE,
    path: '/',
  };
}

export function setAuthCookie(response: NextResponse, token: string) {
  response.cookies.set('auth_token', token, authCookieOptions());
}

export function clearAuthCookie(response: NextResponse) {
  response.cookies.set('auth_token', '', { ...authCookieOptions(), maxAge: 0 });
}

export function otpCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge: 10 * 60,
    path: '/',
  };
}

export function setOtpCookie(response: NextResponse, challengeId: string) {
  response.cookies.set('otp_challenge', challengeId, otpCookieOptions());
}

export function clearOtpCookie(response: NextResponse) {
  response.cookies.set('otp_challenge', '', { ...otpCookieOptions(), maxAge: 0 });
}

export function getOtpChallengeId(req: NextRequest): string | undefined {
  return req.cookies.get('otp_challenge')?.value;
}

export const PW_OTP_COOKIE = 'pw_otp_challenge';
export const PW_CHANGE_GRANT_COOKIE = 'pw_change_auth';
export const PW_CHANGE_GRANT_TTL_SEC = 10 * 60;
export const DISABLE_OTP_COOKIE = 'disable_otp_challenge';

export function setPasswordOtpCookie(response: NextResponse, challengeId: string) {
  response.cookies.set(PW_OTP_COOKIE, challengeId, otpCookieOptions());
}

export function clearPasswordOtpCookie(response: NextResponse) {
  response.cookies.set(PW_OTP_COOKIE, '', { ...otpCookieOptions(), maxAge: 0 });
}

export function getPasswordOtpChallengeId(req: NextRequest): string | undefined {
  return req.cookies.get(PW_OTP_COOKIE)?.value;
}

export function setDisableOtpCookie(response: NextResponse, challengeId: string) {
  response.cookies.set(DISABLE_OTP_COOKIE, challengeId, otpCookieOptions());
}

export function clearDisableOtpCookie(response: NextResponse) {
  response.cookies.set(DISABLE_OTP_COOKIE, '', { ...otpCookieOptions(), maxAge: 0 });
}

export function getDisableOtpChallengeId(req: NextRequest): string | undefined {
  return req.cookies.get(DISABLE_OTP_COOKIE)?.value;
}

export function passwordGrantCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge: PW_CHANGE_GRANT_TTL_SEC,
    path: '/',
  };
}

export function setPasswordChangeGrantCookie(response: NextResponse, token: string) {
  response.cookies.set(PW_CHANGE_GRANT_COOKIE, token, passwordGrantCookieOptions());
}

export function clearPasswordChangeGrantCookie(response: NextResponse) {
  response.cookies.set(PW_CHANGE_GRANT_COOKIE, '', { ...passwordGrantCookieOptions(), maxAge: 0 });
}

export function getPasswordChangeGrant(req: NextRequest): string | undefined {
  return req.cookies.get(PW_CHANGE_GRANT_COOKIE)?.value;
}

export async function signShortToken(payload: Record<string, unknown>, expiresIn = '10m'): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(JWT_SECRET);
}

type LoginIssueOptions = {
  req?: NextRequest;
  /** Defaults to true when req is provided — every successful login records the device. */
  registerDevice?: boolean;
};

function shouldRegisterDevice(options?: LoginIssueOptions): boolean {
  return Boolean(options?.req) && options?.registerDevice !== false;
}

export async function adminLoginResponse(
  user: { id: number; username: string },
  options?: LoginIssueOptions
) {
  const av = await getAuthVersion('user', user.id);
  const token = await signToken({ id: user.id, username: user.username, role: 'admin', av });
  const response = NextResponse.json({
    success: true, role: 'admin', redirect: '/dashboard',
    user: { id: user.id, username: user.username, role: 'admin' },
  });
  setAuthCookie(response, token);
  if (shouldRegisterDevice(options) && options?.req) {
    await registerTrustedDevice({
      req: options.req,
      response,
      accountKind: 'user',
      accountId: user.id,
    });
  }
  return response;
}

/**
 * Shared by both chair-style roles authenticated through the single
 * "Administrator / Chair" login option. `role` is the account's actual
 * DB role (never client-supplied) — Department Chair gets the admin-style
 * home page since it now has near-admin access; Program Chair keeps the
 * existing program-scoped /dept-chair experience unchanged.
 */
export async function chairLoginResponse(
  user: { id: number; username: string; program_id?: number | null },
  role: 'department_chair' | 'program_chair',
  options?: LoginIssueOptions
) {
  const av = await getAuthVersion('user', user.id);
  const programId = user.program_id ?? null;
  const redirect = role === 'department_chair' ? '/dashboard' : '/dept-chair';
  const token = await signToken({
    id: user.id,
    username: user.username,
    role,
    program_id: programId,
    av,
  });
  const response = NextResponse.json({
    success: true, role, redirect,
    user: {
      id: user.id,
      username: user.username,
      role,
      program_id: programId,
    },
  });
  setAuthCookie(response, token);
  if (shouldRegisterDevice(options) && options?.req) {
    await registerTrustedDevice({
      req: options.req,
      response,
      accountKind: 'user',
      accountId: user.id,
    });
  }
  return response;
}

export async function instructorLoginResponse(row: {
  account_id: number;
  username: string;
  faculty_id: number;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
}, options?: LoginIssueOptions) {
  const displayName =
    [row.first_name, row.last_name].filter(Boolean).join(' ') || row.name || row.username;
  const av = await getAuthVersion('instructor', row.account_id);
  const token = await signToken({
    id: row.account_id,
    username: row.username,
    role: 'instructor',
    faculty_id: row.faculty_id,
    name: displayName,
    av,
  });
  const response = NextResponse.json({
    success: true,
    role: 'instructor',
    redirect: '/instructor',
    user: { id: row.faculty_id, name: displayName, role: 'instructor' },
  });
  setAuthCookie(response, token);
  if (shouldRegisterDevice(options) && options?.req) {
    await registerTrustedDevice({
      req: options.req,
      response,
      accountKind: 'instructor',
      accountId: row.account_id,
    });
  }
  return response;
}
