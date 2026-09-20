import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { assertBlockProgramAccess } from '@/server/programScope';
import { ensureBlockCurriculumVersion } from '@/server/migrateCurriculum';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;

    await ensureBlockCurriculumVersion();

    const access = await assertBlockProgramAccess(auth, id);
    if (!access.ok) return access.response;

    const result = await query(`
      SELECT b.*, p.code as program_code, p.name as program_name,
        json_agg(json_build_object(
          'id',               bs.id,
          'curriculum_id',    bs.curriculum_id,
          'subject_code',     c.subject_code,
          'subject_name',     c.subject_name,
          'lecture_hours',    c.lecture_hours,
          'laboratory_hours', c.laboratory_hours,
          'total_hours',      c.total_hours,
          'units',            c.units,
          'status',           bs.status,
          'master_schedule_id', ms.id,
          'faculty_name',     f.name,
          'day_pattern',      ms.day_pattern,
          'start_time',       ms.start_time,
          'end_time',         ms.end_time,
          'room_name',        r.room_name,
          'schedule_status',  ms.status
        ) ORDER BY c.subject_code) AS subjects
      FROM blocks b
      JOIN programs p ON b.program_id = p.id
      LEFT JOIN block_subjects bs ON bs.block_id = b.id
      LEFT JOIN curriculums c ON bs.curriculum_id = c.id
      -- LATERAL ensures at most one master_schedule row per block_subject,
      -- preventing json_agg from producing duplicate bs.id entries.
      LEFT JOIN LATERAL (
        SELECT ms2.id, ms2.day_pattern, ms2.start_time, ms2.end_time,
               ms2.status, ms2.faculty_id, ms2.room_id
        FROM master_schedule ms2
        WHERE ms2.block_subject_id = bs.id
        ORDER BY ms2.id DESC
        LIMIT 1
      ) ms ON true
      LEFT JOIN faculty f ON ms.faculty_id = f.id
      LEFT JOIN rooms  r ON ms.room_id    = r.id
      WHERE b.id = $1
      GROUP BY b.id, p.code, p.name
    `, [id]);

    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ block: result.rows[0] });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    const access = await assertBlockProgramAccess(auth, id);
    if (!access.ok) return access.response;

    const { block_name, number_of_students, academic_year } = await req.json();

    const result = await query(
      'UPDATE blocks SET block_name=$1, number_of_students=$2, academic_year=$3, updated_at=NOW() WHERE id=$4 RETURNING *',
      [block_name.toUpperCase(), number_of_students, academic_year, id]
    );
    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ block: result.rows[0] });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    const access = await assertBlockProgramAccess(auth, id);
    if (!access.ok) return access.response;

    // Hard delete — cascade constraints handle downstream cleanup automatically:
    //   block_subjects   (ON DELETE CASCADE from blocks)
    //   master_schedule  (ON DELETE CASCADE from block_subjects)
    //   instructor_loads (ON DELETE CASCADE from master_schedule)
    //   overloads        (ON DELETE CASCADE from master_schedule)
    //   schedule_sessions(ON DELETE CASCADE from master_schedule)
    // Using soft-delete (is_active=false) leaves the row in the table and the
    // UNIQUE(program_id, year_level, semester, academic_year, block_name) constraint
    // remains active, preventing the admin from re-creating the same block.
    const result = await query(
      'DELETE FROM blocks WHERE id=$1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Block not found.' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/blocks/:id]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
