import { query } from '@/database/db';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { manilaCalendarDateString, manilaClock } from '@/services/appTimezone';
import { expireStaleOccupancy } from '@/services/ensureRoomOccupancy';
import { bumpTopics } from '@/services/realtime';
import { minuteOfDay, roomTimeMarks } from '@/services/roomTimeMarks';

/**
 * Room clock — live updates for what changes with time, not with a save: a class's 15
 * early minutes, a class not scanned within 15 minutes (its room freed), a freed time
 * opening, the last 30 minutes of free time, a class ending and its after-class hold, a
 * reservation's hold (services/roomTimeMarks.ts). Once a minute while the server is awake
 * it ends what has run out (expireStaleOccupancy announces those changes itself) and, on
 * a minute when one of today's class or reservation times reaches such a point, announces
 * 'occupancy' — every open room page then re-reads within seconds. Pages keep their own
 * slower timers for when the server sleeps. ROOM_CLOCK_TIMER=off turns it off.
 */

const TIMER_KEY = '__qrganizeRoomClockTimer';

/** One minute's check. Exported for tests; never throws. */
export async function roomClockTick(): Promise<{ marked: boolean }> {
  try {
    await expireStaleOccupancy();
    const { time, dayOfWeek } = manilaClock();
    const today = manilaCalendarDateString();
    const period = await getActiveAcademicPeriod();
    const res = await query(`
      SELECT to_char(ss.start_time, 'HH24:MI') AS start, to_char(ss.end_time, 'HH24:MI') AS end
      FROM   schedule_sessions ss
      JOIN   master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN   block_subjects  bs ON bs.id = ms.block_subject_id
      JOIN   blocks           b ON b.id  = bs.block_id
      WHERE  ss.day_of_week = $1
        AND  ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
        AND  ms.status IN ('Assigned', 'Scheduled')
        AND  ($2 = '' OR b.academic_year = $2)
        AND  ($3 = '' OR b.semester      = $3)
      UNION
      SELECT to_char(use_start, 'HH24:MI'), to_char(use_end, 'HH24:MI')
      FROM   room_change_requests
      WHERE  use_date = $4::date AND use_start IS NOT NULL AND use_end IS NOT NULL
    `, [dayOfWeek, period.schoolYear ?? '', period.semester ?? '', today]);
    const marked = roomTimeMarks(res.rows as { start: string; end: string }[]).has(minuteOfDay(time));
    if (marked) bumpTopics(['occupancy']);
    return { marked };
  } catch (err) {
    console.warn('[roomClock]', (err as Error).message);
    return { marked: false };
  }
}

/** Starts the minute check, a couple of seconds after each minute turns (so a mark is announced on time) */
export function startRoomClock(): void {
  if (process.env.ROOM_CLOCK_TIMER === 'off') return;
  const g = globalThis as typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };
  if (g[TIMER_KEY]) return;
  const tick = () => { void roomClockTick(); };
  const now = new Date();
  const toNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 2_000;
  const first = setTimeout(() => {
    tick();
    g[TIMER_KEY] = setInterval(tick, 60_000);
    g[TIMER_KEY].unref?.();
  }, toNextMinute);
  first.unref?.();
  // Marks the timer as started straight away, so a second start (dev reload) doesn't add another
  g[TIMER_KEY] = first as unknown as ReturnType<typeof setInterval>;
}
