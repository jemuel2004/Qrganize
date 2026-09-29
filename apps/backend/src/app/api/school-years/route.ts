import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { ensureSystemSettingsTable } from '@/database/schema-guard';
import { withAudit } from '@/services/audit';

/* Module-level guard — DDL runs once per cold start, never on every request */
let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;
  await ensureSystemSettingsTable();
  await query(`
    CREATE TABLE IF NOT EXISTS school_years (
      id         SERIAL PRIMARY KEY,
      label      VARCHAR(20) NOT NULL UNIQUE,
      status     VARCHAR(20) NOT NULL DEFAULT 'Archived'
                 CHECK (status IN ('Active', 'Archived')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  tablesReady = true;
}

async function migrateFromSettings() {
  // If school_years is empty, seed from system_settings.current_school_year
  const count = await query('SELECT COUNT(*)::int AS n FROM school_years');
  if (count.rows[0].n > 0) return;
  const ss = await query(
    "SELECT value FROM system_settings WHERE key = 'current_school_year'"
  );
  const existing = ss.rows[0]?.value;
  if (existing) {
    await query(
      `INSERT INTO school_years (label, status)
       VALUES ($1, 'Active')
       ON CONFLICT (label) DO UPDATE SET status = 'Active', updated_at = NOW()`,
      [existing]
    );
  }
}

export async function GET() {
  try {
    await ensureTables();
    await migrateFromSettings();

    const [yearsRes, semRes] = await Promise.all([
      query('SELECT id, label, status, created_at FROM school_years ORDER BY label DESC'),
      query("SELECT value FROM system_settings WHERE key = 'current_semester'"),
    ]);

    return NextResponse.json({
      years:          yearsRes.rows,
      currentSemester: semRes.rows[0]?.value ?? '1st Semester',
    });
  } catch (err) {
    console.error('[GET /api/school-years]', err);
    return NextResponse.json({ years: [], currentSemester: '1st Semester' });
  }
}

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || (auth.role !== 'admin' && auth.role !== 'program_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { label } = await req.json();
    if (!label || typeof label !== 'string') {
      return NextResponse.json({ error: 'Label is required.' }, { status: 400 });
    }

    const normalized = label.trim().replace('–', '-'); // normalise em-dash
    if (!/^\d{4}-\d{4}$/.test(normalized)) {
      return NextResponse.json(
        { error: 'Invalid format. Use YYYY-YYYY (e.g. 2025-2026).' },
        { status: 400 }
      );
    }
    const [start, end] = normalized.split('-').map(Number);
    if (end !== start + 1) {
      return NextResponse.json(
        { error: 'End year must be start year + 1.' },
        { status: 400 }
      );
    }

    await ensureTables();

    const result = await query(
      `INSERT INTO school_years (label, status)
       VALUES ($1, 'Archived')
       RETURNING id, label, status, created_at`,
      [normalized]
    );

    return NextResponse.json({ year: result.rows[0] }, { status: 201 });
  } catch (err: unknown) {
    const pg = err as { code?: string };
    if (pg?.code === '23505') {
      return NextResponse.json({ error: 'This school year already exists.' }, { status: 409 });
    }
    console.error('[POST /api/school-years]', err);
    return NextResponse.json({ error: 'Failed to create school year.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
