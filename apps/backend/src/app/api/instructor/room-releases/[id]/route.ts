import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { parseId } from '@/database/ids';
import { withAudit } from '@/services/audit';
import { manilaCalendarDateString, manilaClock } from '@/services/appTimezone';
import { ensureRoomReleasesTable, weekdayOfDate } from '@/services/roomReleases';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { facultyName, notifyRoomFreed } from '@/services/roomFreedNotice';
import { ensureRoomRequestsSchema } from '@/services/ensureRoomOccupancy';

/* DELETE /api/instructor/room-releases/:id — take back a classroom made available,
   as long as its class time hasn't started (others may be using it from then on)
   and no other faculty has asked for the room for that time (a today-only room
   request counts on the room being free). */
async function DELETE_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!auth || auth.role !== 'instructor' || !auth.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const rid = parseId((await params).id);
    if (rid === null) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
    await ensureRoomReleasesTable();
    await ensureRoomRequestsSchema();

    const found = await query(`
      SELECT rr.id, to_char(rr.release_date, 'YYYY-MM-DD') AS date, to_char(ss.start_time, 'HH24:MI') AS start_time,
             to_char(ss.end_time, 'HH24:MI') AS end_time, r.id AS room_id, r.room_name, r.room_type,
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
      LEFT JOIN rooms r ON r.id = ss.room_id
      WHERE  rr.id = $1 AND rr.faculty_id = $2
    `, [rid, auth.faculty_id]);
    const row = found.rows[0] as {
      date: string; start_time: string; end_time: string; reserved_by: string | null;
      room_id: number | null; room_name: string | null; room_type: string | null;
    } | undefined;
    if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 });

    const today = manilaCalendarDateString();
    if (row.date === today && row.start_time <= manilaClock().time.slice(0, 5)) {
      return NextResponse.json(
        { error: 'This class time has started, so the classroom stays available to others today.' },
        { status: 409 },
      );
    }

    if (row.reserved_by) {
      return NextResponse.json(
        { error: `${row.reserved_by} already asked for this classroom for that time, so it stays available to them.` },
        { status: 409 },
      );
    }

    await query(`DELETE FROM room_releases WHERE id = $1 AND faculty_id = $2`, [rid, auth.faculty_id]);
    // The faculty who were told it is free now hear that it isn't
    const weekday = weekdayOfDate(row.date);
    if (row.room_id && row.room_name && weekday) {
      const period = await getActiveAcademicPeriod();
      await notifyRoomFreed({
        times: [{ room: { id: Number(row.room_id), room_name: row.room_name, room_type: row.room_type }, date: row.date, weekday, start: row.start_time, end: row.end_time }],
        freedBy: auth.faculty_id,
        freedByName: await facultyName(auth.faculty_id),
        term: { year: period.schoolYear ?? '', semester: period.semester ?? '' },
        takenBack: true,
      });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/instructor/room-releases/:id]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const DELETE = withAudit(DELETE_handler);
