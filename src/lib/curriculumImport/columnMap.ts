import {
  FIELD_LABELS,
  type ColumnMapping,
  type CurriculumField,
  type MatchStrength,
} from './types';

const AUTO_MAP_MIN = 80;

interface AliasDef {
  field: CurriculumField;
  alias: string;
  confidence: number;
  strength: MatchStrength;
}

function alias(field: CurriculumField, value: string, confidence: number, strength: MatchStrength = 'alias'): AliasDef {
  return { field, alias: normalizeHeader(value), confidence, strength };
}

/** Controlled aliases only — no open-ended fuzzy matching. */
const ALIASES: AliasDef[] = [
  alias('courseCode', 'course code', 100, 'exact'),
  alias('courseCode', 'coursecode', 98, 'alias'),
  alias('courseCode', 'course_code', 98, 'alias'),
  alias('courseCode', 'subject code', 96, 'alias'),
  alias('courseCode', 'subjectcode', 95, 'alias'),
  alias('courseCode', 'subject_code', 95, 'alias'),
  alias('courseCode', 'course id', 90, 'alias'),
  alias('courseCode', 'courseid', 90, 'alias'),
  alias('courseCode', 'code', 88, 'alias'),
  alias('courseCode', 'course', 75, 'possible'),
  alias('courseCode', 'subject', 72, 'possible'),

  alias('descriptiveTitle', 'descriptive title', 100, 'exact'),
  alias('descriptiveTitle', 'course title', 96, 'alias'),
  alias('descriptiveTitle', 'course name', 96, 'alias'),
  alias('descriptiveTitle', 'subject title', 95, 'alias'),
  alias('descriptiveTitle', 'subject name', 95, 'alias'),
  alias('descriptiveTitle', 'description', 90, 'alias'),
  alias('descriptiveTitle', 'title', 88, 'alias'),
  alias('descriptiveTitle', 'descriptive', 82, 'alias'),

  alias('lectureHours', 'lec hours', 100, 'exact'),
  alias('lectureHours', 'lecture hours', 100, 'exact'),
  alias('lectureHours', 'no of lecture hours', 96, 'alias'),
  alias('lectureHours', 'number of lecture hours', 96, 'alias'),
  alias('lectureHours', 'lecture hrs', 95, 'alias'),
  alias('lectureHours', 'lec hrs', 95, 'alias'),
  alias('lectureHours', 'lec', 94, 'alias'),
  alias('lectureHours', 'lecture', 90, 'alias'),

  alias('labHours', 'lab hours', 100, 'exact'),
  alias('labHours', 'laboratory hours', 100, 'exact'),
  alias('labHours', 'no of laboratory hours', 96, 'alias'),
  alias('labHours', 'number of laboratory hours', 96, 'alias'),
  alias('labHours', 'laboratory hrs', 95, 'alias'),
  alias('labHours', 'lab hrs', 95, 'alias'),
  alias('labHours', 'lab', 94, 'alias'),
  alias('labHours', 'laboratory', 90, 'alias'),

  alias('creditUnits', 'credit units', 100, 'exact'),
  alias('creditUnits', 'credit unit', 98, 'alias'),
  alias('creditUnits', 'creditunits', 96, 'alias'),
  alias('creditUnits', 'no of units', 95, 'alias'),
  alias('creditUnits', 'number of units', 95, 'alias'),
  alias('creditUnits', 'credits', 92, 'alias'),
  alias('creditUnits', 'units', 90, 'alias'),
  alias('creditUnits', 'unit', 86, 'alias'),
  alias('creditUnits', 'cu', 84, 'alias'),

  alias('prerequisites', 'pre requisite s', 100, 'exact'),
  alias('prerequisites', 'prerequisite s', 100, 'exact'),
  alias('prerequisites', 'prerequisites', 100, 'exact'),
  alias('prerequisites', 'prerequisite', 98, 'alias'),
  alias('prerequisites', 'pre requisite', 98, 'alias'),
  alias('prerequisites', 'prereq s', 94, 'alias'),
  alias('prerequisites', 'prereq', 92, 'alias'),
  alias('prerequisites', 'required course', 86, 'alias'),
  alias('prerequisites', 'previous course', 84, 'alias'),

  alias('grade', 'grade', 100, 'exact'),
  alias('yearLevel', 'year level', 100, 'exact'),
  alias('yearLevel', 'year', 80, 'alias'),
  alias('semester', 'semester', 100, 'exact'),
  alias('semester', 'sem', 88, 'alias'),
  alias('yearSemester', 'year semester', 100, 'exact'),
  alias('yearSemester', 'year and semester', 96, 'alias'),
  alias('yearSemester', 'year sem', 94, 'alias'),
  alias('yearSemester', 'yr semester', 90, 'alias'),
  alias('yearSemester', 'yr sem', 88, 'alias'),
  alias('yearSemester', 'academic term', 84, 'alias'),
];

