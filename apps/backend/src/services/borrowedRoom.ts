import { isLabRoomType } from '@shared/roomPlanning';
import { PATHFIT_VENUE_RULE, pathfitRoomAllowed } from '@shared/pathfitVenue';
import { time12 } from '@shared/roomRequestWindow';

/**
 * Using a room that isn't your class's own — a room freed today (Free My Room, or no
 * QR scan within 15 minutes of the start), or an empty lecture room — by QR scan or
 * a today-only room request (rules the user set on 2026-10-13):
 *
 *  • Only a class with NO room for that subject and time may use it (a faculty with a
 *    room for another subject at another time still may). A class that has its own
 *    room uses that room.
 *  • The room must suit the class (the same rules as Class Assignment / room requests).
 *  • The class must END by the time the room is free until — it may have started
 *    before the room was freed (only the rest of the time is used), but it can never
 *    run past it: the room's next class or reservation is never delayed, and the scan
 *    time never moves or stretches anyone's schedule.
 *  • A freed class time is free only from its own start (never the 15 minutes before),
 *    and the room can't be taken with 30 minutes or less of its free time left.
 */

/** Minutes of free time that must be left to take a room: more than this */
export const BORROW_MIN_LEFT = 30;

export interface BorrowClass {
  /** The class meeting: its Lecture ('lec') or Laboratory ('lab') */
  part: 'lec' | 'lab';
  subject_code: string;
  lecture_hours: number;
  laboratory_hours: number;
  /** Major subject with Lecture + Laboratory: both in one laboratory */
  one_room: boolean;
}

/** Why this class can't use this kind of room — or null when it can */
export function borrowRoomFitError(c: BorrowClass, room: { room_name: string | null; room_type: string | null }): string | null {
  if (!pathfitRoomAllowed(c.subject_code, room.room_name)) return PATHFIT_VENUE_RULE;
  if (isLabRoomType(room.room_type)) {
    if (c.part === 'lab' || c.laboratory_hours > 0) return null;
    return `${c.subject_code} is a lecture subject, so it can only use a lecture room.`;
  }
  if (c.part === 'lab') return `${c.subject_code}'s Laboratory needs a laboratory room.`;
  if (c.one_room) return `${c.subject_code} is a Major subject, so its Lecture and Laboratory stay in one laboratory room.`;
  return null;
}

const toMin = (t: string) => {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** The class ends by the time the room is free until (null = free for the rest of the day) */
export function fitsFreeTime(classEnd: string, freeUntil: string | null): boolean {
  return freeUntil == null || toMin(classEnd) <= toMin(freeUntil);
}

/** The refusal when it doesn't: "IT 214 runs until 1:00 PM, but Room 3 is free only until 12:00 PM today." */
export function notEnoughTimeMessage(subjectCode: string, classEnd: string, roomName: string, freeUntil: string): string {
  return `${subjectCode} runs until ${time12(classEnd)}, but ${roomName} is free only until ${time12(freeUntil)} today. `
    + 'Your whole class must fit in that time.';
}

/** Whole minutes from `now` to `until` ('HH:MM[:SS]'); negative once it has passed */
export function minutesLeft(now: string, until: string): number {
  return toMin(until) - toMin(now);
}

/** "Lecture-3 is free only until 12:00 PM — 25 minutes are left …" */
export function tooLateMessage(roomName: string, now: string, freeUntil: string): string {
  const left = Math.max(0, minutesLeft(now, freeUntil));
  return `${roomName} is free only until ${time12(freeUntil)} — ${left} minute${left === 1 ? ' is' : 's are'} left. `
    + `A room can be taken only while more than ${BORROW_MIN_LEFT} minutes of its free time remain.`;
}

/**
 * Until when a room is free right now from its freed class times (each from its OWN start —
 * never earlier — to its end; back to back ones count as one), or null when none is on now.
 */
export function freedTimeUntil(freed: { start_time: string; end_time: string }[], now: string): string | null {
  const sorted = [...freed].sort((a, b) => toMin(a.start_time) - toMin(b.start_time));
  const cur = sorted.find(f => toMin(f.start_time) <= toMin(now) && toMin(now) < toMin(f.end_time));
  if (!cur) return null;
  let until = cur.end_time;
  for (const f of sorted) {
    if (toMin(f.start_time) <= toMin(until) && toMin(f.end_time) > toMin(until)) until = f.end_time;
  }
  return until;
}

/** The earlier of two 'HH:MM[:SS]' times (null = no limit) */
export function earlierTime(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return toMin(a) <= toMin(b) ? a : b;
}
