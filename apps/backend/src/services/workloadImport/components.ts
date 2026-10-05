import type { WeekDay } from '@shared/dayCombination';
import type { WorkloadRow } from '@shared/workloadImport';
import { validateSessions } from '@/services/scheduleConflicts';
import type { PlannedSession, RoomRef, SessionCandidate, SessionType, SourceRef } from './types';

/*
 * Turning workload-form rows into QRganize sessions.
 *
 * QRganize keeps a subject's Lecture and Laboratory as separate components
 * whose weekly hours must equal the curriculum's (2 h Lec + 3 h Lab for a
 * 3-unit major). A form row may describe one component, both at once
 * ("IT 112 · 4.25 units · 5 h · Wed 7:00–12:00"), or only part of one
 * (a component split between two load forms).
 *
 * Weekly hours are always meeting length × number of meetings: 1:30 on
 * Mon/Thu is 3 hours a week. When a form's time doesn't add up to the
 * curriculum hours (a 1-hour lecture written in a 90-minute template slot),
 * the days and start time are kept and the length is set to QRganize's
 * hours — reported as an adjustment, never silently.
 */

export type RowComponent =
  | { kind: 'lec' | 'lab' | 'both' }
  | { kind: 'partial'; type: SessionType; value: number }
  | { kind: 'unknown' };

const near = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) <= 0.011;

/**
 * Which part of the subject a row is. Units decide first — they are the
 * form's own load figures (Lec = lecture hours, Lab = lab hours × 0.75,
 * both = the sum) — then hours, then the "(Lec)" / "(Lab)" marker, which is
 * the least reliable (often copied from the row above).
 */
export function resolveRowComponent(
  row: Pick<WorkloadRow, 'units' | 'hours' | 'marker'>,
  lecHours: number,
  labHours: number,
): { component: RowComponent; note?: string } {
  if (labHours <= 0) return { component: { kind: 'lec' } };
  if (lecHours <= 0) return { component: { kind: 'lab' } };
  const labUnits = labHours * 0.75;
  const bothUnits = lecHours + labUnits;
  const { units, hours, marker } = row;
  const markerNote = (kind: string) =>
    marker && marker !== kind ? `marked (${marker === 'lec' ? 'Lec' : 'Lab'}) but its units are those of the ${kind === 'both' ? 'whole subject' : kind === 'lec' ? 'Lecture' : 'Laboratory'}` : undefined;

  if (units != null) {
    const ambiguous = near(lecHours, labUnits);
    if (near(units, bothUnits)) return { component: { kind: 'both' }, note: markerNote('both') };
    if (!ambiguous && near(units, lecHours)) return { component: { kind: 'lec' }, note: markerNote('lec') };
    if (!ambiguous && near(units, labUnits)) return { component: { kind: 'lab' }, note: markerNote('lab') };
    if (ambiguous && marker) return { component: { kind: marker } };
    if (marker && units > 0) {
      const full = marker === 'lec' ? lecHours : labUnits;
      if (units < full - 0.011) return { component: { kind: 'partial', type: marker, value: units } };
    }
    return { component: { kind: 'unknown' } };
  }
  if (hours != null) {
    if (near(hours, lecHours + labHours)) return { component: { kind: 'both' } };
    if (lecHours !== labHours && near(hours, lecHours)) return { component: { kind: 'lec' } };
    if (lecHours !== labHours && near(hours, labHours)) return { component: { kind: 'lab' } };
  }
  return marker ? { component: { kind: marker } } : { component: { kind: 'unknown' } };
}

export interface TimedRow {
  row: WorkloadRow;
  /** 'lec' | 'lab' — one component; 'both' — the whole subject in one time block */
  kind: SessionType | 'both';
  room: RoomRef | null;
}

interface Draft {
  sessions: PlannedSession[];
  sources: SourceRef[];
  notes: string[];
}

