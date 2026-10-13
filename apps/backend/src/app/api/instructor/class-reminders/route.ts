import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { ensurePushTables } from '@/database/pushSchema';
import { withAudit } from '@/services/audit';
import { reminderFacultyId, reminderSettings } from '@/services/classReminderSettings';
import { DEFAULT_REMINDER_LEAD, isReminderLead } from '@shared/classReminderTiming';

/**
 * GET /api/instructor/class-reminders — the signed-in faculty member's class
 * reminders on their devices: on or off, minutes before class (30 / 15 / 5),
 * how many devices get them, and the public key a browser subscribes with.
 * PUT { enabled?, lead_minutes? } — change them. Only ever the caller's own.
 */
export async function GET(req: NextRequest) {
  const facultyId = await reminderFacultyId(req);
  if (!facultyId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await reminderSettings(facultyId));
  } catch (error) {
    console.error('[GET /api/instructor/class-reminders]', error);
    return NextResponse.json({ error: 'Could not load your class reminder settings.' }, { status: 500 });
  }
}

async function PUT_handler(req: NextRequest) {
  const facultyId = await reminderFacultyId(req);
  if (!facultyId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

  const enabled = body.enabled;
  const lead = body.lead_minutes;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'Invalid setting.' }, { status: 400 });
  }
  if (lead !== undefined && !isReminderLead(lead)) {
    return NextResponse.json({ error: 'Choose 30, 15 or 5 minutes before class.' }, { status: 400 });
  }
  if (enabled === undefined && lead === undefined) {
    return NextResponse.json({ error: 'Nothing to change.' }, { status: 400 });
  }

  try {
    await ensurePushTables();
    await query(`
      INSERT INTO class_reminder_settings (faculty_id, enabled, lead_minutes, updated_at)
      VALUES ($1, COALESCE($2::boolean, FALSE), COALESCE($3::smallint, $4::smallint), NOW())
      ON CONFLICT (faculty_id) DO UPDATE SET
        enabled      = COALESCE($2::boolean,  class_reminder_settings.enabled),
        lead_minutes = COALESCE($3::smallint, class_reminder_settings.lead_minutes),
        updated_at   = NOW()
    `, [facultyId, enabled ?? null, lead ?? null, DEFAULT_REMINDER_LEAD]);
    return NextResponse.json(await reminderSettings(facultyId));
  } catch (error) {
    console.error('[PUT /api/instructor/class-reminders]', error);
    return NextResponse.json({ error: 'Could not save your class reminder settings.' }, { status: 500 });
  }
}

export const PUT = withAudit(PUT_handler);
