/**
 * Course-prefix → program-code mapping. Uses program.code / name from the
 * database — never a hard-coded program id.
 */
export interface ProgramRecord {
  id: number;
  code: string;
  name: string;
}

export type ProgramDetectionConfidence = 'high' | 'medium' | 'low' | 'none';

export interface ProgramDetection {
  program: ProgramRecord | null;
  confidence: ProgramDetectionConfidence;
  reason: string;
  prefixCounts: Record<string, number>;
  mappedProgramCode: string | null;
}

/** Prefixes that appear in many programs and must not pick the program. */
export const SHARED_COURSE_PREFIXES = new Set([
  'GE', 'NSTP', 'PATH', 'PATHFIT', 'PE', 'MATH', 'FIL', 'ENG', 'HUM',
  'SOCSCI', 'RIZAL', 'LIT', 'ETHICS', 'HIST', 'PHILHIST',
]);

/**
 * Course prefix → existing program.code values to try, in order.
 * Expand this list when new programs are added; IDs stay in PostgreSQL.
 */
export const COURSE_PREFIX_PROGRAM_CODES: Record<string, string[]> = {
  CS: ['BSCS'],
  IT: ['BSIT'],
  CPE: ['BSCPE', 'BSCpE'],
  CPEE: ['BSCPE'],
  IS: ['BSIS'],
};

function normalizeProgramKey(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function extractCoursePrefix(code: string): { prefix: string; digits: string; strong: boolean } | null {
  const compact = String(code ?? '').toUpperCase().trim();
  if (!compact) return null;
  const match = compact.match(/^([A-Z]{1,12})[^A-Z0-9]*([A-Z0-9]*)$/);
  if (!match) return null;
  const prefix = match[1];
  const tail = match[2] ?? '';
  const digits = (tail.match(/\d+/) ?? [''])[0];
  const strong = digits.length >= 3;
  return { prefix, digits, strong };
}

function findProgramByMappedCode(mappedCodes: string[], programs: ProgramRecord[]): ProgramRecord | null {
  const wanted = mappedCodes.map(normalizeProgramKey);
  return programs.find(program => wanted.includes(normalizeProgramKey(program.code)))
    ?? programs.find(program => wanted.some(code => normalizeProgramKey(program.name).includes(code)))
    ?? null;
}

export function detectProgramFromCourseCodes(
  codes: string[],
  programs: ProgramRecord[],
): ProgramDetection {
  const prefixCounts: Record<string, number> = {};
  const empty: ProgramDetection = {
    program: null,
    confidence: 'none',
    reason: 'No program-identifying course prefixes were found.',
    prefixCounts,
    mappedProgramCode: null,
  };
  if (programs.length === 0 || codes.length === 0) return empty;

  for (const code of codes) {
    const extracted = extractCoursePrefix(code);
    if (!extracted) continue;
    if (SHARED_COURSE_PREFIXES.has(extracted.prefix)) continue;
    if (extracted.prefix === 'IT' && !extracted.strong) continue;
    prefixCounts[extracted.prefix] = (prefixCounts[extracted.prefix] ?? 0) + 1;
  }

  const ranked = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return empty;

  const [topPrefix, topCount] = ranked[0];
  const secondCount = ranked[1]?.[1] ?? 0;
  const mappedCodes = COURSE_PREFIX_PROGRAM_CODES[topPrefix];
  if (!mappedCodes) {
    return {
      program: null,
      confidence: 'low',
      reason: `Course prefix "${topPrefix}" is not mapped to a program.`,
      prefixCounts,
      mappedProgramCode: null,
    };
  }

  const program = findProgramByMappedCode(mappedCodes, programs);
  if (!program) {
    return {
      program: null,
      confidence: 'low',
      reason: `Prefix "${topPrefix}" maps to ${mappedCodes.join('/')} but that program is not in the current program list.`,
      prefixCounts,
      mappedProgramCode: mappedCodes[0] ?? null,
    };
  }

  if (ranked.length > 1 && secondCount >= topCount) {
    return {
      program: null,
      confidence: 'none',
      reason: `Conflicting prefixes (${ranked.map(([p, n]) => `${p}×${n}`).join(', ')}). Review the program before importing.`,
      prefixCounts,
      mappedProgramCode: mappedCodes[0] ?? null,
    };
  }

  const confidence: ProgramDetectionConfidence = topCount >= 3 ? 'high' : topCount === 2 ? 'medium' : 'low';
  return {
    program,
    confidence,
    reason: confidence === 'high'
      ? `Multiple ${topPrefix}-prefixed course codes detected (${topCount}). Shared GE/NSTP/PATH-Fit/Math subjects were ignored.`
      : `${topCount} ${topPrefix}-prefixed course code${topCount === 1 ? '' : 's'} detected.`,
    prefixCounts,
    mappedProgramCode: mappedCodes[0] ?? null,
  };
}
