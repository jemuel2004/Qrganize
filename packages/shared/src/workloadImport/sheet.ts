import { normalizeDay, parseDays, WEEK_DAYS, type WeekDay } from '../dayCombination';

/*
 * Faculty teaching-load workbook (NEMSU form FM-ACAD-024), one form per sheet.
 *
 * A form has a header (Name, Status, Educational Qualification, …), a
 * timetable and a footer. In the timetable, column A holds day-group headings
 * ("MTh/Morning", "Wed/Afternoon", "TF/Morning", "DAILY/Afternoon",
 * "SATURDAY") and time ranges written on a 12-hour clock without AM/PM
 * ("7:00-8:30", "1:00-2:30"). The footer has Designation / "Add: …" rows and
 * "Total No. of Units", whose column C names the form's load category
 * (Regular Load, Overload, Praise, Service Credit, Actual Load).
 *
 * Columns: A time/day · B subject code · C description · D course (program,
 * year and block) · E students · F units · G hours · H room. Anything right of
 * column H is side notes and is ignored.
 *
 * This file only reads what a form says; matching it to QRganize records is
 * done by the backend import planner.
 */

export interface WorkloadSheetInput {
  name: string;
  hidden?: boolean;
  /** Displayed cell text, row by row (column A = index 0). */
  rows: unknown[][];
}

export type ComponentMarker = 'lec' | 'lab';

/** Minutes from midnight on a 24-hour clock. */
export interface MinuteRange {
  start: number;
  end: number;
}

export interface WorkloadRow {
  sheet: string;
  /** 1-based worksheet row */
  row: number;
  kind: 'class' | 'activity';
  /** Day-group heading the row sits under, as written ("MTh", "TF", "DAILY", …) */
  dayGroup: string;
  /** Meeting days in week order; empty when the heading is missing or unreadable */
  days: WeekDay[];
  timeText: string;
  time: MinuteRange | null;
  code: string;
  description: string;
  course: string;
  students: number | null;
  units: number | null;
  hours: number | null;
  room: string;
  /** "(Lec)" / "(Lab)" written in the description */
  marker: ComponentMarker | null;
  /** How an irregular row was read */
  notes: string[];
}

export interface WorkloadFooter {
  row: number;
  /** "Designation", "Research/Extension", "Special Assignment", … */
  label: string;
  description: string;
  units: number | null;
}

export interface WorkloadSheet {
  name: string;
  hidden: boolean;
  facultyName: string;
  status: string;
  /** Column C of "Total No. of Units" — the form's load category */
  category: string;
  qualification: string;
  yearsInService: string;
  major: string;
  eligibility: string;
  rows: WorkloadRow[];
  footers: WorkloadFooter[];
}

/** Trimmed text with inner whitespace collapsed */
export const cellText = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

