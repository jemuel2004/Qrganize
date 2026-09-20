import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { REGULAR_LOAD_MAX_UNITS } from '@/lib/regularLoad';

/* Module-level guard — DDL runs once per cold start, never on every request */
let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS instructor_load_deductions (
      id            SERIAL PRIMARY KEY,
      faculty_id    INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
      deduction_type TEXT NOT NULL,
      description   TEXT DEFAULT '',
      deducted_units NUMERIC(4,2) NOT NULL DEFAULT 0,
      semester      TEXT NOT NULL,
      school_year   TEXT NOT NULL,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_ild_faculty_sem ON instructor_load_deductions(faculty_id, semester, school_year)`).catch(() => {});
  await query(`ALTER TABLE faculty ALTER COLUMN designation_type TYPE TEXT`).catch(() => {});
  tableReady = true;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureTable();
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const semester   = searchParams.get('semester')    || '';
    const schoolYear = searchParams.get('school_year') || '';

    const result = await query(
      `SELECT id, deduction_type, description, deducted_units
       FROM instructor_load_deductions
       WHERE faculty_id = $1
         AND ($2 = '' OR semester    = $2)
         AND ($3 = '' OR school_year = $3)
       ORDER BY id`,
      [id, semester, schoolYear],
    );
    return NextResponse.json({ deductions: result.rows });
  } catch (error) {
    console.error('[GET /api/faculty/[id]/deductions]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authPost = await getAuthUser(req) as { role?: string } | null;
    if (!authPost || !['admin', 'department_chair'].includes(authPost.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureTable();
    const { id } = await params;
    const body = await req.json();
    const { deductions, semester, school_year } = body;

    if (!semester || !school_year) {
      return NextResponse.json(
        { error: 'Semester and school year are required.' },
        { status: 400 },
      );
    }

    const entries: { type: string; description: string; units: number }[] =
      Array.isArray(deductions) ? deductions : [];

    // Validate — empty entries = "None / no deduction" which is valid
    for (const e of entries) {
      if (!e.type?.trim()) {
        return NextResponse.json(
          { error: 'Each deduction must have a type.' },
          { status: 400 },
        );
      }
      const u = parseFloat(String(e.units));
      if (isNaN(u) || u <= 0) {
        return NextResponse.json(
          { error: `Units for "${e.type}" must be greater than 0.` },
          { status: 400 },
        );
      }
    }

    const totalDeduction = entries.reduce(
      (s, e) => s + (parseFloat(String(e.units)) || 0),
      0,
    );
    if (totalDeduction > REGULAR_LOAD_MAX_UNITS) {
      return NextResponse.json(
        { error: `Total deduction cannot exceed ${REGULAR_LOAD_MAX_UNITS} units.` },
        { status: 400 },
      );
    }

    // Verify faculty exists and is Permanent
    const facResult = await query(
      `SELECT id, employment_status FROM faculty WHERE id = $1 AND is_active = true`,
      [id],
    );
    if (facResult.rows.length === 0) {
      return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
    }
    if (facResult.rows[0].employment_status !== 'Permanent') {
      return NextResponse.json(
        { error: 'Load deductions only apply to Permanent faculty.' },
        { status: 400 },
      );
    }

    // Replace all deductions for this semester/year atomically
    await query(
      `DELETE FROM instructor_load_deductions
       WHERE faculty_id = $1 AND semester = $2 AND school_year = $3`,
      [id, semester, school_year],
    );

    for (const e of entries) {
      await query(
        `INSERT INTO instructor_load_deductions
           (faculty_id, deduction_type, description, deducted_units, semester, school_year)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          e.type.trim(),
          (e.description || '').trim(),
          parseFloat(String(e.units)),
          semester,
          school_year,
        ],
      );
    }

    // Cache a plain-text label on the faculty row (no VARCHAR limit issues — column is TEXT)
    const labelType  = entries.length > 0 ? entries.map(e => e.type).join(' + ') : 'No Designation';
    const labelUnits = totalDeduction;
    await query(
      `UPDATE faculty
       SET designation_type = $1, designation_units = $2, updated_at = NOW()
       WHERE id = $3`,
      [labelType, labelUnits, id],
    );

    const updatedFac = await query(
      `SELECT id, designation_type, designation_units FROM faculty WHERE id = $1`,
      [id],
    );

    return NextResponse.json({
      success: true,
      total_deduction: totalDeduction,
      faculty: updatedFac.rows[0],
    });
  } catch (error) {
    console.error('[POST /api/faculty/[id]/deductions]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
