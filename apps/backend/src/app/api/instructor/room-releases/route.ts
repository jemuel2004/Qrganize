import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { withAudit } from '@/services/audit';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { manilaCalendarDateString, manilaClock } from '@/services/appTimezone';
import { ensureRoomOccupancy, ensureRoomRequestsSchema } from '@/services/ensureRoomOccupancy';
import {
  ROOM_RELEASE_MAX_DAYS_AHEAD, ROOM_RELEASE_REASONS, daysBetween, ensureRoomReleasesTable, weekdayOfDate,
} from '@/services/roomReleases';
import { facultyName, notifyRoomFreed } from '@/services/roomFreedNotice';

/*
  Faculty "Make Classroom Available" (services/roomReleases.ts)

  GET  /api/instructor/room-releases[?date=YYYY-MM-DD]
       → class_days: the weekdays this faculty teaches with a room (and the last class
                   end time) — the calendar only offers those dates
       → releases: this faculty's releases that haven't ended yet, with their state
                   (upcoming · reserved by another faculty's room request for that
                   date · open to others now · in use by another faculty)
       → sessions: (with ?date) this faculty's classes with a room on that date's
                   weekday, each marked released (and by whom it was reserved) /
                   already ended
  POST /api/instructor/room-releases  { date, session_ids: number[], reason? }
       → frees those sessions' rooms on that one date (only the faculty's own
         assigned classes; the class itself is not changed)
*/

type Auth = { role?: string; faculty_id?: number } | null;

/** The faculty's own classes with a room on one weekday, in the active term */
const OWN_SESSIONS_SQL = `
  SELECT ss.id AS session_id, ss.master_schedule_id,
         to_char(ss.start_time, 'HH24:MI') AS start_time, to_char(ss.end_time, 'HH24:MI') AS end_time,
         COALESCE(ss.type, 'lec') AS session_type,
         r.id AS room_id, r.room_name, r.room_type,
         c.subject_code, c.subject_name, b.block_name, b.year_level, p.code AS program_code,
         EXISTS (SELECT 1 FROM room_releases rr WHERE rr.session_id = ss.id AND rr.release_date = $3::date) AS released,
         (SELECT rr.id FROM room_releases rr WHERE rr.session_id = ss.id AND rr.release_date = $3::date) AS release_id,
         (SELECT COALESCE(NULLIF(trim(COALESCE(f2.name, '')), ''),
                            NULLIF(trim(COALESCE(f2.first_name, '') || ' ' || COALESCE(f2.last_name, '')), ''))
              FROM room_change_requests rcr JOIN faculty f2 ON f2.id = rcr.faculty_id
             WHERE rcr.requested_room_id = ss.room_id AND rcr.use_date = $3::date
               AND rcr.faculty_id <> ms.faculty_id
               AND rcr.status IN ('Pending Confirmation', 'Approved', 'In-Use')
               AND rcr.use_start < ss.end_time AND rcr.use_end > ss.start_time
             ORDER BY rcr.use_start
             LIMIT 1) AS reserved_by
  FROM   schedule_sessions ss
  JOIN   master_schedule ms ON ms.id = ss.master_schedule_id
  JOIN   block_subjects  bs ON bs.id = ms.block_subject_id
  JOIN   curriculums      c ON c.id  = bs.curriculum_id
  JOIN   blocks           b ON b.id  = bs.block_id
  LEFT JOIN programs      p ON p.id  = b.program_id
  JOIN   rooms            r ON r.id  = ss.room_id
  WHERE  ms.faculty_id = $1
    AND  ms.status IN ('Assigned', 'Scheduled')
    AND  ss.day_of_week = $2
    AND  ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
    AND  ($4 = '' OR b.academic_year = $4)
    AND  ($5 = '' OR b.semester      = $5)
`;

