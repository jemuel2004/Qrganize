/**
 * Class Program data helpers + Excel export — shared by the Class Program page
 * and Reports, so both build exactly the same rows, groups and workbook.
 */

import { daysKey, parseDays, type WeekDay } from '@shared/dayCombination';
import { clock12, clockRange12 } from '@shared/clock12';
import {
  DEFAULT_FOOTER_CONFIG, NEMSU_OFFICIAL_DEPT, escapePrintHtml as esc, footerHtml, formatAy, officialPrintDocumentCss,
  officialPrintHeaderHtml, officialPrintPagedHtml, semesterHeading,
} from '@/lib/nemsuOfficialPrintChrome';

export interface SessionData { day: string; start_time: string; end_time: string; session_hours: number; }
export interface RawSchedule {
  ms_id: number;
  day_pattern: string | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
  subject_code: string;
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  total_hours: number;
  units: number;
  faculty_name: string | null;
  room_name: string | null;
  sessions: SessionData[] | null;
  /** NSTP: every Saturday from Settings → Day Combinations → NSTP — typed handler, no room needed */
  nstp?: boolean;
}
export interface BlockDetail {
  id: number; block_name: string; year_level: string; semester: string;
  academic_year: string; program_code: string; program_name: string; department: string | null;
}
export interface DisplayRow {
  key: string; ms_id: number;
  subject_code: string; subject_name: string;
  row_hours: number; row_units: number;
  /** Second+ time slot of the same subject — units already counted on its first row. */
  is_continuation: boolean;
  faculty_name: string | null; room_name: string | null;
  start_time: string | null; end_time: string | null;
  day_pattern: string;
  /** NSTP (Settings → Day Combinations → NSTP): no room needed */
  nstp: boolean;
}
export interface DayGroup { pattern: string; label: string; order: number; rows: DisplayRow[]; }
export interface Signatory { name: string; designation: string; }

/** Default "Prepared by" per program (key: program code, letters/digits only, upper-case). */
export const DEFAULT_COORDINATORS: Record<string, Signatory> = {
  BSIT:  { name: 'SHARON A. BUCALON, MIT',     designation: 'Program Coordinator - IT' },
  BSCS:  { name: 'JOEL S. GRACIA, MSCS',       designation: 'Program Coordinator - CS' },
  BSCPE: { name: 'ENGR. DIONE S. DUERO, MSCpE', designation: 'Program Coordinator, BSCpE' },
};
export const EMPTY_SIGNATORY: Signatory = { name: '', designation: '' };

