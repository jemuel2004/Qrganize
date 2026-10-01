import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { resolveProgramScope, isScopedChair, assertBlockProgramAccess } from '@/services/programScope';
import { ensureBlockCurriculumVersion } from '@/database/migrateCurriculum';
import { fetchBlocksWithAssignmentCounts } from '@/services/blockAssignmentCounts';
import {
  curriculumVersionLabel,
  parseCurriculumVersion,
  blockCurriculumVersion,
} from '@shared/curriculumVersion';
import { withAudit } from '@/services/audit';

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
    if (isScopedChair(authGet) && programId) {
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
      includeUnassignedSubjects: searchParams.get('include') === 'unassigned_subjects',
    });
    return NextResponse.json({ blocks });
  } catch (error) {
    console.error('[GET /api/blocks]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    // Block Creation: Program Chair may create blocks, but only for their own program
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { year_level, semester, academic_year, number_of_students } = body;
    const curriculum_version = parseCurriculumVersion(body.curriculum_version);

    // Accepts `block_names: string[]` (bulk create) or the legacy single
    // `block_name`. Normalised to unique uppercase letters in A→Z order.
    const BLOCK_SEQ = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
    const rawNames: unknown[] = Array.isArray(body.block_names)
      ? body.block_names
      : body.block_name ? [body.block_name] : [];
    const blockNames = [...new Set(rawNames.map(n => String(n).trim().toUpperCase()))]
      .sort((a, b) => BLOCK_SEQ.indexOf(a) - BLOCK_SEQ.indexOf(b));

    await ensureBlockCurriculumVersion();

    const scope = await resolveProgramScope(auth, {
      chairOwnProgram: true,
      requestedProgramId: body.program_id,
      requireProgram: true,
    });
    if (!scope.ok) return scope.response;
    const program_id = scope.programId!;

    if (!year_level || !semester || !academic_year || blockNames.length === 0) {
      return NextResponse.json({ error: 'All required fields must be filled.' }, { status: 400 });
    }
    if (blockNames.some(n => !BLOCK_SEQ.includes(n))) {
      return NextResponse.json({ error: 'Block names must be letters A–Z.' }, { status: 400 });
    }
    // Selected letters must be consecutive (e.g. A, B, C — not A, C) so the
    // Block A → B → C order is never broken.
    const firstIdx = BLOCK_SEQ.indexOf(blockNames[0]);
    if (blockNames.some((n, i) => BLOCK_SEQ.indexOf(n) !== firstIdx + i)) {
      return NextResponse.json({
        error: 'BLOCK_ORDER',
        detail: 'Selected blocks must be consecutive (e.g. Block A, B, C).',
        required_block: BLOCK_SEQ[firstIdx + blockNames.findIndex((n, i) => BLOCK_SEQ.indexOf(n) !== firstIdx + i)],
        requested_block: blockNames[blockNames.length - 1],
      }, { status: 400 });
    }
    if (!curriculum_version) {
      return NextResponse.json({ error: 'Curriculum is required.' }, { status: 400 });
    }

    // Fetch curriculum subjects before opening the transaction — read-only, safe outside
    const progRow = await query('SELECT code FROM programs WHERE id=$1', [program_id]);
    const progCode = progRow.rows[0]?.code ?? `Program ID ${program_id}`;

    // Curriculum must stay consistent across every block under the same Program +
    // Year Level + Semester + Academic Year. Once one exists, later blocks for
    // that combo must match it (delete them all and the choice is free again) —
    // enforced here as a backstop; the UI already locks the field once set.
    const establishedResult = await query(
      `SELECT curriculum_version FROM blocks
       WHERE program_id=$1 AND year_level=$2 AND semester=$3 AND academic_year=$4 AND is_active=true
       LIMIT 1`,
      [program_id, year_level, semester, academic_year]
    );
    const establishedVersion = establishedResult.rows[0]
      ? blockCurriculumVersion(establishedResult.rows[0].curriculum_version)
      : null;
    if (establishedVersion && establishedVersion !== curriculum_version) {
      return NextResponse.json({
        error: 'CURRICULUM_LOCKED',
        detail: `${progCode} ${year_level}, ${semester} ${academic_year} already uses ${curriculumVersionLabel(establishedVersion)}. Blocks in the same program, year, and semester must use the same curriculum.`,
        established_curriculum: establishedVersion,
      }, { status: 409 });
    }

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
      SELECT UPPER(b.block_name) AS block_name
      FROM blocks b
      WHERE b.program_id    = $1
        AND b.year_level    = $2
        AND b.semester      = $3
        AND b.academic_year = $4
        AND UPPER(b.block_name) = ANY($5::text[])
        AND b.curriculum_version = $6
        AND b.is_active     = true
      ORDER BY 1
    `, [program_id, year_level, semester, academic_year, blockNames, curriculum_version]);

    if (dupCheck.rows.length > 0) {
      const taken = dupCheck.rows.map((r: { block_name: string }) => r.block_name).join(', ');
      return NextResponse.json({
        error: 'BLOCK_EXISTS',
        detail: `Block ${taken} already exists for ${progCode}, ${curriculumVersionLabel(curriculum_version)}, ${year_level}, ${semester}, ${academic_year}. Choose a different Block Name or Academic Year.`,
      }, { status: 409 });
    }

    // Sequential block order check: the first selected block needs the one
    // before it (Block B requires Block A, ..., Block Z requires Block Y).
    const blockIdx = firstIdx;
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
          detail: `Block ${requiredBlock} must be created first before creating Block ${blockNames[0]} for ${progCode}, ${curriculumVersionLabel(curriculum_version)}, ${year_level}, ${semester}.`,
          required_block: requiredBlock,
          requested_block: blockNames[0],
        }, { status: 400 });
      }
    }

    // Atomic transaction: for every selected block, create block → load
    // block_subjects → create master_schedule entries. If any step fails for any
    // block, the whole batch is rolled back — no half-created sets, no orphans.
    const created = await transaction(async (client) => {
      const results: { block: { id: number; [k: string]: unknown }; subjects_loaded: number }[] = [];
      for (const name of blockNames) {
        // 1. Insert the block
        const blockResult = await client.query<{ id: number; [k: string]: unknown }>(`
          INSERT INTO blocks (program_id, year_level, semester, academic_year, block_name, number_of_students, curriculum_version)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *
        `, [program_id, year_level, semester, academic_year, name, Number(number_of_students) || 0, curriculum_version]);
        const newBlock = blockResult.rows[0];

        // 2. Load every curriculum subject into block_subjects in one statement
        await client.query(
          `INSERT INTO block_subjects (block_id, curriculum_id, status)
           SELECT $1, cid, 'Unscheduled' FROM unnest($2::int[]) AS cid
           ON CONFLICT (block_id, curriculum_id) DO NOTHING`,
          [newBlock.id, curriculumIds]
        );

        // 3. Create a master_schedule placeholder for each block subject.
        //    ON CONFLICT DO NOTHING guards against re-runs if migration already seeded entries.
        await client.query(
          `INSERT INTO master_schedule (block_subject_id, status, academic_year, semester)
           SELECT bs.id, 'Unassigned', $2, $3 FROM block_subjects bs WHERE bs.block_id = $1
           ON CONFLICT DO NOTHING`,
          [newBlock.id, academic_year, semester]
        );
        const countResult = await client.query<{ n: number }>(
          'SELECT COUNT(*)::int AS n FROM block_subjects WHERE block_id=$1',
          [newBlock.id]
        );

        results.push({ block: newBlock, subjects_loaded: countResult.rows[0].n });
      }
      return results;
    });

    return NextResponse.json({
      // `block` / `subjects_loaded` kept for single-block callers
      block: created[0].block,
      subjects_loaded: created[0].subjects_loaded,
      blocks: created.map(c => c.block),
      total_subjects_loaded: created.reduce((sum, c) => sum + c.subjects_loaded, 0),
    }, { status: 201 });

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

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);

/*
 * Delete several blocks at once (multi-select on Block Creation). Same hard
 * delete + cascade as DELETE /api/blocks/:id. Any blocks may be picked — a
 * removed letter can be re-created later (creation only needs the letter before).
 */
async function DELETE_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const ids = Array.isArray(body.ids)
      ? [...new Set((body.ids as unknown[]).map(Number).filter(n => Number.isInteger(n) && n > 0))]
      : [];
    if (ids.length === 0) return NextResponse.json({ error: 'No blocks selected.' }, { status: 400 });

    for (const id of ids) {
      const access = await assertBlockProgramAccess(auth, id, { chairOwnProgram: true });
      if (!access.ok) return access.response;
    }

    // Cascades to block_subjects → master_schedule → instructor_loads / overloads / schedule_sessions
    const result = await transaction(client =>
      client.query('DELETE FROM blocks WHERE id = ANY($1::int[]) RETURNING id', [ids]),
    );
    return NextResponse.json({ success: true, deleted: result.rowCount ?? 0 });
  } catch (error) {
    console.error('[DELETE /api/blocks]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const DELETE = withAudit(DELETE_handler);
