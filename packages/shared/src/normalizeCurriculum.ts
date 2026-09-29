/**
 * Canonical-value normalizers for year_level and semester.
 * Shared by Curriculum Setup APIs and the Excel importer.
 */

const YEAR_MAP: Record<string, string> = {
  'first year': '1st Year', '1st year': '1st Year', '1 year': '1st Year',
  'year 1': '1st Year', 'year i': '1st Year', 'i year': '1st Year',
  '1': '1st Year', '1st': '1st Year', 'first': '1st Year',
  'second year': '2nd Year', '2nd year': '2nd Year', '2 year': '2nd Year',
  'year 2': '2nd Year', 'year ii': '2nd Year', 'ii year': '2nd Year',
  '2': '2nd Year', '2nd': '2nd Year', 'second': '2nd Year',
  'third year': '3rd Year', '3rd year': '3rd Year', '3 year': '3rd Year',
  'year 3': '3rd Year', 'year iii': '3rd Year', 'iii year': '3rd Year',
  '3': '3rd Year', '3rd': '3rd Year', 'third': '3rd Year',
  'fourth year': '4th Year', '4th year': '4th Year', '4 year': '4th Year',
  'year 4': '4th Year', 'year iv': '4th Year', 'iv year': '4th Year',
  '4': '4th Year', '4th': '4th Year', 'fourth': '4th Year',
};

const SEM_MAP: Record<string, string> = {
  'first semester': '1st Semester', '1st semester': '1st Semester',
  '1 semester': '1st Semester', 'semester 1': '1st Semester',
  'first sem': '1st Semester', '1st sem': '1st Semester',
  'sem 1': '1st Semester', '1 sem': '1st Semester',
  'sem. 1': '1st Semester', '1st sem.': '1st Semester',
  'second semester': '2nd Semester', '2nd semester': '2nd Semester',
  '2 semester': '2nd Semester', 'semester 2': '2nd Semester',
  'second sem': '2nd Semester', '2nd sem': '2nd Semester',
  'sem 2': '2nd Semester', '2 sem': '2nd Semester',
  'sem. 2': '2nd Semester', '2nd sem.': '2nd Semester',
  'summer': 'Summer', 'summer semester': 'Summer',
  'summer sem': 'Summer', 'summer term': 'Summer', 'summer class': 'Summer',
};

export function normalizeYearLevel(raw: string | null | undefined): string {
  if (!raw) return '';
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return YEAR_MAP[key] ?? raw.trim();
}

export function normalizeSemester(raw: string | null | undefined): string {
  if (!raw) return '';
  const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return SEM_MAP[key] ?? raw.trim();
}

export function isCanonicalYearLevel(value: string): boolean {
  return ['1st Year', '2nd Year', '3rd Year', '4th Year'].includes(value);
}

export function isCanonicalSemester(value: string): boolean {
  return ['1st Semester', '2nd Semester', 'Summer'].includes(value);
}
