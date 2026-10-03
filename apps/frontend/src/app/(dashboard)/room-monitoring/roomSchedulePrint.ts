/**
 * Printable room schedule (Room Monitoring → a room → Print schedule).
 *
 * The room's weekly classes for the term on the official NEMSU sheet (same
 * header, footer and long-bond page as the workload form): one block per day
 * group — the semester's day combinations, e.g. MONDAY AND THURSDAY — split
 * into MORNING / AFTERNOON, with TIME · SUBJECT / DESCRIPTION · COURSE ·
 * INSTRUCTOR. Plain black and white; free time in the standard periods (an
 * hour or more) stays as blank rows so open time is easy to see.
 */

import { WEEK_DAYS, sortDays, type WeekDay } from '@shared/dayCombination';
import { activeCombinations, fetchDayCombinations } from '@/lib/dayCombinations';
import {
  DEFAULT_FOOTER_CONFIG, escapePrintHtml as esc, footerHtml,
  officialPrintDocumentCss, officialPrintHeaderHtml, officialPrintPagedHtml, semesterHeading,
} from '@/lib/nemsuOfficialPrintChrome';
import { openBlankPrintWindow, openPrintHtmlDocument, type OpenPrintHtmlResult } from '@/lib/openPrintHtmlDocument';

/** One weekly class meeting in the room */
export interface RoomClass {
  day: string;
  /** 'HH:MM' */
  start: string;
  end: string;
  subject_code: string;
  subject_name: string | null;
  component: string | null;
  block: string | null;
  faculty_id: number | null;
  faculty_name: string | null;
}

const toMin = (hm: string) => { const [h, m] = hm.split(':').map(Number); return h * 60 + (m || 0); };
/** 7:00, 1:30 — the MORNING / AFTERNOON heading carries the AM / PM */
const clock = (min: number) => `${Math.floor(min / 60) % 12 || 12}:${String(min % 60).padStart(2, '0')}`;

/** Standard periods of the sheet (blank rows when free) and the lunch hour */
const PERIODS: [number, number][] = [[420, 510], [510, 600], [600, 690], [780, 870], [870, 960], [960, 1050], [1050, 1140]];
const LUNCH: [number, number] = [720, 780];
const NOON = 720;
/** Shorter gaps between classes are left out */
const MIN_FREE = 60;
/** Day groups when the term has no day combinations set */
const DEFAULT_GROUPS: WeekDay[][] = [['Monday', 'Thursday'], ['Wednesday'], ['Tuesday', 'Friday']];

/** The term's day combinations, then any other day that has classes; each day printed once */
function dayGroups(classes: RoomClass[], combinations: WeekDay[][]): WeekDay[][] {
  const base = combinations.length ? combinations : DEFAULT_GROUPS;
  const covered = new Set(base.flat());
  const extra = WEEK_DAYS.filter(d => !covered.has(d) && classes.some(c => c.day === d)).map(d => [d]);
  const seen = new Set<WeekDay>();
  const groups: WeekDay[][] = [];
  for (const g of [...base, ...extra]) {
    const days = sortDays(g).filter(d => !seen.has(d));
    days.forEach(d => seen.add(d));
    if (days.length) groups.push(days);
  }
  return groups;
}

/** MONDAY AND THURSDAY · MONDAY, WEDNESDAY AND FRIDAY */
function groupLabel(days: WeekDay[]): string {
  const up = days.map(d => d.toUpperCase());
  return up.length > 1 ? `${up.slice(0, -1).join(', ')} AND ${up[up.length - 1]}` : up[0];
}

interface Line { start: number; end: number; cls: RoomClass | null; days: WeekDay[] }

/** A group's rows: each class once (same class at the same time on several of its days),
 *  plus the free time left in the standard periods, in time order */
function groupLines(days: WeekDay[], classes: RoomClass[]): Line[] {
  const merged = new Map<string, Line>();
  for (const c of classes) {
    if (!days.includes(c.day as WeekDay)) continue;
    const key = [c.start, c.end, c.subject_code, c.component, c.block, c.faculty_id].join('|');
    const line = merged.get(key) ?? { start: toMin(c.start), end: toMin(c.end), cls: c, days: [] };
    line.days.push(c.day as WeekDay);
    merged.set(key, line);
  }
  const lines = [...merged.values()];
  // Free time: what classes leave of each standard period (an hour or more)
  const busy = lines.map(l => [l.start, l.end] as const).sort((a, b) => a[0] - b[0]);
  for (const [ps, pe] of PERIODS) {
    let from = ps;
    for (const [bs, be] of busy) {
      if (be <= from || bs >= pe) continue;
      if (bs - from >= MIN_FREE) lines.push({ start: from, end: bs, cls: null, days: [] });
      from = Math.max(from, be);
    }
    if (pe - from >= MIN_FREE) lines.push({ start: from, end: pe, cls: null, days: [] });
  }
  return lines.sort((a, b) => a.start - b.start || a.end - b.end);
}

