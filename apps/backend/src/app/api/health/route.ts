import { NextResponse } from 'next/server';

/**
 * GET /api/health — public and database-free. Render's free plan puts the
 * server to sleep after 15 minutes without visitors (waking takes up to a
 * minute); an uptime pinger calling this every ~10 minutes keeps it awake.
 */
export function GET() {
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
