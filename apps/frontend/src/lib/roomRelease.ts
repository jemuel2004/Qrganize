/**
 * "Make Classroom Available" — a faculty member frees the room of their own
 * class for one date (API: /api/instructor/room-releases). Shared by My
 * Schedule, its dialog and Find Available Rooms.
 */

/** upcoming = released for that date · reserved = another faculty asked for the room then (room request) ·
 *  open = the class time is on and the room is free for others · in-use = another faculty took it */
export type ReleaseState = 'upcoming' | 'reserved' | 'open' | 'in-use';

export interface RoomRelease {
  id: number;
  date: string;
  reason: string | null;
  session_id: number;
  master_schedule_id: number;
  day: string;
  start_time: string;
  end_time: string;
  room_name: string | null;
  room_type: string | null;
  subject_code: string;
  subject_name: string;
  block_name: string | null;
  year_level: string | null;
  program_code: string | null;
  taken_by: string | null;
  /** Another faculty's room request for that time — the room can't be taken back then */
  reserved_by: string | null;
  state: ReleaseState;
}

/** One of the faculty's own classes on the picked date */
export interface ReleaseSession {
  session_id: number;
  master_schedule_id: number;
  start_time: string;
  end_time: string;
  session_type: string;
  room_id: number;
  room_name: string;
  room_type: string;
  subject_code: string;
  subject_name: string;
  block_name: string | null;
  year_level: string | null;
  program_code: string | null;
  released: boolean;
  /** The release record when `released` (for Take back) */
  release_id: number | null;
  /** Another faculty's room request for the freed time — no Take back then */
  reserved_by: string | null;
  ended: boolean;
}

/** A weekday the faculty teaches with a classroom, and when its last class ends */
export interface ClassDay {
  day: string;
  last_end: string;
}

/** A room another faculty made available on a date (Find Available Rooms) */
export interface ReleasedRoom {
  room_id: number;
  room_name: string;
  room_type: string;
  capacity: number | null;
  building: string | null;
  date: string;
  start_time: string;
  end_time: string;
  reason: string | null;
  released_by: string | null;
}

/** 'YYYY-MM-DD' + n days (calendar dates, no time zone) */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → weekday name ("Monday") */
export function weekdayOf(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' });
}

/** 'YYYY-MM-DD' → "Thu, Oct 15, 2026" (or the long form "Thursday, October 15, 2026") */
export function releaseDateLabel(date: string, long = false): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-US', long
    ? { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
    : { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** Status chip of a release — one colour each (palette: blue / green / amber) */
export const RELEASE_STATE: Record<ReleaseState, { label: string; cls: string }> = {
  upcoming: { label: 'Released for this date', cls: 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]' },
  reserved: { label: 'Reserved by another faculty', cls: 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]' },
  open: { label: 'Available to others', cls: 'bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]' },
  'in-use': { label: 'In use by another faculty', cls: 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]' },
};
