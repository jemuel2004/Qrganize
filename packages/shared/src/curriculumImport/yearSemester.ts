import {
  isCanonicalSemester,
  isCanonicalYearLevel,
  normalizeSemester,
  normalizeYearLevel,
} from '../normalizeCurriculum';

const YEAR_TOKEN: Record<string, string> = {
  FIRST: '1st Year', SECOND: '2nd Year', THIRD: '3rd Year', FOURTH: '4th Year',
  '1ST': '1st Year', '2ND': '2nd Year', '3RD': '3rd Year', '4TH': '4th Year',
  '1': '1st Year', '2': '2nd Year', '3': '3rd Year', '4': '4th Year',
  I: '1st Year', II: '2nd Year', III: '3rd Year', IV: '4th Year',
};

const SEM_TOKEN: Record<string, string> = {
  FIRST: '1st Semester', SECOND: '2nd Semester',
  '1ST': '1st Semester', '2ND': '2nd Semester',
  '1': '1st Semester', '2': '2nd Semester',
};

export function detectYearSemester(cells: string[]): { yearLevel: string; semester: string } | null {
  const raw = cells.filter(Boolean).join(' ').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const text = raw.toUpperCase();
  if (!/\bYEAR\b|\bYR\b/.test(text) && !/\bSEM(?:ESTER)?\b|\bSUMMER\b/.test(text)) return null;
  if (isSkipLabel(text)) return null;

  let yearLevel = '';
  const yearBefore = text.match(/\b(FIRST|SECOND|THIRD|FOURTH|1ST|2ND|3RD|4TH|[1-4]|I{1,3}|IV)(?:ST|ND|RD|TH)?\s+(?:YEAR|YR)\b/);
  const yearAfter = text.match(/\b(?:YEAR|YR)\s+([1-4]|I{1,3}|IV)\b/);
  if (yearBefore) yearLevel = YEAR_TOKEN[yearBefore[1]] ?? '';
  else if (yearAfter) yearLevel = YEAR_TOKEN[yearAfter[1]] ?? '';
  if (!yearLevel) {
    const normalized = normalizeYearLevel(raw);
    if (isCanonicalYearLevel(normalized)) yearLevel = normalized;
  }
  if (!yearLevel) return null;

  let semester = '';
  if (/\bSUMMER\b/.test(text)) {
    semester = 'Summer';
  } else {
    const semBefore = text.match(/\b(FIRST|SECOND|1ST|2ND|[12])(?:ST|ND)?\s+SEM(?:ESTER)?\b/);
    const semAfter = text.match(/\bSEM(?:ESTER)?\s+([12])\b/);
    if (semBefore) semester = SEM_TOKEN[semBefore[1]] ?? '';
    else if (semAfter) semester = SEM_TOKEN[semAfter[1]] ?? '';
  }
  if (!semester) {
    const normalized = normalizeSemester(raw);
    if (isCanonicalSemester(normalized)) semester = normalized;
  }
  if (!semester) return null;
  return { yearLevel, semester };
}

export function detectYearSemesterFromSheetName(name: string): { yearLevel: string; semester: string } | null {
  const compact = name.replace(/[_]/g, ' ');
  return detectYearSemester([compact])
    ?? detectYearSemester([compact.replace(/^(\d)\s*Y\b/i, '$1st Year').replace(/\b(\d)\s*S\b/i, '$1st Semester')]);
}

function isSkipLabel(text: string): boolean {
  return /^(TOTAL|GRAND TOTAL|SUBTOTAL|SUMMARY|NOTES|REMARKS|CURRICULUM)\b/.test(text.trim());
}

/** Course codes such as CS 111, GE-US, MATH 1, IT 1, NSTP1, PATH-Fit 1. */
export function looksLikeCourseCode(value: string): boolean {
  const code = String(value ?? '').trim();
  if (!code || code.length > 24) return false;
  if (/^(total|grand total|subtotal|summary|notes|remarks)$/i.test(code)) return false;
  if (/\b(curriculum|university|philippines|evaluated|generated)\b/i.test(code)) return false;
  if (detectYearSemester([code])) return false;
  return /^[A-Za-z]{1,12}(?:[\s.\-]*[A-Za-z0-9]{1,12}){0,3}$/.test(code);
}

/**
 * True only for a year/semester *heading* row (Structure A).
 * A data row that also contains "FIRST YEAR - First Semester" plus a course
 * code and title (Structure B) must not be treated as a heading.
 */
export function isSectionHeadingRow(cells: string[]): boolean {
  if (!detectYearSemester(cells)) return false;
  const nonEmpty = cells.filter(Boolean);
  if (nonEmpty.length <= 2) {
    return nonEmpty.every(cell => detectYearSemester([cell]) || !looksLikeCourseCode(cell));
  }
  return !nonEmpty.some(cell => looksLikeCourseCode(cell) && !detectYearSemester([cell]));
}
