import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { parseId } from '@/database/ids';
import { getAuthUser } from '@/auth/auth';
import { assertBlockProgramAccess } from '@/services/programScope';
import { ensureBlockCurriculumVersion } from '@/database/migrateCurriculum';
import { withAudit } from '@/services/audit';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Block not found.' }, { status: 404 });

    await ensureBlockCurriculumVersion();

    const access = await assertBlockProgramAccess(auth, id, { chairOwnProgram: true });
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
    console.error('[GET /api/blocks/:id]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function PUT_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Block not found.' }, { status: 404 });

    const access = await assertBlockProgramAccess(auth, id, { chairOwnProgram: true });
    if (!access.ok) return access.response;
    const block = access.block;

    const { block_name, number_of_students, academic_year } = await req.json();
    const name = String(block_name ?? '').trim().toUpperCase();
    const year = String(academic_year ?? '').trim();
    const students = number_of_students === '' || number_of_students == null ? 0 : Number(number_of_students);
    if (!name || !year) {
      return NextResponse.json({ error: 'Block name and academic year are required.' }, { status: 400 });
    }
    if (!Number.isInteger(students) || students < 0) {
      return NextResponse.json({ error: 'Number of students must be a whole number (0 or more).' }, { status: 400 });
    }

    // Faculty loads, overloads and schedules are filed under the block's school
    // year — moving a block that already has assigned subjects would leave them
    // under the old year (and its classes never checked against the new term's).
    if (year !== String(block.academic_year)) {
      const assigned = await query(
        `SELECT COUNT(*)::int AS n
         FROM master_schedule ms
         JOIN block_subjects bs ON bs.id = ms.block_subject_id
         WHERE bs.block_id = $1 AND ms.faculty_id IS NOT NULL`,
        [id],
      );
      const n = Number(assigned.rows[0]?.n) || 0;
      if (n > 0) {
        return NextResponse.json({
          error: `Block ${block.block_name} has ${n} subject${n === 1 ? '' : 's'} assigned to faculty for ${block.academic_year}. Remove ${n === 1 ? 'it' : 'them'} from Faculty Workload before changing the school year.`,
        }, { status: 409 });
      }
    }

    const result = await transaction(async (client) => {
      const updated = await client.query(
        'UPDATE blocks SET block_name=$1, number_of_students=$2, academic_year=$3, updated_at=NOW() WHERE id=$4 RETURNING *',
        [name, students, year, id]
      );
      // The block's subject slots stay on the block's school year
      await client.query(
        `UPDATE master_schedule ms SET academic_year = $1, updated_at = NOW()
         FROM block_subjects bs
         WHERE bs.id = ms.block_subject_id AND bs.block_id = $2
           AND ms.academic_year IS DISTINCT FROM $1`,
        [year, id],
      );
      return updated;
    });
    if (result.rows.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ block: result.rows[0] });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({
        error: 'BLOCK_EXISTS',
        detail: 'A block with this name already exists for this program, year level, semester and school year.',
      }, { status: 409 });
    }
    console.error('[PUT /api/blocks/:id]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function DELETE_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Block not found.' }, { status: 404 });

    const access = await assertBlockProgramAccess(auth, id, { chairOwnProgram: true });
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

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const PUT = withAudit(PUT_handler);
export const DELETE = withAudit(DELETE_handler);
