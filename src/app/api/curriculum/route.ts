import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { ensureCurriculumFields } from '@/server/migrateCurriculum';
import { normalizeYearLevel, normalizeSemester } from '@/server/normalizeCurriculum';
import { categoryFromHours } from '@/lib/subjectCategory';
import {
  DEFAULT_CURRICULUM_VERSION,
  parseCurriculumVersion,
  type CurriculumVersion,
} from '@/lib/curriculumVersion';
import { resolveProgramScope, canAccessProgram } from '@/server/programScope';

function versionFromQuery(req: NextRequest): CurriculumVersion {
  return parseCurriculumVersion(new URL(req.url).searchParams.get('curriculum_version'))
    ?? DEFAULT_CURRICULUM_VERSION;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string; program_id?: number | null } | null;
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureCurriculumFields();
    const { searchParams } = new URL(req.url);
    const scope = await resolveProgramScope(auth, { requestedProgramId: searchParams.get('program_id') });
    if (!scope.ok) return scope.response;

    // Program is always required — prevent full-table scans
    if (scope.programId == null) {
      return NextResponse.json({ curriculums: [] });
    }
    const programId = String(scope.programId);

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
    const auth = await getAuthUser(req) as { role?: string; program_id?: number | null } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
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
    if (!(await canAccessProgram(auth, Number(program_id)))) {
      return NextResponse.json({ error: 'You can only manage curriculum for your assigned program.' }, { status: 403 });
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
    const normCode = String(subject_code).toUpperCase().trim();
    const lecH = lecture_hours || 0;
    const labH = laboratory_hours || 0;
    const unitsVal = parseFloat(String(units)) || 0;
    const prereqVal = prerequisites || '';
    const gradeVal = grade || '';

    const curriculum = await transaction(async (client) => {
      // A prior soft-deleted subject occupies the same unique key
      // (program_id, year_level, semester, subject_code, curriculum_version) —
      // reactivate it instead of hitting the unique constraint on INSERT.
      const existing = await client.query(
        `SELECT id, is_active FROM curriculums
          WHERE program_id = $1 AND year_level = $2 AND semester = $3
            AND subject_code = $4 AND curriculum_version = $5`,
        [program_id, normYear, normSem, normCode, version],
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.is_active === false) {
          const updated = await client.query(`
            UPDATE curriculums
               SET is_active = true, subject_name = $1,
                   lecture_hours = $2, laboratory_hours = $3, units = $4,
                   prerequisites = $5, grade = $6, subject_category = $7, updated_at = NOW()
             WHERE id = $8
             RETURNING *
          `, [subject_name, lecH, labH, unitsVal, prereqVal, gradeVal, category, row.id]);
          return updated.rows[0];
        }
        throw new Error('DUPLICATE_ACTIVE_SUBJECT');
      }

      const inserted = await client.query(`
        INSERT INTO curriculums
          (program_id, year_level, semester, subject_code, subject_name,
           lecture_hours, laboratory_hours, units, prerequisites, grade, subject_category, curriculum_version)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
      `, [
        program_id, normYear, normSem, normCode, subject_name,
        lecH, labH, unitsVal, prereqVal, gradeVal, category, version,
      ]);
      return inserted.rows[0];
    });

    return NextResponse.json({ curriculum }, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (msg === 'DUPLICATE_ACTIVE_SUBJECT' || msg.includes('unique') || msg.includes('duplicate'))
      return NextResponse.json({ error: 'Subject code already exists for this program, year level, semester, and curriculum version.' }, { status: 409 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