interface OwnSession {
  session_id: number; master_schedule_id: number; start_time: string; end_time: string; session_type: string;
  room_id: number; room_name: string; room_type: string;
  subject_code: string; subject_name: string; block_name: string | null; year_level: string | null; program_code: string | null;
  released: boolean;
  release_id: number | null;
  /** Another faculty's today-only room request for the freed time */
  reserved_by: string | null;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as Auth;
    if (!auth || auth.role !== 'instructor' || !auth.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const facultyId = auth.faculty_id;
    await ensureRoomReleasesTable();
    await ensureRoomOccupancy();
    await ensureRoomRequestsSchema();
    const today = manilaCalendarDateString();
    const now = manilaClock().time.slice(0, 5);

    // Releases that haven't ended (a release whose class time is over is simply past)
    const rel = await query(`
      SELECT rr.id, to_char(rr.release_date, 'YYYY-MM-DD') AS date, rr.reason,
             ss.id AS session_id, ss.master_schedule_id, ss.day_of_week AS day,
             to_char(ss.start_time, 'HH24:MI') AS start_time, to_char(ss.end_time, 'HH24:MI') AS end_time,
             r.room_name, r.room_type,
             c.subject_code, c.subject_name, b.block_name, b.year_level, p.code AS program_code,
             (SELECT COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                              NULLIF(trim(COALESCE(f.first_name, '') || ' ' || COALESCE(f.last_name, '')), ''))
                FROM room_occupancy ro JOIN faculty f ON f.id = ro.faculty_id
               WHERE ro.room_id = ss.room_id AND ro.faculty_id <> rr.faculty_id
                 AND ro.status IN ('Pending', 'Occupied') AND ro.expires_at > NOW()
               LIMIT 1) AS taken_by,
             (SELECT COALESCE(NULLIF(trim(COALESCE(f2.name, '')), ''),
                              NULLIF(trim(COALESCE(f2.first_name, '') || ' ' || COALESCE(f2.last_name, '')), ''))
                FROM room_change_requests rcr JOIN faculty f2 ON f2.id = rcr.faculty_id
               WHERE rcr.requested_room_id = ss.room_id AND rcr.use_date = rr.release_date
                 AND rcr.faculty_id <> rr.faculty_id
                 AND rcr.status IN ('Pending Confirmation', 'Approved', 'In-Use')
                 AND rcr.use_start < ss.end_time AND rcr.use_end > ss.start_time
               ORDER BY rcr.use_start
               LIMIT 1) AS reserved_by
      FROM   room_releases rr
      JOIN   schedule_sessions ss ON ss.id = rr.session_id
      JOIN   master_schedule  ms ON ms.id = ss.master_schedule_id AND ms.faculty_id = rr.faculty_id
      JOIN   block_subjects   bs ON bs.id = ms.block_subject_id
      JOIN   curriculums       c ON c.id  = bs.curriculum_id
      JOIN   blocks            b ON b.id  = bs.block_id
      LEFT JOIN programs       p ON p.id  = b.program_id
      LEFT JOIN rooms          r ON r.id  = ss.room_id
      WHERE  rr.faculty_id = $1
        AND  (rr.release_date > $2::date OR (rr.release_date = $2::date AND ss.end_time > $3::time))
      ORDER BY rr.release_date, ss.start_time
    `, [facultyId, today, now]);

    const releases = rel.rows.map(r => {
      const started = r.date === today && String(r.start_time) <= now;
      const takenBy = started ? r.taken_by : null;
      return {
        ...r,
        taken_by: takenBy,
        // upcoming → "Released for this date"; reserved → another faculty asked for the
        // room then (can't be taken back); open → "Available to others"; in-use → someone took it
        state: takenBy ? 'in-use' : r.reserved_by ? 'reserved' : started ? 'open' : 'upcoming',
      };
    });

    // The weekdays with a class in a room (active term) — the same classes OWN_SESSIONS_SQL lists
    const period = await getActiveAcademicPeriod();
    const days = await query(`
      SELECT ss.day_of_week AS day, to_char(MAX(ss.end_time), 'HH24:MI') AS last_end
      FROM   schedule_sessions ss
      JOIN   master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN   block_subjects  bs ON bs.id = ms.block_subject_id
      JOIN   blocks           b ON b.id  = bs.block_id
      WHERE  ms.faculty_id = $1
        AND  ms.status IN ('Assigned', 'Scheduled')
        AND  ss.room_id IS NOT NULL AND ss.day_of_week IS NOT NULL
        AND  ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
        AND  ($2 = '' OR b.academic_year = $2)
        AND  ($3 = '' OR b.semester      = $3)
      GROUP  BY ss.day_of_week
    `, [facultyId, period.schoolYear ?? '', period.semester ?? '']);

    const date = req.nextUrl.searchParams.get('date');
    let sessions: (OwnSession & { ended: boolean })[] | undefined;
    if (date) {
      const weekday = weekdayOfDate(date);
      if (!weekday) return NextResponse.json({ error: 'Choose a valid date.' }, { status: 400 });
      const res = await query(`${OWN_SESSIONS_SQL} ORDER BY ss.start_time, c.subject_code`,
        [facultyId, weekday, date, period.schoolYear ?? '', period.semester ?? '']);
      sessions = (res.rows as OwnSession[]).map(s => ({ ...s, ended: date < today || (date === today && s.end_time <= now) }));
    }

    return NextResponse.json({
      today, now, releases, sessions, class_days: days.rows,
      reasons: ROOM_RELEASE_REASONS, max_days_ahead: ROOM_RELEASE_MAX_DAYS_AHEAD,
    });
  } catch (error) {
    console.error('[GET /api/instructor/room-releases]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as Auth;
    if (!auth || auth.role !== 'instructor' || !auth.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const facultyId = auth.faculty_id;
    await ensureRoomReleasesTable();

    const body = await req.json().catch(() => ({})) as { date?: unknown; session_ids?: unknown; reason?: unknown };
    const date = typeof body.date === 'string' ? body.date : '';
    const weekday = weekdayOfDate(date);
    if (!weekday) return NextResponse.json({ error: 'Choose a valid date.' }, { status: 400 });
    const today = manilaCalendarDateString();
    const ahead = daysBetween(today, date);
    if (ahead < 0) return NextResponse.json({ error: 'Choose today or a later date.' }, { status: 400 });
    if (ahead > ROOM_RELEASE_MAX_DAYS_AHEAD) {
      return NextResponse.json({ error: 'Choose a date within the next 6 months.' }, { status: 400 });
    }

    const ids = Array.isArray(body.session_ids)
      ? [...new Set(body.session_ids.map(Number).filter(n => Number.isInteger(n) && n > 0))]
      : [];
    if (ids.length === 0) return NextResponse.json({ error: 'Choose at least one class.' }, { status: 400 });
    if (ids.length > 30) return NextResponse.json({ error: 'Too many classes at once.' }, { status: 400 });

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason && !(ROOM_RELEASE_REASONS as readonly string[]).includes(reason)) {
      return NextResponse.json({ error: 'Choose a reason from the list.' }, { status: 400 });
    }

    // Only the faculty's own classes with a room on that weekday (active term) — anything else is refused
    const period = await getActiveAcademicPeriod();
    const own = (await query(`${OWN_SESSIONS_SQL} AND ss.id = ANY($6::int[])`,
      [facultyId, weekday, date, period.schoolYear ?? '', period.semester ?? '', ids])).rows as OwnSession[];
    if (own.length !== ids.length) {
      return NextResponse.json(
        { error: `You can only make your own assigned classrooms available, for classes you have on ${weekday}.` },
        { status: 403 },
      );
    }
    if (date === today) {
      const now = manilaClock().time.slice(0, 5);
      const over = own.find(s => s.end_time <= now);
      if (over) return NextResponse.json({ error: `${over.subject_code} has already ended today.` }, { status: 400 });
    }

    // One record per class session and date — asking twice changes nothing
    const inserted = await query(`
      INSERT INTO room_releases (session_id, faculty_id, release_date, reason)
      SELECT s, $2, $3::date, NULLIF($4, '') FROM unnest($1::int[]) AS s
      ON CONFLICT (session_id, release_date) DO NOTHING
      RETURNING session_id
    `, [ids, facultyId, date, reason]);
    const n = inserted.rowCount ?? 0;
    if (n === 0) {
      return NextResponse.json({ error: 'Already free for others on that date.' }, { status: 409 });
    }

    // Tell the faculty who could use it — from the class's start (today: from now, if it has started)
    const freedIds = new Set(inserted.rows.map(row => Number(row.session_id)));
    const nowHm = manilaClock().time.slice(0, 5);
    await notifyRoomFreed({
      times: own.filter(s => freedIds.has(Number(s.session_id))).map(s => ({
        room: { id: Number(s.room_id), room_name: s.room_name, room_type: s.room_type },
        date, weekday,
        start: date === today && s.start_time < nowHm ? nowHm : s.start_time,
        end: s.end_time,
      })),
      freedBy: facultyId,
      freedByName: await facultyName(facultyId),
      term: { year: period.schoolYear ?? '', semester: period.semester ?? '' },
    });

    const rooms = [...new Set(own.map(s => s.room_name))].join(', ');
    return NextResponse.json({ created: n, message: `${rooms} is now free for others on that date.` }, { status: 201 });
  } catch (error) {
    console.error('[POST /api/instructor/room-releases]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
