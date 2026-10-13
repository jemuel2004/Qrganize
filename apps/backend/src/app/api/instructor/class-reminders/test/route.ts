import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { ensurePushTables } from '@/database/pushSchema';
import { withAudit } from '@/services/audit';
import { reminderFacultyId } from '@/services/classReminderSettings';
import { sendPush } from '@/services/webPush';

/** One test per faculty member this often */
const TEST_EVERY_MS = 15_000;
const lastTest = new Map<number, number>();

/**
 * POST /api/instructor/class-reminders/test { endpoint } — sends a sample
 * reminder to this device, so the faculty member sees what one looks like and
 * that it arrives. Only to their own device.
 */
async function POST_handler(req: NextRequest) {
  const facultyId = await reminderFacultyId(req);
  if (!facultyId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { endpoint?: unknown };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  if (typeof body.endpoint !== 'string' || !body.endpoint || body.endpoint.length > 1024) {
    return NextResponse.json({ error: 'Invalid device.' }, { status: 400 });
  }

  const now = Date.now();
  if (now - (lastTest.get(facultyId) ?? 0) < TEST_EVERY_MS) {
    return NextResponse.json({ error: 'A test reminder was just sent. Please wait a few seconds.' }, { status: 429 });
  }

  try {
    await ensurePushTables();
    const sub = (await query(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = $1 AND faculty_id = $2`,
      [body.endpoint, facultyId],
    )).rows[0] as { id: number; endpoint: string; p256dh: string; auth: string } | undefined;
    if (!sub) {
      return NextResponse.json({ error: 'Reminders are not set up on this device yet.' }, { status: 404 });
    }
    if (lastTest.size > 2000) lastTest.clear();
    lastTest.set(facultyId, now);

    const outcome = await sendPush(sub, {
      v: 1,
      kind: 'test',
      title: 'QRganize — Test Reminder',
      body: 'Class reminders work on this device. You will get one before each class.',
      url: '/instructor/profile',
      tag: 'qrganize-test',
      icon: '/icons/icon-192.png',
    }, { ttlSeconds: 300, urgency: 'high' });

    if (outcome === 'gone') {
      await query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
      return NextResponse.json({ error: 'This device stopped accepting reminders. Turn them on again.' }, { status: 410 });
    }
    if (outcome === 'retry') {
      return NextResponse.json({ error: 'The notification service did not answer. Try again in a moment.' }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[POST /api/instructor/class-reminders/test]', error);
    return NextResponse.json({ error: 'Could not send a test reminder.' }, { status: 500 });
  }
}

export const POST = withAudit(POST_handler);
