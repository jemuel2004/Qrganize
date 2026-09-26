import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const facultyId = searchParams.get('faculty_id');
    const academicYear = searchParams.get('academic_year');
    const semester = searchParams.get('semester');

    let sql = `
      SELECT p.*, f.name as faculty_name, f.position, f.employee_id
      FROM praise p
      JOIN faculty f ON p.faculty_id = f.id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    let idx = 1;

    if (facultyId) { sql += ` AND p.faculty_id = $${idx++}`; params.push(facultyId); }
    if (academicYear) { sql += ` AND p.academic_year = $${idx++}`; params.push(academicYear); }
    if (semester) { sql += ` AND p.semester = $${idx++}`; params.push(semester); }
    sql += ' ORDER BY f.name, p.created_at DESC';

    const result = await query(sql, params);
    return NextResponse.json({ praise: result.rows });
  } catch (error) {
    console.error('[GET /api/praise]', error);
    return NextResponse.json({ error: 'Failed to load praise records.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { faculty_id, praise_type, description, equivalent_units, equivalent_hours, academic_year, semester, remarks } = await req.json();

    if (!faculty_id || !praise_type || !academic_year || !semester) {
      return NextResponse.json({ error: 'Faculty, praise type, academic year, and semester are required' }, { status: 400 });
    }

    // Check if faculty is Permanent (employment_status is a generated column)
    const facultyResult = await query('SELECT employment_status FROM faculty WHERE id=$1', [faculty_id]);
    if (facultyResult.rows.length === 0) return NextResponse.json({ error: 'Faculty not found' }, { status: 404 });

    if (facultyResult.rows[0].employment_status !== 'Permanent') {
      return NextResponse.json({ error: 'Contractual instructors cannot have Praise assignments' }, { status: 400 });
    }

    const toNonNegNumber = (value: unknown): number | null => {
      if (value === '' || value === null || value === undefined) return 0;
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n) || n < 0) return null;
      return n;
    };
    const units = toNonNegNumber(equivalent_units);
    const hours = toNonNegNumber(equivalent_hours);
    if (units === null || hours === null) {
      return NextResponse.json({ error: 'Equivalent Units and Equivalent Hours must be non-negative numbers.' }, { status: 400 });
    }
    const hasAtMostThreeNumericDigits = (value: unknown) =>
      (String(value).match(/\d/g) ?? []).length <= 3;
    if (
      !hasAtMostThreeNumericDigits(equivalent_units)
      || !hasAtMostThreeNumericDigits(equivalent_hours)
      || !hasAtMostThreeNumericDigits(units)
      || !hasAtMostThreeNumericDigits(hours)
    ) {
      return NextResponse.json({ error: 'Maximum of 3 digits only (e.g., 1.23).' }, { status: 400 });
    }

    const result = await query(`
      INSERT INTO praise (faculty_id, praise_type, description, equivalent_units, equivalent_hours, academic_year, semester, remarks)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `, [faculty_id, praise_type, description, units, hours, academic_year, semester, remarks]);

    return NextResponse.json({ praise: result.rows[0] }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/praise]', error);
    return NextResponse.json({ error: 'Failed to save praise record.' }, { status: 500 });
  }
}
