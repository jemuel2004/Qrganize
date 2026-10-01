/** Application calendar timezone (Philippines, no DST). */
export const APP_TIMEZONE = 'Asia/Manila';

export interface CalendarDayRange {
  /** Inclusive start of the calendar day (UTC instant). */
  start: Date;
  /** Exclusive start of the next calendar day (UTC instant). */
  end: Date;
  /** Calendar date in Asia/Manila, YYYY-MM-DD. */
  date: string;
}

/** Today's Asia/Manila calendar date as YYYY-MM-DD. */
export function manilaCalendarDateString(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Current Manila wall-clock time ("HH:MM:SS") and weekday ("Monday"), whatever the server's timezone. */
export function manilaClock(now = new Date()): { time: string; dayOfWeek: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  return { time: `${get('hour')}:${get('minute')}:${get('second')}`, dayOfWeek: get('weekday') };
}

/** SQL timestamptz for "today (Manila) at <timeSql>" — CURRENT_DATE would use the DB session's timezone. */
export function manilaTodayAtSql(timeSql: string): string {
  return `(((NOW() AT TIME ZONE '${APP_TIMEZONE}')::date + ${timeSql}) AT TIME ZONE '${APP_TIMEZONE}')`;
}

/**
 * Half-open [start, end) range for a Manila calendar day.
 * Use with: timestamp >= start AND timestamp < end
 */
export function manilaCalendarDayRange(now = new Date()): CalendarDayRange {
  const date = manilaCalendarDateString(now);
  const start = new Date(`${date}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, date };
}
