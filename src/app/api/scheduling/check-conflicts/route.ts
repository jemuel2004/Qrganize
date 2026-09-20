import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';

function addMins(timeStr: string, minutes: number): string {
  const parts = timeStr.split(':').map(Number);
  const total = parts[0] * 60 + parts[1] + minutes;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

function fmt12(t: string): string {
  const parts = t.split(':').map(Number);
  const h = parts[0]; const m = parts[1];
  if (isNaN(h)) return t;
  return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

type ConflictType = 'instructor' | 'room' | 'block';

interface CheckSession {
  day: string;
  start_time: string;
  hours: number | string;
  room_id?: string | null;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { master_schedule_id, sessions, semester, academic_year, component } = await req.json() as {
      master_schedule_id: number;
      sessions: CheckSession[];
      semester?: string;
      academic_year?: string;
      /** Component being edited — exclude only these sessions of this schedule, not the sibling Lec/Lab. */
      component?: 'lec' | 'lab' | string;
    };

    if (!master_schedule_id || !sessions?.length) {
      return NextResponse.json({ conflicts: [] });
    }

    // Exclude only the component currently being replaced (same master_schedule_id + type).
    // Sibling Lecture/Laboratory sessions of the same Major subject MUST still conflict.
    const editingType = (component === 'lab' || component === 'lec')
      ? component
      : 'lec';

    const schedResult = await query(`
      SELECT ms.faculty_id, bs.block_id, b.semester, b.academic_year
      FROM master_schedule ms
      JOIN block_subjects bs ON ms.block_subject_id = bs.id
      JOIN blocks b ON bs.block_id = b.id
      WHERE ms.id = $1
    `, [master_schedule_id]);

    if (schedResult.rows.length === 0) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    const { faculty_id, block_id } = schedResult.rows[0];
    /* Prefer the semester/year passed by the client; fall back to the block's own values.
     * This ensures conflict checks never cross semester boundaries. */
    const sem = semester    || schedResult.rows[0].semester;
    const yr  = academic_year || schedResult.rows[0].academic_year;

    const conflicts: Array<{
      session_index: number;
      type: ConflictType;
      message: string;
      existing_session_id?: number;
      day?: string;
      existing_start?: string;
      existing_end?: string;
    }> = [];

    for (let i = 0; i < sessions.length; i++) {
      const sess = sessions[i];
      if (!sess.day || !sess.start_time || !sess.hours) continue;

      const durMins  = Math.round(parseFloat(String(sess.hours)) * 60);
      const endTime  = addMins(sess.start_time, durMins);
      const startTime = sess.start_time;

      // ── Instructor conflict (same semester only) ───────────────
      // Exclude only sessions of the component being replaced:
      //   (ms2.id != $3 OR ss.type IS DISTINCT FROM $8)
      // so same-subject Lecture vs Laboratory still conflicts.
      // Ignore orphaned sessions (no faculty / inactive status) left after unassign.
      const instrRows = await query(`
        SELECT c.subject_code, b2.block_name, ss.id AS session_id, ss.start_time, ss.end_time, ss.type
        FROM schedule_sessions ss
        JOIN master_schedule ms2 ON ss.master_schedule_id = ms2.id
        JOIN block_subjects  bs2 ON ms2.block_subject_id  = bs2.id
        JOIN curriculums     c   ON bs2.curriculum_id     = c.id
        JOIN blocks          b2  ON bs2.block_id          = b2.id
        WHERE ms2.faculty_id = $1
          AND ms2.faculty_id IS NOT NULL
          AND ms2.status IN ('Assigned', 'Scheduled')
          AND ss.day_of_week = $2
          AND (ms2.id != $3 OR ss.type IS DISTINCT FROM $8)
          AND ss.start_time < $5::time
          AND ss.end_time   > $4::time
          AND ($6 = '' OR b2.semester     = $6)
          AND ($7 = '' OR b2.academic_year = $7)
        LIMIT 1
      `, [faculty_id, sess.day, master_schedule_id, startTime, endTime, sem || '', yr || '', editingType]);

      if (instrRows.rows.length > 0) {
        const r  = instrRows.rows[0];
        const st = String(r.start_time).substring(0, 5);
        const et = String(r.end_time).substring(0, 5);
        conflicts.push({
          session_index: i,
          type: 'instructor',
          message: `Instructor already has a class on ${sess.day}: ${r.subject_code} (${r.block_name}) ${fmt12(st)}–${fmt12(et)}.`,
          existing_session_id: Number(r.session_id),
          day: sess.day,
          existing_start: st,
          existing_end: et,
        });
      }

      // ── Block / section conflict (same semester only) ─────────
      // Must ignore ghost sessions from unassigned / pending master_schedule rows
      // (e.g. leftover GE-PC after overload removal) or false conflicts appear.
      const blockRows = await query(`
        SELECT c.subject_code, ss.id AS session_id, ss.start_time, ss.end_time
        FROM schedule_sessions ss
        JOIN master_schedule ms2 ON ss.master_schedule_id = ms2.id
        JOIN block_subjects  bs2 ON ms2.block_subject_id  = bs2.id
        JOIN curriculums     c   ON bs2.curriculum_id     = c.id
        JOIN blocks          b2  ON bs2.block_id          = b2.id
        WHERE bs2.block_id  = $1
          AND ms2.faculty_id IS NOT NULL
          AND ms2.status IN ('Assigned', 'Scheduled')
          AND ss.day_of_week = $2
          AND (ms2.id != $3 OR ss.type IS DISTINCT FROM $8)
          AND ss.start_time < $5::time
          AND ss.end_time   > $4::time
          AND ($6 = '' OR b2.semester     = $6)
          AND ($7 = '' OR b2.academic_year = $7)
        LIMIT 1
      `, [block_id, sess.day, master_schedule_id, startTime, endTime, sem || '', yr || '', editingType]);

      if (blockRows.rows.length > 0) {
        const r  = blockRows.rows[0];
        const st = String(r.start_time).substring(0, 5);
        const et = String(r.end_time).substring(0, 5);
        conflicts.push({
          session_index: i,
          type: 'block',
          message: `Block already has another class on ${sess.day}: ${r.subject_code} ${fmt12(st)}–${fmt12(et)}.`,
          existing_session_id: Number(r.session_id),
          day: sess.day,
          existing_start: st,
          existing_end: et,
        });
      }

      // ── Room conflict (same semester only) ────────────────────
      if (sess.room_id) {
        const roomRows = await query(`
          SELECT r.room_name, c.subject_code, b2.block_name, ss.id AS session_id, ss.start_time, ss.end_time
          FROM schedule_sessions ss
          JOIN master_schedule ms2 ON ss.master_schedule_id = ms2.id
          JOIN block_subjects  bs2 ON ms2.block_subject_id  = bs2.id
          JOIN curriculums     c   ON bs2.curriculum_id     = c.id
          JOIN blocks          b2  ON bs2.block_id          = b2.id
          JOIN rooms           r   ON ss.room_id            = r.id
          WHERE ss.room_id          = $1
            AND ss.day_of_week      = $2
            AND ms2.faculty_id IS NOT NULL
            AND ms2.status IN ('Assigned', 'Scheduled')
            AND (ss.master_schedule_id != $3 OR ss.type IS DISTINCT FROM $8)
            AND ss.start_time < $5::time
            AND ss.end_time   > $4::time
            AND ($6 = '' OR b2.semester     = $6)
            AND ($7 = '' OR b2.academic_year = $7)
          LIMIT 1
        `, [sess.room_id, sess.day, master_schedule_id, startTime, endTime, sem || '', yr || '', editingType]);

        if (roomRows.rows.length > 0) {
          const r  = roomRows.rows[0];
          const st = String(r.start_time).substring(0, 5);
          const et = String(r.end_time).substring(0, 5);
          conflicts.push({
            session_index: i,
            type: 'room',
            message: `Room "${r.room_name}" is already occupied on ${sess.day}: ${r.subject_code} (${r.block_name}) ${fmt12(st)}–${fmt12(et)}.`,
            existing_session_id: Number(r.session_id),
            day: sess.day,
            existing_start: st,
            existing_end: et,
          });
        }
      }
    }

    return NextResponse.json({ conflicts });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
