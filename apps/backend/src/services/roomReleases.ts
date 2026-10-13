import { APP_TIMEZONE, manilaDateAtSql } from '@/services/appTimezone';
import { holdEndSql } from '@/services/occupancyHold';
import { SCAN_WITHIN_MIN } from '@shared/roomRequestWindow';

export { ensureRoomReleasesTable } from '@/database/roomReleasesSchema';

/**
 * Faculty-controlled classroom availability ("Make Classroom Available").
 *
 * A faculty member frees the room of one of their own class sessions for ONE
 * calendar date (official travel, a university meeting…). Nothing about the
 * class changes: the session keeps its room, day and time, and the next week
 * everything is as before. A release only tells the date-based checks — QR
 * check-in, Find Available Rooms, the room page, today's lists and class
 * reminders — that this session does not use its room on that date.
 * Room requests are for today only, so a room freed for today can be asked
 * for by another faculty (and is then no longer taken back).
 *
 * A class nobody checked in for frees its room the same way, by itself: with
 * no QR check-in 15 minutes after the start, the room is open to anyone for the
 * rest of that class time today (unclaimedNowSql). Its own faculty can still
 * check in late while nobody else has taken the room.
 *
 * Weekly scheduling ignores both on purpose: it sets a room for every week,
 * and one day's free room must never turn into that.
 */

export const ROOM_RELEASE_REASONS = [
  'Official University Meeting',
  'Official Travel',
  'University Event',
  'Other Official Activity',
] as const;

/** How far ahead a classroom can be made available */
export const ROOM_RELEASE_MAX_DAYS_AHEAD = 180;

/**
 * SQL condition: session `ss` (of class `ms`) has its room released on the date
 * `dateSql` (a DATE expression or parameter). A release only counts while the
 * class still belongs to the faculty who made it — reassigning the class to
 * someone else drops it.
 */
export function releasedOnSql(ss: string, ms: string, dateSql: string): string {
  return `EXISTS (
    SELECT 1 FROM room_releases rr
    WHERE rr.session_id = ${ss}.id
      AND rr.release_date = ${dateSql}
      AND rr.faculty_id = ${ms}.faculty_id
  )`;
}

/** SQL: today's date in Manila */
const TODAY_SQL = `(NOW() AT TIME ZONE '${APP_TIMEZONE}')::date`;

/**
 * SQL condition: occupancy `ro` — the class's faculty in the class's room — covers
 * session `ss` on the Manila date `dateSql`: they were in the room for it, checked in
 * from 15 minutes before the start, or still there from an earlier class or walk-in
 * when it started (a Lecture followed by its Laboratory needs one scan).
 */
export function occupancyCoversSql(ro: string, ss: string, dateSql: string): string {
  return `(${ro}.occupied_at IS NOT NULL
    AND ${ro}.occupied_at < ${manilaDateAtSql(dateSql, `${ss}.end_time`)}
    AND LEAST(${ro}.released_at, ${holdEndSql(ro)})
          > ${manilaDateAtSql(dateSql, `${ss}.start_time`)} - INTERVAL '${SCAN_WITHIN_MIN} minutes')`;
}

/**
 * SQL condition: session `ss` (of class `ms`, meeting in room `room`) is unclaimed
 * right now — it meets today, started more than 15 minutes ago, hasn't ended, and its
 * faculty hasn't checked into the room for it. The room is then free to anyone for
 * the rest of the class time, as if released for today.
 */
export function unclaimedNowSql(ss: string, ms: string, room = `${ss}.room_id`): string {
  return `(${room} IS NOT NULL
    AND ${ss}.day_of_week = to_char(NOW() AT TIME ZONE '${APP_TIMEZONE}', 'FMDay')
    AND NOW() >= ${manilaDateAtSql(TODAY_SQL, `${ss}.start_time`)} + INTERVAL '${SCAN_WITHIN_MIN} minutes'
    AND NOW() <  ${manilaDateAtSql(TODAY_SQL, `${ss}.end_time`)}
    AND NOT EXISTS (
      SELECT 1 FROM room_occupancy ro_cover
      WHERE  ro_cover.room_id    = ${room}
        AND  ro_cover.faculty_id = ${ms}.faculty_id
        AND  ${occupancyCoversSql('ro_cover', ss, TODAY_SQL)}
    ))`;
}

/**
 * SQL condition: session `ss` doesn't hold its room on the date `dateSql` — its
 * faculty released it for that date, or (today) nobody checked in for it in time.
 * A NULL date (a weekly search) is neither.
 */
export function freedOnSql(ss: string, ms: string, dateSql: string, room = `${ss}.room_id`): string {
  return `(${releasedOnSql(ss, ms, dateSql)}
    OR (${dateSql} IS NOT DISTINCT FROM ${TODAY_SQL} AND ${unclaimedNowSql(ss, ms, room)}))`;
}

/** 'YYYY-MM-DD' → weekday name ('Monday'…), or null when it isn't a real date */
export function weekdayOfDate(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

/** Whole days from `from` to `to` (both 'YYYY-MM-DD') */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
