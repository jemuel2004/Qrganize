import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { evaluateSession } from '@/auth/trustedDevices';
import { getRequiredJwtSecretBytes } from '@/auth/authSecret';

/**
 * Backend API gate: every /api request needs a valid, still-live session,
 * except the public sign-in endpoints below. Route handlers still do their
 * own role checks on top of this.
 */

const JWT_SECRET = getRequiredJwtSecretBytes();

/** Public API routes that never require a token (keyed as METHOD:pathname). */
const PUBLIC_API = new Set([
  'POST:/api/auth/login',
  'POST:/api/auth/google-login',
  'POST:/api/auth/logout',
  'GET:/api/auth/login-otp',
  'POST:/api/auth/login-otp',
  'DELETE:/api/auth/login-otp',
  'POST:/api/auth/login-otp/resend',
  'GET:/api/auth/verify-email-google',
  'POST:/api/auth/verify-email-google',
  'DELETE:/api/auth/verify-email-google',
  'GET:/api/settings/logo',
]);

/**
 * Checked every few seconds by each open tab. It returns version numbers only
 * and confirms the session itself (re-checked against the database every
 * 15 s), so the gate verifies the token without a database round trip.
 */
const TOKEN_ONLY_API = new Set([
  'GET:/api/realtime/versions',
]);

function clearAuth(res: NextResponse) {
  res.cookies.set('auth_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });
  return res;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_API.has(`${req.method}:${pathname}`)) return NextResponse.next();

  const token = req.cookies.get('auth_token')?.value;
  if (!token) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  let payload: Record<string, unknown>;
  try {
    payload = (await jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'] })).payload as Record<string, unknown>;
  } catch {
    return clearAuth(NextResponse.json({ error: 'Session expired' }, { status: 401 }));
  }

  if (TOKEN_ONLY_API.has(`${req.method}:${pathname}`)) return NextResponse.next();

  try {
    if (!(await evaluateSession(payload)).live) {
      return clearAuth(NextResponse.json({ error: 'Session expired' }, { status: 401 }));
    }
  } catch {
    // Database briefly unavailable — allow a still-valid JWT through.
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
