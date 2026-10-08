import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { isRecentSignIn, mustChangePassword } from '@/auth/passwordChange';

/**
 * GET /api/auth/session — used by the frontend's page gate (proxy.ts).
 * 200 { role } when the session is valid and still live, otherwise 401.
 * getAuthUser verifies the JWT and checks it was not signed out / revoked.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.role) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  // must_change_password: the frontend sends every page to /change-password until it is done
  const mustChange = await mustChangePassword(user).catch(() => false);
  return NextResponse.json(
    // recent_sign_in: /change-password only takes a new password without the old one right after signing in
    { role: String(user.role), must_change_password: mustChange, recent_sign_in: isRecentSignIn(user) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
