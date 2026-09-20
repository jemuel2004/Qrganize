export const CURRICULUM_VERSIONS = ['old', 'new'] as const;
export type CurriculumVersion = (typeof CURRICULUM_VERSIONS)[number];

/** Unspecified version / blocks / existing live data use Old Curriculum. */
export const DEFAULT_CURRICULUM_VERSION: CurriculumVersion = 'old';

export const CURRICULUM_VERSION_STORAGE_KEY = 'qrganize.curriculumVersion.v2';

export function isCurriculumVersion(value: unknown): value is CurriculumVersion {
  return value === 'new' || value === 'old';
}

export function parseCurriculumVersion(value: unknown): CurriculumVersion | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'new' || v === 'new curriculum') return 'new';
  if (v === 'old' || v === 'old curriculum') return 'old';
  return null;
}

export function curriculumVersionLabel(version: CurriculumVersion): string {
  return version === 'old' ? 'Old Curriculum' : 'New Curriculum';
}

/** Compact curriculum tag for dense dropdowns (Old → OC, New → N). */
export function curriculumVersionAbbrev(version: CurriculumVersion): string {
  return version === 'new' ? 'N' : 'OC';
}

export function curriculumVersionFileSlug(version: CurriculumVersion): string {
  return version === 'old' ? 'Old' : 'New';
}

/** Blocks without a stored version are treated as Old Curriculum. */
export function blockCurriculumVersion(value: unknown): CurriculumVersion {
  return parseCurriculumVersion(value) ?? DEFAULT_CURRICULUM_VERSION;
}
