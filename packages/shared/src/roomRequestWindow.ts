import { minutesHHMM, minutesLabel } from './schoolDay';

/**
 * Room requests are for today only: a request holds a room for ONE class time
 * of the faculty's own class today — never for the whole semester, and the
 * class's regular schedule never changes.
 *
 * A class's sessions today form its class times: a session that starts when
 * (or before) the one before it ends joins it, so a Major subject's Lecture
 * followed by its Laboratory is one class time in one room, confirmed with one
 * QR scan. A lecture room only takes the Lecture sessions; a laboratory room
 * takes any (the Scheduling rule). Shared by the request form (which rooms are
 * free) and the server (what is held), so both use the same time.
 */

export type ClassPart = 'lec' | 'lab';
export type RoomGroup = 'lec' | 'lab';

/** One of the class's sessions today ("HH:MM" or "HH:MM:SS" times) */
export interface PartSession {
  part: ClassPart;
  start: string;
  end: string;
}

export interface ClassTime<T extends PartSession = PartSession> {
  /** "HH:MM" */
  start: string;
  end: string;
  /** Lecture first */
  parts: ClassPart[];
  sessions: T[];
}

/** The room is held from 15 minutes before the class time… */
export const HOLD_BEFORE_MIN = 15;
/** …and its QR code is scanned by 15 minutes after the class starts, or the hold ends.
 *  A scheduled class has the same 15 minutes: with no check-in by then its room is
 *  free to anyone for the rest of the class time (backend services/roomReleases.ts) */
export const SCAN_WITHIN_MIN = 15;

/** "13:30" / "13:30:00" → 810 */
export function timeMinutes(t: string): number {
  const [h, m] = String(t).split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/** "13:30" moved by `min` minutes, never before midnight */
export function shiftTime(t: string, min: number): string {
  return minutesHHMM(Math.max(0, timeMinutes(t) + min));
}

/** The class times of a class's sessions today, in time order */
export function classTimes<T extends PartSession>(sessions: T[]): ClassTime<T>[] {
  const sorted = [...sessions].sort((a, b) =>
    timeMinutes(a.start) - timeMinutes(b.start) || timeMinutes(a.end) - timeMinutes(b.end));
  const out: ClassTime<T>[] = [];
  for (const s of sorted) {
    const start = minutesHHMM(timeMinutes(s.start));
    const end = minutesHHMM(timeMinutes(s.end));
    const last = out[out.length - 1];
    if (last && timeMinutes(start) <= timeMinutes(last.end)) {
      if (timeMinutes(end) > timeMinutes(last.end)) last.end = end;
      if (!last.parts.includes(s.part)) last.parts.push(s.part);
      last.sessions.push(s);
    } else {
      out.push({ start, end, parts: [s.part], sessions: [s] });
    }
  }
  for (const t of out) t.parts.sort((a, b) => (a === b ? 0 : a === 'lec' ? -1 : 1));
  return out;
}

/**
 * What a request for the class time starting at `start` holds in a room of
 * `group`: the whole class time in a laboratory room, only its Lecture part in
 * a lecture room. Null when there is no such class time, or the room can take
 * none of it (a Laboratory never goes into a lecture room).
 */
export function requestWindow<T extends PartSession>(sessions: T[], start: string, group: RoomGroup): ClassTime<T> | null {
  const at = minutesHHMM(timeMinutes(start));
  const picked = classTimes(sessions).find(t => t.start === at);
  if (!picked) return null;
  if (group === 'lab') return picked;
  return classTimes(picked.sessions.filter(s => s.part === 'lec'))[0] ?? null;
}

/** "13:00" → "1:00 PM" */
export function time12(t: string): string {
  return minutesLabel(timeMinutes(t));
}

/** "1:00 PM – 2:30 PM" — AM/PM on both ends, as everywhere else */
export function timeRange12(start: string, end: string): string {
  return `${time12(start)} – ${time12(end)}`;
}