const IGNORE_HEADERS = new Set([
  'no of hours',
  'number of hours',
  'hours',
  'no of hour',
  'remarks',
  'notes',
  'note',
  'total',
  'grand total',
  'subtotal',
  'summary',
  'category',
  'subject category',
]);

export function normalizeHeader(raw: string): string {
  return String(raw ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\n\r]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[_–—/\\]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchHeader(raw: string): Omit<ColumnMapping, 'columnIndex' | 'excelHeader'> | null {
  const normalized = normalizeHeader(raw);
  if (!normalized || IGNORE_HEADERS.has(normalized)) return null;

  let best: AliasDef | null = null;
  for (const entry of ALIASES) {
    if (entry.alias !== normalized) continue;
    if (!best || entry.confidence > best.confidence) best = entry;
  }
  if (!best || best.confidence < 60) return null;
  return {
    field: best.field,
    confidence: best.confidence,
    strength: best.strength,
    label: FIELD_LABELS[best.field],
  };
}

export function scoreHeaderCells(cells: string[]): {
  score: number;
  mappings: ColumnMapping[];
} {
  const mappings: ColumnMapping[] = [];
  const usedFields = new Set<CurriculumField>();

  const candidates = cells.map((header, columnIndex) => {
    const match = matchHeader(header);
    return match ? { ...match, excelHeader: header.trim() || header, columnIndex } : null;
  });

  const ranked = candidates
    .filter((c): c is ColumnMapping => Boolean(c))
    .sort((a, b) => b.confidence - a.confidence || a.columnIndex - b.columnIndex);

  for (const candidate of ranked) {
    if (usedFields.has(candidate.field)) continue;
    if (candidate.confidence < 60) continue;
    usedFields.add(candidate.field);
    mappings.push(candidate);
  }

  mappings.sort((a, b) => a.columnIndex - b.columnIndex);

  let score = 0;
  for (const mapping of mappings) {
    if (mapping.confidence >= AUTO_MAP_MIN) score += mapping.confidence >= 90 ? 2 : 1;
    else if (mapping.strength === 'possible') score += 0.4;
  }
  if (usedFields.has('courseCode')) score += 2;
  if (usedFields.has('descriptiveTitle')) score += 2;
  if (usedFields.has('creditUnits')) score += 1;
  return { score, mappings };
}

export function mergeHeaderRows(top: string[], bottom: string[]): string[] {
  const width = Math.max(top.length, bottom.length);
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    const a = (top[i] ?? '').trim();
    const b = (bottom[i] ?? '').trim();
    const aNorm = normalizeHeader(a);
    if (IGNORE_HEADERS.has(aNorm) && b) {
      out[i] = b;
      continue;
    }
    if (a && b && normalizeHeader(a) !== normalizeHeader(b)) out[i] = `${a} ${b}`;
    else out[i] = a || b;
  }
  return out;
}

export function looksLikeSubHeaderRow(cells: string[]): boolean {
  const values = cells.map(c => normalizeHeader(c)).filter(Boolean);
  if (values.length === 0) return false;
  return values.every(v =>
    v === 'lec' || v === 'lab' || v === 'hours' || v === 'hour' || v === 'no' || IGNORE_HEADERS.has(v)
    || v === 'lecture' || v === 'laboratory',
  );
}

/** Repeated official table headers must not be imported as subjects. */
export function looksLikeTableHeaderRow(cells: string[]): boolean {
  const scored = scoreHeaderCells(cells);
  const hasCode = scored.mappings.some(m => m.field === 'courseCode' && m.confidence >= 72);
  const hasTitle = scored.mappings.some(m => m.field === 'descriptiveTitle' && m.confidence >= 80);
  return Boolean(hasCode && hasTitle && scored.score >= 3);
}

export const AUTO_MAP_THRESHOLD = AUTO_MAP_MIN;
