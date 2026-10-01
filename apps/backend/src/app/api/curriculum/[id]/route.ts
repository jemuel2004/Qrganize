import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { ensureCurriculumFields } from '@/database/migrateCurriculum';
import { normalizeYearLevel, normalizeSemester } from '@shared/normalizeCurriculum';
import { categoryFromHours } from '@shared/subjectCategory';
import { canAccessProgram, isScopedChair } from '@/services/programScope';
import { withAudit } from '@/services/audit';

async function PUT_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { role?: string; program_id?: number | null } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureCurriculumFields();

    const { id } = await params;

    if (isScopedChair(auth)) {
      const ownerCheck = await query('SELECT program_id FROM curriculums WHERE id = $1', [id]);
      if (ownerCheck.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (!(await canAccessProgram(auth, ownerCheck.rows[0].program_id))) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    }

    const { program_id, year_level, semester, subject_code, subject_name,
            lecture_hours, laboratory_hours, units, prerequisites, grade } = await req.json();

    if (!(await canAccessProgram(auth, Number(program_id)))) {
      return NextResponse.json({ error: 'You can only manage curriculum for your assigned program.' }, { status: 403 });
    }

    const category = categoryFromHours(lecture_hours, laboratory_hours, subject_code);

    const normYear = normalizeYearLevel(year_level) || year_level;
    const normSem  = normalizeSemester(semester)    || semester;

    const result = await query(`
      UPDATE curriculums
      SET program_id=$1, year_level=$2, semester=$3, subject_code=$4, subject_name=$5,
          lecture_hours=$6, laboratory_hours=$7, units=$8,
          prerequisites=$9, grade=$10, subject_category=$11, updated_at=NOW()
      WHERE id=$12
      RETURNING *
    `, [
      program_id, normYear, normSem,
      String(subject_code).toUpperCase().trim(), subject_name,
      lecture_hours || 0, laboratory_hours || 0,
      parseFloat(String(units)) || 0,
      prerequisites || '', grade || '',
      category,
      id,
    ]);

    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ curriculum: result.rows[0] });
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('unique') || msg.includes('duplicate'))
      return NextResponse.json({ error: 'Subject code already exists for this program, year level, semester, and curriculum version.' }, { status: 409 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function DELETE_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { role?: string; program_id?: number | null } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    if (isScopedChair(auth)) {
      const ownerCheck = await query('SELECT program_id FROM curriculums WHERE id = $1', [id]);
      if (ownerCheck.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (!(await canAccessProgram(auth, ownerCheck.rows[0].program_id))) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
    }

    await query('UPDATE curriculums SET is_active=false, updated_at=NOW() WHERE id=$1', [id]);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const PUT = withAudit(PUT_handler);
export const DELETE = withAudit(DELETE_handler);
