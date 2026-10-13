import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { ensureRoomOccupancy, expireStaleOccupancy, holdEndSql, legacyInUseHoldSql } from '@/services/ensureRoomOccupancy';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { APP_TIMEZONE, manilaCalendarDateString, manilaClock, manilaDateAtSql } from '@/services/appTimezone';
import { ensureRoomReleasesTable, freedOnSql, releasedOnSql, unclaimedNowSql, weekdayOfDate } from '@/services/roomReleases';

/**
 * GET /api/instructor/available-rooms?day=Monday&start_time=08:00&end_time=09:00&room_type=all[&date=YYYY-MM-DD]
 *
 * Returns all Active rooms with their current occupancy and schedule-conflict
 * status for the requested day + time window — and `released`: rooms taken by
 * a class on that day every week, but free on an upcoming date because the
 * class's faculty made the classroom available then (services/roomReleases.ts).
 *
 * With `date` (that weekday — today for room requests, which are for today
 * only): a class whose faculty made the room available that date doesn't
 * count, nor — today — one nobody checked in for within 15 minutes (`freed`
 * says which — only those rooms can be requested), a room reserved for an
 * overlapping time is taken (`reservation`), and someone using the room counts
 * only when it is today and they still hold it at the start time.
 */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureRoomOccupancy();
    await expireStaleOccupancy();
    await ensureRoomReleasesTable();

    const { searchParams } = new URL(req.url);
    const day       = searchParams.get('day');
    const startTime = searchParams.get('start_time');
    const endTime   = searchParams.get('end_time');
    const roomType  = searchParams.get('room_type') ?? 'all';
    // Room request form: ignore the class being moved (its own current room isn't a clash)
    const excludeMs = Number(searchParams.get('exclude_ms')) || 0;
    const dateParam = searchParams.get('date');
    const date = dateParam && day && weekdayOfDate(dateParam) === day ? dateParam : null;
    const today = manilaCalendarDateString();
    const timed = !!(day && startTime && endTime);

    // Classes only clash within one school year + semester: the term of the
    // class being moved, otherwise the active term (same rule as the server's
    // room-request check and the scheduling conflict rules).
    let termYear = '';
    let termSemester = '';
    const ownTerm = excludeMs
      ? (await query(`
          SELECT b.academic_year, b.semester
          FROM   master_schedule ms
          JOIN   block_subjects bs ON bs.id = ms.block_subject_id
          JOIN   blocks b ON b.id = bs.block_id
          WHERE  ms.id = $1
        `, [excludeMs])).rows[0]
      : undefined;
    if (ownTerm) {
      termYear = String(ownTerm.academic_year ?? '');
      termSemester = String(ownTerm.semester ?? '');
    } else {
      const period = await getActiveAcademicPeriod();
      termYear = period.schoolYear ?? '';
      termSemester = period.semester ?? '';
    }

    // Fetch all active rooms
    let roomsQuery = `SELECT id, room_name, room_type, capacity, building FROM rooms WHERE status = 'Active'`;
    const roomsParams: unknown[] = [];
    if (roomType && roomType !== 'all') {
      roomsQuery += ` AND room_type = $1`;
      roomsParams.push(roomType);
    }
    roomsQuery += ' ORDER BY room_name';
    const roomsResult = await query(roomsQuery, roomsParams);

    // On a date: reserved by a today-only room request for an overlapping time,
    // and freed by the faculty of the class that meets there then
    const reservedBy = new Map<number, { faculty_name: string | null; start_time: string; end_time: string; is_mine: boolean }>();
    /** unclaimed: its class wasn't checked in within 15 minutes — free until `until` ("HH:MM") */
    const freedBy = new Map<number, { faculty_name: string | null; reason: string | null; unclaimed?: true; until?: string }>();
    if (date && timed) {
      const resv = await query(`
        SELECT DISTINCT ON (rcr.requested_room_id)
               rcr.requested_room_id AS room_id,
               COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                        NULLIF(trim(COALESCE(f.first_name, '') || ' ' || COALESCE(f.last_name, '')), '')) AS faculty_name,
               to_char(rcr.use_start, 'HH24:MI') AS start_time, to_char(rcr.use_end, 'HH24:MI') AS end_time,
               rcr.faculty_id IS NOT DISTINCT FROM $4::int AS is_mine
        FROM   room_change_requests rcr
        JOIN   faculty f ON f.id = rcr.faculty_id
        WHERE  rcr.use_date = $1::date
          AND  rcr.status IN ('Pending Confirmation', 'Approved', 'In-Use')
          AND  rcr.use_start < $3::time AND rcr.use_end > $2::time
        ORDER  BY rcr.requested_room_id, rcr.use_start
      `, [date, startTime, endTime, authUser.faculty_id ?? null]);
      for (const r of resv.rows) {
        reservedBy.set(Number(r.room_id), { faculty_name: r.faculty_name, start_time: r.start_time, end_time: r.end_time, is_mine: r.is_mine === true });
      }
      const freed = await query(`
        SELECT DISTINCT ON (ss.room_id)
               ss.room_id, rr.reason,
               COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                        NULLIF(trim(COALESCE(f.first_name, '') || ' ' || COALESCE(f.last_name, '')), '')) AS faculty_name
        FROM   room_releases rr
        JOIN   schedule_sessions ss ON ss.id = rr.session_id
        JOIN   master_schedule  ms ON ms.id = ss.master_schedule_id AND ms.faculty_id = rr.faculty_id
        JOIN   block_subjects   bs ON bs.id = ms.block_subject_id
        JOIN   blocks            b ON b.id  = bs.block_id
        LEFT JOIN faculty        f ON f.id  = rr.faculty_id
        WHERE  rr.release_date = $1::date
          AND  ss.day_of_week  = $2
          AND  ss.start_time < $4::time AND ss.end_time > $3::time
          AND  ms.status IN ('Assigned', 'Scheduled')
          AND  ($5 = '' OR b.academic_year = $5)
          AND  ($6 = '' OR b.semester      = $6)
          -- another faculty's room: only those can be requested (your own isn't "freed for you")
          AND  rr.faculty_id IS DISTINCT FROM $7::int
        ORDER  BY ss.room_id, ss.start_time
      `, [date, day, startTime, endTime, termYear, termSemester, authUser.faculty_id ?? null]);
      for (const r of freed.rows) freedBy.set(Number(r.room_id), { faculty_name: r.faculty_name, reason: r.reason });
      // Today: another faculty's class that nobody checked in for (no name — it wasn't their choice)
      if (date === today) {
        const unclaimed = await query(`
          SELECT DISTINCT ON (ss.room_id) ss.room_id, to_char(ss.end_time, 'HH24:MI') AS until
          FROM   schedule_sessions ss
          JOIN   master_schedule  ms ON ms.id = ss.master_schedule_id
          JOIN   block_subjects   bs ON bs.id = ms.block_subject_id
          JOIN   blocks            b ON b.id  = bs.block_id
          WHERE  ss.day_of_week = $1
            AND  ss.start_time < $3::time AND ss.end_time > $2::time
            AND  ms.status IN ('Assigned', 'Scheduled')
            AND  ($4 = '' OR b.academic_year = $4)
            AND  ($5 = '' OR b.semester      = $5)
            AND  ms.faculty_id IS DISTINCT FROM $6::int
            AND  ${unclaimedNowSql('ss', 'ms')}
          ORDER  BY ss.room_id, ss.end_time
        `, [day, startTime, endTime, termYear, termSemester, authUser.faculty_id ?? null]);
        for (const r of unclaimed.rows) {
          if (!freedBy.has(Number(r.room_id))) freedBy.set(Number(r.room_id), { faculty_name: null, reason: null, unclaimed: true, until: r.until });
        }
      }
    }

    // For each room, check live occupancy and schedule conflicts
    const rooms = await Promise.all(roomsResult.rows.map(async room => {
      // Live occupancy (Pending or Occupied right now). On a date: only today, and
      // only someone else still holding the room at the start time (a class
      // check-in until its class ends, an older request until it is released)
      const occRes = !date
        ? await query(`
          SELECT ro.status, CONCAT_WS(' ', f.first_name, f.last_name) AS faculty_name
          FROM room_occupancy ro
          JOIN faculty f ON ro.faculty_id = f.id
          WHERE ro.room_id = $1 AND ro.status IN ('Pending', 'Occupied')
          LIMIT 1
        `, [room.id])
        : date === today && timed
          ? await query(`
            SELECT ro.status, CONCAT_WS(' ', f.first_name, f.last_name) AS faculty_name,
                   CASE WHEN ${legacyInUseHoldSql('ro')} THEN NULL
                        ELSE to_char(${holdEndSql('ro')} AT TIME ZONE '${APP_TIMEZONE}', 'HH24:MI') END AS until
            FROM room_occupancy ro
            JOIN faculty f ON ro.faculty_id = f.id
            WHERE ro.room_id = $1 AND ro.status IN ('Pending', 'Occupied')
              AND ro.faculty_id IS DISTINCT FROM $2::int
              AND (${holdEndSql('ro')} > ${manilaDateAtSql('$3::date', '$4::time')} OR ${legacyInUseHoldSql('ro')})
            LIMIT 1
          `, [room.id, authUser.faculty_id ?? null, date, startTime])
          : { rows: [] };
      const occupancy = occRes.rows[0] ?? null;

      // Schedule conflict: any class assigned to this room at the requested day/time
      let scheduleConflict = null;
      if (day && startTime && endTime) {
        const conflictRes = await query(`
          SELECT
            c.subject_code, c.subject_name,
            b.block_name, b.year_level,
            p.code AS program_code,
            CONCAT_WS(' ', f2.first_name, f2.last_name) AS faculty_name,
            ss.start_time::text, ss.end_time::text
          FROM schedule_sessions ss
          JOIN master_schedule ms ON ss.master_schedule_id = ms.id
          JOIN block_subjects  bs ON ms.block_subject_id = bs.id
          JOIN curriculums      c ON bs.curriculum_id = c.id
          JOIN blocks           b ON bs.block_id = b.id
          JOIN programs         p ON b.program_id = p.id
          LEFT JOIN faculty    f2 ON ms.faculty_id = f2.id
          WHERE ss.room_id = $1
            AND ms.status IN ('Assigned', 'Scheduled')
            AND ss.day_of_week = $2
            AND ss.start_time  < $3::time
            AND ss.end_time    > $4::time
            AND ms.id <> $5
            AND ($6 = '' OR b.academic_year = $6)
            AND ($7 = '' OR b.semester      = $7)
            AND NOT ${freedOnSql('ss', 'ms', '$8::date')}
          LIMIT 1
        `, [room.id, day, endTime, startTime, excludeMs, termYear, termSemester, date]);
        scheduleConflict = conflictRes.rows[0] ?? null;
      }

      const reservation = reservedBy.get(Number(room.id)) ?? null;
      const isAvailable = !occupancy && !scheduleConflict && !reservation;

      return {
        ...room,
        occupancy,
        schedule_conflict: scheduleConflict,
        reservation,
        // Its weekly class then was made available for that date by its faculty
        freed: isAvailable ? freedBy.get(Number(room.id)) ?? null : null,
        is_available: isAvailable,
      };
    }));

    /* Free on a date: the weekly class in the room during this time was made
       available for that date, and no other class uses the room then. Upcoming
       dates only (today's until the class time ends); other faculty's releases. */
    let released: unknown[] = [];
    if (timed) {
      const now = manilaClock().time.slice(0, 5);
      const res = await query(`
        SELECT r.id AS room_id, r.room_name, r.room_type, r.capacity, r.building,
               to_char(rr.release_date, 'YYYY-MM-DD') AS date,
               to_char(GREATEST(ss.start_time, $2::time), 'HH24:MI') AS start_time,
               to_char(LEAST(ss.end_time, $3::time), 'HH24:MI') AS end_time,
               rr.reason,
               COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                        NULLIF(trim(COALESCE(f.first_name, '') || ' ' || COALESCE(f.last_name, '')), '')) AS released_by
        FROM   room_releases rr
        JOIN   schedule_sessions ss ON ss.id = rr.session_id
        JOIN   master_schedule  ms ON ms.id = ss.master_schedule_id AND ms.faculty_id = rr.faculty_id
        JOIN   block_subjects   bs ON bs.id = ms.block_subject_id
        JOIN   blocks            b ON b.id  = bs.block_id
        JOIN   rooms             r ON r.id  = ss.room_id
        LEFT JOIN faculty        f ON f.id  = rr.faculty_id
        WHERE  ss.day_of_week = $1
          AND  ss.start_time < $3::time AND ss.end_time > $2::time
          AND  ms.status IN ('Assigned', 'Scheduled')
          AND  ($4 = '' OR b.academic_year = $4)
          AND  ($5 = '' OR b.semester      = $5)
          AND  r.status = 'Active'
          AND  ($6 = 'all' OR r.room_type = $6)
          AND  rr.faculty_id IS DISTINCT FROM $7::int
          AND  (rr.release_date > $8::date OR (rr.release_date = $8::date AND ss.end_time > $9::time))
          -- the searched date's own releases are among the rooms above
          AND  rr.release_date IS DISTINCT FROM $10::date
          -- every other class in the room during this time is released that date too
          AND  NOT EXISTS (
                 SELECT 1
                 FROM   schedule_sessions ss2
                 JOIN   master_schedule  ms2 ON ms2.id = ss2.master_schedule_id
                 JOIN   block_subjects   bs2 ON bs2.id = ms2.block_subject_id
                 JOIN   blocks            b2 ON b2.id  = bs2.block_id
                 WHERE  ss2.room_id = ss.room_id
                   AND  ss2.id <> ss.id
                   AND  ss2.day_of_week = $1
                   AND  ss2.start_time < LEAST(ss.end_time, $3::time)
                   AND  ss2.end_time   > GREATEST(ss.start_time, $2::time)
                   AND  ms2.status IN ('Assigned', 'Scheduled')
                   AND  ($4 = '' OR b2.academic_year = $4)
                   AND  ($5 = '' OR b2.semester      = $5)
                   AND  NOT ${releasedOnSql('ss2', 'ms2', 'rr.release_date')}
               )
        ORDER  BY rr.release_date, r.room_name, ss.start_time
      `, [day, startTime, endTime, termYear, termSemester, roomType || 'all', authUser.faculty_id ?? null, today, now, date]);
      released = res.rows;
    }

    return NextResponse.json({ rooms, released });
  } catch (error) {
    console.error('[GET /api/instructor/available-rooms]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