const minutes = (h: number) => Math.round(h * 60);
export const clock = (m: number) => {
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Same academic-day rules as saving a schedule (7:00 AM–6:00 PM, no lunch overlap) */
export function sessionsAreValid(sessions: Pick<PlannedSession, 'day' | 'start' | 'end'>[]): boolean {
  if (sessions.some(s => s.end <= s.start)) return false;
  return validateSessions(sessions.map(s => ({ day: s.day, start_time: toTime(s.start), hours: (s.end - s.start) / 60 }))) === null;
}

const totalMinutes = (sessions: PlannedSession[]) => sessions.reduce((sum, s) => sum + (s.end - s.start), 0);
const src = (row: WorkloadRow): SourceRef => ({ sheet: row.sheet, row: row.row });

/** Split a whole-subject time block into its Lecture and Laboratory parts (Lec first). */
function splitBoth(t: TimedRow, lecH: number, labH: number): { lec: PlannedSession[]; lab: PlannedSession[]; note: string } | null {
  const { row } = t;
  if (!row.time || row.days.length === 0) return null;
  const lecMin = minutes(lecH), labMin = minutes(labH), need = lecMin + labMin;
  const n = row.days.length;
  let { start, end } = row.time;
  let note = 'Lec/Lab order inside the combined time is not on the form — Lecture placed first';
  if ((end - start) * n !== need) {
    const per = need / n;
    if (!Number.isInteger(per)) return null;
    const keepStart = row.days.map(day => ({ day, start, end: start + per }));
    const keepEnd = row.days.map(day => ({ day, start: end - per, end }));
    if (sessionsAreValid(keepStart)) end = start + per;
    else if (sessionsAreValid(keepEnd)) start = end - per;
    else return null;
    note = `form time ${clock(row.time.start)}–${clock(row.time.end)} × ${n} = ${((row.time.end - row.time.start) * n) / 60} h; set to ${clock(start)}–${clock(end)} for QRganize's ${need / 60} h. ${note}`;
  }
  const per = end - start;
  if (n === 1) {
    return {
      lec: [{ day: row.days[0], start, end: start + lecMin, type: 'lec', room: t.room }],
      lab: [{ day: row.days[0], start: start + lecMin, end, type: 'lab', room: t.room }],
      note,
    };
  }
  // Several meetings (e.g. DAILY 5:00–6:00): whole meetings to each part when they fit
  if (lecMin % per === 0 && labMin % per === 0) {
    const lecDays = lecMin / per;
    return {
      lec: row.days.slice(0, lecDays).map(day => ({ day, start, end, type: 'lec' as const, room: t.room })),
      lab: row.days.slice(lecDays).map(day => ({ day, start, end, type: 'lab' as const, room: t.room })),
      note: `${note}; the first ${lecDays} meeting day(s) are Lecture, the rest Laboratory`,
    };
  }
  const lecPer = lecMin / n, labPer = labMin / n;
  if (!Number.isInteger(lecPer) || !Number.isInteger(labPer)) return null;
  return {
    lec: row.days.map(day => ({ day, start, end: start + lecPer, type: 'lec' as const, room: t.room })),
    lab: row.days.map(day => ({ day, start: start + lecPer, end, type: 'lab' as const, room: t.room })),
    note,
  };
}

/**
 * The Lecture and Laboratory drafts one sheet gives for a class. When a
 * sheet has separate Lec and Lab rows whose times fit the curriculum only
 * with the labels swapped (Lab 7:00–9:00 + Lec 9:00–12:00 for 2 h Lec /
 * 3 h Lab), the times are kept and the labels swapped — reported.
 */
export function draftsFromSheet(rows: TimedRow[], lecH: number, labH: number): { lec?: Draft; lab?: Draft; problems: string[] } {
  const problems: string[] = [];
  const lec: Draft = { sessions: [], sources: [], notes: [] };
  const lab: Draft = { sessions: [], sources: [], notes: [] };
  for (const t of rows) {
    if (!t.row.time || t.row.days.length === 0) {
      problems.push(`row ${t.row.row}: ${t.row.time ? 'no day heading' : 'time not readable'}`);
      continue;
    }
    if (t.kind === 'both') {
      const parts = splitBoth(t, lecH, labH);
      if (!parts) { problems.push(`row ${t.row.row}: the combined time can't be split into ${lecH} h Lec + ${labH} h Lab`); continue; }
      lec.sessions.push(...parts.lec); lab.sessions.push(...parts.lab);
      lec.sources.push(src(t.row)); lab.sources.push(src(t.row));
      lec.notes.push(parts.note); lab.notes.push(parts.note);
      continue;
    }
    const target = t.kind === 'lec' ? lec : lab;
    target.sources.push(src(t.row));
    for (const day of t.row.days) target.sessions.push({ day, start: t.row.time.start, end: t.row.time.end, type: t.kind, room: t.room });
  }

  // Labels swapped on the form?
  const lecMin = totalMinutes(lec.sessions), labMin = totalMinutes(lab.sessions);
  const separate = rows.every(r => r.kind !== 'both');
  if (separate && lec.sessions.length && lab.sessions.length && lecH > 0 && labH > 0
      && lecMin !== minutes(lecH) && labMin !== minutes(labH)
      && lecMin === minutes(labH) && labMin === minutes(lecH)) {
    const note = 'Lec/Lab labels on the form are the other way round from their times — times kept, labels swapped to fit QRganize\'s hours';
    const swapped = {
      lec: { sessions: lab.sessions.map(s => ({ ...s, type: 'lec' as const })), sources: lab.sources, notes: [...lab.notes, note] },
      lab: { sessions: lec.sessions.map(s => ({ ...s, type: 'lab' as const })), sources: lec.sources, notes: [...lec.notes, note] },
    };
    return { lec: swapped.lec, lab: swapped.lab, problems };
  }
  return { lec: lec.sessions.length ? lec : undefined, lab: lab.sessions.length ? lab : undefined, problems };
}

/**
 * A component's options from one draft: as written when its weekly hours
 * already equal QRganize's, otherwise the same days with the meeting length
 * set to QRganize's hours (start kept; end kept when the start can't be).
 */
export function candidatesFromDraft(draft: Draft, type: SessionType, hours: number): { asWritten?: SessionCandidate; adjusted?: SessionCandidate; problem?: string } {
  const need = minutes(hours);
  const total = totalMinutes(draft.sessions);
  const sessions = [...draft.sessions].sort((a, b) => dayIndex(a.day) - dayIndex(b.day) || a.start - b.start);
  if (total === need) {
    return { asWritten: { sessions, sources: draft.sources, fit: 'as-written', notes: [...new Set(draft.notes)] } };
  }
  const first = sessions[0];
  const uniform = sessions.every(s => s.start === first.start && s.end === first.end);
  const formText = `form time ${describeSessions(sessions)} = ${fmtHours(total / 60)} a week`;
  if (!uniform) return { problem: `${formText}; QRganize's ${type === 'lec' ? 'Lecture' : 'Laboratory'} needs ${fmtHours(hours)} and the rows use different times, so no single adjustment fits` };
  const per = need / sessions.length;
  if (!Number.isInteger(per) || per % 5 !== 0) return { problem: `${formText}; ${fmtHours(hours)} can't be spread evenly over ${sessions.length} meeting(s)` };
  const keepStart = sessions.map(s => ({ ...s, end: s.start + per }));
  const keepEnd = sessions.map(s => ({ ...s, start: s.end - per }));
  const chosen = sessionsAreValid(keepStart) ? keepStart : sessionsAreValid(keepEnd) ? keepEnd : null;
  if (!chosen) return { problem: `${formText}; a ${fmtHours(per / 60)} meeting can't start or end at the written time within school hours` };
  return {
    adjusted: {
      sessions: chosen,
      sources: draft.sources,
      fit: 'adjusted',
      notes: [...new Set(draft.notes), `${formText}; set to ${describeSessions(chosen)} = ${fmtHours(hours)} (QRganize ${type === 'lec' ? 'Lecture' : 'Laboratory'} hours)`],
    },
  };
}

export const dayIndex = (d: WeekDay) => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].indexOf(d);
const SHORT: Record<string, string> = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };
export const shortDay = (d: string) => SHORT[d] ?? d;
export const fmtHours = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, '')} h`;

/** "Mon/Thu 7:00 AM–8:30 AM" (groups days sharing a time) */
export function describeSessions(sessions: Pick<PlannedSession, 'day' | 'start' | 'end'>[]): string {
  const groups = new Map<string, string[]>();
  for (const s of [...sessions].sort((a, b) => dayIndex(a.day) - dayIndex(b.day))) {
    const k = `${clock(s.start)}–${clock(s.end)}`;
    groups.set(k, [...(groups.get(k) ?? []), shortDay(s.day)]);
  }
  return [...groups.entries()].map(([time, days]) => `${days.join('/')} ${time}`).join(', ');
}

export const sameSessions = (a: PlannedSession[], b: PlannedSession[]) =>
  a.length === b.length && a.every((s, i) => s.day === b[i].day && s.start === b[i].start && s.end === b[i].end && s.type === b[i].type
    && (s.room?.roomId ?? s.room?.newRoomKey ?? null) === (b[i].room?.roomId ?? b[i].room?.newRoomKey ?? null));
