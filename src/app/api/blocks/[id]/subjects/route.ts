import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { assertBlockProgramAccess } from '@/server/programScope';
import { ensureBlockCurriculumVersion } from '@/server/migrateCurriculum';
import { blockCurriculumVersion } from '@/lib/curriculumVersion';

// POST /api/blocks/[id]/subjects — add a curriculum subject to a block
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    await ensureBlockCurriculumVersion();

    const access = await assertBlockProgramAccess(auth, id);
    if (!access.ok) return access.response;

    const { curriculum_id } = await req.json();

    if (!curriculum_id) return NextResponse.json({ error: 'curriculum_id is required' }, { status: 400 });

    const block = access.block as {
      program_id: number; year_level: string; semester: string; academic_year: string;
      curriculum_version?: string;
    };
    const version = blockCurriculumVersion(block.curriculum_version);

    const currRow = await query(
      'SELECT * FROM curriculums WHERE id=$1 AND program_id=$2 AND year_level=$3 AND semester=$4 AND curriculum_version=$5 AND is_active=true',
      [curriculum_id, block.program_id, block.year_level, block.semester, version]
    );
    if (currRow.rows.length === 0) {
      return NextResponse.json({ error: 'Subject does not belong to this block\'s program, curriculum, year level, and semester' }, { status: 400 });
    }

    const bs = await query(
      'INSERT INTO block_subjects (block_id, curriculum_id, status) VALUES ($1,$2,\'Unscheduled\') ON CONFLICT (block_id, curriculum_id) DO NOTHING RETURNING *',
      [id, curriculum_id]
    );

    if (bs.rows.length === 0) return NextResponse.json({ error: 'Subject is already in this block' }, { status: 409 });

    // Create master_schedule entry
    await query(
      'INSERT INTO master_schedule (block_subject_id, status, academic_year, semester) VALUES ($1,\'Unassigned\',$2,$3)',
      [bs.rows[0].id, block.academic_year, block.semester]
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/blocks/[id]/subjects?block_subject_id=X — remove a subject from a block
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    const access = await assertBlockProgramAccess(auth, id);
    if (!access.ok) return access.response;

    const { searchParams } = new URL(req.url);
    const bsId = searchParams.get('block_subject_id');

    if (!bsId) return NextResponse.json({ error: 'block_subject_id is required' }, { status: 400 });

    // Verify it belongs to this block
    const check = await query('SELECT id FROM block_subjects WHERE id=$1 AND block_id=$2', [bsId, id]);
    if (check.rows.length === 0) return NextResponse.json({ error: 'Subject not found in this block' }, { status: 404 });

    // Cascade: remove master_schedule, then block_subject
    await query('DELETE FROM master_schedule WHERE block_subject_id=$1', [bsId]);
    await query('DELETE FROM block_subjects WHERE id=$1', [bsId]);

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
