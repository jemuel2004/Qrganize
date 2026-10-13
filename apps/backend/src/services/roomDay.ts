import { query } from '@/database/db';
import { manilaCalendarDateString } from '@/services/appTimezone';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { ensureRoomOccupancy, ensureRoomRequestsSchema, expireStaleOccupancy } from '@/services/ensureRoomOccupancy';
import { ensureRoomReleasesTable, releasedOnSql, unclaimedNowSql } from '@/services/roomReleases';

/**
 * One room, one day: who holds it right now and which classes meet in it.
 * Shared by the room page a QR opens (GET /api/rooms/by-qr) and the room
 * details on Find Available Rooms (GET /api/instructor/rooms/:id/schedule).
 */

export type RoomStatusNow =
  | { state: 'Available' }
  | { state: 'Pending' | 'Occupied'; faculty_name: string | null; is_mine: boolean; since: string | null; until: string | null };

/** The room's status now — the same occupancy records Room Monitoring and the scan use */
export async function roomStatusNow(roomId: number, viewerFacultyId: number | null): Promise<RoomStatusNow> {
  await ensureRoomOccupancy();
  await expireStaleOccupancy(roomId);
  const res = await query(`
    SELECT ro.status, ro.occupied_at, ro.reserved_at, ro.expires_at, ro.faculty_id,
           COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                    NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')) AS faculty_name
    FROM   room_occupancy ro
    JOIN   faculty f ON f.id = ro.faculty_id
    WHERE  ro.room_id = $1 AND ro.status IN ('Pending', 'Occupied')
    ORDER  BY (ro.status = 'Occupied') DESC, ro.reserved_at DESC
    LIMIT  1
  `, [roomId]);
  const occ = res.rows[0] as {
    status: 'Pending' | 'Occupied'; occupied_at: string | null; reserved_at: string | null; expires_at: string | null;
    faculty_id: number; faculty_name: string | null;
  } | undefined;
  if (!occ) return { state: 'Available' };
  return {
    state: occ.status,
    faculty_name: occ.faculty_name,
    is_mine: viewerFacultyId != null && Number(occ.faculty_id) === viewerFacultyId,
    since: occ.status === 'Occupied' ? occ.occupied_at : occ.reserved_at,
    until: occ.expires_at,
  };
}

export interface RoomDayClass {
  ms_id: number;
  subject_code: string;
  subject_name: string;
  /** "BSIT 3C" */
  block: string;
  faculty_name: string | null;
  start_time: string;
  end_time: string;
  is_mine: boolean;
  /** Its faculty made the room available for today */
  released: boolean;
  /** Today: not checked in within 15 minutes of the start — the room is free to anyone until it ends */
  unclaimed: boolean;
  /** Dates (today on) its faculty made the room available — services/roomReleases.ts */
  releases: { date: string; reason: string | null }[];
}

export interface RoomReservation {
  faculty_name: string | null;
  subject_code: string | null;
  /** "BSIT 3C" */
  block: string;
  start_time: string;
  end_time: string;
  /** Pending Confirmation (waiting for its QR scan) · Approved · In-Use */
  status: string;
  is_mine: boolean;
}

/** Today's room requests for a room (today-only, still on), by start time */
export async function roomReservationsToday(roomId: number, viewerFacultyId: number | null): Promise<RoomReservation[]> {
  await ensureRoomRequestsSchema();
  const res = await query(`
    SELECT rcr.faculty_id, rcr.status, c.subject_code, b.year_level, b.block_name, p.code AS program_code,
           to_char(rcr.use_start, 'HH24:MI') AS start_time, to_char(rcr.use_end, 'HH24:MI') AS end_time,
           COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                    NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')) AS faculty_name
    FROM   room_change_requests rcr
    JOIN   faculty f ON f.id = rcr.faculty_id
    LEFT JOIN master_schedule ms ON ms.id = rcr.master_schedule_id
    LEFT JOIN block_subjects  bs ON bs.id = ms.block_subject_id
    LEFT JOIN curriculums      c ON c.id  = bs.curriculum_id
    LEFT JOIN blocks           b ON b.id  = bs.block_id
    LEFT JOIN programs         p ON p.id  = b.program_id
    WHERE  rcr.requested_room_id = $1
      AND  rcr.use_date = $2::date
      AND  rcr.status IN ('Pending Confirmation', 'Approved', 'In-Use')
    ORDER  BY rcr.use_start
  `, [roomId, manilaCalendarDateString()]);
  return (res.rows as {
    faculty_id: number; status: string; subject_code: string | null; year_level: string | null; block_name: string | null;
    program_code: string | null; start_time: string; end_time: string; faculty_name: string | null;
  }[]).map(r => {
    const year = String(r.year_level ?? '').match(/\d+/)?.[0] ?? '';
    return {
      faculty_name: r.faculty_name,
      subject_code: r.subject_code,
      block: [r.program_code, `${year}${r.block_name ?? ''}`].filter(Boolean).join(' '),
      start_time: r.start_time,
      end_time: r.end_time,
      status: r.status,
      is_mine: viewerFacultyId != null && Number(r.faculty_id) === viewerFacultyId,
    };
  });
}

