import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { ensureSystemSettingsTable } from '@/database/schema-guard';
import { withAudit } from '@/services/audit';

// GET — used by SchoolYearContext on every page to get the global active year + semester.
export async function GET() {
  try {
    const period = await getActiveAcademicPeriod();
    return NextResponse.json(period);
  } catch {
    return NextResponse.json({ schoolYear: null, semester: null });
  }
}

// POST — only updates the default semester now.
// School year activation is managed via PATCH /api/school-years/[id].
async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || (auth.role !== 'admin' && auth.role !== 'program_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    await ensureSystemSettingsTable();

    const semester = body.semester ?? '';
    await query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ('current_semester', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [semester]
    );

    return NextResponse.json({ success: true, semester });
  } catch {
    return NextResponse.json({ error: 'Failed to save semester.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
