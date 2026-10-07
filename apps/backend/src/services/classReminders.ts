import { query } from '@/database/db';
import { ensureNotificationsTable } from '@/database/notificationsSchema';
import { manilaCalendarDateString, manilaClock } from '@/services/appTimezone';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { bumpNotifications } from '@/services/realtime';

/*
 * Class reminders for faculty. They are made when the faculty's inbox is read
 * (the bell checks about every minute while QRganize is open), so no
 * scheduler is needed:
 *   • class_today    — once a day, while classes are still ahead: how many
 *                      and which one is next.
 *   • class_starting — from 15 minutes before a class until it ends, unless
 *                      the faculty already checked in (scanned the room QR).
 * Each is made once per class per day; the bell keeps them and the faculty
 * pages pop them up.
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
        AND created_at >= ((NOW() AT TIME ZONE 'Asia/Manila')::date AT TIME ZONE 'Asia/Manila')
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
    const { time, dayOfWeek } = manilaClock();
    const nowMin = toMin(time);
    if (nowMin < DAY_START_MIN) return;
    await ensureNotificationsTable();

    // Today's classes in the active term — the same rows as the faculty dashboard
    const period = await getActiveAcademicPeriod();
    const res = await query(`
      SELECT ms.id, c.subject_code, b.year_level, b.block_name,
             ss.start_time::text AS start_time, ss.end_time::text AS end_time,
             COALESCE(sr.room_name, r.room_name) AS room_name
      FROM   master_schedule ms
      JOIN   block_subjects bs ON ms.block_subject_id = bs.id
      JOIN   curriculums     c  ON bs.curriculum_id    = c.id
      JOIN   blocks          b  ON bs.block_id         = b.id
      LEFT JOIN rooms        r  ON ms.room_id          = r.id
      JOIN   schedule_sessions ss ON ss.master_schedule_id = ms.id
      LEFT JOIN rooms        sr ON ss.room_id          = sr.id
      WHERE  ms.faculty_id = $1
        AND  ms.status IN ('Assigned', 'Scheduled')
        AND  ss.day_of_week = $2
        AND  ($3 = '' OR b.academic_year = $3)
        AND  ($4 = '' OR b.semester      = $4)
      ORDER  BY ss.start_time
    `, [facultyId, dayOfWeek, period.schoolYear ?? '', period.semester ?? '']);

    // One entry per meeting (a class can meet twice a day, e.g. Lec + Lab)
    const seen = new Set<string>();
    const classes = (res.rows as {
      id: number; subject_code: string; year_level: string | null; block_name: string | null;
      start_time: string; end_time: string; room_name: string | null;
    }[]).filter(c => {
      const k = `${c.id}|${c.start_time}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const ahead = classes.filter(c => toMin(c.end_time) > nowMin);
    if (ahead.length === 0) return;

    const label = (c: (typeof classes)[number]) => {
      const year = String(c.year_level ?? '').match(/\d+/)?.[0] ?? '';
      const block = `${year}${c.block_name ?? ''}`;
      return block ? `${c.subject_code} (${block})` : c.subject_code;
    };
    const where = (c: (typeof classes)[number]) => (c.room_name ? ` in ${c.room_name}` : '');

    let added = false;

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
