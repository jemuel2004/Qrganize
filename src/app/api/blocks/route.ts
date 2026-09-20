import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { resolveProgramScope } from '@/server/programScope';
import { ensureBlockCurriculumVersion } from '@/server/migrateCurriculum';
import { fetchBlocksWithAssignmentCounts } from '@/server/blockAssignmentCounts';
import {
  curriculumVersionLabel,
  parseCurriculumVersion,
} from '@/lib/curriculumVersion';

export async function GET(req: NextRequest) {
  try {
    const authGet = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!authGet) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const programId = searchParams.get('program_id');

    /*
     * Program scoping for department chairs is feature-specific:
     * - When program_id is provided (Block Creation / Class Program), enforce match.
     * - When omitted (e.g. Instructor Workload), do not force the chair's program.
     */
    let effectiveProgramId: string | number | null = programId;
    if (authGet.role === 'department_chair' && programId) {
      const scope = await resolveProgramScope(authGet, { requestedProgramId: programId });
      if (!scope.ok) return scope.response;
      effectiveProgramId = scope.programId;
    }

    const blocks = await fetchBlocksWithAssignmentCounts({
      programId: effectiveProgramId,
      yearLevel: searchParams.get('year_level'),
      semester: searchParams.get('semester'),
      academicYear: searchParams.get('academic_year'),
      curriculumVersion: searchParams.get('curriculum_version'),
    });
    return NextResponse.json({ blocks });
  } catch (error) {
    console.error('[GET /api/blocks]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { year_level, semester, academic_year, block_name, number_of_students } = body;
    const curriculum_version = parseCurriculumVersion(body.curriculum_version);

    await ensureBlockCurriculumVersion();

    const scope = await resolveProgramScope(auth, {
      requestedProgramId: body.program_id,
      requireProgram: true,
    });
    if (!scope.ok) return scope.response;
    const program_id = scope.programId!;

    if (!year_level || !semester || !academic_year || !block_name) {
      return NextResponse.json({ error: 'All required fields must be filled.' }, { status: 400 });
    }
    if (!curriculum_version) {
      return NextResponse.json({ error: 'Curriculum is required.' }, { status: 400 });
    }

    // Fetch curriculum subjects before opening the transaction — read-only, safe outside
    const progRow = await query('SELECT code FROM programs WHERE id=$1', [program_id]);
    const progCode = progRow.rows[0]?.code ?? `Program ID ${program_id}`;

    const curriculumResult = await query(
      `SELECT id FROM curriculums
       WHERE program_id=$1 AND year_level=$2 AND semester=$3
         AND curriculum_version=$4 AND is_active=true
       ORDER BY subject_code`,
      [program_id, year_level, semester, curriculum_version]
    );

    if (curriculumResult.rows.length === 0) {
      return NextResponse.json({
        error: 'NO_CURRICULUM',
        detail: `No ${curriculumVersionLabel(curriculum_version)} subjects found for ${progCode}, ${year_level}, ${semester}. Please set up subjects in Curriculum Setup first.`,
        program_code: progCode, year_level, semester,
        curriculum_version,
        curriculum_label: curriculumVersionLabel(curriculum_version),
      }, { status: 400 });
    }

    const curriculumIds: number[] = curriculumResult.rows.map((r: { id: number }) => r.id);

    // Explicit active-only duplicate check — must run before the INSERT so the
    // error message is definitively about an active block, not a deleted one.
    // The partial unique index (WHERE is_active=true) enforces this at the DB level,
    // but this pre-check gives a clear, human-readable error with the exact details.
    const dupCheck = await query(`
      SELECT b.id
      FROM blocks b
      WHERE b.program_id    = $1
        AND b.year_level    = $2
        AND b.semester      = $3
        AND b.academic_year = $4
        AND UPPER(b.block_name) = UPPER($5)
        AND b.curriculum_version = $6
        AND b.is_active     = true
    `, [program_id, year_level, semester, academic_year, block_name, curriculum_version]);

    if (dupCheck.rows.length > 0) {
      return NextResponse.json({
        error: 'BLOCK_EXISTS',
        detail: `Block ${String(block_name).toUpperCase()} already exists for ${progCode}, ${curriculumVersionLabel(curriculum_version)}, ${year_level}, ${semester}, ${academic_year}. Choose a different Block Name (e.g., Block B) or Academic Year.`,
      }, { status: 409 });
    }

    // Sequential block order check: Block B requires Block A, ..., Block Z requires Block Y.
    const BLOCK_SEQ = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    const blockIdx = BLOCK_SEQ.indexOf(String(block_name).toUpperCase());
    if (blockIdx > 0) {
      const requiredBlock = BLOCK_SEQ[blockIdx - 1];
      const prevCheck = await query(`
        SELECT id FROM blocks
        WHERE program_id = $1 AND year_level = $2 AND semester = $3
          AND academic_year = $4 AND UPPER(block_name) = $5
          AND curriculum_version = $6 AND is_active = true
      `, [program_id, year_level, semester, academic_year, requiredBlock, curriculum_version]);

      if (prevCheck.rows.length === 0) {
        return NextResponse.json({
          error: 'BLOCK_ORDER',
          detail: `Block ${requiredBlock} must be created first before creating Block ${String(block_name).toUpperCase()} for ${progCode}, ${curriculumVersionLabel(curriculum_version)}, ${year_level}, ${semester}.`,
          required_block: requiredBlock,
          requested_block: String(block_name).toUpperCase(),
        }, { status: 400 });
      }
    }

    // Atomic transaction: create block → load block_subjects → create master_schedule entries.
    // If any step fails the entire block creation is rolled back — no orphaned data.
    const { block, subjects_loaded } = await transaction(async (client) => {
      // 1. Insert the block
      const blockResult = await client.query<{ id: number; [k: string]: unknown }>(`
        INSERT INTO blocks (program_id, year_level, semester, academic_year, block_name, number_of_students, curriculum_version)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [program_id, year_level, semester, academic_year, String(block_name).toUpperCase(), Number(number_of_students) || 0, curriculum_version]);

      const newBlock = blockResult.rows[0];

      // 2. Load each curriculum subject into block_subjects
      for (const curriculumId of curriculumIds) {
        await client.query(
          `INSERT INTO block_subjects (block_id, curriculum_id, status)
           VALUES ($1, $2, 'Unscheduled')
           ON CONFLICT (block_id, curriculum_id) DO NOTHING`,
          [newBlock.id, curriculumId]
        );
      }

      // 3. Fetch the newly created block_subjects
      const bsResult = await client.query<{ id: number }>(
        'SELECT id FROM block_subjects WHERE block_id=$1',
        [newBlock.id]
      );

      // 4. Create a master_schedule placeholder for each block subject.
      //    ON CONFLICT DO NOTHING guards against re-runs if migration already seeded entries.
      for (const bs of bsResult.rows) {
        await client.query(
          `INSERT INTO master_schedule (block_subject_id, status, academic_year, semester)
           VALUES ($1, 'Unassigned', $2, $3)
           ON CONFLICT DO NOTHING`,
          [bs.id, academic_year, semester]
        );
      }

      return { block: newBlock, subjects_loaded: bsResult.rows.length };
    });

    return NextResponse.json({ block, subjects_loaded }, { status: 201 });

  } catch (error) {
    const msg = String(error);
    console.error('[POST /api/blocks]', error);

    if (msg.includes('unique') || msg.includes('duplicate')) {
      return NextResponse.json({
        error: 'BLOCK_EXISTS',
        detail: 'This block already exists. A block with the same program, curriculum, year level, semester, academic year, and block name is already in the system.',
      }, { status: 409 });
    }

    return NextResponse.json({
      error: 'Unable to create block. Please check the selected curriculum and try again.',
    }, { status: 500 });
  }
}