/** The classes meeting in a room on one weekday (active term), by start time */
export async function roomClassesOnDay(roomId: number, dayOfWeek: string, viewerFacultyId: number | null): Promise<RoomDayClass[]> {
  const period = await getActiveAcademicPeriod();
  await ensureRoomReleasesTable();
  const res = await query(`
    SELECT ms.id AS ms_id, ms.faculty_id, c.subject_code, c.subject_name, b.year_level, b.block_name, p.code AS program_code,
           ss.start_time::text AS start_time, ss.end_time::text AS end_time,
           ${releasedOnSql('ss', 'ms', '$5::date')} AS released,
           ${unclaimedNowSql('ss', 'ms', 'COALESCE(ss.room_id, ms.room_id)')} AS unclaimed,
           (SELECT json_agg(json_build_object('date', to_char(rr.release_date, 'YYYY-MM-DD'), 'reason', rr.reason) ORDER BY rr.release_date)
              FROM room_releases rr
             WHERE rr.session_id = ss.id AND rr.faculty_id = ms.faculty_id AND rr.release_date >= $5::date) AS releases,
           COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                    NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')) AS faculty_name
    FROM   schedule_sessions ss
    JOIN   master_schedule ms ON ms.id = ss.master_schedule_id
    JOIN   block_subjects bs ON ms.block_subject_id = bs.id
    JOIN   curriculums     c  ON bs.curriculum_id    = c.id
    JOIN   blocks          b  ON bs.block_id         = b.id
    LEFT JOIN programs     p  ON b.program_id        = p.id
    LEFT JOIN faculty      f  ON ms.faculty_id       = f.id
    WHERE  COALESCE(ss.room_id, ms.room_id) = $1
      AND  ss.day_of_week = $2
      AND  ms.status IN ('Assigned', 'Scheduled')
      AND  ($3 = '' OR b.academic_year = $3)
      AND  ($4 = '' OR b.semester      = $4)
    ORDER  BY ss.start_time
  `, [roomId, dayOfWeek, period.schoolYear ?? '', period.semester ?? '', manilaCalendarDateString()]);

  const seen = new Set<string>();
  return (res.rows as {
    ms_id: number; faculty_id: number | null; subject_code: string; subject_name: string; year_level: string | null;
    block_name: string | null; program_code: string | null; start_time: string; end_time: string; faculty_name: string | null;
    released: boolean; unclaimed: boolean; releases: { date: string; reason: string | null }[] | null;
  }[])
    // A class listed twice at the same time (e.g. Lec + Lab rows) meets once
    .filter(c => { const k = `${c.ms_id}|${c.start_time}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(c => {
      const year = String(c.year_level ?? '').match(/\d+/)?.[0] ?? '';
      return {
        ms_id: c.ms_id,
        subject_code: c.subject_code,
        subject_name: c.subject_name,
        block: [c.program_code, `${year}${c.block_name ?? ''}`].filter(Boolean).join(' '),
        faculty_name: c.faculty_name,
        start_time: c.start_time.slice(0, 5),
        end_time: c.end_time.slice(0, 5),
        is_mine: viewerFacultyId != null && Number(c.faculty_id) === viewerFacultyId,
        released: c.released === true,
        unclaimed: c.unclaimed === true,
        releases: c.releases ?? [],
      };
    });
}
