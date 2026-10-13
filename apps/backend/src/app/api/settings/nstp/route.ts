import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { withAudit } from '@/services/audit';
import { getNstpSchedule, saveNstpSchedule } from '@/services/nstp';
import { NSTP_DAY, validateNstpSchedule } from '@shared/nstp';

/*
 * NSTP (Settings → Day Combinations → NSTP) — Class Program only.
 *   GET — the setting (any signed-in user): every Saturday, its time and the
 *         handler's typed name.
 *   PUT { start_time, end_time, handler_name } — Administrator only. The Class
 *         Program follows at once; nothing else in the scheduling changes.
 */

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ day: NSTP_DAY, ...(await getNstpSchedule()) });
  } catch (error) {
    console.error('[GET /api/settings/nstp]', error);
    return NextResponse.json({ error: 'Could not load the NSTP setting.' }, { status: 500 });
  }
}

async function PUT_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (auth.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Send the NSTP time and handler.' }, { status: 400 });
    }
    const checked = validateNstpSchedule(body);
    if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

    return NextResponse.json({ day: NSTP_DAY, ...(await saveNstpSchedule(checked.value)) });
  } catch (error) {
    console.error('[PUT /api/settings/nstp]', error);
    return NextResponse.json({ error: 'Could not save the NSTP setting.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const PUT = withAudit(PUT_handler);
