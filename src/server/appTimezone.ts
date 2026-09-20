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
