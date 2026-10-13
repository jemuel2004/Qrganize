import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { ensureRoomOccupancy, expireStaleOccupancy, completeRoomRelease } from '@/services/ensureRoomOccupancy';
import { withAudit } from '@/services/audit';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { manilaCalendarDateString, manilaClock } from '@/services/appTimezone';
import { ensureRoomReleasesTable } from '@/services/roomReleases';
import { facultyName, notifyRoomFreed } from '@/services/roomFreedNotice';

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/rooms/occupancy
   Returns all active (Pending / Occupied) records and the list of free rooms.
   Admin / department chair only. Faculty cannot list occupancy records.
───────────────────────────────────────────────────────────────────────────── */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string } | null;
    if (!authUser || (authUser.role !== 'admin' && authUser.role !== 'program_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureRoomOccupancy();
    await expireStaleOccupancy();

    const occupancies = await query(`
      SELECT
        ro.id,
        ro.room_id,
        ro.faculty_id,
        ro.status,
        ro.reserved_at,
        ro.expires_at,
        ro.occupied_at,
        r.room_name,
        r.room_type,
        r.building,
        COALESCE(
          NULLIF(trim(COALESCE(f.name, '')), ''),
          NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')
        ) AS faculty_name
      FROM  room_occupancy ro
      JOIN  rooms   r ON ro.room_id   = r.id
      JOIN  faculty f ON ro.faculty_id = f.id
      WHERE ro.status IN ('Pending', 'Occupied')
      ORDER BY ro.reserved_at DESC
    `);

    const available = await query(`
      SELECT r.id, r.room_name, r.room_type, r.building, r.capacity
      FROM   rooms r
      WHERE  r.status = 'Active'
        AND  NOT EXISTS (
               SELECT 1 FROM room_occupancy ro
               WHERE  ro.room_id = r.id
                 AND  ro.status  IN ('Pending', 'Occupied')
             )
      ORDER BY r.room_name
    `);

    return NextResponse.json({
      occupancies:     occupancies.rows,
      available_rooms: available.rows,
    });
  } catch (error) {
    console.error('[rooms/occupancy GET]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/rooms/occupancy
   Body: { room_id: number, faculty_id: number }

   Security rules:
     • Caller must be authenticated.
     • Faculty role: faculty_id in body MUST match session faculty_id
       (prevents a faculty member from reserving on behalf of another person).
     • Admin role: may pass any faculty_id (management override).
───────────────────────────────────────────────────────────────────────────── */
async function POST_handler(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureRoomOccupancy();

    const body        = await req.json();
    const room_id     = Number(body.room_id);
    const faculty_id  = Number(body.faculty_id);

    if (!room_id || !faculty_id) {
      return NextResponse.json({ error: 'room_id and faculty_id are required' }, { status: 400 });
    }

    // Instructors can only reserve for themselves — block impersonation
    if (authUser.role === 'instructor') {
      if (!authUser.faculty_id || faculty_id !== authUser.faculty_id) {
        return NextResponse.json(
          { error: 'Forbidden: instructors may only reserve rooms for themselves.' },
          { status: 403 },
        );
      }
    } else if (authUser.role !== 'admin' && authUser.role !== 'program_chair') {
      // Only instructor, admin, and program_chair roles may create reservations
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Auto-expire this room's stale records first
    await expireStaleOccupancy(room_id);

    // Check if the room is already active
    const roomOcc = await query(`
      SELECT ro.status,
             CONCAT_WS(' ', f.first_name, f.last_name) AS faculty_name,
             ro.expires_at
      FROM   room_occupancy ro
      JOIN   faculty f ON ro.faculty_id = f.id
      WHERE  ro.room_id = $1
        AND  ro.status IN ('Pending', 'Occupied')
      LIMIT 1
    `, [room_id]);

    if (roomOcc.rows.length > 0) {
      const o = roomOcc.rows[0];
      return NextResponse.json({
        error:            `Room is currently ${o.status} by ${o.faculty_name}.`,
        conflict_status:  o.status,
        faculty_name:     o.faculty_name,
        expires_at:       o.expires_at,
      }, { status: 409 });
    }

    // Check if this faculty already holds an active reservation elsewhere
    await expireStaleOccupancy();
    const facOcc = await query(`
      SELECT ro.status, r.room_name
      FROM   room_occupancy ro
      JOIN   rooms r ON ro.room_id = r.id
      WHERE  ro.faculty_id = $1
        AND  ro.status IN ('Pending', 'Occupied')
      LIMIT 1
    `, [faculty_id]);

    if (facOcc.rows.length > 0) {
      const fo = facOcc.rows[0];
      return NextResponse.json({
        error: `You already have a ${fo.status} reservation for ${fo.room_name}. Release it before reserving another room.`,
      }, { status: 409 });
    }

    // Create Pending reservation — 15-minute window
    const result = await query(`
      INSERT INTO room_occupancy (room_id, faculty_id, status, expires_at)
      VALUES ($1, $2, 'Pending', NOW() + INTERVAL '15 minutes')
      RETURNING *
    `, [room_id, faculty_id]);

    return NextResponse.json({ occupancy: result.rows[0] }, { status: 201 });

  } catch (error) {
    const msg = String(error);
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return NextResponse.json({ error: 'Room was just reserved by another faculty member.' }, { status: 409 });
    }
    console.error('[rooms/occupancy POST]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   DELETE /api/rooms/occupancy
   Body: { room_id: number, faculty_id?: number }

   Security rules:
     • Faculty: releases only their own occupancy (faculty_id comes from
       the session, not the request body).
     • Admin / department chair: may pass faculty_id to release any occupancy.
───────────────────────────────────────────────────────────────────────────── */
/** The faculty's class in this room right now (or starting within 15 minutes): freed for the rest of
 *  today's class time — a room_releases row for today — and the faculty who could use it are told.
 *  Returns until when ('HH:MM'), or null when there is no such class (a borrowed room, a walk-in). */
async function freeRestOfClassToday(roomId: number, facultyId: number): Promise<string | null> {
  await ensureRoomReleasesTable();
  const { time, dayOfWeek } = manilaClock();
  const today = manilaCalendarDateString();
  const period = await getActiveAcademicPeriod();
  const res = await query(`
    SELECT ss.id AS session_id, to_char(ss.start_time, 'HH24:MI') AS start_time, to_char(ss.end_time, 'HH24:MI') AS end_time,
           r.id AS room_id, r.room_name, r.room_type
    FROM   schedule_sessions ss
    JOIN   master_schedule ms ON ms.id = ss.master_schedule_id
    JOIN   block_subjects  bs ON bs.id = ms.block_subject_id
    JOIN   blocks           b ON b.id  = bs.block_id
    JOIN   rooms            r ON r.id  = ss.room_id
    WHERE  ms.faculty_id = $1 AND ss.room_id = $2 AND ss.day_of_week = $3
      AND  $4::time >= ss.start_time - INTERVAL '15 minutes' AND $4::time < ss.end_time
      AND  ms.status IN ('Assigned', 'Scheduled')
      AND  ($5 = '' OR b.academic_year = $5)
      AND  ($6 = '' OR b.semester      = $6)
    ORDER  BY ss.start_time
  `, [facultyId, roomId, dayOfWeek, time, period.schoolYear ?? '', period.semester ?? '']);
  const sessions = res.rows as { session_id: number; start_time: string; end_time: string; room_id: number; room_name: string; room_type: string | null }[];
  if (sessions.length === 0) return null;
  await query(`
    INSERT INTO room_releases (session_id, faculty_id, release_date, reason)
    SELECT s, $2, $3::date, NULL FROM unnest($1::int[]) AS s
    ON CONFLICT (session_id, release_date) DO NOTHING
  `, [sessions.map(s => s.session_id), facultyId, today]);
  const nowHm = time.slice(0, 5);
  await notifyRoomFreed({
    times: sessions.map(s => ({
      room: { id: Number(s.room_id), room_name: s.room_name, room_type: s.room_type },
      date: today, weekday: dayOfWeek,
      start: s.start_time < nowHm ? nowHm : s.start_time,
      end: s.end_time,
    })),
    freedBy: facultyId,
    freedByName: await facultyName(facultyId),
    term: { year: period.schoolYear ?? '', semester: period.semester ?? '' },
  });
  return sessions[sessions.length - 1].end_time;
}

async function DELETE_handler(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureRoomOccupancy();

    const body       = await req.json();
    const room_id    = Number(body.room_id);
    const bodyFacultyId = Number(body.faculty_id);

    if (!room_id) {
      return NextResponse.json({ error: 'room_id is required' }, { status: 400 });
    }

    let faculty_id: number;
    if (authUser.role === 'instructor') {
      if (!authUser.faculty_id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      faculty_id = Number(authUser.faculty_id);
    } else if (authUser.role === 'admin' || authUser.role === 'department_chair' || authUser.role === 'program_chair') {
      if (!bodyFacultyId) {
        return NextResponse.json({ error: 'room_id and faculty_id are required' }, { status: 400 });
      }
      faculty_id = bodyFacultyId;
    } else {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await expireStaleOccupancy(room_id);

    const ended = await completeRoomRelease(room_id, faculty_id);
    if (!ended) {
      return NextResponse.json(
        { error: 'No active occupancy found for this room.' },
        { status: 409 },
      );
    }

    // Free My Room during their own class in this room: the rest of that class time today is free
    // for others (as if freed on My Schedule), and the faculty who could use it are told
    const freedUntil = authUser.role === 'instructor' ? await freeRestOfClassToday(room_id, faculty_id) : null;
    return NextResponse.json({ success: true, ...(freedUntil ? { freed_until: freedUntil } : {}) });
  } catch (error) {
    console.error('[rooms/occupancy DELETE]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
export const DELETE = withAudit(DELETE_handler);
