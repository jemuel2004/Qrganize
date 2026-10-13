import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { ensurePushTables } from '@/database/pushSchema';
import { withAudit } from '@/services/audit';
import { reminderFacultyId, reminderSettings } from '@/services/classReminderSettings';
import { isPushEndpoint, validPushKeys } from '@/services/webPush';

/** Devices kept per faculty member (the newest) */
const MAX_DEVICES = 10;

/**
 * POST /api/instructor/class-reminders/devices — this browser / phone gets the
 * signed-in faculty member's class reminders. Body: the browser's push
 * subscription ({ endpoint, keys: { p256dh, auth } }). A device another account
 * used before moves to this one, so it never shows someone else's classes.
 *
 * DELETE { endpoint } — this device stops getting reminders (turning them off,
 * signing out). Only someone on the device knows its address, so whoever it
 * belonged to, it stops.
 */
async function POST_handler(req: NextRequest) {
  const facultyId = await reminderFacultyId(req);
  if (!facultyId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (!isPushEndpoint(endpoint) || !validPushKeys(p256dh, auth)) {
    return NextResponse.json({ error: 'This browser cannot receive QRganize reminders.' }, { status: 400 });
  }

  try {
    await ensurePushTables();
    await query(`
      INSERT INTO push_subscriptions (faculty_id, endpoint, p256dh, auth, user_agent)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (endpoint) DO UPDATE SET
        faculty_id = EXCLUDED.faculty_id,
        p256dh     = EXCLUDED.p256dh,
        auth       = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        created_at = CASE WHEN push_subscriptions.faculty_id = EXCLUDED.faculty_id
                          THEN push_subscriptions.created_at ELSE NOW() END
    `, [facultyId, endpoint, p256dh, auth, (req.headers.get('user-agent') ?? '').slice(0, 160)]);
    await query(`
      DELETE FROM push_subscriptions
      WHERE  faculty_id = $1
        AND  id NOT IN (SELECT id FROM push_subscriptions WHERE faculty_id = $1
                        ORDER BY created_at DESC, id DESC LIMIT ${MAX_DEVICES})
    `, [facultyId]);
    return NextResponse.json(await reminderSettings(facultyId));
  } catch (error) {
    console.error('[POST /api/instructor/class-reminders/devices]', error);
    return NextResponse.json({ error: 'Could not set up reminders on this device.' }, { status: 500 });
  }
}

async function DELETE_handler(req: NextRequest) {
  const facultyId = await reminderFacultyId(req);
  if (!facultyId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { endpoint?: unknown };
  try { body = await req.json() as typeof body; }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  if (typeof body.endpoint !== 'string' || !body.endpoint || body.endpoint.length > 1024) {
    return NextResponse.json({ error: 'Invalid device.' }, { status: 400 });
  }

  try {
    await ensurePushTables();
    await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [body.endpoint]);
    return NextResponse.json(await reminderSettings(facultyId));
  } catch (error) {
    console.error('[DELETE /api/instructor/class-reminders/devices]', error);
    return NextResponse.json({ error: 'Could not turn off reminders on this device.' }, { status: 500 });
  }
}

export const POST = withAudit(POST_handler);
export const DELETE = withAudit(DELETE_handler);
