import { query } from '@/database/db';
import { ensurePushTables } from '@/database/pushSchema';
import { manilaCalendarDateString, manilaClock } from '@/services/appTimezone';
import { todaysClassSessions } from '@/services/classReminders';
import { pushTopic, sendPush } from '@/services/webPush';
import { dueClassReminders, reminderText, type DueReminder } from '@shared/classReminderTiming';

/*
 * Class reminders on faculty devices (Web Push), like a calendar's: each
 * faculty member who turned them on (Settings → Class Reminders) gets one push
 * on each of their devices for every class time today, 30 / 15 / 5 minutes
 * before it starts — their own classes only, in the active term, not once the
 * class has started, nor when they made the room available (away that day) or
 * already checked in. The bell keeps its own reminders; nothing pops up in the
 * app.
 *
 * It runs every minute while the server is awake (instrumentation.ts) and on
 * each call of /api/cron/class-reminders (an outside scheduler can wake a
 * sleeping server). A device's reminder is claimed in class_reminder_deliveries
 * before it is sent, so retries, restarts or two servers never send it twice; a
 * send that fails for a passing reason is released and tried again on the next
 * run, until the class starts. Errors stay here — the scanner and the schedule
 * never wait on this.
 */

export interface PushRunResult {
  /** Reminders claimed for sending this run */
  due: number;
  sent: number;
  /** Will be tried again on the next run */
  failed: number;
  /** Devices that were no longer subscribed (forgotten) */
  removed: number;
}

/** Where tapping a class reminder goes */
const REMINDER_URL = '/instructor/schedule';
const ICON = '/icons/icon-192.png';

let running: Promise<PushRunResult> | null = null;

/** Send the reminders that are due now (one run at a time per server). */
export function runClassPushReminders(): Promise<PushRunResult> {
  if (!running) running = sendDueReminders().finally(() => { running = null; });
  return running;
}

const toSeconds = (hhmmss: string) => {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
};

/** The block as faculty read it: "BSIT 2A" */
function blockLabel(programCode: string | null, yearLevel: string | null, blockName: string | null): string {
  const year = String(yearLevel ?? '').match(/\d+/)?.[0] ?? '';
  return [programCode, `${year}${blockName ?? ''}`].filter(Boolean).join(' ');
}

/** What the device gets — the service worker writes the notification from it */
function reminderPayload(r: DueReminder, startsAtMs: number) {
  const text = reminderText(r, r.minutesLeft);
  return {
    v: 1,
    kind: 'class',
    title: text.title,
    body: text.body,
    subject: r.subjectName.trim() || r.subjectCode,
    room: r.room,
    block: r.block,
    start: r.start,
    end: r.end,
    startsAt: startsAtMs,
    url: REMINDER_URL,
    tag: `class-${r.key}`,
    icon: ICON,
  };
}

