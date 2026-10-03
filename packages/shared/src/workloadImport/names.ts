import { cellText } from './sheet';

/*
 * Reading names and codes written on the workload forms: people, employment
 * status, courses (program + year + block), subject codes and rooms. Each
 * helper normalises harmless differences (case, spacing, dots, dashes) and
 * nothing more — deciding whether two records are the same is left to the
 * caller.
 */

export interface PersonName {
  first: string;
  middle: string;
  last: string;
}

const HONORIFIC = /^(engr|dr|mr|mrs|ms|prof|atty|hon)\.?$/i;

/**
 * "ENGR. MARCEL L. BUDLONG" → Marcel / L. / Budlong (as written, case kept).
 * Titles before the name and degrees after a comma ("…, PhD") are dropped;
 * a single-letter middle initial splits first from last name. Null when the
 * text is not a person's name (e.g. "IT 9").
 */
export function parsePersonName(raw: unknown): PersonName | null {
  const base = cellText(raw).split(',')[0].replace(/\.(?=[A-Za-z])/g, '. ');
  const tokens = base.split(' ').filter(Boolean);
  while (tokens.length && HONORIFIC.test(tokens[0])) tokens.shift();
  if (tokens.length < 2 || tokens.some(t => /\d/.test(t))) return null;
  let mid = -1;
  for (let i = tokens.length - 2; i >= 1; i--) {
    if (/^[A-Za-z]\.?$/.test(tokens[i])) { mid = i; break; }
  }
  if (mid > 0) {
    const initial = tokens[mid].replace(/\.?$/, '.');
    return { first: tokens.slice(0, mid).join(' '), middle: initial, last: tokens.slice(mid + 1).join(' ') };
  }
  return { first: tokens.slice(0, -1).join(' '), middle: '', last: tokens[tokens.length - 1] };
}

/** Upper-case letters and single spaces only — "Chectoper" vs "CHECTOPER" compare equal */
export const nameWord = (s: string) => s.toUpperCase().replace(/[^A-Z\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** "Arnold C. Lugo" style — each word capitalised (initials keep their dot) */
export function titleCaseName(s: string): string {
  return cellText(s)
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Levenshtein distance — small spelling differences in names */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Same person written two ways: identical last name and a first name that is
 * identical or differs by a letter or two ("Russell" / "Russel",
 * "Chectopher" / "Chectoper") with the same first letter. Different people
 * who share a surname ("Jhon Fred" / "Juspher Angelo") never match.
 */
export function samePerson(a: Pick<PersonName, 'first' | 'last'>, b: Pick<PersonName, 'first' | 'last'>): 'exact' | 'spelling' | null {
  const al = nameWord(a.last), bl = nameWord(b.last);
  const af = nameWord(a.first), bf = nameWord(b.first);
  if (!al || al !== bl || !af || !bf) return null;
  if (af === bf) return 'exact';
  if (af[0] !== bf[0]) return null;
  const limit = Math.min(af.length, bf.length) >= 6 ? 2 : 1;
  return editDistance(af, bf) <= limit ? 'spelling' : null;
}

export type FacultyClassification = 'Permanent' | 'Contractual' | 'Part-time';

/**
 * The form's "Status:" line as a QRganize classification. "Temporary
 * Permanent" is Permanent. Academic ranks or blanks ("Instructor I",
 * "Temporary Instructor", "") are not a classification → null.
 */
export function classifyStatus(status: string): FacultyClassification | null {
  const s = cellText(status);
  if (/contract/i.test(s)) return 'Contractual';
  if (/permanent/i.test(s)) return 'Permanent';
  if (/part[\s-]*tim/i.test(s)) return 'Part-time';
  return null;
}

export type SheetKind = 'actual' | 'regular' | 'overload' | 'praise' | 'unknown';

/**
 * Which form a sheet is. The sheet name wins for "actual" (some actual-load
 * sheets keep the "Regular Load" footer); "Service Credit" is the Praise form.
 */
export function classifySheet(sheetName: string, category: string): SheetKind {
  const name = cellText(sheetName), cat = cellText(category);
  if (/actual/i.test(name) || /^a(c)?tual/i.test(cat) || /\bacual\b/i.test(cat)) return 'actual';
  if (/praise|service\s*credit/i.test(cat)) return 'praise';
  if (/overload/i.test(cat)) return 'overload';
  if (/regular/i.test(cat)) return 'regular';
  if (/praise/i.test(name)) return 'praise';
  if (/overload/i.test(name)) return 'overload';
  return 'unknown';
}

export interface CourseRef {
  /** BSIT / BSCS / BSCPE, or null when the course names no program ("1F") */
  program: string | null;
  year: number | null;
  /** Block letter, or null when the course names none ("BSIT 2") */
  block: string | null;
}

const PROGRAM_ALIASES: Record<string, string> = { BSIT: 'BSIT', IT: 'BSIT', BSCS: 'BSCS', CS: 'BSCS', BSCPE: 'BSCPE', CPE: 'BSCPE' };

/** "BSIT 2F", "BSIT2H", "CS 3B", "CpE 1C", "BSCpE 1A" → program, year, block */
export function parseCourse(raw: unknown): CourseRef {
  const t = cellText(raw).toUpperCase().replace(/\s+/g, '');
  const m = t.match(/^([A-Z]+)?(\d)([A-Z])?$/);
  if (!m) return { program: null, year: null, block: null };
  const program = m[1] ? PROGRAM_ALIASES[m[1]] ?? null : null;
  return { program, year: Number(m[2]), block: m[3] ?? null };
}

/** "GE--PC", "GE - AA", "PathFit 3", "IT412" → GEPC, GEAA, PATHFIT3, IT412 */
export const codeKey = (code: unknown) => cellText(code).toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface RoomKey {
  kind: 'lab' | 'lec' | 'other';
  number: number | null;
  /** Comparison key: "lab:3", "lec:6", or letters+digits ("MP1", "ROBLAB") */
  key: string;
}

/**
 * "Lab. 12", "LAB 1", "Laboratory-12" → lab 12; "Lec. 6", "Lec.3",
 * "Lecture-6" → lec 6. Any other name compares by its letters and digits
 * ("M.P. 3" = "M.P 3", "CS Lab 4" stays distinct from Laboratory-4).
 */
export function roomKey(raw: unknown): RoomKey {
  const t = cellText(raw);
  const lab = t.match(/^(lab|laboratory)\s*[.\-]?\s*(\d+)$/i);
  if (lab) return { kind: 'lab', number: Number(lab[2]), key: `lab:${Number(lab[2])}` };
  const lec = t.match(/^(lec|lecture)\s*[.\-]?\s*(\d+)$/i);
  if (lec) return { kind: 'lec', number: Number(lec[2]), key: `lec:${Number(lec[2])}` };
  return { kind: 'other', number: null, key: t.toUpperCase().replace(/[^A-Z0-9]/g, '') };
}

/** Year level as stored in QRganize: 2 → "2nd Year" */
export function yearLevelLabel(year: number): string {
  const suffix = year === 1 ? 'st' : year === 2 ? 'nd' : year === 3 ? 'rd' : 'th';
  return `${year}${suffix} Year`;
}
