/**
 * Machine-readable curriculum export layout.
 * Visual Excel styling is applied later; this structure is what the importer reads.
 */

export const UNIVERSITY_REPUBLIC = 'Republic of the Philippines';
export const UNIVERSITY_NAME = 'NORTH EASTERN MINDANAO STATE UNIVERSITY';
export const UNIVERSITY_ADDRESS = 'Cantilan, Surigao del Sur 8317';
export const UNIVERSITY_PHONE = '086-212-2723';
export const UNIVERSITY_WEBSITE = 'www.nemsu.edu.ph';

export const YEAR_SECTION_LABEL: Record<string, string> = {
  '1st Year': 'FIRST YEAR',
  '2nd Year': 'SECOND YEAR',
  '3rd Year': 'THIRD YEAR',
  '4th Year': 'FOURTH YEAR',
};

export const SEM_SECTION_LABEL: Record<string, string> = {
  '1st Semester': 'First Semester',
  '2nd Semester': 'Second Semester',
  Summer: 'Summer',
};

export type ExportRowKind =
  | 'logo'
  | 'republic'
  | 'university'
  | 'program'
  | 'version'
  | 'blank'
  | 'section'
  | 'header1'
  | 'header2'
  | 'subject'
  | 'total'
  | 'eval'
  | 'footer';

export interface CurriculumExportSubject {
  subject_code: string;
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  units: number;
  prerequisites: string;
  grade: string;
}

export interface CurriculumExportGroup {
  yearLevel: string;
  semester: string;
  subjects: CurriculumExportSubject[];
}

export interface CurriculumExportInput {
  programName: string;
  programCode?: string;
  curriculumLabel: string;
  groups: CurriculumExportGroup[];
}

export interface BuiltExportRow {
  kind: ExportRowKind;
  values: Array<string | number>;
  formulas?: Partial<Record<number, string>>;
}

export interface BuiltCurriculumSheet {
  name: string;
  rows: BuiltExportRow[];
  merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>;
  lastRow: number;
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function sectionHeading(yearLevel: string, semester: string): string {
  const year = YEAR_SECTION_LABEL[yearLevel] ?? String(yearLevel).toUpperCase();
  const sem = SEM_SECTION_LABEL[semester] ?? semester;
  return `${year} – ${sem}`;
}

export function buildCurriculumExportSheet(input: CurriculumExportInput): BuiltCurriculumSheet {
  const groups = input.groups.filter(g => g.subjects.length > 0);
  const rows: BuiltExportRow[] = [];
  const merges: BuiltCurriculumSheet['merges'] = [];

  const pushMerged = (kind: ExportRowKind, text: string) => {
    const r = rows.length;
    rows.push({ kind, values: [text, '', '', '', '', '', ''] });
    merges.push({ s: { r, c: 0 }, e: { r, c: 6 } });
  };

  const logoStart = rows.length;
  rows.push({ kind: 'logo', values: ['', '', '', '', '', '', ''] });
  rows.push({ kind: 'logo', values: ['', '', '', '', '', '', ''] });
  merges.push({ s: { r: logoStart, c: 0 }, e: { r: logoStart + 1, c: 6 } });
  pushMerged('republic', UNIVERSITY_REPUBLIC);
  pushMerged('university', UNIVERSITY_NAME);
  pushMerged('program', (input.programName || input.programCode || 'Curriculum').toUpperCase());
  pushMerged('version', input.curriculumLabel.toUpperCase());
  rows.push({ kind: 'blank', values: ['', '', '', '', '', '', ''] });

  for (const group of groups) {
    pushMerged('section', sectionHeading(group.yearLevel, group.semester));

    const header1 = rows.length;
    rows.push({
      kind: 'header1',
      values: ['Course Code', 'Descriptive Title', 'No. of Hours', '', 'Credit Units', 'Pre-requisite(s)', 'Grade'],
    });
    rows.push({
      kind: 'header2',
      values: ['', '', 'Lec.', 'Lab', '', '', ''],
    });
    merges.push({ s: { r: header1, c: 0 }, e: { r: header1 + 1, c: 0 } });
    merges.push({ s: { r: header1, c: 1 }, e: { r: header1 + 1, c: 1 } });
    merges.push({ s: { r: header1, c: 2 }, e: { r: header1, c: 3 } });
    merges.push({ s: { r: header1, c: 4 }, e: { r: header1 + 1, c: 4 } });
    merges.push({ s: { r: header1, c: 5 }, e: { r: header1 + 1, c: 5 } });
    merges.push({ s: { r: header1, c: 6 }, e: { r: header1 + 1, c: 6 } });

    const firstSubject = rows.length + 1;
    let totalLec = 0;
    let totalLab = 0;
    let totalUnits = 0;
    for (const subject of group.subjects) {
      const lec = asNumber(subject.lecture_hours);
      const lab = asNumber(subject.laboratory_hours);
      const units = asNumber(subject.units);
      totalLec += lec;
      totalLab += lab;
      totalUnits += units;
      rows.push({
        kind: 'subject',
        values: [
          String(subject.subject_code ?? '').trim(),
          String(subject.subject_name ?? '').trim(),
          lec,
          lab,
          units,
          String(subject.prerequisites ?? '').trim(),
          String(subject.grade ?? '').trim(),
        ],
      });
    }
    const lastSubject = rows.length;
    const lecRange = `C${firstSubject}:C${lastSubject}`;
    const labRange = `D${firstSubject}:D${lastSubject}`;
    const unitRange = `E${firstSubject}:E${lastSubject}`;
    rows.push({
      kind: 'total',
      values: ['', 'TOTAL', totalLec, totalLab, totalUnits, '', ''],
      formulas: {
        2: `SUM(${lecRange})`,
        3: `SUM(${labRange})`,
        4: `SUM(${unitRange})`,
      },
    });
    pushMerged('eval', 'Evaluated by: ________________________________');
    if (group !== groups[groups.length - 1]) {
      rows.push({ kind: 'blank', values: ['', '', '', '', '', '', ''] });
    }
  }

  pushMerged(
    'footer',
    `${UNIVERSITY_ADDRESS}  ·  ${UNIVERSITY_PHONE}  ·  ${UNIVERSITY_WEBSITE}  ·  Generated by QRganize`,
  );

  return {
    name: 'Curriculum',
    rows,
    merges: merges.filter(m => m.s.r !== m.e.r || m.s.c !== m.e.c),
    lastRow: rows.length,
  };
}

export function exportSheetToAoA(sheet: BuiltCurriculumSheet): Array<Array<string | number>> {
  return sheet.rows.map(row => row.values.map((value, col) => {
    if (row.formulas?.[col]) return row.values[col];
    return value;
  }));
}
