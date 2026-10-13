import { NextRequest, NextResponse } from 'next/server';
import { cleanText, readJsonObject } from '@/services/requestInput';
import { query } from '@/database/db';
import { parseId } from '@/database/ids';
import { getAuthUser } from '@/auth/auth';
import { formatLoadCap, maxDeductionUnits, permanentRegularLoadLimit, shownUnitsCap } from '@shared/regularLoad';
import { getWorkloadPolicy } from '@/services/workloadPolicy';
import { canAccessProgram, isScopedChair } from '@/services/programScope';
import { withAudit } from '@/services/audit';

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
    const auth = await getAuthUser(req) as { role?: string; program_id?: number | null } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (isScopedChair(auth)) {
      const fid = parseId((await params).id);
      if (fid === null) return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
      const ownerCheck = await query('SELECT program_id FROM faculty WHERE id = $1', [fid]);
      if (ownerCheck.rows.length === 0) return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
      if (!(await canAccessProgram(auth, ownerCheck.rows[0].program_id))) {
        return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
      }
    }

    await ensureTable();
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
    const { searchParams } = new URL(req.url);
    const semester   = cleanText(searchParams.get('semester'), 40);
    const schoolYear = cleanText(searchParams.get('school_year'), 40);
    if (semester === null || schoolYear === null) {
      return NextResponse.json({ error: 'Invalid term.' }, { status: 400 });
    }

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

async function POST_handler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authPost = await getAuthUser(req) as { role?: string; program_id?: number | null } | null;
    if (!authPost || !['admin', 'department_chair', 'program_chair'].includes(authPost.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (isScopedChair(authPost)) {
      const fid = parseId((await params).id);
      if (fid === null) return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
      const ownerCheck = await query('SELECT program_id FROM faculty WHERE id = $1', [fid]);
      if (ownerCheck.rows.length === 0) return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
      if (!(await canAccessProgram(authPost, ownerCheck.rows[0].program_id))) {
        return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
      }
    }

    await ensureTable();
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
    const body = await readJsonObject(req);
    const semester = cleanText(body?.semester, 40);
    const school_year = cleanText(body?.school_year, 40);
    const deductions = body?.deductions;

    if (!semester || !school_year) {
      return NextResponse.json(
        { error: 'Semester and school year are required.' },
        { status: 400 },
      );
    }

    if (deductions !== undefined && deductions !== null && !Array.isArray(deductions)) {
      return NextResponse.json({ error: 'Invalid deductions.' }, { status: 400 });
    }

    // Validate — empty entries = "None / no deduction" which is valid
    const entries: { type: string; description: string; units: number }[] = [];
    for (const raw of Array.isArray(deductions) ? deductions : []) {
      const e = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const type = cleanText(e.type, 100);
      const description = cleanText(e.description, 2000);
      if (!type || description === null) {
        return NextResponse.json(
          { error: 'Each deduction must have a type.' },
          { status: 400 },
        );
      }
      const u = parseFloat(String(e.units));
      if (isNaN(u) || u <= 0) {
        return NextResponse.json(
          { error: `Units for "${type}" must be greater than 0.` },
          { status: 400 },
        );
      }
      entries.push({ type, description, units: u });
    }

    const totalDeduction = entries.reduce(
      (s, e) => s + (parseFloat(String(e.units)) || 0),
      0,
    );
    // Deloading can take at most the whole Regular Load (Settings → Workload Limits)
    const policy = await getWorkloadPolicy();
    const maxDeduction = maxDeductionUnits(policy);
    if (totalDeduction > maxDeduction) {
      return NextResponse.json(
        { error: `Total deduction cannot exceed ${formatLoadCap(shownUnitsCap(maxDeduction))} units.` },
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

    // The Regular Load never goes past its limit: deloading that would leave the subjects
    // already in Regular Load over the new limit is refused until part of them moves to Overload.
    const newLimit = permanentRegularLoadLimit(totalDeduction, policy);
    const currentRegular = parseFloat(String((await query(
      `SELECT COALESCE(SUM(units), 0) AS total FROM instructor_loads
        WHERE faculty_id = $1 AND load_category = 'Regular' AND academic_year = $2 AND semester = $3`,
      [id, school_year, semester],
    )).rows[0]?.total ?? 0)) || 0;
    if (currentRegular > newLimit + 0.001) {
      return NextResponse.json({
        error: `With ${formatLoadCap(totalDeduction)} units of deloading the Regular Load limit is ${formatLoadCap(shownUnitsCap(newLimit))} units, `
          + `but ${currentRegular.toFixed(2)} units are already in Regular Load. Move at least ${(currentRegular - newLimit).toFixed(2)} units `
          + 'to Overload (or remove a subject) first, then save the deloading.',
        over_limit: true,
      }, { status: 409 });
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

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
