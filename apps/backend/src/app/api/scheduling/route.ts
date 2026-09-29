import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getChairAssignedProgramId, isScopedChair } from '@/services/programScope';
import { findScheduleConflicts, validateSessions, type ScheduleConflict } from '@/services/scheduleConflicts';
import { termDayCombinationError } from '@/services/dayCombinations';
import { withAudit } from '@/services/audit';

/* Run once per cold start — avoids DDL + migration overhead on every POST */
let schedSchemaReady   = false;
let schedMigrationDone = false;

async function ensureSchedSchema() {
  if (schedSchemaReady) return;
  await query(`ALTER TABLE schedule_sessions ADD COLUMN IF NOT EXISTS type VARCHAR(3) DEFAULT 'lec'`);
  schedSchemaReady = true;
}

async function ensureSchedMigration() {
  if (schedMigrationDone) return;
  // Legacy rows saved before `type` existed. Only lab-only subjects are
  // relabelled: the Lecture of a Major + Lab subject may now sit in a lab room.
  await query(`
    UPDATE schedule_sessions ss
    SET type = 'lab'
    FROM master_schedule ms
    JOIN block_subjects bs ON bs.id = ms.block_subject_id
    JOIN curriculums c ON c.id = bs.curriculum_id
    WHERE ss.master_schedule_id = ms.id
      AND ss.type = 'lec'
      AND COALESCE(c.lecture_hours, 0) = 0
      AND ss.room_id IN (SELECT id FROM rooms WHERE room_type IN ('Laboratory', 'Computer Lab'))
  `);
  schedMigrationDone = true;
}

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

