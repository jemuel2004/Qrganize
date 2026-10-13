import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { withAudit } from '@/services/audit';
import { runClassPushReminders } from '@/services/classPush';

/**
 * GET or POST /api/cron/class-reminders — sends the class reminders due now
 * (services/classPush.ts). The server already does this every minute while it
 * is awake; on a host that sleeps when idle (Render's free plan) an outside
 * scheduler calling this every 5 minutes wakes it so reminders still go out.
 *
 * Off unless CRON_SECRET is set (at least 16 characters); the caller sends
 * "Authorization: Bearer <CRON_SECRET>". It answers with counts only.
 */
function authorized(req: NextRequest): boolean | null {
  const secret = process.env.CRON_SECRET?.trim() ?? '';
  if (secret.length < 16) return null;
  const given = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handler(req: NextRequest) {
  const ok = authorized(req);
  if (ok === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const result = await runClassPushReminders();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error('[cron/class-reminders]', error);
    return NextResponse.json({ error: 'Reminder run failed.' }, { status: 500 });
  }
}

export const GET = handler;
export const POST = withAudit(handler);
