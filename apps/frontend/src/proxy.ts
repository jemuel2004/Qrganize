import { NextRequest, NextResponse } from 'next/server';
import { ROLE_HEADER } from '@/lib/pageAuth';

/**
 * Frontend page gate. The frontend holds no secrets and no database access:
 * the session is confirmed by the backend (`GET /api/auth/session`), which
 * verifies the JWT and checks it has not been signed out or revoked.
 *
 * `/api/*` and `/uploads/*` are not handled here — next.config.ts forwards
 * them to the backend, which enforces its own auth.
 */

const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:4000').replace(/\/$/, '');

/** mustChangePassword: signed in on a default / common password — every page goes to /change-password */
type Session = { state: 'live'; role: string; mustChangePassword: boolean } | { state: 'dead' } | { state: 'unreachable' };

/** The page where a default / common password is replaced before anything else */
const CHANGE_PASSWORD = '/change-password';

// Short cache so page + prefetch requests don't all hit the backend.
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; session: Session }>();

/**
 * How long a page waits for the session check. The free backend sleeps when
 * idle and takes up to a minute to wake: the sign-in page never waits for it
 * (it shows at once), other pages give up after a while and go to sign-in.
 */
const LOGIN_CHECK_MS = 2_500;
const PAGE_CHECK_MS = 20_000;

async function checkSession(token: string, timeoutMs: number): Promise<Session> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.session;
  let session: Session;
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/session`, {
      headers: { cookie: `auth_token=${encodeURIComponent(token)}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const data = await res.json() as { role?: string; must_change_password?: boolean };
      session = data.role
        ? { state: 'live', role: data.role, mustChangePassword: data.must_change_password === true }
        : { state: 'dead' };
    } else {
      session = res.status === 401 || res.status === 403 ? { state: 'dead' } : { state: 'unreachable' };
    }
  } catch {
    session = { state: 'unreachable' };
  }
  if (session.state !== 'unreachable') {
    if (cache.size > 500) cache.clear();
    cache.set(token, { at: Date.now(), session });
  }
  return session;
}

function homeForRole(role: string): string {
  if (role === 'instructor') return '/instructor';
  if (role === 'program_chair') return '/dept-chair';
  return '/dashboard';
}

/** A room's page (/room/<code>) — what a room QR opens on a phone camera; every role may open it */
function isQrLink(pathname: string): boolean {
  return pathname.startsWith('/room/');
}

function isInstructorArea(pathname: string): boolean {
  return pathname === '/instructor' || pathname.startsWith('/instructor/');
}

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

/** Continue to the page, passing the confirmed role (and never a client-sent one). */
function next(req: NextRequest, role: string | null) {
  const h = new Headers(req.headers);
  h.delete(ROLE_HEADER);
  if (role) h.set(ROLE_HEADER, role);
  return NextResponse.next({ request: { headers: h } });
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get('auth_token')?.value;

  // Replacing a default / common password: only for a session that has to
  if (pathname === CHANGE_PASSWORD) {
    if (!token) return NextResponse.redirect(new URL('/login', req.url));
    const s = await checkSession(token, PAGE_CHECK_MS);
    if (s.state === 'dead') return clearAuth(NextResponse.redirect(new URL('/login', req.url)));
    if (s.state === 'unreachable') return NextResponse.redirect(new URL('/login', req.url));
    if (!s.mustChangePassword) return NextResponse.redirect(new URL(homeForRole(s.role), req.url));
    return next(req, s.role);
  }

  if (pathname === '/' || pathname === '/login') {
    if (token) {
      const s = await checkSession(token, LOGIN_CHECK_MS);
      if (s.state === 'live') {
        if (s.mustChangePassword) return NextResponse.redirect(new URL(CHANGE_PASSWORD, req.url));
        // Already signed in: a room QR link goes straight on to that room
        const back = req.nextUrl.searchParams.get('next') ?? '';
        const target = isQrLink(back) && /^\/room\/[A-Za-z0-9%-]{4,100}$/.test(back) ? back : homeForRole(s.role);
        return NextResponse.redirect(new URL(target, req.url));
      }
      if (s.state === 'dead') {
        return clearAuth(pathname === '/' ? NextResponse.redirect(new URL('/login', req.url)) : next(req, null));
      }
    }
    if (pathname === '/') return NextResponse.redirect(new URL('/login', req.url));
    return next(req, null);
  }

  // Signed out: sign in first; a room QR link comes back to that room afterwards
  const toLogin = () => {
    const url = new URL('/login', req.url);
    if (isQrLink(pathname)) url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  };
  if (!token) return toLogin();

  const s = await checkSession(token, PAGE_CHECK_MS);
  if (s.state === 'dead') return clearAuth(toLogin());
  // Backend down: keep the cookie, send to login (every page needs the backend anyway).
  if (s.state === 'unreachable') return NextResponse.redirect(new URL('/login', req.url));

  // A default / common password is changed before any page opens
  if (s.mustChangePassword) return NextResponse.redirect(new URL(CHANGE_PASSWORD, req.url));

  // Cross-role page access (a room QR link sorts each role out itself)
  if (isQrLink(pathname)) return next(req, s.role);
  if (s.role === 'instructor' && !isInstructorArea(pathname)) {
    return NextResponse.redirect(new URL('/instructor', req.url));
  }
  if ((s.role === 'admin' || s.role === 'department_chair' || s.role === 'program_chair') && isInstructorArea(pathname)) {
    return NextResponse.redirect(new URL(homeForRole(s.role), req.url));
  }

  return next(req, s.role);
}

export const config = {
  matcher: [
    // Pages only — API calls and uploaded files go straight to the backend.
    '/((?!api/|uploads/|_next/|favicon\\.ico|nemlogo).*)',
  ],
};
