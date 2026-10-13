import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query, transaction } from '@/database/db';
import { parseId } from '@/database/ids';
import {
  activateDueReservations, expireStaleOccupancy, expireStaleRoomRequests, holdEndSql, legacyInUseHoldSql,
} from '@/services/ensureRoomOccupancy';
import { createNotification } from '@/services/notifications';
import { withAudit } from '@/services/audit';
import { APP_TIMEZONE, manilaCalendarDateString, manilaClock, manilaDateAtSql } from '@/services/appTimezone';
import { ensureRoomReleasesTable, freedOnSql, releasedOnSql } from '@/services/roomReleases';
import { BORROW_MIN_LEFT, fitsFreeTime, minutesLeft, notEnoughTimeMessage, tooLateMessage } from '@/services/borrowedRoom';
import { needsOneRoomSql } from '@shared/subjectCategory';
import { PATHFIT_VENUE_RULE, pathfitRoomAllowed } from '@shared/pathfitVenue';
import {
  HOLD_BEFORE_MIN, SCAN_WITHIN_MIN, classTimes, requestWindow, shiftTime, time12, timeMinutes, timeRange12,
  type ClassPart,
} from '@shared/roomRequestWindow';

/* ─── GET /api/instructor/room-requests ─────────────────────────────────────
   Returns the faculty's full request history with subject, sessions, and
   room details (a today-only request also its class time and when its QR
   scan opens), plus today's Manila date and time. Expires stale Pending
   Confirmation records before responding.
─────────────────────────────────────────────────────────────────────────── */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await expireStaleOccupancy();
    await expireStaleRoomRequests();

    if (req.nextUrl.searchParams.get('count') === '1') {
      const countResult = await query(
        `SELECT COUNT(*)::int AS n
         FROM room_change_requests
         WHERE faculty_id = $1
           AND status IN ('Pending', 'Pending Confirmation')`,
        [authUser.faculty_id],
      );
      return NextResponse.json({ pendingCount: countResult.rows[0]?.n ?? 0 });
    }

    const result = await query(`
      SELECT
        rcr.id,
        rcr.master_schedule_id,
        rcr.reason,
        rcr.status,
        rcr.admin_notes,
        rcr.auto_notes,
        rcr.confirmation_deadline,
        rcr.approved_at,
        rcr.rejected_at,
        rcr.expired_at,
        rcr.confirmed_at,
        rcr.created_at,
        rcr.updated_at,
        to_char(rcr.use_date, 'YYYY-MM-DD') AS use_date,
        to_char(rcr.use_start, 'HH24:MI')   AS use_start,
        to_char(rcr.use_end, 'HH24:MI')     AS use_end,
        CASE WHEN rcr.use_date IS NOT NULL
             THEN ${manilaDateAtSql('rcr.use_date', 'rcr.use_start')} - INTERVAL '${HOLD_BEFORE_MIN} minutes'
        END                AS scan_opens_at,
        orig.room_name    AS original_room_name,
        orig.room_type    AS original_room_type,
        req.room_name     AS requested_room_name,
        req.room_type     AS requested_room_type,
        c.subject_code,
        c.subject_name,
        c.lecture_hours,
        c.laboratory_hours,
        b.block_name,
        b.year_level,
        p.code            AS program_code,
        (
          SELECT json_agg(json_build_object(
            'day',        ss.day_of_week,
            'start_time', ss.start_time::text,
            'end_time',   ss.end_time::text
          ) ORDER BY ss.day_of_week, ss.start_time)
          FROM schedule_sessions ss
          WHERE ss.master_schedule_id = rcr.master_schedule_id
            AND ss.day_of_week IS NOT NULL
            AND ss.start_time  IS NOT NULL
            AND ss.end_time    IS NOT NULL
        ) AS sessions
      FROM  room_change_requests rcr
      LEFT JOIN rooms         orig ON rcr.original_room_id  = orig.id
      LEFT JOIN rooms         req  ON rcr.requested_room_id = req.id
      LEFT JOIN master_schedule ms ON rcr.master_schedule_id = ms.id
      LEFT JOIN block_subjects  bs ON ms.block_subject_id = bs.id
      LEFT JOIN curriculums      c ON bs.curriculum_id    = c.id
      LEFT JOIN blocks           b ON bs.block_id         = b.id
      LEFT JOIN programs         p ON b.program_id        = p.id
      WHERE rcr.faculty_id = $1
      ORDER BY rcr.created_at DESC
    `, [authUser.faculty_id]);

    const { time, dayOfWeek } = manilaClock();
    return NextResponse.json({
      requests: result.rows,
      // Requests are for today's classes only — the form lists those (Manila time)
      today: { date: manilaCalendarDateString(), day: dayOfWeek, now: time.slice(0, 5) },
    });
  } catch (error) {
    console.error('[GET /api/instructor/room-requests]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/* ─── POST /api/instructor/room-requests ────────────────────────────────────
   Asks for a room for ONE class time of the faculty's own class TODAY — never
   for the whole semester (@shared/roomRequestWindow). The class's schedule is
   not changed; the room is only held for that time.

   • All conflicts detected          → 409 error (no record created)
   • No conflict found               → status = 'Pending Confirmation', with the
                                       class time (use_date / use_start / use_end)
   • From 15 minutes before the class the room is held for the faculty (Pending)
   • Faculty scans the room's QR by 15 minutes after the start → 'In-Use',
     held until the class ends, then the request closes by itself
   • No scan by then                 → 'Expired', the room is free again

   VALIDATION CHAIN (server-side, never trust frontend):
   1.  Auth             — must be faculty with faculty_id
   2.  Required fields  — master_schedule_id, requested_room_id (the reason is optional)
   3+4. Schedule        — must belong to faculty + have ≥1 valid session
   5.  Room             — must exist and be Active, and fit the subject
   6.  Class time today — the class meets today (start_time picks which time),
                          it hasn't ended, and it has NO room for that time (a
                          class with its own room uses it — services/borrowedRoom.ts)
   7.  Room free today  — no class in the room during that time (a class whose
                          faculty made the room available today doesn't count)
   7b. Freed room only  — another faculty freed this room for today during that
                          time (Free My Room, or no scan within 15 minutes); a room
                          nobody freed can't be asked for — and the class must END by
                          the time it is free until (it may have started earlier)
   8.  Not in use       — nobody holds the room past the class's start
   9.  Insert           — one at a time per room: no other request of the
                          faculty, and nobody else's, overlaps that time
  10.  Hold             — when the time is near, the room is held right away
─────────────────────────────────────────────────────────────────────────── */
async function POST_handler(req: NextRequest) {
  try {
    /* 1. Auth ─────────────────────────────────────────────────────────────── */
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const facultyId = authUser.faculty_id;

    /* Expire stale records before validating ─────────────────────────────── */
    await expireStaleOccupancy();
    await expireStaleRoomRequests();
    await ensureRoomReleasesTable();

    /* 2. Required fields ─────────────────────────────────────────────────── */
    const body = await req.json().catch(() => null) as {
      master_schedule_id?: unknown; requested_room_id?: unknown; reason?: unknown; start_time?: unknown;
    } | null;
    const master_schedule_id = parseId(body?.master_schedule_id);
    const requested_room_id = parseId(body?.requested_room_id);
    // Optional — saved as empty text when left out
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    // Which of the class's times today ("HH:MM") — optional when only one is left
    const pickedStart = typeof body?.start_time === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(body.start_time)
      ? body.start_time.slice(0, 5)
      : null;

    if (!master_schedule_id) {
      return NextResponse.json(
        { error: 'A teaching schedule must be selected. Room requests must be linked to an official schedule.' },
        { status: 400 },
      );
    }
    if (!requested_room_id) {
      return NextResponse.json(
        { error: 'A preferred room must be selected.' },
        { status: 400 },
      );
    }

    /* 3 + 4. Schedule ownership + valid sessions ─────────────────────────── */
    const schedRes = await query(`
      SELECT
        ms.id,
        ms.faculty_id,
        ms.room_id                             AS current_room_id,
        r.room_name                            AS current_room_name,
        c.subject_code,
        c.subject_name,
        COALESCE(c.lecture_hours, 0)           AS lecture_hours,
        COALESCE(c.laboratory_hours, 0)        AS laboratory_hours,
        ${needsOneRoomSql('c')}              AS one_room,
        b.block_name,
        b.academic_year,
        b.semester,
        COUNT(ss.id) FILTER (
          WHERE ss.day_of_week IS NOT NULL
            AND ss.start_time  IS NOT NULL
            AND ss.end_time    IS NOT NULL
        ) AS valid_session_count
      FROM  master_schedule  ms
      JOIN  block_subjects   bs ON ms.block_subject_id = bs.id
      JOIN  curriculums       c ON bs.curriculum_id    = c.id
      JOIN  blocks            b ON bs.block_id         = b.id
      LEFT JOIN rooms         r ON ms.room_id = r.id
      LEFT JOIN schedule_sessions ss ON ss.master_schedule_id = ms.id
      WHERE ms.id = $1
        AND ms.status IN ('Assigned', 'Scheduled')
        AND (
          ms.faculty_id = $2
          OR EXISTS (
            SELECT 1 FROM instructor_loads il
            WHERE il.master_schedule_id = ms.id
              AND il.faculty_id = $2
          )
        )
      GROUP BY ms.id, ms.faculty_id, ms.room_id, r.room_name,
               c.subject_code, c.subject_name, c.lecture_hours, c.laboratory_hours,
               c.subject_category, c.subject_category_manual,
               b.block_name, b.academic_year, b.semester
    `, [master_schedule_id, facultyId]);

    if (schedRes.rows.length === 0) {
      return NextResponse.json(
        { error: 'Schedule not found or you are not assigned to it. Only your officially assigned schedules are accepted.' },
        { status: 403 },
      );
    }

    const sched = schedRes.rows[0];

    if (Number(sched.valid_session_count) === 0) {
      return NextResponse.json(
        { error: `Schedule "${sched.subject_code}" has no valid time slots assigned yet. Contact your administrator.` },
        { status: 400 },
      );
    }

    /* 5. Requested room must exist and be Active ──────────────────────────── */
    const roomRes = await query(
      `SELECT id, room_name, room_type FROM rooms WHERE id = $1 AND status = 'Active'`,
      [requested_room_id],
    );
    if (roomRes.rows.length === 0) {
      return NextResponse.json(
        { error: 'Selected room does not exist or is not active.' },
        { status: 400 },
      );
    }
    const requestedRoom = roomRes.rows[0];

    /* 5b. Lecture-only subjects may only use lecture rooms */
    const isLabRoom = ['laboratory', 'computer lab'].includes(String(requestedRoom.room_type ?? '').trim().toLowerCase());
    if (isLabRoom && !(Number(sched.laboratory_hours) > 0)) {
      return NextResponse.json(
        { error: `${sched.subject_code} is a lecture subject, so it can only use a lecture room. Please choose a lecture room.` },
        { status: 400 },
      );
    }
    /* 5c. Laboratory sessions never move into a lecture room (Scheduling rule), so a
          laboratory-only subject has nothing that could use one */
    if (!isLabRoom && !(Number(sched.lecture_hours) > 0)) {
      return NextResponse.json(
        { error: `${sched.subject_code} is a laboratory subject, so it can only use a laboratory room. Please choose a laboratory room.` },
        { status: 400 },
      );
    }

    /* 5d. A Major subject's Lecture and Laboratory share one room — a lecture
          room could only take the Lecture, so the class can only use a
          laboratory room (services/majorRoomRule.ts) */
    if (!isLabRoom && sched.one_room) {
      return NextResponse.json(
        { error: `${sched.subject_code} is a Major subject, so its Lecture and Laboratory stay in one room. Please choose a laboratory room.` },
        { status: 400 },
      );
    }

    /* 5e. PATHFIT meets only in the CCA Gym or the SAO Room */
    if (!pathfitRoomAllowed(sched.subject_code, requestedRoom.room_name)) {
      return NextResponse.json({ error: PATHFIT_VENUE_RULE }, { status: 400 });
    }

    /* 6. The class time today ─────────────────────────────────────────────── */
    const today = manilaCalendarDateString();
    const { time, dayOfWeek } = manilaClock();
    const nowHm = time.slice(0, 5);
    const todayRes = await query(`
      SELECT ss.id, COALESCE(ss.type, 'lec') AS part,
             to_char(ss.start_time, 'HH24:MI') AS start, to_char(ss.end_time, 'HH24:MI') AS end,
             ss.room_id, r0.room_name AS own_room,
             ${releasedOnSql('ss', 'ms', '$3::date')} AS released
      FROM   schedule_sessions ss
      JOIN   master_schedule ms ON ms.id = ss.master_schedule_id
      LEFT JOIN rooms r0 ON r0.id = ss.room_id AND r0.status = 'Active'
      WHERE  ss.master_schedule_id = $1
        AND  ss.day_of_week = $2
        AND  ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
    `, [master_schedule_id, dayOfWeek, today]);
    const todays = (todayRes.rows as { id: number; part: string; start: string; end: string; room_id: number | null; own_room: string | null; released: boolean }[])
      .map(s => ({ ...s, part: (s.part === 'lab' ? 'lab' : 'lec') as ClassPart }));
    if (todays.length === 0) {
      return NextResponse.json(
        { error: `${sched.subject_code} has no class today (${dayOfWeek}). Room requests are for today's classes only.` },
        { status: 400 },
      );
    }
    // Sessions whose room the faculty made available for today aren't held today
    const held = todays.filter(s => !s.released);
    if (held.length === 0) {
      return NextResponse.json(
        { error: `You made the classroom of ${sched.subject_code} available for today. Take it back on My Schedule first if you will hold the class.` },
        { status: 400 },
      );
    }
    let start = pickedStart;
    if (!start) {
      const left = classTimes(held).filter(t => timeMinutes(t.end) > timeMinutes(nowHm));
      if (left.length === 0) {
        return NextResponse.json({ error: `${sched.subject_code}'s class today has already ended.` }, { status: 400 });
      }
      if (left.length > 1) {
        return NextResponse.json({ error: `Choose which of ${sched.subject_code}'s class times today.` }, { status: 400 });
      }
      start = left[0].start;
    }
    if (!classTimes(held).some(t => t.start === start)) {
      return NextResponse.json(
        { error: `${sched.subject_code} has no class at ${time12(start)} today.` },
        { status: 400 },
      );
    }
    // A lecture room only takes the Lecture part of the class time
    const slot = requestWindow(held, start, isLabRoom ? 'lab' : 'lec');
    if (!slot) {
      return NextResponse.json(
        { error: `${sched.subject_code}'s class at ${time12(start)} today is its Laboratory, which needs a laboratory room.` },
        { status: 400 },
      );
    }
    const range = timeRange12(slot.start, slot.end);
    if (timeMinutes(slot.end) <= timeMinutes(nowHm)) {
      return NextResponse.json(
        { error: `${sched.subject_code}'s class at ${range} has already ended.` },
        { status: 400 },
      );
    }
    if (slot.sessions.every(s => Number(s.room_id) === requested_room_id)) {
      return NextResponse.json(
        { error: `${requestedRoom.room_name} is already your room for ${sched.subject_code} at ${range}.` },
        { status: 400 },
      );
    }
    // Only a class with no room for that time may ask for a freed room — one with its own room uses it
    const ownRoom = slot.sessions.find(s => s.own_room)?.own_room;
    if (ownRoom) {
      return NextResponse.json(
        { error: `${sched.subject_code} at ${range} already has a room (${ownRoom}). Freed rooms are only for classes without a room.` },
        { status: 400 },
      );
    }

    /* 7. No class in the room during that time today (same school year +
          semester; a class whose faculty made the room available today, or that
          nobody checked in for within 15 minutes, doesn't count) */
    const sessionConflictRes = await query(`
      SELECT c2.subject_code,
             to_char(ss2.start_time, 'HH24:MI') AS start, to_char(ss2.end_time, 'HH24:MI') AS end
      FROM   schedule_sessions ss2
      JOIN   master_schedule   ms2 ON ss2.master_schedule_id = ms2.id
      JOIN   block_subjects    bs2 ON ms2.block_subject_id   = bs2.id
      JOIN   curriculums        c2 ON bs2.curriculum_id      = c2.id
      JOIN   blocks            b2  ON bs2.block_id           = b2.id
      WHERE  ss2.room_id = $1
        AND  ms2.status IN ('Assigned', 'Scheduled')
        AND  ms2.id != $2
        AND  b2.academic_year = $3
        AND  b2.semester      = $4
        AND  ss2.day_of_week  = $5
        AND  ss2.start_time   < $7::time
        AND  ss2.end_time     > $6::time
        AND  NOT ${freedOnSql('ss2', 'ms2', '$8::date')}
      ORDER  BY ss2.start_time
      LIMIT  1
    `, [requested_room_id, master_schedule_id, sched.academic_year, sched.semester, dayOfWeek, slot.start, slot.end, today]);

    if (sessionConflictRes.rows.length > 0) {
      const other = sessionConflictRes.rows[0];
      return NextResponse.json(
        { error: `${requestedRoom.room_name} has ${other.subject_code} at ${timeRange12(other.start, other.end)} today. Please choose a different room.` },
        { status: 409 },
      );
    }

    /* 7b. Only a room another faculty's class frees today: one of their classes
           meets in it during this time and they made it available for today
           (Free My Room), or nobody checked in for it within 15 minutes of the
           start. Any other room is not open to requests. */
    const freedRes = await query(`
      SELECT to_char(ss2.end_time, 'HH24:MI') AS free_until
      FROM   schedule_sessions ss2
      JOIN   master_schedule   ms2 ON ss2.master_schedule_id = ms2.id
      JOIN   block_subjects    bs2 ON ms2.block_subject_id   = bs2.id
      JOIN   blocks            b2  ON bs2.block_id           = b2.id
      WHERE  ss2.room_id = $1
        AND  ms2.status IN ('Assigned', 'Scheduled')
        AND  ms2.id != $2
        AND  ms2.faculty_id IS DISTINCT FROM $3::int
        AND  b2.academic_year = $4
        AND  b2.semester      = $5
        AND  ss2.day_of_week  = $6
        AND  ss2.start_time   < $8::time
        AND  ss2.end_time     > $7::time
        AND  ${freedOnSql('ss2', 'ms2', '$9::date')}
      ORDER  BY ss2.end_time DESC
    `, [requested_room_id, master_schedule_id, facultyId, sched.academic_year, sched.semester, dayOfWeek, slot.start, slot.end, today]);

    if (freedRes.rows.length === 0) {
      return NextResponse.json(
        { error: `${requestedRoom.room_name} is not free for ${range} today. You can request a room its faculty freed with Free My Room, or one whose class was not scanned within 15 minutes of starting.` },
        { status: 409 },
      );
    }
    // The freed class time keeps its own end: the requested class must end by then
    // (freed class times back to back count as one — the latest end)
    const freeUntil = String(freedRes.rows[0].free_until);
    if (!fitsFreeTime(slot.end, freeUntil)) {
      return NextResponse.json(
        { error: notEnoughTimeMessage(sched.subject_code, slot.end, requestedRoom.room_name, freeUntil) },
        { status: 409 },
      );
    }
    // Asked for after the class started: never with 30 minutes or less of the free time left
    if (minutesLeft(nowHm, freeUntil) <= BORROW_MIN_LEFT) {
      return NextResponse.json({ error: tooLateMessage(requestedRoom.room_name, nowHm, freeUntil) }, { status: 409 });
    }

    /* 8. Nobody else holds the room past the class's start — a class check-in
          counts until its class ends (not the 30 minutes after), an older
          request that moved a class into the room until it is released */
    const liveOccRes = await query(`
      SELECT COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                      NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')) AS faculty_name,
             ${legacyInUseHoldSql('ro')} AS until_released,
             to_char(${holdEndSql('ro')} AT TIME ZONE '${APP_TIMEZONE}', 'HH24:MI') AS until
      FROM   room_occupancy ro
      JOIN   faculty f ON f.id = ro.faculty_id
      WHERE  ro.room_id     = $1
        AND  ro.faculty_id <> $2
        AND  ro.status IN ('Pending', 'Occupied')
        AND  (${holdEndSql('ro')} > ${manilaDateAtSql('$3::date', '$4::time')} OR ${legacyInUseHoldSql('ro')})
      LIMIT  1
    `, [requested_room_id, facultyId, today, slot.start]);

    if (liveOccRes.rows.length > 0) {
      const o = liveOccRes.rows[0];
      return NextResponse.json(
        { error: `${requestedRoom.room_name} is in use by ${o.faculty_name ?? 'another faculty member'}${o.until_released ? '' : ` until ${time12(o.until)}`}. Please choose a different room.` },
        { status: 409 },
      );
    }

    /* 9. Insert — one request at a time per room and day, so the same time can't be given twice */
    type Created = { id: number; confirmation_deadline: string; deadline_hm: string; hold_now: boolean };
    const outcome = await transaction(async (client): Promise<{ created: Created } | { error: string }> => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`room-request:${requested_room_id}:${today}`]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`room-request-faculty:${facultyId}:${today}`]);

      const mine = await client.query(`
        SELECT r.room_name, to_char(rcr.use_start, 'HH24:MI') AS start, to_char(rcr.use_end, 'HH24:MI') AS end
        FROM   room_change_requests rcr
        LEFT JOIN rooms r ON r.id = rcr.requested_room_id
        WHERE  rcr.faculty_id = $1
          AND  rcr.use_date   = $2::date
          AND  rcr.status IN ('Pending Confirmation', 'Approved', 'In-Use')
          AND  rcr.use_start  < $4::time
          AND  rcr.use_end    > $3::time
        LIMIT  1
      `, [facultyId, today, slot.start, slot.end]);
      if (mine.rows.length > 0) {
        const m = mine.rows[0];
        return { error: `You already have ${m.room_name ?? 'a room'} for ${timeRange12(m.start, m.end)} today. Cancel that request first if you need a different room.` };
      }

      const taken = await client.query(`
        SELECT COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                        NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')) AS faculty_name,
               to_char(rcr.use_start, 'HH24:MI') AS start, to_char(rcr.use_end, 'HH24:MI') AS end
        FROM   room_change_requests rcr
        JOIN   faculty f ON f.id = rcr.faculty_id
        WHERE  rcr.requested_room_id = $1
          AND  rcr.faculty_id       <> $2
          AND  rcr.use_date          = $3::date
          AND  rcr.status IN ('Pending Confirmation', 'Approved', 'In-Use')
          AND  rcr.use_start < $5::time
          AND  rcr.use_end   > $4::time
        LIMIT  1
      `, [requested_room_id, facultyId, today, slot.start, slot.end]);
      if (taken.rows.length > 0) {
        const t = taken.rows[0];
        return { error: `${requestedRoom.room_name} is already reserved by ${t.faculty_name ?? 'another faculty member'} for ${timeRange12(t.start, t.end)} today. Please choose a different room.` };
      }

      // Scan by 15 minutes after the class starts (or 15 minutes from now when it
      // already has), never past the class's end
      const startAt = manilaDateAtSql('$6::date', '$7::time');
      const endAt = manilaDateAtSql('$6::date', '$8::time');
      const ins = await client.query(`
        INSERT INTO room_change_requests
          (faculty_id, master_schedule_id, original_room_id, requested_room_id,
           reason, status, confirmation_deadline, submitted_by, use_date, use_start, use_end)
        VALUES ($1, $2, $3, $4, $5, 'Pending Confirmation',
                LEAST(GREATEST(${startAt}, NOW()) + INTERVAL '${SCAN_WITHIN_MIN} minutes', ${endAt}),
                'instructor', $6::date, $7::time, $8::time)
        RETURNING id, confirmation_deadline,
                  to_char(confirmation_deadline AT TIME ZONE '${APP_TIMEZONE}', 'HH24:MI') AS deadline_hm,
                  NOW() >= ${startAt} - INTERVAL '${HOLD_BEFORE_MIN} minutes' AS hold_now
      `, [
        facultyId,
        master_schedule_id,
        slot.sessions.find(s => s.room_id != null)?.room_id ?? sched.current_room_id ?? null,
        requested_room_id,
        reason,
        today,
        slot.start,
        slot.end,
      ]);
      return { created: ins.rows[0] as Created };
    });

    if ('error' in outcome) {
      return NextResponse.json({ error: outcome.error }, { status: 409 });
    }
    const newRequest = outcome.created;

    /* 10. The time is near: the room is held for the faculty right away */
    if (newRequest.hold_now) await activateDueReservations();

    const scanFrom = time12(shiftTime(slot.start, -HOLD_BEFORE_MIN));
    const scanBy = time12(newRequest.deadline_hm);
    const message = newRequest.hold_now
      ? `${requestedRoom.room_name} is held for your ${sched.subject_code} class (${range}). Scan its QR code by ${scanBy} to confirm.`
      : `${requestedRoom.room_name} is reserved for your ${sched.subject_code} class today, ${range}. Scan its QR code between ${scanFrom} and ${scanBy} to confirm.`;

    // Notify instructor
    createNotification({
      recipientId: facultyId, recipientRole: 'instructor',
      title: 'Room Request Submitted',
      message,
      type: 'room_request_submitted', relatedModule: 'room_request', relatedId: newRequest.id,
    }).catch(() => {});
    // Admin side: the live "Room Request Pending" alert (syncWorkloadMonitoringNotifications) covers it

    return NextResponse.json(
      {
        id:                    newRequest.id,
        confirmation_deadline: newRequest.confirmation_deadline,
        use_date:              today,
        use_start:             slot.start,
        use_end:               slot.end,
        message,
      },
      { status: 201 },
    );

  } catch (error) {
    console.error('[POST /api/instructor/room-requests]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
