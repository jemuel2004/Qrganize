import { manilaCalendarDateString } from '@/services/appTimezone';
import { daysBetween } from '@/services/roomReleases';

/* A room's freed time — for the "Free My Room" notices (services/roomFreedNotice.ts). Pure, no database. */

export interface FreedTime {
  room: { id: number; room_name: string; room_type: string | null };
  /** 'YYYY-MM-DD' (Manila) and its weekday */
  date: string;
  weekday: string;
  /** 'HH:MM' — the time others may use the room */
  start: string;
  end: string;
}

/** "today (Oct 13)", "tomorrow (Oct 14)", "Monday, Oct 20" */
export function freedDayPhrase(date: string, today = manilaCalendarDateString()): string {
  const [y, m, d] = date.split('-').map(Number);
  const short = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const ahead = daysBetween(today, date);
  if (ahead === 0) return `today (${short})`;
  if (ahead === 1) return `tomorrow (${short})`;
  const weekday = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });
  return `${weekday}, ${short}`;
}

/** Merges one room's freed class times that touch or overlap ("10:00–11:00" + "11:00–12:00" → "10:00–12:00") */
export function mergeFreedTimes<T extends FreedTime>(times: T[]): T[] {
  const sorted = [...times].sort((a, b) => a.room.id - b.room.id || a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const out: T[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && last.room.id === t.room.id && last.date === t.date && t.start <= last.end) {
      if (t.end > last.end) last.end = t.end;
    } else out.push({ ...t });
  }
  return out;
}
