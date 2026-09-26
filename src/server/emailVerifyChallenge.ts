import { NextRequest, NextResponse } from 'next/server';
import {
  clearAuthCookie,
  clearOtpCookie,
  signShortToken,
  verifyToken,
} from '@/server/auth';
import { EMAIL_VERIFICATION_REQUIRED } from '@/server/emailIdentity';

export const EMAIL_VERIFY_COOKIE = 'email_verify_challenge';
export const EMAIL_VERIFY_TTL_SEC = 30 * 60;

export type EmailVerifyChallengePayload = {
  purpose: 'email_verify';
  accountKind: 'user' | 'instructor';
  accountId: number;
  role: 'program_chair' | 'instructor';
  username: string;
  email: string;
  av: number;
  program_id?: number | null;
  faculty_id?: number;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
};

export function emailVerifyCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge: EMAIL_VERIFY_TTL_SEC,
    path: '/',
  };
}

export function setEmailVerifyCookie(response: NextResponse, token: string) {
  response.cookies.set(EMAIL_VERIFY_COOKIE, token, emailVerifyCookieOptions());
}

export function clearEmailVerifyCookie(response: NextResponse) {
  response.cookies.set(EMAIL_VERIFY_COOKIE, '', { ...emailVerifyCookieOptions(), maxAge: 0 });
}

export function getEmailVerifyToken(req: NextRequest): string | undefined {
  return req.cookies.get(EMAIL_VERIFY_COOKIE)?.value;
}

export async function readEmailVerifyChallenge(
  req: NextRequest
): Promise<EmailVerifyChallengePayload | null> {
  const raw = getEmailVerifyToken(req);
  if (!raw) return null;
  const payload = await verifyToken(raw);
  if (!payload || payload.purpose !== 'email_verify') return null;
  const role = String(payload.role ?? '');
  if (role !== 'program_chair' && role !== 'instructor') return null;
  const accountKind = payload.accountKind === 'instructor' ? 'instructor' : 'user';
  const accountId = Number(payload.accountId);
  if (!accountId) return null;
  return {
    purpose: 'email_verify',
    accountKind,
    accountId,
    role,
    username: String(payload.username ?? ''),
    email: String(payload.email ?? ''),
    av: Number(payload.av ?? 1),
    program_id: payload.program_id == null ? null : Number(payload.program_id),
    faculty_id: payload.faculty_id == null ? undefined : Number(payload.faculty_id),
    first_name: (payload.first_name as string | null | undefined) ?? null,
    last_name: (payload.last_name as string | null | undefined) ?? null,
    name: (payload.name as string | null | undefined) ?? null,
  };
}

function maskEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.indexOf('@');
  if (at <= 0) return 'your registered email';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

/** Password was valid but email ownership is not verified — no full session. */
export async function emailVerificationRequiredResponse(
  challenge: Omit<EmailVerifyChallengePayload, 'purpose'>
): Promise<NextResponse> {
  const token = await signShortToken(
    { purpose: 'email_verify', ...challenge },
    `${EMAIL_VERIFY_TTL_SEC}s`
  );
  const response = NextResponse.json(
    {
      error: EMAIL_VERIFICATION_REQUIRED,
      EMAIL_VERIFICATION_REQUIRED: true,
      email_verification_required: true,
      role: challenge.role,
      masked_email: maskEmail(challenge.email),
      verify_with_google: true,
    },
    { status: 403 }
  );
  /* Never leave a prior full session alongside a verify challenge. */
  clearAuthCookie(response);
  clearOtpCookie(response);
  setEmailVerifyCookie(response, token);
  return response;
}
