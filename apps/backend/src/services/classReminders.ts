import { query } from '@/database/db';
import { ensureNotificationsTable } from '@/database/notificationsSchema';
import { manilaCalendarDateString, manilaClock } from '@/services/appTimezone';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { ensureRoomReleasesTable, releasedOnSql } from '@/services/roomReleases';
import { bumpNotifications } from '@/services/realtime';

/*
 * Class reminders for faculty. They are made when the faculty's inbox is read
 * (the bell checks about every minute while QRganize is open), so no
 * scheduler is needed:
 *   • class_today    — once a day, while classes are still ahead: how many
 *                      and which one is next.
 *   • class_starting — from 15 minutes before a class until it ends, unless
 *                      the faculty already checked in (scanned the room QR).
 * Each is made once per class per day and shows in the bell only (no pop-ups).
 * They are for that day: a reminder is marked read once its class is over or
 * the faculty has checked in, the day's summary once no class is left, and
 * the next day they leave the inbox.
 */

const LEAD_MIN = 15;
/** No day summary before 5:00 AM */
const DAY_START_MIN = 5 * 60;
/** At most one check per faculty this often (the bell may ask more often) */
const CHECK_EVERY_MS = 30_000;
const lastCheck = new Map<number, number>();

const toMin = (t: string) => {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

function clock12(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** SQL: the start of today in Manila */
const START_OF_TODAY = `((NOW() AT TIME ZONE 'Asia/Manila')::date AT TIME ZONE 'Asia/Manila')`;

/** A class session today, as read by todaysClassSessions */
export interface TodaySession {
  faculty_id: number;
  /** master_schedule id — the class */
  id: number;
  subject_code: string;
  subject_name: string;
  program_code: string | null;
  year_level: string | null;
  block_name: string | null;
  /** "HH:MM:SS" */
  start_time: string;
  end_time: string;
  room_name: string | null;
  /** 'lec' | 'lab' */
  part: string;
}

/**
 * Today's class sessions (Manila day) of these faculty members in the active
 * term — the same rows as the faculty dashboard: their own classes only, still
 * Assigned / Scheduled, minus those whose room the faculty made available for
 * today (away that day). Shared by the bell reminders below and the device
 * reminders (services/classPush.ts).
 */
export async function todaysClassSessions(facultyIds: readonly number[]): Promise<TodaySession[]> {
  const ids = [...new Set(facultyIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  const { dayOfWeek } = manilaClock();
  const period = await getActiveAcademicPeriod();
  await ensureRoomReleasesTable();
  const res = await query(`
    SELECT ms.faculty_id, ms.id, c.subject_code, c.subject_name, p.code AS program_code,
           b.year_level, b.block_name,
           ss.start_time::text AS start_time, ss.end_time::text AS end_time,
           COALESCE(sr.room_name, r.room_name) AS room_name,
           COALESCE(ss.type, 'lec') AS part
    FROM   master_schedule ms
    JOIN   block_subjects bs ON ms.block_subject_id = bs.id
    JOIN   curriculums     c  ON bs.curriculum_id    = c.id
    JOIN   blocks          b  ON bs.block_id         = b.id
    LEFT JOIN programs     p  ON b.program_id        = p.id
    LEFT JOIN rooms        r  ON ms.room_id          = r.id
    JOIN   schedule_sessions ss ON ss.master_schedule_id = ms.id
    LEFT JOIN rooms        sr ON ss.room_id          = sr.id
    WHERE  ms.faculty_id = ANY($1::int[])
      AND  ms.status IN ('Assigned', 'Scheduled')
      AND  ss.day_of_week = $2
      AND  ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
      AND  ($3 = '' OR b.academic_year = $3)
      AND  ($4 = '' OR b.semester      = $4)
      AND  NOT ${releasedOnSql('ss', 'ms', '$5::date')}
    ORDER  BY ss.start_time
  `, [ids, dayOfWeek, period.schoolYear ?? '', period.semester ?? '', manilaCalendarDateString()]);
  return res.rows as TodaySession[];
}

/** Insert unless the same reminder was already made today (Manila); true when added */
async function addOnce(
  facultyId: number, type: 'class_today' | 'class_starting', module: string, relatedId: number,
  title: string, message: string,
): Promise<boolean> {
  const res = await query(`
    INSERT INTO notifications (recipient_id, recipient_role, title, message, type, related_module, related_id)
    SELECT $1::int, 'instructor', $2::varchar, $3::text, $4::varchar, $5::varchar, $6::int
    WHERE NOT EXISTS (
      SELECT 1 FROM notifications
      WHERE recipient_role = 'instructor' AND recipient_id = $1::int
        AND type = $4::varchar AND related_module = $5::varchar AND related_id = $6::int
        AND created_at >= ${START_OF_TODAY}
    )
  `, [facultyId, title, message, type, module, relatedId]);
  return (res.rowCount ?? 0) > 0;
}

export async function syncClassReminders(facultyId: number): Promise<void> {
  if (!Number.isInteger(facultyId) || facultyId <= 0) return;
  const nowMs = Date.now();
  if (nowMs - (lastCheck.get(facultyId) ?? 0) < CHECK_EVERY_MS) return;
  if (lastCheck.size > 2000) lastCheck.clear();
  lastCheck.set(facultyId, nowMs);

  try {
    const { time } = manilaClock();
    const nowMin = toMin(time);
    if (nowMin < DAY_START_MIN) return;
    await ensureNotificationsTable();

    // Today's classes in the active term (shared with the device reminders)
    const rows = await todaysClassSessions([facultyId]);

    // One entry per meeting (a class can meet twice a day, e.g. Lec + Lab)
    const seen = new Set<string>();
    const classes = rows.filter(c => {
      const k = `${c.id}|${c.start_time}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const ahead = classes.filter(c => toMin(c.end_time) > nowMin);

    // Reminders are for today only: earlier days' leave the inbox, a class that
    // is over no longer needs its reminder, and the day's summary is done once
    // no class is left
    let changed = 0;
    const gone = await query(`
      DELETE FROM notifications
      WHERE  recipient_role = 'instructor' AND recipient_id = $1
        AND  type IN ('class_today', 'class_starting')
        AND  created_at < ${START_OF_TODAY}
    `, [facultyId]);
    changed += gone.rowCount ?? 0;
    const over = classes.filter(c => toMin(c.end_time) <= nowMin);
    if (over.length > 0) {
      const done = await query(`
        UPDATE notifications SET is_read = TRUE
        WHERE  recipient_role = 'instructor' AND recipient_id = $1
          AND  type = 'class_starting' AND is_read = FALSE
          AND  created_at >= ${START_OF_TODAY}
          AND  (related_module, related_id) IN (SELECT unnest($2::text[]), unnest($3::int[]))
      `, [facultyId, over.map(c => `class@${c.start_time.slice(0, 5)}`), over.map(c => Number(c.id))]);
      changed += done.rowCount ?? 0;
    }
    if (ahead.length === 0) {
      const dayDone = await query(`
        UPDATE notifications SET is_read = TRUE
        WHERE  recipient_role = 'instructor' AND recipient_id = $1
          AND  type = 'class_today' AND is_read = FALSE
          AND  created_at >= ${START_OF_TODAY}
      `, [facultyId]);
      changed += dayDone.rowCount ?? 0;
      if (changed > 0) bumpNotifications('instructor', facultyId);
      return;
    }

    const label = (c: (typeof classes)[number]) => {
      const year = String(c.year_level ?? '').match(/\d+/)?.[0] ?? '';
      const block = `${year}${c.block_name ?? ''}`;
      return block ? `${c.subject_code} (${block})` : c.subject_code;
    };
    const where = (c: (typeof classes)[number]) => (c.room_name ? ` in ${c.room_name}` : '');

    let added = changed > 0;

    // The day's summary — once a day
    const next = ahead[0];
    const dateKey = Number(manilaCalendarDateString().replace(/-/g, '')); // 20261007
    added = (await addOnce(
      facultyId, 'class_today', 'class_day', dateKey,
      ahead.length === 1 ? 'You have a class today' : `You have ${ahead.length} classes today`,
      `Next: ${label(next)} at ${clock12(toMin(next.start_time))}${where(next)}.`,
    )) || added;

    // Starting soon / in session — skipped once the faculty has checked in today
    const soon = ahead.filter(c => nowMin >= toMin(c.start_time) - LEAD_MIN);
    if (soon.length > 0) {
      const checkedIn = new Set<number>();
      try {
        const scans = await query(`
          SELECT DISTINCT master_schedule_id FROM qr_scan_logs
          WHERE faculty_id = $1 AND scan_date = $2 AND master_schedule_id IS NOT NULL
            AND status NOT IN ('Blocked', 'Unauthorized', 'Overuse')
        `, [facultyId, manilaCalendarDateString()]);
        for (const s of scans.rows as { master_schedule_id: number }[]) checkedIn.add(Number(s.master_schedule_id));
      } catch { /* no scan log yet */ }

      // Checked in already: that class's reminder is done
      if (checkedIn.size > 0) {
        const scanned = await query(`
          UPDATE notifications SET is_read = TRUE
          WHERE  recipient_role = 'instructor' AND recipient_id = $1
            AND  type = 'class_starting' AND is_read = FALSE
            AND  created_at >= ${START_OF_TODAY}
            AND  related_id = ANY($2::int[])
        `, [facultyId, [...checkedIn]]);
        if ((scanned.rowCount ?? 0) > 0) added = true;
      }

      for (const c of soon) {
        if (checkedIn.has(Number(c.id))) continue;
        const start = toMin(c.start_time);
        const started = nowMin >= start;
        added = (await addOnce(
          facultyId, 'class_starting', `class@${c.start_time.slice(0, 5)}`, Number(c.id),
          started ? 'Your class is in session' : 'Your class starts soon',
          `${label(c)} ${started ? 'started' : 'starts'} at ${clock12(start)}${where(c)}. Scan the room QR when you arrive.`,
        )) || added;
      }
    }

    if (added) bumpNotifications('instructor', facultyId);
  } catch (error) {
    console.error('[classReminders]', error);
  }
}
