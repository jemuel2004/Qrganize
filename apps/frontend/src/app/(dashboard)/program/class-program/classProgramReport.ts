/**
 * Class Program data helpers + Excel export — shared by the Class Program page
 * and Reports, so both build exactly the same rows, groups and workbook.
 */

import { daysKey, parseDays, type WeekDay } from '@shared/dayCombination';
import { NEMSU_OFFICIAL_DEPT, formatAy, semesterHeading } from '@/lib/nemsuOfficialPrintChrome';

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

export function fmt12(t: string): string {
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h}:00` : `${h}:${m.toString().padStart(2, '0')}`;
}

export function formatTimeRange(start: string | null, end: string | null): string {
  if (!start) return '';
  if (!end) return fmt12(start);
  return `${fmt12(start)}-${fmt12(end)}`;
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
    preparedBy: coordinators[key] ?? DEFAULT_COORDINATORS[key] ?? EMPTY_SIGNATORY,
    recommendedBy: { name: s?.recommendedByName || CP_DEFAULTS.recommendedBy.name, designation: s?.recommendedByDesig || CP_DEFAULTS.recommendedBy.designation },
    notedBy: { name: s?.notedByName || CP_DEFAULTS.notedBy.name, designation: s?.notedByDesig || CP_DEFAULTS.notedBy.designation },
    approvedBy: { name: s?.approvedByName || CP_DEFAULTS.approvedBy.name, designation: s?.approvedByDesig || CP_DEFAULTS.approvedBy.designation },
  };
}

// ─── Excel export — formatted like the printed / signed form ─────────────────

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
    room: r.room_name || 'No room assigned',
  });
  // NEMSU seal for the top of the sheet — the file still downloads without it
  const logo = await fetch('/nemlogo/NEMSU-logo.png')
    .then(r => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);
  const buffer = await buildClassProgramWorkbook({
    logo: logo ? { buffer: logo, extension: 'png' } : undefined,
    department: (block.department || '').trim() || NEMSU_OFFICIAL_DEPT,
    campusLine: [settings.campusName, settings.campusAddress].filter(Boolean).join(' — '),
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
      status: r.faculty_name ? 'Assigned' : 'Unscheduled',
    })),
    totalUnits: scheduledRows.reduce((s, r) => s + r.row_units, 0),
    totalHours: scheduledRows.reduce((s, r) => s + r.row_hours, 0),
    preparedBy: settings.preparedBy,
    recommendedBy: settings.recommendedBy,
    notedBy: settings.notedBy,
    approvedBy: settings.approvedBy,
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

/** Load a block's class program from the API (same request as the Class Program page) */
export async function fetchClassProgram(params: { blockId: string; programId: string; yearLevel: string; semester: string }) {
  const res = await fetch(`/api/class-program?${new URLSearchParams({
    block_id: params.blockId, program_id: params.programId, year_level: params.yearLevel, semester: params.semester,
  })}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load class program.');
  return { block: data.block as BlockDetail, schedules: (data.schedules ?? []) as RawSchedule[] };
}