function addMinutesToTime(timeStr: string, minutes: number): string {
  const [h, m] = timeStr.split(':').map(Number);
  const totalMinutes = h * 60 + m + minutes;
  const newH = Math.floor(totalMinutes / 60) % 24;
  const newM = totalMinutes % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}:00`;
}

function timeToMinutes(t: string): number {
  const parts = t.split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

const LAB_ROOM_TYPES = ['Laboratory', 'Computer Lab'];

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // sessions: [{ day, start_time, hours, type: 'lec'|'lab', room_id: string|null }]
    // component: 'lec' | 'lab' — which component of a Lec+Lab subject is being scheduled
    const { master_schedule_id, day_pattern, split_type, sessions, component } = await req.json();

    if (!master_schedule_id || !day_pattern || !sessions || sessions.length === 0) {
      return NextResponse.json({ error: 'Schedule ID, day pattern, and sessions are required' }, { status: 400 });
    }

    // Get schedule and subject details
    const schedResult = await query(`
      SELECT ms.*, c.total_hours, c.lecture_hours, c.laboratory_hours, c.units,
        ms.faculty_id, b.semester, b.academic_year, b.id as block_id, b.program_id,
        bs.block_id as bs_block_id
      FROM master_schedule ms
      JOIN block_subjects bs ON ms.block_subject_id = bs.id
      JOIN curriculums c ON bs.curriculum_id = c.id
      JOIN blocks b ON bs.block_id = b.id
      WHERE ms.id = $1
    `, [master_schedule_id]);

    if (schedResult.rows.length === 0) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    const sched = schedResult.rows[0];

    if (isScopedChair(auth)) {
      const chairProgramId = auth.id ? await getChairAssignedProgramId(Number(auth.id)) : null;
      if (chairProgramId == null || Number(sched.program_id) !== chairProgramId) {
        return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
      }
    }

    if (!sched.faculty_id) return NextResponse.json({ error: 'Please assign a faculty member first' }, { status: 400 });

    // Reject malformed sessions (unknown day, bad time, 0 hours) — they would
    // match nothing and slip past every conflict check.
    const invalidSessions = validateSessions(sessions);
    if (invalidSessions) return NextResponse.json({ error: invalidSessions }, { status: 400 });

    // Only the day combinations allowed for this block's semester (Settings → Day Combinations)
    const comboError = await termDayCombinationError(
      String(sched.academic_year ?? ''), String(sched.semester ?? ''),
      sessions.map((s: { day?: unknown }) => String(s.day ?? '')),
    );
    if (comboError) return NextResponse.json({ error: comboError, day_combination_error: true }, { status: 400 });

    const lecHours = parseFloat(sched.lecture_hours) || 0;
    const labHours = parseFloat(sched.laboratory_hours) || 0;
    const isLecLab = lecHours > 0 && labHours > 0;
    const isLabOnly = labHours > 0 && lecHours === 0;

    // Validate session hours match curriculum component hours
    const totalSessionHours = sessions.reduce((sum: number, s: { hours: number }) => sum + parseFloat(String(s.hours)), 0);
    let expectedTotal: number;
    if (isLecLab && component) {
      expectedTotal = component === 'lab' ? labHours : lecHours;
    } else {
      expectedTotal = parseFloat(sched.total_hours);
    }

    if (Math.abs(totalSessionHours - expectedTotal) > 0.01) {
      return NextResponse.json({
        error: `Session hours must equal ${expectedTotal.toFixed(2)} hrs. Got: ${totalSessionHours.toFixed(2)} hrs`
      }, { status: 400 });
    }

    // ── Within-schedule session overlap detection (server-side) ─────────────
    // Catches overlapping sessions submitted for the same schedule even before
    // they hit the database, complementing the client-side duplicate check.
    for (let i = 0; i < sessions.length; i++) {
      for (let j = i + 1; j < sessions.length; j++) {
        const a = sessions[i];
        const b = sessions[j];
        if (a.day !== b.day) continue;
        const aStart = timeToMinutes(a.start_time);
        const aEnd   = aStart + Math.round(parseFloat(String(a.hours)) * 60);
        const bStart = timeToMinutes(b.start_time);
        const bEnd   = bStart + Math.round(parseFloat(String(b.hours)) * 60);
        if (aStart < bEnd && aEnd > bStart) {
          return NextResponse.json({
            error: `Sessions ${i + 1} and ${j + 1} overlap on ${a.day}. Each session on the same day must use a distinct, non-overlapping time slot.`
          }, { status: 400 });
        }
      }
    }

    // ── Room-type validation (per session, only when a room is selected) ────
    // Lab sessions may be saved without a room; room is optional.
    // When a room IS provided, validate it matches the session type.
    for (const session of sessions) {
      const sessionRoomId = session.room_id || null;
      if (!sessionRoomId) continue;
      const sessionType: string = session.type || component || (isLabOnly ? 'lab' : 'lec');
      const roomResult = await query('SELECT room_type, status FROM rooms WHERE id=$1', [sessionRoomId]);
      if (roomResult.rows.length === 0) {
        return NextResponse.json({ error: 'The selected room no longer exists.' }, { status: 400 });
      }
      if (roomResult.rows[0].status && roomResult.rows[0].status !== 'Active') {
        return NextResponse.json({ error: 'The selected room is not active.' }, { status: 400 });
      }
      const isLabRoom = LAB_ROOM_TYPES.includes(roomResult.rows[0].room_type);
      if (sessionType === 'lab' && !isLabRoom) {
        return NextResponse.json({ error: 'Lab sessions must use a Laboratory or Computer Lab room' }, { status: 400 });
      }
      // The Lecture of a subject that has a lab (Major + Lab) may use a lab
      // room; a pure lecture subject may not.
      if (sessionType === 'lec' && isLabRoom && labHours <= 0) {
        return NextResponse.json({ error: 'A lecture-only subject cannot use a laboratory room' }, { status: 400 });
      }
    }

    // Component being saved — exclude only these sessions on re-save; sibling Lec/Lab must still conflict.
    const schedulingType: string = component || (isLabOnly ? 'lab' : 'lec');

    // ── Compute master_schedule time fields ─────────────────────────────────
    const firstLecSession = sessions.find((s: { type?: string }) => (s.type || 'lec') === 'lec') || sessions[0];
    const firstStartTime = firstLecSession.start_time;
    const firstHoursMinutes = Math.round(parseFloat(String(firstLecSession.hours)) * 60);
    const firstEndTime = addMinutesToTime(firstStartTime, firstHoursMinutes);

    // For same-day Lec+Lab, extend master end_time to cover the full continuous block
    const isSameDayLecLab = isLecLab && sessions.length === 2 && sessions[0].day === sessions[1].day;
    let masterEndTime = firstEndTime;
    if (isSameDayLecLab) {
      const lastSession = [...sessions].sort(
        (a: { start_time: string }, b: { start_time: string }) => a.start_time.localeCompare(b.start_time)
      ).pop()!;
      const lastMins = Math.round(parseFloat(String(lastSession.hours)) * 60);
      masterEndTime = addMinutesToTime(lastSession.start_time, lastMins);
    }

    // Persist first session's room to master_schedule for workload queries
    const masterRoomId = sessions[0]?.room_id || null;

    // Ensure type column + legacy migration run once per cold start, not per request
    await ensureSchedSchema();
    await ensureSchedMigration();

    // ── Atomic save (transaction) ───────────────────────────────────────────
    // DELETE + INSERT + UPDATE are all-or-nothing: a mid-save failure rolls
    // back entirely instead of leaving the schedule in a partial state.
    // For Lec+Lab subjects, only sessions of the current component type are
    // deleted so the other component's sessions are preserved independently.
    const outcome = await transaction(async (client) => {
      // One schedule save at a time: without this, two admins saving at the
      // same moment could both pass the conflict check and double-book an
      // instructor, room or block. Released automatically at COMMIT/ROLLBACK.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('qrganize:schedule-save'))`);

      // Conflict check inside the lock — same rules as /check-conflicts
      const conflicts = await findScheduleConflicts(
        (text, params) => client.query(text, params),
        {
          masterScheduleId: Number(master_schedule_id),
          facultyId: Number(sched.faculty_id),
          blockId: Number(sched.bs_block_id),
          semester: sched.semester || '',
          academicYear: sched.academic_year || '',
          editingType: schedulingType === 'lab' ? 'lab' : 'lec',
          sessions,
        },
      );
      if (conflicts.length > 0) return { conflicts };

      await client.query(
        'DELETE FROM schedule_sessions WHERE master_schedule_id=$1 AND type=$2',
        [master_schedule_id, schedulingType]
      );

      for (const session of sessions) {
        const sessionHoursMinutes = Math.round(parseFloat(String(session.hours)) * 60);
        const sessionEndTime = addMinutesToTime(session.start_time, sessionHoursMinutes);
        const sessionRoomId = session.room_id || null;
        await client.query(`
          INSERT INTO schedule_sessions (master_schedule_id, day_of_week, start_time, end_time, session_hours, room_id, type)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [master_schedule_id, session.day, session.start_time, sessionEndTime, session.hours, sessionRoomId, schedulingType]);
      }

      // For Lec+Lab subjects, only mark 'Scheduled' when both components have sessions.
      // Single-component subjects are always 'Scheduled' after saving.
      let newStatus = 'Scheduled';
      if (isLecLab) {
        const lecCheck = await client.query(
          `SELECT 1 FROM schedule_sessions WHERE master_schedule_id=$1 AND type='lec' LIMIT 1`,
          [master_schedule_id]
        );
        const labCheck = await client.query(
          `SELECT 1 FROM schedule_sessions WHERE master_schedule_id=$1 AND type='lab' LIMIT 1`,
          [master_schedule_id]
        );
        newStatus = (lecCheck.rows.length > 0 && labCheck.rows.length > 0) ? 'Scheduled' : 'Assigned';
      }

      await client.query(`
        UPDATE master_schedule SET
          day_pattern=$1, start_time=$2, end_time=$3, room_id=$4,
          split_type=$5, status=$6, updated_at=NOW()
        WHERE id=$7
      `, [day_pattern, firstStartTime, masterEndTime, masterRoomId, split_type || 'Manual', newStatus, master_schedule_id]);

      await client.query(
        `UPDATE block_subjects SET status=$1
         WHERE id=(SELECT block_subject_id FROM master_schedule WHERE id=$2)`,
        [newStatus, master_schedule_id]
      );
      return { conflicts: [] as ScheduleConflict[] };
    });

    if (outcome.conflicts.length > 0) {
      return NextResponse.json({
        error: `Schedule conflict: ${outcome.conflicts[0].message}`,
        conflicts: outcome.conflicts,
      }, { status: 409 });
    }

    return NextResponse.json({ success: true, message: 'Schedule saved successfully' });
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