export function programKey(code: string | null | undefined): string {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Every spelling of a weekday → [order, short, full]. */
export const DAY_INFO: Record<string, [number, string, string]> = {};
([
  [1, 'Mon', 'Monday', ['m', 'mon', 'monday']],
  [2, 'Tue', 'Tuesday', ['t', 'tue', 'tues', 'tuesday']],
  [3, 'Wed', 'Wednesday', ['w', 'wed', 'wednesday']],
  [4, 'Thu', 'Thursday', ['th', 'thu', 'thur', 'thurs', 'thursday']],
  [5, 'Fri', 'Friday', ['f', 'fri', 'friday']],
  [6, 'Sat', 'Saturday', ['s', 'sat', 'saturday']],
  [7, 'Sun', 'Sunday', ['su', 'sun', 'sunday']],
] as const).forEach(([order, short, full, names]) => {
  for (const n of names) DAY_INFO[n] = [order, short, full];
});
export const COMPACT_PATTERNS: Record<string, string> = { mwf: 'm/w/f', mw: 'm/w', tth: 't/th', tthu: 't/th' };

export function patternDays(pattern: string): Array<[number, string, string]> | null {
  const p = pattern.trim().toLowerCase();
  const parts = (COMPACT_PATTERNS[p] ?? p).split(/[/,\-\s]+/).filter(Boolean);
  const days = parts.map(d => DAY_INFO[d]);
  return days.length > 0 && days.every(Boolean) ? days : null;
}

export function getDayOrder(pattern: string): number {
  const days = patternDays(pattern);
  return days ? Math.min(...days.map(d => d[0])) : 99;
}

/** "Tue/Thu" → "Tuesday/Thursday"; unknown patterns are shown as typed. */
export function getDayLabel(pattern: string): string {
  const days = patternDays(pattern);
  return days ? days.map(d => d[2]).join('/') : pattern;
}

export function isAM(t: string | null): boolean {
  if (!t) return true;
  return parseInt(t.split(':')[0], 10) < 12;
}

/** "13:30" → "1:30 PM" */
export function fmt12(t: string): string {
  return clock12(t);
}

/** "07:00", "08:30" → "7:00 AM–8:30 AM" — the printed form's TIME/DAY cell (as on the workload form) */
export function formatTimeRange(start: string | null, end: string | null): string {
  if (!start) return '';
  return clockRange12(start, end, '–');
}

/**
 * One row per time slot. A subject's sessions at the same start/end time are
 * one row across their days (Tue + Thu 7:30–8:30 → "Tue/Thu"), so a lecture
 * and a lab at different times each get their own row. Row hours are that
 * slot's weekly hours; the subject's units sit on its first row only.
 */
export function expandToDisplayRows(schedules: RawSchedule[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const s of schedules) {
    const base = {
      ms_id:        s.ms_id,
      subject_code: s.subject_code,
      subject_name: s.subject_name,
      faculty_name: s.faculty_name,
      room_name:    s.room_name,
      nstp:         s.nstp === true,
    };
    const units = parseFloat(String(s.units)) || 0;
    const sessions = (s.sessions ?? []).filter(x => x.day && x.start_time);

    if (sessions.length === 0) {
      rows.push({
        ...base,
        key:          String(s.ms_id),
        row_hours:    parseFloat(String(s.total_hours)) || 0,
        row_units:    units,
        is_continuation: false,
        start_time:   s.start_time,
        end_time:     s.end_time,
        day_pattern:  s.day_pattern ?? 'TBA',
      });
      continue;
    }

    const slots = new Map<string, { start: string; end: string; days: Set<string>; hours: number }>();
    for (const x of sessions) {
      const start = x.start_time.slice(0, 5);
      const end = (x.end_time ?? '').slice(0, 5);
      const k = `${start}-${end}`;
      const slot = slots.get(k) ?? { start, end, days: new Set<string>(), hours: 0 };
      slot.days.add(x.day);
      slot.hours += parseFloat(String(x.session_hours)) || 0;
      slots.set(k, slot);
    }

    const ordered = [...slots.values()]
      .map(slot => {
        const days = [...slot.days]
          .map(d => DAY_INFO[d.trim().toLowerCase()] ?? [99, d, d] as [number, string, string])
          .sort((a, b) => a[0] - b[0]);
        return { ...slot, pattern: days.map(d => d[1]).join('/'), order: days[0][0] };
      })
      .sort((a, b) => a.order - b.order || a.start.localeCompare(b.start));

    ordered.forEach((slot, i) => {
      rows.push({
        ...base,
        key:          `${s.ms_id}-${slot.pattern}-${slot.start}`,
        row_hours:    slot.hours,
        row_units:    i === 0 ? units : 0,
        is_continuation: i > 0,
        start_time:   slot.start,
        end_time:     slot.end,
        day_pattern:  slot.pattern,
      });
    });
  }
  return rows;
}

/** Day groups; with configured day combinations (Settings) they follow that order first */
export function groupByDay(rows: DisplayRow[], combos: readonly { days: readonly WeekDay[] }[] = []): DayGroup[] {
  const map = new Map<string, DisplayRow[]>();
  for (const row of rows) {
    if (!map.has(row.day_pattern)) map.set(row.day_pattern, []);
    map.get(row.day_pattern)!.push(row);
  }
  const comboRank = (pattern: string) => {
    const days = parseDays(pattern);
    const i = days ? combos.findIndex(c => daysKey(c.days) === daysKey(days)) : -1;
    return i < 0 ? combos.length : i;
  };
  return [...map.entries()]
    .map(([pattern, r]) => ({
      pattern,
      label: getDayLabel(pattern),
      order: getDayOrder(pattern),
      rank: comboRank(pattern),
      rows: r.sort((a, b) => (a.start_time ?? '').localeCompare(b.start_time ?? '')),
    }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order || a.pattern.localeCompare(b.pattern));
}

export function fmtNum(n: number): string {
  return n.toFixed(n % 1 === 0 ? 0 : 1);
}

/** Room No. cell: NSTP needs no room (a dash), other classes show theirs */
export function roomLabel(r: Pick<DisplayRow, 'room_name' | 'nstp'>): string {
  return r.nstp ? '—' : (r.room_name || 'No room assigned');
}

/** Status of a row still under Pending / Unscheduled */
export function pendingStatus(r: Pick<DisplayRow, 'faculty_name' | 'nstp'>): string {
  if (r.nstp) return 'Set time in Settings';
  return r.faculty_name ? 'Assigned' : 'Unscheduled';
}

/** Course label for print rows — same convention as Faculty Workload Course column. */
export function formatCourseLabel(block: BlockDetail): string {
  const yearNum = (String(block.year_level).match(/\d+/) ?? [''])[0] || block.year_level;
  return [block.program_code, `${yearNum}${block.block_name}`].filter(Boolean).join(' ').trim();
}
// ─── Document settings (campus + signatories, saved in this browser) ─────────

export const CP_SETTINGS_KEY = 'cp_doc_settings_v2'; // v2: earlier saved signatories were blank or shifted
export const CP_COORDINATORS_KEY = 'cp_prepared_by_program';

export const CP_DEFAULTS = {
  campusName: 'Cantilan Campus',
  campusAddress: 'Cantilan, Surigao del Sur',
  campusTel: '086-212-5122',
  campusWebsite: 'www.nemsu.edu.ph',
  recommendedBy: { name: 'RAMONALIZA A. ESPENIDO, MST-SS', designation: 'Registrar III' },
  notedBy: { name: 'ENGR. NELYNE LOURDES Y. PLAZA, Ph.D.', designation: 'Dept. Chair, Dept. of Computer Studies' },
  approvedBy: { name: 'JUANCHO A. INTANO, Ph.D.', designation: 'Campus Director' },
};

export interface ClassProgramDocSettings {
  campusName: string; campusAddress: string;
  /** Footer phone / website (Document Settings) — the address is campusAddress */
  campusTel?: string; campusWebsite?: string;
  preparedBy: Signatory; recommendedBy: Signatory; notedBy: Signatory; approvedBy: Signatory;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

/** The signatories/campus details the Class Program page saved (or the defaults) */
export function loadClassProgramDocSettings(programCode: string | null | undefined): ClassProgramDocSettings {
  const s = readJson<Record<string, string>>(CP_SETTINGS_KEY);
  const coordinators = readJson<Record<string, Signatory>>(CP_COORDINATORS_KEY) ?? {};
  const key = programKey(programCode);
  return {
    campusName: s?.campusName || CP_DEFAULTS.campusName,
    campusAddress: s?.campusAddress || CP_DEFAULTS.campusAddress,
    campusTel: s?.campusTel || CP_DEFAULTS.campusTel,
    campusWebsite: s?.campusWebsite || CP_DEFAULTS.campusWebsite,
    preparedBy: coordinators[key] ?? DEFAULT_COORDINATORS[key] ?? EMPTY_SIGNATORY,
    recommendedBy: { name: s?.recommendedByName || CP_DEFAULTS.recommendedBy.name, designation: s?.recommendedByDesig || CP_DEFAULTS.recommendedBy.designation },
    notedBy: { name: s?.notedByName || CP_DEFAULTS.notedBy.name, designation: s?.notedByDesig || CP_DEFAULTS.notedBy.designation },
    approvedBy: { name: s?.approvedByName || CP_DEFAULTS.approvedBy.name, designation: s?.approvedByDesig || CP_DEFAULTS.approvedBy.designation },
  };
}

// ─── Excel export — the printed Class Program as a sheet ──────────────────────

export async function downloadClassProgramExcel(opts: {
  block: BlockDetail;
  schedules: RawSchedule[];
  combos?: readonly { days: readonly WeekDay[] }[];
  settings: ClassProgramDocSettings;
}): Promise<void> {
  const { block, schedules, settings } = opts;
  const displayRows = expandToDisplayRows(schedules);
  const scheduledRows = displayRows.filter(r => r.day_pattern !== 'TBA');
  const unscheduledRows = displayRows.filter(r => r.day_pattern === 'TBA');
  const dayGroups = groupByDay(scheduledRows, opts.combos ?? []);
  const { buildClassProgramWorkbook } = await import('@shared/classProgramExport');
  const course = formatCourseLabel(block);
  const toRow = (r: DisplayRow) => ({
    time: formatTimeRange(r.start_time, r.end_time),
    code: r.subject_code,
    description: r.subject_name,
    course,
    units: r.is_continuation ? '' as const : r.row_units,
    hours: r.row_hours,
    instructor: r.faculty_name || '',
    room: roomLabel(r),
  });
  // Seal for the header and the footer marks — the file still downloads without them
  const png = (path: string) => fetch(path).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  const [logo, iso, bagong] = await Promise.all([
    png('/nemlogo/NEMSU-logo.png'),
    png('/nemlogo/ISO-UKAS.png'),
    png('/nemlogo/BAGONG-PILIPINAS-LOGO.png'),
  ]);
  const buffer = await buildClassProgramWorkbook({
    logo: logo ? { buffer: logo, extension: 'png' } : undefined,
    department: (block.department || '').trim() || NEMSU_OFFICIAL_DEPT,
    semesterHeading: semesterHeading(block.semester),
    academicYear: formatAy(block.academic_year),
    courseYearSection: `${block.program_code} ${block.year_level} — Block ${block.block_name}`,
    programName: block.program_name || block.program_code,
    dayGroups: dayGroups.map(g => ({
      label: g.label,
      am: g.rows.filter(r => isAM(r.start_time)).map(toRow),
      pm: g.rows.filter(r => !isAM(r.start_time)).map(toRow),
    })),
    unscheduled: unscheduledRows.map(r => ({
      code: r.subject_code,
      description: r.subject_name,
      units: r.row_units,
      hours: r.row_hours,
      instructor: r.faculty_name || 'Not assigned',
      status: pendingStatus(r),
    })),
    totalUnits: scheduledRows.reduce((s, r) => s + r.row_units, 0),
    totalHours: scheduledRows.reduce((s, r) => s + r.row_hours, 0),
    preparedBy: settings.preparedBy,
    recommendedBy: settings.recommendedBy,
    notedBy: settings.notedBy,
    approvedBy: settings.approvedBy,
    // Same footer lines as the printed page
    footer: {
      address: settings.campusAddress || DEFAULT_FOOTER_CONFIG.address,
      phone: settings.campusTel || DEFAULT_FOOTER_CONFIG.phone,
      website: settings.campusWebsite || DEFAULT_FOOTER_CONFIG.website,
    },
    // visibleHeight: how much of each square PNG the mark fills, so both print at the same height
    footerLogos: [{ b: iso, visibleHeight: 0.57 }, { b: bagong, visibleHeight: 0.74 }]
      .filter((l): l is { b: ArrayBuffer; visibleHeight: number } => !!l.b)
      .map(l => ({ buffer: l.b, extension: 'png' as const, visibleHeight: l.visibleHeight })),
  });
  const url = URL.createObjectURL(new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `ClassProgram_${block.program_code}_Block${block.block_name}_${block.semester.replace(/\s+/g, '_')}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Print — the Class Program's paper form as its own document ──────────────

/** "7:00 AM–8:30 AM" may wrap only after the dash (as on the page's TIME/DAY cell) */
function timeCellHtml(label: string): string {
  const m = label.match(/^(.+?–)(.+)$/);
  return m ? `<span class="t-time-a">${esc(m[1])}</span><wbr><span class="t-time-b">${esc(m[2])}</span>` : esc(label);
}

/**
 * The printed Class Program as a standalone HTML document — the same paper form
 * as the Class Program page (header on every page, A.M. / P.M. rows per day
 * group, totals, Pending / Unscheduled, signatories, footer). Reports prints it
 * in place (lib/openPrintHtmlDocument: printHtmlInPlace) without opening the page.
 */
export function buildClassProgramPrintHtml(opts: {
  block: BlockDetail;
  schedules: RawSchedule[];
  combos?: readonly { days: readonly WeekDay[] }[];
  settings: ClassProgramDocSettings;
  origin: string;
}): string {
  const { block, settings, origin } = opts;
  const displayRows = expandToDisplayRows(opts.schedules);
  const scheduledRows = displayRows.filter(r => r.day_pattern !== 'TBA');
  const unscheduledRows = displayRows.filter(r => r.day_pattern === 'TBA');
  const dayGroups = groupByDay(scheduledRows, opts.combos ?? []);
  const totalUnits = scheduledRows.reduce((s, r) => s + r.row_units, 0);
  const totalHours = scheduledRows.reduce((s, r) => s + r.row_hours, 0);
  const course = formatCourseLabel(block);

  const row = (r: DisplayRow) => `<tr>
  <td class="t-time">${timeCellHtml(formatTimeRange(r.start_time, r.end_time))}</td>
  <td class="t-code">${esc(r.subject_code)}</td>
  <td class="t-desc" style="text-align:left">${esc(r.subject_name)}</td>
  <td class="t-course">${esc(course)}</td>
  <td class="t-units">${r.is_continuation ? '' : fmtNum(r.row_units)}</td>
  <td class="t-hours">${fmtNum(r.row_hours)}</td>
  <td class="t-inst">${esc(r.faculty_name ?? '')}</td>
  <td class="t-room">${r.nstp ? '—' : r.room_name ? esc(r.room_name) : '<span class="no-room">No room assigned</span>'}</td>
</tr>`;
  const emptyRow = '<tr class="dr-empty"><td colspan="8"></td></tr>';

  const schedule = dayGroups.length > 0 ? `
<table class="wl">
  <colgroup>
    <col class="t-time"><col class="t-code"><col style="width:24%"><col class="t-course">
    <col class="t-units"><col class="t-hours"><col class="t-inst"><col class="t-room">
  </colgroup>
  <thead><tr>
    <th>TIME/DAY</th><th>Subject<br>Code</th><th>Description</th><th>Course</th>
    <th>Units</th><th>No. of<br>Hours</th><th>Instructor/Professor</th><th>Room No.</th>
  </tr></thead>
  <tbody>
    ${dayGroups.map((g: DayGroup) => {
      const am = g.rows.filter(r => isAM(r.start_time));
      const pm = g.rows.filter(r => !isAM(r.start_time));
      return `<tr class="sec-hdr"><td>A.M.</td><td colspan="7">${esc(g.label)}</td></tr>
    ${am.length ? am.map(row).join('') : emptyRow}
    <tr class="sec-hdr"><td>P.M.</td><td colspan="7" style="font-style:italic;text-align:center">Lunch Break</td></tr>
    ${pm.length ? pm.map(row).join('') : emptyRow}`;
    }).join('')}
    <tr class="tr-total">
      <td colspan="4" class="c-right">Total Number of Units</td>
      <td class="c-center">${fmtNum(totalUnits)}</td>
      <td class="c-center">${fmtNum(totalHours)}</td>
      <td colspan="2"></td>
    </tr>
  </tbody>
</table>` : '<p style="text-align:center;padding:16pt 0;font-size:8.5pt;color:#555">No subjects have been scheduled yet.</p>';

  const pending = unscheduledRows.length > 0 ? `
<table class="wl" style="margin-top:8px">
  <thead>
    <tr class="sec-hdr"><td colspan="6">Pending / Unscheduled Subjects</td></tr>
    <tr>
      <th style="width:10%">Subject<br>Code</th><th style="width:32%">Description</th><th style="width:7%">Units</th>
      <th style="width:7%">Hours</th><th style="width:32%">Instructor/Professor</th><th style="width:12%">Status</th>
    </tr>
  </thead>
  <tbody>
    ${unscheduledRows.map(r => `<tr>
      <td class="t-code">${esc(r.subject_code)}</td>
      <td class="t-desc" style="text-align:left">${esc(r.subject_name)}</td>
      <td class="t-units">${fmtNum(r.row_units)}</td>
      <td class="t-hours">${fmtNum(r.row_hours)}</td>
      <td class="t-inst">${r.faculty_name ? esc(r.faculty_name) : '<span class="no-room">Not assigned</span>'}</td>
      <td class="t-status">${esc(pendingStatus(r))}</td>
    </tr>`).join('')}
  </tbody>
</table>` : '';

  const signer = (s: Signatory) => `<div class="nm">${s.name ? esc(s.name) : '&nbsp;'}</div>${s.designation ? `<div class="tt">${esc(s.designation)}</div>` : ''}`;
  const signatures = `
<table class="sig"><tbody>
  <tr>
    <td style="width:50%;padding-right:20px" class="lbl">Prepared by:</td>
    <td style="width:50%;padding-left:20px" class="lbl">Recommending Approval:</td>
  </tr>
  <tr class="sp"><td></td><td></td></tr>
  <tr>
    <td style="padding:0 20px 0 0;text-align:left">${signer(settings.preparedBy)}</td>
    <td style="padding:0 0 0 20px" class="blk">${signer(settings.recommendedBy)}</td>
  </tr>
  <tr><td colspan="2" class="lbl sec" style="text-align:center">Noted by:</td></tr>
  <tr class="sp"><td colspan="2"></td></tr>
  <tr><td colspan="2" class="blk" style="padding:0 25%">${signer(settings.notedBy)}</td></tr>
  <tr><td colspan="2" class="lbl sec" style="text-align:center">Approved:</td></tr>
  <tr class="sp"><td colspan="2"></td></tr>
  <tr><td colspan="2" class="blk" style="padding:0 25%">${signer(settings.approvedBy)}</td></tr>
</tbody></table>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Class Program — ${esc(course)}</title>
<style>
${officialPrintDocumentCss()}
/* "BSIT 1A" stays on one line, as on the Class Program page */
.wl td.t-course { white-space: nowrap; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
.wl tbody tr { page-break-inside: avoid; }
</style>
</head>
<body>
<div class="page">
${officialPrintPagedHtml(officialPrintHeaderHtml({
    logoSrc: `${origin}/nemlogo/NEMSU-logo.png`,
    department: (block.department || '').trim() || NEMSU_OFFICIAL_DEPT,
    title: 'CLASS PROGRAM',
    semesterHeading: semesterHeading(block.semester),
    academicYear: block.academic_year,
  }), `
<div class="info">
  <div class="info-left" style="flex:1 1 auto">
    <div class="hf"><span class="i-lbl">Course/Year/Section:</span><span class="i-val"><strong>${esc(block.program_code)} ${esc(block.year_level)} — Block ${esc(block.block_name)}</strong></span></div>
    <div class="hf"><span class="i-lbl">Program:</span><span class="i-val">${esc(block.program_name || block.program_code)}</span></div>
  </div>
</div>
${schedule}
${pending}
${signatures}`)}
</div>
${footerHtml({
    address: settings.campusAddress || DEFAULT_FOOTER_CONFIG.address,
    phone: settings.campusTel || DEFAULT_FOOTER_CONFIG.phone,
    website: settings.campusWebsite || DEFAULT_FOOTER_CONFIG.website,
    logoOrigin: origin,
  })}
</body>
</html>`;
}

/** Load a block's class program from the API (same request as the Class Program page) */
export async function fetchClassProgram(params: { blockId: string; programId: string; yearLevel: string; semester: string }) {
  const res = await fetch(`/api/class-program?${new URLSearchParams({
    block_id: params.blockId, program_id: params.programId, year_level: params.yearLevel, semester: params.semester,
  })}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load class program.');
  return { block: data.block as BlockDetail, schedules: (data.schedules ?? []) as RawSchedule[] };
}
