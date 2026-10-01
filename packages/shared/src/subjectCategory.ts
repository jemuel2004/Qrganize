export const SUBJECT_CATEGORIES = ['Minor', 'Major'] as const;
export type SubjectCategory = (typeof SUBJECT_CATEGORIES)[number];

export type CurriculumSubjectType = 'Lecture' | 'Laboratory' | 'Lecture + Laboratory';

/** Accept only explicit Major/Minor labels. Never infer from subject codes. */
export function parseSubjectCategory(value: unknown): SubjectCategory | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'minor') return 'Minor';
  if (normalized === 'major') return 'Major';
  return null;
}

export function coerceSubjectCategory(
  value: unknown,
  fallback: SubjectCategory = 'Minor',
): SubjectCategory {
  return parseSubjectCategory(value) ?? fallback;
}

/** Program course codes that are always Major: CS, CPE, IT ("CS 211", "CS326", "CPE 101", "IT 1"). */
const MAJOR_CODE_PREFIX = /^(CS|CPE|IT)(?![A-Z])/i;

export function isMajorCourseCode(subjectCode: unknown): boolean {
  return MAJOR_CODE_PREFIX.test(String(subjectCode ?? '').trim());
}

/**
 * Source of truth for saved rows (category is derived, never typed in):
 * CS / CPE / IT course code → Major, even when lecture only
 * Any laboratory hours → Major
 * Everything else (lecture only, other codes) → Minor
 */
export function categoryFromHours(
  lectureHours: unknown,
  laboratoryHours: unknown,
  subjectCode: unknown,
): SubjectCategory {
  const lab = Number(laboratoryHours) || 0;
  return lab > 0 || isMajorCourseCode(subjectCode) ? 'Major' : 'Minor';
}

/** Form-side mapping from the selected Subject Type control and the typed course code. */
export function categoryFromSubjectType(
  type: CurriculumSubjectType | '' | string,
  subjectCode: unknown,
): SubjectCategory {
  if (type === 'Laboratory' || type === 'Lecture + Laboratory') return 'Major';
  return isMajorCourseCode(subjectCode) ? 'Major' : 'Minor';
}

/** PostgreSQL expression matching categoryFromHours. Pass a table alias when joining. */
export function subjectCategorySql(alias = ''): string {
  const p = alias ? `${alias}.` : '';
  return `CASE WHEN COALESCE(${p}laboratory_hours, 0) > 0
                 OR UPPER(TRIM(${p}subject_code)) ~ '^(CS|CPE|IT)([^A-Z]|$)'
               THEN 'Major' ELSE 'Minor' END`;
}
