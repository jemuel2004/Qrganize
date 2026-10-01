import { NextRequest, NextResponse } from 'next/server';
import { realtimeSessionUser, versionsFor } from '@/services/realtime';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/realtime/versions — current versions of the topics this user may
 * see (see packages/shared/src/realtime.ts) as `{ v, now }`. Open tabs check
 * it every few seconds and re-fetch whatever moved on. Numbers only, never records.
 */
export async function GET(req: NextRequest) {
  const user = await realtimeSessionUser(req).catch(() => null);
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401, headers: NO_STORE });
  try {
    return NextResponse.json(await versionsFor(user), { headers: NO_STORE });
  } catch (err) {
    console.warn('[realtime] versions unavailable:', (err as Error).message);
    return NextResponse.json({ error: 'Live updates are unavailable right now' }, { status: 503, headers: NO_STORE });
  }
}
