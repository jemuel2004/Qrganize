import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { ensureCurriculumFields } from '@/server/migrateCurriculum';
import { normalizeYearLevel, normalizeSemester } from '@/server/normalizeCurriculum';
import { categoryFromHours } from '@/lib/subjectCategory';
import {
  DEFAULT_CURRICULUM_VERSION,
  parseCurriculumVersion,
  type CurriculumVersion,
} from '@/lib/curriculumVersion';

function versionFromQuery(req: NextRequest): CurriculumVersion {
  return parseCurriculumVersion(new URL(req.url).searchParams.get('curriculum_version'))
    ?? DEFAULT_CURRICULUM_VERSION;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureCurriculumFields();
    const { searchParams } = new URL(req.url);
    const programId = searchParams.get('program_id')?.trim() ?? '';

    // Program is always required — prevent full-table scans
    if (!programId || isNaN(Number(programId))) {
      return NextResponse.json({ curriculums: [] });
    }

    /*
     * Normalize year_level and semester so that "First Year" / "FIRST YEAR"
     * still matches rows stored as "1st Year".
     * An empty string means "all" — the WHERE clause is omitted for that dimension.
     */
    const rawYear = searchParams.get('year_level') ?? '';
    const rawSem  = searchParams.get('semester')   ?? '';
    const yearLevel = rawYear ? normalizeYearLevel(rawYear) : '';
    const semester  = rawSem  ? normalizeSemester(rawSem)   : '';
    const version   = versionFromQuery(req);

    let sql = `
      SELECT c.*, p.code AS program_code, p.name AS program_name
      FROM curriculums c
      JOIN programs p ON c.program_id = p.id
      WHERE c.is_active = true
        AND c.program_id = $1
        AND c.curriculum_version = $2
    `;
    const params: unknown[] = [programId, version];
    let idx = 3;

    if (yearLevel) { sql += ` AND c.year_level = $${idx++}`; params.push(yearLevel); }
    if (semester)  { sql += ` AND c.semester   = $${idx++}`; params.push(semester); }

    sql += ' ORDER BY c.year_level, c.semester, c.subject_code';

    const result = await query(sql, params);
    return NextResponse.json({
      curriculums: result.rows.map(r => ({
        ...r,
        subject_category: categoryFromHours(r.lecture_hours, r.laboratory_hours),
      })),
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureCurriculumFields();

    const body = await req.json();
    const { program_id, year_level, semester, subject_code, subject_name,
            lecture_hours, laboratory_hours, units, prerequisites, grade } = body;
    const version = parseCurriculumVersion(body.curriculum_version) ?? DEFAULT_CURRICULUM_VERSION;

    if (!program_id || !year_level || !semester || !subject_code || !subject_name) {
      return NextResponse.json({ error: 'All required fields must be filled' }, { status: 400 });
    }
    /* Category is derived from hours, never from client-supplied labels or codes. */
    const category = categoryFromHours(lecture_hours, laboratory_hours);
    if (lecture_hours < 0 || laboratory_hours < 0) {
      return NextResponse.json({ error: 'Hours cannot be negative' }, { status: 400 });
    }
    if (units < 0) {
      return NextResponse.json({ error: 'Credit Units cannot be negative' }, { status: 400 });
    }

    /* Normalize before inserting from the Add Subject form as well */
    const normYear = normalizeYearLevel(year_level) || year_level;
    const normSem  = normalizeSemester(semester)    || semester;

    const result = await query(`
      INSERT INTO curriculums
        (program_id, year_level, semester, subject_code, subject_name,
         lecture_hours, laboratory_hours, units, prerequisites, grade, subject_category, curriculum_version)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [
      program_id, normYear, normSem,
      String(subject_code).toUpperCase().trim(), subject_name,
      lecture_hours || 0, laboratory_hours || 0,
      parseFloat(String(units)) || 0,
      prerequisites || '', grade || '',
      category, version,
    ]);

    return NextResponse.json({ curriculum: result.rows[0] }, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('unique') || msg.includes('duplicate'))
      return NextResponse.json({ error: 'Subject code already exists for this program, year level, semester, and curriculum version.' }, { status: 409 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