function lineHtml(line: Line, groupDays: WeekDay[]): string {
  const time = `${clock(line.start)} – ${clock(line.end)}`;
  if (!line.cls) return `<tr class="rs-free"><td class="rs-time">${time}</td><td></td><td></td><td></td></tr>`;
  const c = line.cls;
  const lab = (c.component ?? '').toLowerCase().startsWith('lab');
  // Only some of the group's days (e.g. Monday only under MONDAY AND THURSDAY)
  const only = groupDays.length > 1 && line.days.length < groupDays.length
    ? `<div class="rs-only">${esc(sortDays(line.days).join(' & '))} only</div>` : '';
  return `<tr>
    <td class="rs-time">${time}${only}</td>
    <td class="rs-subj"><span class="rs-code">${esc(c.subject_code)}</span> ${esc(c.subject_name ?? '')}${lab ? ' (Lab)' : ''}</td>
    <td class="rs-course">${esc(c.block ?? '')}</td>
    <td class="rs-inst">${esc((c.faculty_name ?? '').toUpperCase())}</td>
  </tr>`;
}

function groupHtml(days: WeekDay[], classes: RoomClass[]): string {
  const lines = groupLines(days, classes);
  const morning = lines.filter(l => l.start < NOON);
  const afternoon = lines.filter(l => l.start >= NOON);
  const lunch = lines.some(l => l.cls && l.start < LUNCH[1] && l.end > LUNCH[0])
    ? ''
    : `<tr class="rs-lunch"><td class="rs-time">${clock(LUNCH[0])} – ${clock(LUNCH[1])}</td><td colspan="3">Lunch Break</td></tr>`;
  return `
    <tbody class="rs-group">
      <tr class="rs-day"><td colspan="4">${groupLabel(days)}</td></tr>
      <tr class="rs-half"><td colspan="4">MORNING</td></tr>
      ${morning.map(l => lineHtml(l, days)).join('')}
      ${lunch}
      <tr class="rs-half"><td colspan="4">AFTERNOON</td></tr>
      ${afternoon.map(l => lineHtml(l, days)).join('')}
    </tbody>`;
}

const ROOM_SCHEDULE_CSS = `
.rs { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin-top: 6px; }
.rs th, .rs td { border: 1px solid #222; padding: 3px 6px; vertical-align: middle; }
.rs col.c-time { width: 15%; }
.rs col.c-subj { width: 43%; }
.rs col.c-course { width: 12%; }
.rs col.c-inst { width: 30%; }
.rs thead { display: table-header-group; }
.rs .rs-room th { font-size: 11.5pt; letter-spacing: .06em; padding: 6px; }
.rs .rs-cols th { font-size: 8pt; letter-spacing: .04em; padding: 4px 6px; }
.rs .rs-day td { text-align: center; font-weight: bold; font-size: 9.5pt; letter-spacing: .05em; padding: 5px 6px; border-top: 2px solid #000; }
.rs .rs-half td { text-align: center; font-weight: bold; font-size: 8pt; letter-spacing: .1em; padding: 2px 6px; }
.rs td.rs-time { text-align: center; white-space: nowrap; }
.rs td.rs-subj { text-align: left; }
.rs td.rs-course { text-align: center; white-space: nowrap; }
.rs td.rs-inst { text-align: center; }
.rs .rs-code { font-weight: bold; }
.rs .rs-only { font-size: 6.5pt; font-style: italic; }
.rs .rs-free td { height: 17px; }
.rs .rs-lunch td { text-align: center; font-style: italic; }
.rs tr { page-break-inside: avoid; }
`;

export function buildRoomScheduleHtml(input: {
  /** As shown on screen, e.g. "Laboratory 10" */
  roomName: string;
  classes: RoomClass[];
  term: { semester: string | null; school_year: string | null };
  combinations: WeekDay[][];
  origin: string;
}): string {
  const groups = dayGroups(input.classes, input.combinations);
  // Header on every page; the room name and column titles repeat too when the table runs on
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Room Schedule — ${esc(input.roomName)}</title>
<style>
${officialPrintDocumentCss()}
${ROOM_SCHEDULE_CSS}
</style>
</head>
<body>
<div class="page">
${officialPrintPagedHtml(officialPrintHeaderHtml({
  logoSrc: `${input.origin}/nemlogo/NEMSU-logo.png`,
  title: 'ROOM SCHEDULE',
  semesterHeading: semesterHeading(input.term.semester ?? ''),
  academicYear: input.term.school_year ?? '',
}), `
<table class="rs">
  <colgroup><col class="c-time"><col class="c-subj"><col class="c-course"><col class="c-inst"></colgroup>
  <thead>
    <tr class="rs-room"><th colspan="4">${esc(input.roomName.toUpperCase())}</th></tr>
    <tr class="rs-cols"><th>TIME</th><th>SUBJECT / DESCRIPTION</th><th>COURSE</th><th>INSTRUCTOR</th></tr>
  </thead>
  ${groups.map(days => groupHtml(days, input.classes)).join('')}
</table>`)}
</div>
${footerHtml({ ...DEFAULT_FOOTER_CONFIG, logoOrigin: input.origin })}
</body>
</html>`;
}

/** Open the room's printable schedule. Call straight from the click (the print window opens first). */
export async function printRoomSchedule(input: Omit<Parameters<typeof buildRoomScheduleHtml>[0], 'combinations' | 'origin'>): Promise<OpenPrintHtmlResult> {
  const preOpened = openBlankPrintWindow('width=860,height=1150');
  const combinations = activeCombinations(await fetchDayCombinations(input.term.semester, input.term.school_year))
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(c => c.days);
  const html = buildRoomScheduleHtml({ ...input, combinations, origin: window.location.origin });
  return openPrintHtmlDocument(html, {
    windowFeatures: 'width=860,height=1150',
    preOpenedWindow: preOpened,
    downloadFilename: `room-schedule-${input.roomName.replace(/[^\w-]+/g, '-')}.html`,
  });
}