async function sendDueReminders(): Promise<PushRunResult> {
  const result: PushRunResult = { due: 0, sent: 0, failed: 0, removed: 0 };
  await ensurePushTables();

  // Faculty with reminders on and at least one device
  const settings = await query(`
    SELECT s.faculty_id, s.lead_minutes
    FROM   class_reminder_settings s
    WHERE  s.enabled
      AND  EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.faculty_id = s.faculty_id)
  `);
  if (settings.rows.length > 0) {
    const leadByFaculty = new Map<number, number>(
      (settings.rows as { faculty_id: number; lead_minutes: number }[]).map(r => [Number(r.faculty_id), Number(r.lead_minutes)]),
    );
    const facultyIds = [...leadByFaculty.keys()];
    const now = new Date();
    const { time } = manilaClock(now);
    const date = manilaCalendarDateString(now);
    const nowSec = toSeconds(time);

    const sessions = await todaysClassSessions(facultyIds);
    // Checked in already (scanned the room QR for that class today): no reminder
    const checkedIn = new Set<string>();
    const scans = await query(`
      SELECT DISTINCT faculty_id, master_schedule_id FROM qr_scan_logs
      WHERE  faculty_id = ANY($1::int[]) AND scan_date = $2 AND master_schedule_id IS NOT NULL
        AND  status NOT IN ('Blocked', 'Unauthorized', 'Overuse')
    `, [facultyIds, date]).catch(() => ({ rows: [] as { faculty_id: number; master_schedule_id: number }[] }));
    for (const s of scans.rows as { faculty_id: number; master_schedule_id: number }[]) {
      checkedIn.add(`${Number(s.faculty_id)}|${Number(s.master_schedule_id)}`);
    }

    const due = dueClassReminders(
      sessions.map(s => ({
        facultyId: Number(s.faculty_id),
        classId: Number(s.id),
        subjectCode: s.subject_code,
        subjectName: s.subject_name ?? '',
        block: blockLabel(s.program_code, s.year_level, s.block_name),
        room: s.room_name,
        part: s.part === 'lab' ? 'lab' : 'lec',
        start: s.start_time,
        end: s.end_time,
      })),
      leadByFaculty,
      Math.floor(nowSec / 60),
      date,
      checkedIn,
    );

    if (due.length > 0) {
      // Each faculty member's own devices only
      const subs = (await query(`
        SELECT id, faculty_id, endpoint, p256dh, auth FROM push_subscriptions WHERE faculty_id = ANY($1::int[])
      `, [[...new Set(due.map(d => d.facultyId))]])).rows as
        { id: number; faculty_id: number; endpoint: string; p256dh: string; auth: string }[];

      for (const r of due) {
        const startSec = toSeconds(`${r.start}:00`);
        const ttl = Math.max(30, startSec - nowSec);
        const payload = reminderPayload(r, now.getTime() + (startSec - nowSec) * 1000);
        for (const sub of subs.filter(s => Number(s.faculty_id) === r.facultyId)) {
          // Claim first: whoever inserts the row sends it, nobody else
          const claim = await query(`
            INSERT INTO class_reminder_deliveries (subscription_id, reminder_key)
            VALUES ($1, $2)
            ON CONFLICT (subscription_id, reminder_key) DO NOTHING
            RETURNING id
          `, [sub.id, r.key]);
          const claimId = (claim.rows[0] as { id: number } | undefined)?.id;
          if (!claimId) continue;
          result.due++;

          const outcome = await sendPush(sub, payload, { ttlSeconds: ttl, topic: pushTopic(r.key) });
          if (outcome === 'sent') {
            result.sent++;
            await query(`UPDATE class_reminder_deliveries SET status = 'sent' WHERE id = $1`, [claimId]);
            await query(`UPDATE push_subscriptions SET last_sent_at = NOW() WHERE id = $1`, [sub.id]);
          } else if (outcome === 'gone') {
            result.removed++;
            await query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
          } else {
            result.failed++;
            await query(`DELETE FROM class_reminder_deliveries WHERE id = $1`, [claimId]);
          }
        }
      }
    }
  }

  // Sent reminders are only needed for the day
  await query(`DELETE FROM class_reminder_deliveries WHERE created_at < NOW() - INTERVAL '3 days'`);
  return result;
}

const TIMER_KEY = '__qrganizeClassPushTimer';

/**
 * Check every minute while the server is awake. CLASS_PUSH_TIMER=off turns it
 * off (e.g. a test copy of the database); the cron route still works.
 */
export function startClassPushTimer(): void {
  if (process.env.CLASS_PUSH_TIMER === 'off') return;
  const g = globalThis as typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };
  if (g[TIMER_KEY]) return;
  const tick = () => {
    runClassPushReminders()
      .then(r => { if (r.due > 0) console.log(`[classPush] sent ${r.sent} of ${r.due} class reminder(s)`); })
      .catch(err => console.warn('[classPush]', (err as Error).message));
  };
  g[TIMER_KEY] = setInterval(tick, 60_000);
  g[TIMER_KEY].unref?.();
  setTimeout(tick, 20_000).unref?.();
}
