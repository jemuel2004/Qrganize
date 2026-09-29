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

/**
 * Source of truth for saved rows: Subject Type is stored as hours, not a column.
 * Lecture only (no lab hours) → Minor
 * Laboratory only, or Lecture + Laboratory (lab hours > 0) → Major
 */
export function categoryFromHours(
  lectureHours: unknown,
  laboratoryHours: unknown,
): SubjectCategory {
  const lab = Number(laboratoryHours) || 0;
  return lab > 0 ? 'Major' : 'Minor';
}

/** Form-side mapping from the selected Subject Type control. */
export function categoryFromSubjectType(
  type: CurriculumSubjectType | '' | string,
): SubjectCategory {
  if (type === 'Laboratory' || type === 'Lecture + Laboratory') return 'Major';
  return 'Minor';
}

/** PostgreSQL expression using hour columns. Pass a table alias when joining. */
export function subjectCategorySql(alias = ''): string {
  const col = alias ? `${alias}.laboratory_hours` : 'laboratory_hours';
  return `CASE WHEN COALESCE(${col}, 0) > 0 THEN 'Major' ELSE 'Minor' END`;
}
