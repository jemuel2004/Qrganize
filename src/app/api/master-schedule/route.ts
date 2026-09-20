import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { ensureCurriculumFields } from '@/server/migrateCurriculum';
import { subjectCategorySql } from '@/lib/subjectCategory';
import { resolveProgramScope } from '@/server/programScope';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await ensureCurriculumFields();

    const { searchParams } = new URL(req.url);
    const programId    = searchParams.get('program_id');
    const blockId      = searchParams.get('block_id');
    const yearLevel    = searchParams.get('year_level');
    const semester     = searchParams.get('semester');
    const academicYear = searchParams.get('academic_year');
    const status       = searchParams.get('status');

    // Require at least a program or a block — returning everything at once is expensive
    if (!programId && !blockId) {
      return NextResponse.json({ schedules: [] });
    }

    let effectiveProgramId: string | number | null = programId;

    if (auth.role === 'department_chair') {
      const scope = await resolveProgramScope(auth, {
        requestedProgramId: programId || undefined,
        requireProgram: !blockId,
      });
      if (!scope.ok) return scope.response;
      effectiveProgramId = scope.programId;

      // block-only requests still must belong to the chair's program
      if (blockId && !programId) {
        const blockCheck = await query(
          `SELECT program_id FROM blocks WHERE id = $1 AND is_active = true`,
          [blockId]
        );
        const bp = blockCheck.rows[0]?.program_id;
        if (bp == null || Number(bp) !== scope.programId) {
          return NextResponse.json(
            { error: 'You can only manage resources for your assigned program.' },
            { status: 403 },
          );
        }
      }
    }

    // Inner query: deduplicate via DISTINCT ON so each block_subject contributes exactly
    // one row (the most recently created master_schedule entry wins).
    // Outer query: apply the stable sort the UI needs.
    const params: unknown[] = [];
    let idx = 1;

    let innerWhere = `WHERE b.is_active = true AND c.is_active = true`;

    if (effectiveProgramId) { innerWhere += ` AND p.id            = $${idx++}`; params.push(effectiveProgramId); }
    if (blockId)            { innerWhere += ` AND b.id            = $${idx++}`; params.push(blockId); }
    if (yearLevel)          { innerWhere += ` AND b.year_level    = $${idx++}`; params.push(yearLevel); }
    if (semester)           { innerWhere += ` AND b.semester      = $${idx++}`; params.push(semester); }
    if (academicYear)       { innerWhere += ` AND b.academic_year = $${idx++}`; params.push(academicYear); }
    if (status === 'Unassigned') {
      // Available to assign: no living active instructor, even if status was left as Assigned.
      innerWhere += ` AND (ms.faculty_id IS NULL OR f.id IS NULL OR f.is_active IS FALSE)`;
    } else if (status) {
      innerWhere += ` AND ms.status = $${idx++}`;
      params.push(status);
    }

    const sql = `
      SELECT * FROM (
        SELECT DISTINCT ON (ms.block_subject_id)
          ms.id,
          ms.block_subject_id,
          ms.faculty_id,
          ms.day_pattern,
          ms.start_time,
          ms.end_time,
          ms.room_id,
          ms.split_type,
          ms.status,
          ms.academic_year,
          ms.semester,
          c.subject_code,
          c.subject_name,
          c.lecture_hours,
          c.laboratory_hours,
          c.total_hours,
          c.units,
          ${subjectCategorySql('c')} AS subject_category,
          b.block_name,
          b.year_level,
          b.semester       AS block_semester,
          b.academic_year  AS block_academic_year,
          b.number_of_students,
          p.code  AS program_code,
          p.name  AS program_name,
          p.id    AS program_id,
          f.name       AS faculty_name,
          f.position   AS faculty_position,
          f.employee_id,
          r.room_name,
          r.room_type
        FROM master_schedule ms
        JOIN block_subjects bs ON ms.block_subject_id = bs.id
        JOIN curriculums     c  ON bs.curriculum_id   = c.id
        JOIN blocks          b  ON bs.block_id        = b.id
        JOIN programs        p  ON b.program_id       = p.id
        LEFT JOIN faculty    f  ON ms.faculty_id      = f.id
        LEFT JOIN rooms      r  ON ms.room_id         = r.id
        ${innerWhere}
        ORDER BY ms.block_subject_id, ms.id DESC
      ) deduped
      ORDER BY
        year_level,
        block_semester,
        block_name,
        subject_code
    `;

    const result = await query(sql, params);
    return NextResponse.json({ schedules: result.rows });
  } catch (error) {
    console.error('[GET /api/master-schedule]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
