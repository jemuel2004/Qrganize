import { classTimes, time12, timeMinutes, type ClassPart } from './roomRequestWindow';

/**
 * Class reminders on a faculty member's devices (Web Push), like a calendar's:
 * one per class time today, `lead` minutes before it starts. A Lecture
 * followed by its Laboratory is one class time (@shared/roomRequestWindow), so
 * it gets one reminder. Pure, so the server job and the tests share it.
 */

/** How long before class a faculty member may be reminded (minutes) */
export const REMINDER_LEADS = [30, 15, 5] as const;
export type ReminderLead = (typeof REMINDER_LEADS)[number];
export const DEFAULT_REMINDER_LEAD: ReminderLead = 15;

export const isReminderLead = (value: unknown): value is ReminderLead =>
  REMINDER_LEADS.some(lead => lead === value);

/** One of a faculty member's class sessions today */
export interface ReminderSession {
  facultyId: number;
  /** master_schedule id — the class */
  classId: number;
  subjectCode: string;
  subjectName: string;
  /** e.g. "BSIT 2A" */
  block: string;
  room: string | null;
  part: ClassPart;
  /** "HH:MM" or "HH:MM:SS" */
  start: string;
  end: string;
}

export interface DueReminder {
  facultyId: number;
  classId: number;
  subjectCode: string;
  subjectName: string;
  block: string;
  /** The class time's room(s), e.g. "Room 205" or "Lab 1 / Lab 2"; null when none is set */
  room: string | null;
  /** "HH:MM" */
  start: string;
  end: string;
  /** Whole minutes until it starts (at least 1) */
  minutesLeft: number;
  /** One reminder per class time and day: "2026-10-09|123|13:00" */
  key: string;
}

/**
 * The reminders due at `nowMin` (minutes after midnight, Manila) on `date`:
 * each class time whose start is at most the faculty's lead away and has not
 * started yet. Never for a class that has started (or ended), for a faculty
 * member without a lead (reminders off), or for a class they already checked
 * in to (`checkedIn` holds "facultyId|classId").
 */
export function dueClassReminders(
  sessions: readonly ReminderSession[],
  leadByFaculty: ReadonlyMap<number, number>,
  nowMin: number,
  date: string,
  checkedIn: ReadonlySet<string> = new Set(),
): DueReminder[] {
  const byClass = new Map<string, ReminderSession[]>();
  for (const s of sessions) {
    if (!leadByFaculty.has(s.facultyId)) continue;
    const k = `${s.facultyId}|${s.classId}`;
    const list = byClass.get(k);
    if (list) list.push(s);
    else byClass.set(k, [s]);
  }

  const due: DueReminder[] = [];
  for (const [k, list] of byClass) {
    if (checkedIn.has(k)) continue;
    const first = list[0];
    const lead = leadByFaculty.get(first.facultyId) ?? 0;
    if (lead <= 0) continue;
    for (const t of classTimes(list)) {
      const minutesLeft = timeMinutes(t.start) - nowMin;
      if (minutesLeft <= 0 || minutesLeft > lead) continue;
      const rooms = [...new Set(t.sessions.map(x => x.room).filter((r): r is string => !!r))];
      due.push({
        facultyId: first.facultyId,
        classId: first.classId,
        subjectCode: first.subjectCode,
        subjectName: first.subjectName,
        block: first.block,
        room: rooms.length > 0 ? rooms.join(' / ') : null,
        start: t.start,
        end: t.end,
        minutesLeft,
        key: `${date}|${first.classId}|${t.start}`,
      });
    }
  }
  return due.sort((a, b) => timeMinutes(a.start) - timeMinutes(b.start) || a.facultyId - b.facultyId);
}

/** "starts in 15 minutes" / "starts in 1 minute" / "starts now" */
export function startsIn(minutes: number): string {
  if (minutes <= 0) return 'starts now';
  return `starts in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * What the device shows, e.g.
 *   QRganize — Upcoming Class
 *   Your Web Systems class starts in 15 minutes.
 *   Room: Room 205 · Block: BSIT 2A · Time: 1:00 PM – 2:00 PM (one per line)
 */
export function reminderText(r: Pick<DueReminder, 'subjectName' | 'subjectCode' | 'block' | 'room' | 'start' | 'end'>, minutesLeft: number) {
  const subject = r.subjectName.trim() || r.subjectCode;
  const lines = [
    `Your ${subject} class ${startsIn(minutesLeft)}.`,
    `Room: ${r.room ?? 'No room assigned yet'}`,
    ...(r.block ? [`Block: ${r.block}`] : []),
    `Time: ${time12(r.start)} – ${time12(r.end)}`,
  ];
  return { title: 'QRganize — Upcoming Class', body: lines.join('\n') };
}