const cellNumber = (value: unknown): number | null => {
  const t = cellText(value).replace(/,/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const MON_TO_FRI: WeekDay[] = WEEK_DAYS.slice(0, 5) as WeekDay[];

export interface DayHeading {
  group: string;
  days: WeekDay[];
  period: 'morning' | 'afternoon' | null;
}

/**
 * A timetable heading — "MTh/Morning", "TF/Afternoon", "Wed/Morning",
 * "DAILY/Afternoon", "M-F/Morning", "SATURDAY". Null for anything else
 * (time ranges, labels).
 */
export function parseDayHeading(raw: unknown): DayHeading | null {
  const t = cellText(raw);
  if (!t || /\d/.test(t)) return null;
  const parts = t.split('/').map(s => s.trim());
  if (parts.length > 2) return null;
  const [groupRaw, periodRaw = ''] = parts;
  let period: DayHeading['period'] = null;
  if (/^morning$/i.test(periodRaw)) period = 'morning';
  else if (/^(afternoon|evening)$/i.test(periodRaw)) period = 'afternoon';
  else if (periodRaw) return null;
  const days = /^(daily|m\s*-\s*f)$/i.test(groupRaw) ? MON_TO_FRI : parseDays(groupRaw);
  if (!days || days.length === 0) return null;
  return { group: groupRaw, days: [...days], period };
}

/**
 * A time range written on a 12-hour clock without AM/PM. School hours decide
 * the half of the day: a start of 7–11 is morning, 12 is noon, 1–5 is
 * afternoon; 6 follows the heading (6:00 morning slot vs 6:00 PM). The end is
 * the first matching clock time after the start ("5:30-7:00" → 5:30–7:00 PM).
 * "1:006:00" (dash left out) is read as 1:00–6:00.
 */
export function parseClockRange(
  raw: unknown,
  period: DayHeading['period'] = null,
): { range: MinuteRange; note?: string } | null {
  const compact = cellText(raw).replace(/\s+/g, '');
  const m = compact.match(/^(\d{1,2}):(\d{2})(-*)(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, h1, m1, dash, h2, m2] = m;
  const sh = Number(h1), sm = Number(m1), eh = Number(h2), em = Number(m2);
  if (sm > 59 || em > 59 || eh > 23) return null;

  let startHour: number;
  if (sh >= 7 && sh <= 11) startHour = sh;
  else if (sh === 12) startHour = 12;
  else if (sh >= 1 && sh <= 5) startHour = sh + 12;
  else if (sh === 6) startHour = period === 'morning' ? 6 : 18;
  else if (sh >= 13 && sh <= 23) startHour = sh;
  else return null;
  const start = startHour * 60 + sm;

  const ends = eh >= 13 ? [eh * 60 + em] : [(eh % 12) * 60 + em, ((eh % 12) + 12) * 60 + em];
  const end = ends.find(e => e > start);
  if (end === undefined || end - start > 12 * 60) return null;
  return { range: { start, end }, note: dash ? undefined : `time "${cellText(raw)}" read as a range without its dash` };
}

/** "(Lec)" / "(Lab)" in a description */
export function componentMarker(description: string): ComponentMarker | null {
  if (/\(\s*(lec|lecture)\s*\)/i.test(description)) return 'lec';
  if (/\(\s*(lab|laboratory)\s*\)/i.test(description)) return 'lab';
  return null;
}

/** "Flag Ceremony (Monday)" — an activity held on one named day of its day group */
function namedDay(description: string): WeekDay | null {
  const m = description.match(/\(\s*([A-Za-z]+)\s*\)/);
  return m ? normalizeDay(m[1]) : null;
}

const HEADER_LABELS: { field: 'facultyName' | 'status' | 'yearsInService' | 'qualification' | 'major' | 'eligibility'; re: RegExp }[] = [
  { field: 'facultyName', re: /^name\s*:/i },
  { field: 'status', re: /^status\s*:/i },
  { field: 'yearsInService', re: /^years\s+in\s+service\s*:/i },
  { field: 'qualification', re: /^educ\S*\s+qualification\s*:/i },
  { field: 'major', re: /^major\s*:/i },
  { field: 'eligibility', re: /^eligibility(\s*\/\s*prc)?\s*:/i },
];

const FORM_COLUMNS = 8; // A–H

/** Read one teaching-load form. */
export function parseWorkloadSheet(input: WorkloadSheetInput): WorkloadSheet {
  const rows = input.rows.map(r => (Array.isArray(r) ? r : []));
  const sheet: WorkloadSheet = {
    name: input.name,
    hidden: !!input.hidden,
    facultyName: '', status: '', category: '',
    qualification: '', yearsInService: '', major: '', eligibility: '',
    rows: [], footers: [],
  };

  const headerRow = rows.findIndex(r => /^TIME\s*\/\s*DAY/i.test(cellText(r[0])));
  const headerEnd = headerRow >= 0 ? headerRow : Math.min(rows.length, 12);
  for (let r = 0; r < headerEnd; r++) {
    for (let c = 0; c < FORM_COLUMNS; c++) {
      const t = cellText(rows[r][c]);
      const label = HEADER_LABELS.find(l => l.re.test(t));
      if (label && !sheet[label.field]) sheet[label.field] = cellText(t.slice(t.indexOf(':') + 1).replace(/^[\s:]+/, ''));
    }
  }

  let tableEnd = rows.length;
  if (headerRow >= 0) {
    const found = rows.findIndex((r, i) => i > headerRow && /^No\.?\s*of\s+Units/i.test(cellText(r[0])));
    if (found >= 0) tableEnd = found;
  }

  for (let r = Math.max(headerRow, 0); r < rows.length; r++) {
    const a = cellText(rows[r][0]);
    if (/^Total\s+No\.?\s*of\s+Units/i.test(a)) sheet.category = cellText(rows[r][2]);
    if (r < tableEnd && headerRow >= 0) continue;
    const footer = a.match(/^(Designation|Add\s*:\s*(.*))$/i);
    if (footer) {
      const label = footer[2] !== undefined ? cellText(footer[2]).replace(/:$/, '') : 'Designation';
      sheet.footers.push({ row: r + 1, label, description: cellText(rows[r][2]), units: cellNumber(rows[r][5]) });
    }
  }
  if (headerRow < 0) return sheet;

  /** First heading below row r — used when a heading is missing above a group */
  const nextHeading = (r: number): DayHeading | null => {
    for (let i = r + 1; i < tableEnd; i++) {
      const h = parseDayHeading(rows[i][0]);
      if (h) return h;
    }
    return null;
  };

  let heading: DayHeading | null = null;
  let period: DayHeading['period'] = null;
  for (let r = headerRow + 2; r < tableEnd; r++) {
    const row = rows[r];
    const a = cellText(row[0]);
    const cells = Array.from({ length: FORM_COLUMNS - 1 }, (_, i) => cellText(row[i + 1]));
    // B–D carry the entry; numbers alone (E–H) are template formulas
    const hasContent = cells.slice(0, 3).some(Boolean);
    const h = parseDayHeading(a);
    if (h && !hasContent) {
      heading = h;
      period = h.period;
      continue;
    }
    if (!hasContent) continue; // empty template slot

    const notes: string[] = [];
    const parsed = parseClockRange(a, period);
    if (!parsed) notes.push(a ? `time "${a}" could not be read` : 'no time written');
    else if (parsed.note) notes.push(parsed.note);

    if (parsed && heading) {
      const morning = parsed.range.start < 12 * 60;
      if (morning && period === 'afternoon') {
        // A morning time below an afternoon heading: the next group's morning
        // heading is missing (its rows follow the previous group's afternoon).
        const next = nextHeading(r);
        if (next) {
          notes.push(`day heading missing above this row — read as ${next.group} (the heading that follows)`);
          heading = { ...next, period: 'morning' };
        } else {
          notes.push('day heading missing above this row');
          heading = null;
        }
        period = 'morning';
      } else if (!morning && period === 'morning') {
        period = 'afternoon'; // afternoon heading left out
      }
    }

    const [code, description, course, students, units, hours, room] = cells;
    const kind: WorkloadRow['kind'] = code || course ? 'class' : 'activity';
    let days = heading ? [...heading.days] : [];
    if (kind === 'activity') {
      const only = namedDay(description);
      if (only && days.includes(only)) days = [only];
    }
    sheet.rows.push({
      sheet: input.name,
      row: r + 1,
      kind,
      dayGroup: heading?.group ?? '',
      days,
      timeText: a,
      time: parsed?.range ?? null,
      code,
      description,
      course,
      students: cellNumber(students),
      units: cellNumber(units),
      hours: cellNumber(hours),
      room,
      marker: componentMarker(description),
      notes,
    });
  }
  return sheet;
}
