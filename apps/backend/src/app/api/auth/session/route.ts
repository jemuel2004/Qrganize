import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';

/**
 * GET /api/auth/session — used by the frontend's page gate (proxy.ts).
 * 200 { role } when the session is valid and still live, otherwise 401.
 * getAuthUser verifies the JWT and checks it was not signed out / revoked.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.role) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  return NextResponse.json({ role: String(user.role) }, { headers: { 'Cache-Control': 'no-store' } });
}
