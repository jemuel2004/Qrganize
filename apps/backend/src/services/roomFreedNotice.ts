import { query } from '@/database/db';
import { createNotification } from '@/services/notifications';
import { borrowRoomFitError, fitsFreeTime } from '@/services/borrowedRoom';
import { freedDayPhrase, mergeFreedTimes, type FreedTime } from '@/services/freedTime';
import { needsOneRoomSql } from '@shared/subjectCategory';
import { time12 } from '@shared/roomRequestWindow';

/**
 * "Free My Room" → tell the faculty who could use the room (bell only, the user's rule
 * 2026-10-13): a class of theirs on that day whose time overlaps the freed time, that has
 * NO room, that suits the room, and that ends by the time the room is free until (the
 * borrowed-room rules, services/borrowedRoom.ts). Nobody else is told.
 *   "Jehu has freed Lecture-1 for tomorrow (Oct 14), from 10:00 AM to 12:00 PM."
 * Taking the room back tells the same faculty it is no longer free.
 */

/** The faculty (ids) whose class that day could use the freed time — never the one who freed it */
async function facultyWhoCouldUse(t: FreedTime, freedBy: number, term: { year: string; semester: string }): Promise<number[]> {
  const res = await query(`
    SELECT ms.faculty_id, CASE WHEN ss.type = 'lab' THEN 'lab' ELSE 'lec' END AS part,
           to_char(ss.end_time, 'HH24:MI') AS end_time, c.subject_code,
           COALESCE(c.lecture_hours, 0)::float AS lecture_hours, COALESCE(c.laboratory_hours, 0)::float AS laboratory_hours,
           ${needsOneRoomSql('c')} AS one_room
    FROM   schedule_sessions ss
    JOIN   master_schedule ms ON ss.master_schedule_id = ms.id
    JOIN   block_subjects  bs ON ms.block_subject_id   = bs.id
    JOIN   curriculums      c ON bs.curriculum_id       = c.id
    JOIN   blocks           b ON bs.block_id            = b.id
    LEFT JOIN rooms        r0 ON r0.id = ss.room_id AND r0.status = 'Active'
    WHERE  ss.day_of_week = $1
      AND  ss.start_time  < $3::time
      AND  ss.end_time    > $2::time
      AND  ms.status IN ('Assigned', 'Scheduled')
      AND  ms.faculty_id IS NOT NULL AND ms.faculty_id <> $4
      AND  ($5 = '' OR b.academic_year = $5)
      AND  ($6 = '' OR b.semester      = $6)
      AND  r0.id IS NULL
  `, [t.weekday, t.start, t.end, freedBy, term.year, term.semester]);
  const ids = new Set<number>();
  for (const row of res.rows as { faculty_id: number; part: 'lec' | 'lab'; end_time: string; subject_code: string; lecture_hours: number; laboratory_hours: number; one_room: boolean }[]) {
    if (!fitsFreeTime(row.end_time, t.end)) continue;
    if (borrowRoomFitError({ ...row, one_room: !!row.one_room }, t.room)) continue;
    ids.add(Number(row.faculty_id));
  }
  return [...ids];
}

/** Bell notifications for freed (or taken back) room times. Never throws — a failed notice must not undo the save. */
export async function notifyRoomFreed(opts: {
  times: FreedTime[];
  freedBy: number;
  freedByName: string;
  term: { year: string; semester: string };
  takenBack?: boolean;
}): Promise<number> {
  let sent = 0;
  try {
    for (const t of mergeFreedTimes(opts.times)) {
      const who = await facultyWhoCouldUse(t, opts.freedBy, opts.term);
      const when = `${freedDayPhrase(t.date)}, from ${time12(t.start)} to ${time12(t.end)}`;
      for (const facultyId of who) {
        await createNotification({
          recipientId: facultyId,
          recipientRole: 'instructor',
          title: opts.takenBack ? 'Room No Longer Free' : 'Room Freed',
          message: opts.takenBack
            ? `${opts.freedByName} took back ${t.room.room_name} for ${when}. It is no longer free.`
            : `${opts.freedByName} has freed ${t.room.room_name} for ${when}.`,
          type: 'room_released',
          relatedModule: 'room',
          relatedId: t.room.id,
        });
        sent += 1;
      }
    }
  } catch (err) {
    console.error('[notifyRoomFreed]', err);
  }
  return sent;
}

/** The faculty's display name */
export async function facultyName(facultyId: number): Promise<string> {
  const res = await query(`
    SELECT COALESCE(NULLIF(trim(COALESCE(name, '')), ''),
                    NULLIF(trim(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '')) AS n
    FROM faculty WHERE id = $1`, [facultyId]).catch(() => ({ rows: [] as { n: string | null }[] }));
  return (res.rows[0] as { n?: string | null } | undefined)?.n || 'A faculty member';
}
