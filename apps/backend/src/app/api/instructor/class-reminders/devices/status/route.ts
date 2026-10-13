import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { ensurePushTables } from '@/database/pushSchema';
import { withAudit } from '@/services/audit';
import { reminderFacultyId } from '@/services/classReminderSettings';

/**
 * POST /api/instructor/class-reminders/devices/status { endpoint } — does this
 * device get the signed-in faculty member's reminders? (POST so the device's
 * address stays out of URLs and logs.) A device still set up for another
 * account changed hands: it is cleared, so it never shows that account's classes.
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

  try {
    await ensurePushTables();
    const row = (await query(`SELECT faculty_id FROM push_subscriptions WHERE endpoint = $1`, [body.endpoint]))
      .rows[0] as { faculty_id: number } | undefined;
    if (!row) return NextResponse.json({ registered: false });
    if (Number(row.faculty_id) === facultyId) return NextResponse.json({ registered: true });
    await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [body.endpoint]);
    return NextResponse.json({ registered: false, cleared: true });
  } catch (error) {
    console.error('[POST /api/instructor/class-reminders/devices/status]', error);
    return NextResponse.json({ error: 'Could not check this device.' }, { status: 500 });
  }
}

export const POST = withAudit(POST_handler);
