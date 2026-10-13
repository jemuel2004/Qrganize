/**
 * NSTP — on the Class Program only (Settings → Day Combinations → NSTP).
 *
 * NSTP subjects stay on their blocks but never enter the regular scheduling:
 * no class row (master_schedule) is made for them, so they carry no faculty
 * workload, no room and no conflict check. The Class Program shows them every
 * Saturday at the time set in Settings, with the handler's name as typed there
 * (the handler needs no QRganize account).
 */

import type { WeekDay } from './dayCombination';
import { SCHOOL_DAY_END_MIN, SCHOOL_DAY_LABEL, SCHOOL_DAY_START_MIN } from './schoolDay';

/** NSTP always meets on Saturday — not a setting */
export const NSTP_DAY: WeekDay = 'Saturday';

/** Longest handler name kept */
export const NSTP_HANDLER_MAX = 100;

/** NSTP 1, NSTP1, nstp-2 … */
export function isNstpSubject(code: string | null | undefined): boolean {
  return /^\s*NSTP/i.test(String(code ?? ''));
}

/** The same test for Postgres: `c.subject_code ~* '<NSTP_CODE_PATTERN>'` */
export const NSTP_CODE_PATTERN = '^\\s*NSTP';

export interface NstpSchedule {
  /** 'HH:MM' (24-hour), null until set */
  start_time: string | null;
  end_time: string | null;
  /** Typed in Settings, e.g. "Roy Sumaoy" — not a QRganize account */
  handler_name: string;
}

export const EMPTY_NSTP: NstpSchedule = { start_time: null, end_time: null, handler_name: '' };

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** One spacing, no control characters */
export function cleanHandlerName(name: unknown): string {
  return String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Checks what Settings sends; the times come back as 'HH:MM' */
export function validateNstpSchedule(input: { start_time?: unknown; end_time?: unknown; handler_name?: unknown }):
  { ok: true; value: NstpSchedule } | { ok: false; error: string } {
  const start = String(input.start_time ?? '').trim();
  const end = String(input.end_time ?? '').trim();
  const handler = cleanHandlerName(input.handler_name);
  if (!HHMM.test(start) || !HHMM.test(end)) return { ok: false, error: 'Set the NSTP start and end time.' };
  const s = toMin(start);
  const e = toMin(end);
  if (e <= s) return { ok: false, error: 'The NSTP end time must be after its start time.' };
  if (s < SCHOOL_DAY_START_MIN || e > SCHOOL_DAY_END_MIN) {
    return { ok: false, error: `NSTP must be within the school day (${SCHOOL_DAY_LABEL}).` };
  }
  if (!handler) return { ok: false, error: "Type the NSTP handler's name." };
  if (handler.length > NSTP_HANDLER_MAX) return { ok: false, error: `The handler's name can be at most ${NSTP_HANDLER_MAX} characters.` };
  return { ok: true, value: { start_time: start.slice(0, 5), end_time: end.slice(0, 5), handler_name: handler } };
}

/** The time is set (both ends, in order) */
export function nstpTimeSet(s: NstpSchedule | null | undefined): s is NstpSchedule & { start_time: string; end_time: string } {
  return !!s?.start_time && !!s.end_time && HHMM.test(s.start_time) && HHMM.test(s.end_time) && toMin(s.end_time) > toMin(s.start_time);
}

/** Hours of one NSTP meeting (07:00–10:00 → 3) — 0 until the time is set */
export function nstpHours(s: NstpSchedule | null | undefined): number {
  if (!nstpTimeSet(s)) return 0;
  return Math.round(((toMin(s.end_time) - toMin(s.start_time)) / 60) * 100) / 100;
}
