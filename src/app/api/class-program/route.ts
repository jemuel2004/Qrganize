import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { resolveProgramScope, assertBlockProgramAccess } from '@/server/programScope';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);

    // ── Parse & validate all required params ────────────────────────────────
    const rawBlockId   = searchParams.get('block_id')?.trim()   ?? '';
    const rawProgramId = searchParams.get('program_id')?.trim() ?? '';
    const rawYearLevel = searchParams.get('year_level')?.trim() ?? '';
    const rawSemester  = searchParams.get('semester')?.trim()   ?? '';

    const blockId = parseInt(rawBlockId, 10);

    // All four params are required — reject incomplete requests immediately
    if (!rawBlockId || isNaN(blockId) || blockId <= 0) {
      return NextResponse.json(
        { error: 'block_id is required and must be a valid positive integer.' },
        { status: 400 },
      );
    }

    const scope = await resolveProgramScope(auth, {
      requestedProgramId: rawProgramId || undefined,
      requireProgram: true,
    });
    if (!scope.ok) return scope.response;
    const programId = scope.programId!;

    if (!rawYearLevel) {
      return NextResponse.json(
        { error: 'year_level is required. Select a year level before generating the class program.' },
        { status: 400 },
      );
    }
    if (!rawSemester) {
      return NextResponse.json(
        { error: 'semester is required. Ensure an active semester is configured in School Year Management.' },
        { status: 400 },
      );
    }

    const access = await assertBlockProgramAccess(auth, blockId);
    if (!access.ok) return access.response;

    // ── Fetch block ──────────────────────────────────────────────────────────
    const blockResult = await query(
      `SELECT b.*, p.code AS program_code, p.name AS program_name, p.department
       FROM blocks b
       JOIN programs p ON b.program_id = p.id
       WHERE b.id = $1 AND b.is_active = true`,
      [blockId],
    );

    if (blockResult.rows.length === 0) {
      return NextResponse.json({ error: 'Block not found.' }, { status: 404 });
    }

    const block = blockResult.rows[0];

    // ── Cross-validate: block must belong to the specified program ───────────
    if (block.program_id !== programId) {
      return NextResponse.json(
        { error: 'The selected block does not belong to the specified program. Please re-select from the correct program.' },
        { status: 422 },
      );
    }

    // ── Cross-validate: block must match the specified year level ────────────
    if (block.year_level !== rawYearLevel) {
      return NextResponse.json(
        { error: `The selected block is for ${block.year_level}, not ${rawYearLevel}. Please re-select the correct block.` },
        { status: 422 },
      );
    }

    // ── Cross-validate: block semester must match the active semester ────────
    if (block.semester !== rawSemester) {
      return NextResponse.json(
        { error: `This block is for ${block.semester}. The active semester is ${rawSemester}. Please re-select the block for the current semester.` },
        { status: 422 },
      );
    }

    // ── Fetch all subjects for this block (scheduled + unscheduled) ──────────
    const schedResult = await query(`
      SELECT
        COALESCE(ms.id, bs.id * -1)            AS ms_id,
        ms.day_pattern,
        ms.start_time,
        ms.end_time,
        COALESCE(ms.status, bs.status)         AS status,
        c.subject_code,
        c.subject_name,
        c.lecture_hours,
        c.laboratory_hours,
        c.total_hours,
        c.units,
        COALESCE(
          NULLIF(trim(f.name), ''),
          NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')
        ) AS faculty_name,
        r.room_name,
        (
          SELECT json_agg(json_build_object(
            'day',           ss.day_of_week,
            'start_time',    ss.start_time::text,
            'end_time',      ss.end_time::text,
            'session_hours', ss.session_hours
          ) ORDER BY ss.start_time)
          FROM schedule_sessions ss
          WHERE ss.master_schedule_id = ms.id
        ) AS sessions
      FROM block_subjects bs
      JOIN curriculums c ON bs.curriculum_id = c.id
      LEFT JOIN LATERAL (
        SELECT * FROM master_schedule
        WHERE block_subject_id = bs.id
        ORDER BY id DESC LIMIT 1
      ) ms ON true
      LEFT JOIN faculty f ON ms.faculty_id = f.id
      LEFT JOIN rooms   r ON ms.room_id    = r.id
      WHERE bs.block_id = $1
      ORDER BY ms.start_time NULLS LAST, c.subject_code
    `, [blockId]);

    return NextResponse.json({ block, schedules: schedResult.rows });

  } catch (error) {
    console.error('[GET /api/class-program]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
