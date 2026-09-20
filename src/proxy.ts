import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';
import { evaluateSession } from '@/server/trustedDevices';
import { getRequiredJwtSecretBytes } from '@/lib/authSecret';

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

function homeForRole(role: string): string {
  if (role === 'instructor') return '/instructor';
  if (role === 'department_chair') return '/dept-chair';
  return '/dashboard';
}

function isInstructorArea(pathname: string): boolean {
  return pathname === '/instructor' || pathname.startsWith('/instructor/');
}

async function getPayload(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

function clearAuthAndContinue(req: NextRequest, unauthenticated: NextResponse) {
  unauthenticated.cookies.set('auth_token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 0,
    path: '/',
  });
  return unauthenticated;
}

/** Block cross-role page access; APIs keep handler-level role checks. */
function enforceRolePageAccess(
  req: NextRequest,
  pathname: string,
  role: string,
): NextResponse | null {
  if (pathname.startsWith('/api/')) return null;

  if (role === 'instructor' && !isInstructorArea(pathname)) {
    return NextResponse.redirect(new URL('/instructor', req.url));
  }

  if ((role === 'admin' || role === 'department_chair') && isInstructorArea(pathname)) {
    return NextResponse.redirect(new URL(homeForRole(role), req.url));
  }

  return null;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method;

  if (PUBLIC_API.has(`${method}:${pathname}`)) return NextResponse.next();

  const token = req.cookies.get('auth_token')?.value;

  if (pathname === '/' || pathname === '/login') {
    if (token) {
      const payload = await getPayload(token);
      if (payload) {
        let live = true;
        try {
          live = (await evaluateSession(payload)).live;
        } catch {
          live = true;
        }
        if (live) {
          const dest = homeForRole(String(payload.role ?? 'admin'));
          return NextResponse.redirect(new URL(dest, req.url));
        }
        const res = pathname === '/'
          ? NextResponse.redirect(new URL('/login', req.url))
          : NextResponse.next();
        return clearAuthAndContinue(req, res);
      }
    }
    if (pathname === '/') return NextResponse.redirect(new URL('/login', req.url));
    return NextResponse.next();
  }

  if (!token) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const payload = await getPayload(token);
  if (!payload) {
    const res = pathname.startsWith('/api/')
      ? NextResponse.json({ error: 'Session expired' }, { status: 401 })
      : NextResponse.redirect(new URL('/login', req.url));
    return clearAuthAndContinue(req, res);
  }

  try {
    const session = await evaluateSession(payload);
    if (!session.live) {
      const res = pathname.startsWith('/api/')
        ? NextResponse.json({ error: 'Session expired' }, { status: 401 })
        : NextResponse.redirect(new URL('/login', req.url));
      return clearAuthAndContinue(req, res);
    }
  } catch {
    // Database briefly unavailable — allow a still-valid JWT through.
  }

  const roleGate = enforceRolePageAccess(req, pathname, String(payload.role ?? ''));
  if (roleGate) return roleGate;

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/|favicon\\.ico|uploads|nemlogo).*)',
  ],
};
