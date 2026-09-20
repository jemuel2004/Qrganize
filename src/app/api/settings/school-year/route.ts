import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { getActiveAcademicPeriod } from '@/server/activeAcademicPeriod';
import { ensureSystemSettingsTable } from '@/server/schema-guard';

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
export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || auth.role !== 'admin') {
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
