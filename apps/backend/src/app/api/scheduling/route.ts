import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getChairAssignedProgramId, isScopedChair } from '@/services/programScope';
import { withAudit } from '@/services/audit';
import { saveSchedulePart, type SchedulePartBody } from '@/services/scheduleSave';

// Returns all master_schedule rows that have an assigned instructor but no saved
// class schedule yet (status = 'Assigned').  This is the source of truth for
// the Scheduling Panel — subjects flow in from Instructor Workload, not from
// the raw curriculum table.
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let programFilter: number | null = null;
    if (isScopedChair(auth)) {
      programFilter = auth.id ? await getChairAssignedProgramId(Number(auth.id)) : null;
      if (programFilter == null) return NextResponse.json({ schedules: [] });
    }

    const result = await query(`
      SELECT * FROM (
        SELECT DISTINCT ON (ms.block_subject_id)
          ms.id,
          ms.status,
          ms.faculty_id,
          c.subject_code,
          c.subject_name,
          c.lecture_hours,
          c.laboratory_hours,
          c.total_hours,
          c.units,
          b.block_name,
          b.year_level,
          b.semester,
          b.academic_year,
          p.id    AS program_id,
          p.code  AS program_code,
          p.name  AS program_name,
          f.name  AS faculty_name,
          f.position AS faculty_position
        FROM master_schedule ms
        JOIN block_subjects bs ON ms.block_subject_id = bs.id
        JOIN curriculums     c  ON bs.curriculum_id   = c.id
        JOIN blocks          b  ON bs.block_id        = b.id
        JOIN programs        p  ON b.program_id       = p.id
        JOIN faculty         f  ON ms.faculty_id      = f.id
        WHERE ms.status = 'Assigned'
          AND ms.faculty_id IS NOT NULL
          AND ($1::int IS NULL OR p.id = $1::int)
        ORDER BY ms.block_subject_id, ms.id DESC
      ) sub
      ORDER BY program_code, year_level, semester, block_name, subject_code
    `, [programFilter]);

    return NextResponse.json({ schedules: result.rows });
  } catch (error) {
    console.error('[GET /api/scheduling]', error);
    return NextResponse.json({ error: 'Failed to load schedules.' }, { status: 500 });
  }
}


async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // sessions: [{ day, start_time, hours, type: 'lec'|'lab', room_id: string|null }]
    // component: 'lec' | 'lab' — which component of a Lec+Lab subject is being scheduled
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Schedule ID, day pattern, and sessions are required' }, { status: 400 });
    }
    const scopedProgramId = isScopedChair(auth)
      ? (auth.id ? await getChairAssignedProgramId(Number(auth.id)) : null)
      : undefined;
    const out = await saveSchedulePart(body as SchedulePartBody, { scopedProgramId });
    return NextResponse.json(out.body, { status: out.status });
  } catch (error) {
    console.error('[POST /api/scheduling]', error);
    return NextResponse.json({ error: 'Failed to save schedule.' }, { status: 500 });
  }
}

async function DELETE_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const rawId = searchParams.get('id');
    const id = rawId ? parseInt(rawId, 10) : NaN;
    const component = (searchParams.get('type') || searchParams.get('component') || '').toLowerCase();

    if (!rawId || isNaN(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid schedule ID' }, { status: 400 });
    }
    // Lecture and Laboratory share one master_schedule_id — require component type.
    if (component !== 'lec' && component !== 'lab') {
      return NextResponse.json({
        error: 'type=lec or type=lab is required so Lecture and Laboratory are deleted independently.',
      }, { status: 400 });
    }

    const check = await query(
      `SELECT ms.id, ms.status, c.lecture_hours, c.laboratory_hours, b.program_id
       FROM master_schedule ms
       JOIN block_subjects bs ON ms.block_subject_id = bs.id
       JOIN curriculums c ON bs.curriculum_id = c.id
       JOIN blocks b ON bs.block_id = b.id
       WHERE ms.id = $1`,
      [id]
    );
    if (check.rows.length === 0) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }
    if (isScopedChair(auth)) {
      const chairProgramId = auth.id ? await getChairAssignedProgramId(Number(auth.id)) : null;
      if (chairProgramId == null || Number(check.rows[0].program_id) !== chairProgramId) {
        return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
      }
    }

    const lecHours = parseFloat(String(check.rows[0].lecture_hours)) || 0;
    const labHours = parseFloat(String(check.rows[0].laboratory_hours)) || 0;
    const isLecLab = lecHours > 0 && labHours > 0;

    await transaction(async (client) => {
      // Delete only the requested component — never wipe sibling Lecture/Laboratory.
      await client.query(
        'DELETE FROM schedule_sessions WHERE master_schedule_id = $1 AND type = $2',
        [id, component]
      );

      const remaining = await client.query(
        `SELECT type, day_of_week, start_time, end_time, room_id
         FROM schedule_sessions
         WHERE master_schedule_id = $1
         ORDER BY start_time, id`,
        [id]
      );

      if (remaining.rows.length === 0) {
        await client.query(`
          UPDATE master_schedule SET
            day_pattern = NULL, start_time = NULL, end_time = NULL, room_id = NULL,
            split_type = NULL, status = 'Assigned', updated_at = NOW()
          WHERE id = $1
        `, [id]);

        await client.query(`
          UPDATE block_subjects SET status = 'Assigned'
          WHERE id = (SELECT block_subject_id FROM master_schedule WHERE id = $1)
        `, [id]);
      } else {
        const hasLec = remaining.rows.some((r: { type: string }) => r.type === 'lec');
        const hasLab = remaining.rows.some((r: { type: string }) => r.type === 'lab');
        let newStatus = 'Scheduled';
        if (isLecLab) {
          newStatus = (hasLec && hasLab) ? 'Scheduled' : 'Assigned';
        }

        const first = remaining.rows[0];
        const last = [...remaining.rows].sort(
          (a: { start_time: string }, b: { start_time: string }) =>
            String(a.start_time).localeCompare(String(b.start_time))
        ).pop()!;
        const days = [...new Set(remaining.rows.map((r: { day_of_week: string }) => r.day_of_week))];
        const dayPattern = days.join('/');

        await client.query(`
          UPDATE master_schedule SET
            day_pattern = $1, start_time = $2, end_time = $3, room_id = $4,
            status = $5, updated_at = NOW()
          WHERE id = $6
        `, [
          dayPattern,
          first.start_time,
          last.end_time,
          first.room_id,
          newStatus,
          id,
        ]);

        await client.query(`
          UPDATE block_subjects SET status = $1
          WHERE id = (SELECT block_subject_id FROM master_schedule WHERE id = $2)
        `, [newStatus, id]);
      }
    });

    return NextResponse.json({
      success: true,
      message: `${component === 'lab' ? 'Laboratory' : 'Lecture'} schedule deleted successfully`,
    });
  } catch (error) {
    console.error('[DELETE /api/scheduling]', error);
    return NextResponse.json({ error: 'Failed to delete schedule.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
export const DELETE = withAudit(DELETE_handler);
