import { normalizeComparableText } from './curriculumImport/compareExisting';

export interface SubjectRef {
  subject_code: string;
  subject_name: string;
}

/**
 * Tidy display spelling for a course code.
 * "GE - AA", "ge-aa" and "GE  -AA" all become "GE-AA"; "CPE  1" becomes "CPE 1".
 */
export function canonicalSubjectCode(code: string | null | undefined): string {
  return String(code ?? '')
    .toUpperCase()
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Exact code + title identity (case, spacing, dashes, apostrophes ignored). */
export function subjectKey(code: string | null | undefined, title: string | null | undefined): string {
  const norm = (v: string | null | undefined) =>
    normalizeComparableText(String(v ?? '').replace(/['’‘.]/g, ''));
  return `${norm(code)}|${norm(title)}`;
}

/** "CS 122", "CS122" and "cs-122" compare equal. */
function codeKey(code: string | null | undefined): string {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const FILLER = new Set(['the', 'a', 'an', 'of', 'in', 'and', 'for', 'with', 'to', 'on']);

/** Title reduced to its meaningful words: no brackets, punctuation or filler words. */
function titleKey(title: string | null | undefined): string {
  return normalizeComparableText(
    String(title ?? '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/['’‘.,:;&]/g, ''),
  )
    .split(' ')
    .filter(w => w && !FILLER.has(w))
    .join(' ');
}

/** Dice similarity over letter pairs — 1 for identical, near 0 for unrelated. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const pairs = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i + 2);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const pa = pairs(a);
  const pb = pairs(b);
  let shared = 0;
  for (const [k, n] of pa) shared += Math.min(n, pb.get(k) ?? 0);
  const total = Math.max(a.length - 1, 0) + Math.max(b.length - 1, 0);
  return total ? (2 * shared) / total : 0;
}

/**
 * Checked against the real BSCpE/BSIT/BSCS curricula: title variants of one
 * subject (typos, "The", "Reading/Readings", a missing "1") score 0.76+, while
 * different subjects sharing a code (Ethics vs Gender and Society, Calculus vs
 * Statistics) score 0.20 or less.
 */
const SAME_TITLE_THRESHOLD = 0.75;

/** 0–1 likeness of two descriptive titles (brackets, punctuation and filler words ignored) */
export function subjectTitleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  return similarity(titleKey(a), titleKey(b));
}

/**
 * Same subject across programs: same course code and the same (or nearly the
 * same) descriptive title, whether it sits in BSCpE, BSIT or BSCS.
 */
export function isSameSubject(a: SubjectRef, b: SubjectRef): boolean {
  if (codeKey(a.subject_code) !== codeKey(b.subject_code)) return false;
  return similarity(titleKey(a.subject_name), titleKey(b.subject_name)) >= SAME_TITLE_THRESHOLD;
}

/**
 * Collapses a list to one entry per subject, keeping the first of each group
 * (callers sort the preferred spelling first). Codes come back tidied.
 */
export function mergeSameSubjects<T extends SubjectRef>(list: T[]): T[] {
  const kept: T[] = [];
  for (const s of list) {
    if (!kept.some(k => isSameSubject(k, s))) {
      kept.push({
        ...s,
        subject_code: canonicalSubjectCode(s.subject_code),
        subject_name: String(s.subject_name ?? '').replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return kept;
}
