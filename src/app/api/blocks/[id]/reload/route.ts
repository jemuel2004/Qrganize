import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { assertBlockProgramAccess } from '@/server/programScope';
import { ensureBlockCurriculumVersion } from '@/server/migrateCurriculum';
import { blockCurriculumVersion } from '@/lib/curriculumVersion';

// POST /api/blocks/[id]/reload — sync block subjects with curriculum (adds missing, no duplicates)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    await ensureBlockCurriculumVersion();

    const access = await assertBlockProgramAccess(auth, id);
    if (!access.ok) return access.response;

    const block = access.block as {
      program_id: number; year_level: string; semester: string; academic_year: string;
      curriculum_version?: string;
    };
    const version = blockCurriculumVersion(block.curriculum_version);

    const subjects = await query(
      'SELECT id FROM curriculums WHERE program_id=$1 AND year_level=$2 AND semester=$3 AND curriculum_version=$4 AND is_active=true',
      [block.program_id, block.year_level, block.semester, version]
    );

    // block_subjects + its companion master_schedule row must commit together —
    // otherwise a failure between the two inserts leaves an orphaned block_subjects
    // row with no master_schedule row, which /api/master-schedule (INNER JOINs from
    // master_schedule) then silently excludes from every "Unassigned" result.
    let added = 0;
    for (const subject of subjects.rows) {
      const inserted = await transaction(async client => {
        const bs = await client.query(
          'INSERT INTO block_subjects (block_id, curriculum_id, status) VALUES ($1,$2,\'Unscheduled\') ON CONFLICT (block_id, curriculum_id) DO NOTHING RETURNING id',
          [id, subject.id]
        );
        if (bs.rows.length === 0) return false;

        await client.query(
          'INSERT INTO master_schedule (block_subject_id, status, academic_year, semester) VALUES ($1,\'Unassigned\',$2,$3)',
          [bs.rows[0].id, block.academic_year, block.semester]
        );
        return true;
      });
      if (inserted) added++;
    }

    return NextResponse.json({ success: true, added, total: subjects.rows.length });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
