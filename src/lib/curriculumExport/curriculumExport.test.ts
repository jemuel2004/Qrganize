import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { parseCurriculumWorkbook } from '../curriculumImport';
import { buildCurriculumWorkbook, TABLE_COL_WIDTHS, centeredImageCol, excelWidthToPx } from './buildWorkbook';
import { buildCurriculumExportSheet, exportSheetToAoA, sectionHeading } from './model';

const SAMPLE_GROUPS = [
  {
    yearLevel: '1st Year',
    semester: '1st Semester',
    subjects: [
      { subject_code: 'CS 111', subject_name: 'Introduction to Computing', lecture_hours: 2, laboratory_hours: 3, units: 3, prerequisites: '', grade: '' },
      { subject_code: 'CS 112', subject_name: 'Fundamentals of Programming', lecture_hours: 2, laboratory_hours: 3, units: 3, prerequisites: 'CS 111', grade: '' },
    ],
  },
  {
    yearLevel: '1st Year',
    semester: '2nd Semester',
    subjects: [
      { subject_code: 'CS 121', subject_name: 'Discrete Structures 1', lecture_hours: 3, laboratory_hours: 0, units: 3, prerequisites: 'CS 111', grade: '' },
    ],
  },
];

test('section headings use official year/semester wording', () => {
  assert.equal(sectionHeading('1st Year', '1st Semester'), 'FIRST YEAR – First Semester');
  assert.equal(sectionHeading('2nd Year', '2nd Semester'), 'SECOND YEAR – Second Semester');
});

test('export model is importable and ignores branding, totals, and repeated headers', () => {
  const sheet = buildCurriculumExportSheet({
    programName: 'Bachelor of Science in Computer Science',
    programCode: 'BSCS',
    curriculumLabel: 'Old Curriculum',
    groups: SAMPLE_GROUPS,
  });
  const result = parseCurriculumWorkbook({
    fileName: 'export.xlsx',
    sheets: [{ name: sheet.name, rows: exportSheetToAoA(sheet), merges: sheet.merges }],
  });

  assert.equal(result.rows.length, 3);
  assert.equal(result.rows[0].subjectCode, 'CS 111');
  assert.equal(result.rows[0].yearLevel, '1st Year');
  assert.equal(result.rows[0].semester, '1st Semester');
  assert.equal(result.rows[2].subjectCode, 'CS 121');
  assert.equal(result.rows[2].semester, '2nd Semester');
  assert.ok(result.rows.every(row => !/total/i.test(row.subjectCode)));
  assert.ok(result.rows.every(row => row.subjectCode !== 'COURSE CODE'));
  assert.equal(sheet.rows.some(row => row.kind === 'docTitle'), false);
  assert.ok(!sheet.rows.some(row => String(row.values[0]).trim() === 'Curriculum'));
});

test('empty semester groups are omitted', () => {
  const sheet = buildCurriculumExportSheet({
    programName: 'BSCS',
    curriculumLabel: 'Old Curriculum',
    groups: [
      ...SAMPLE_GROUPS,
      { yearLevel: '4th Year', semester: 'Summer', subjects: [] },
    ],
  });
  const headings = sheet.rows.filter(row => row.kind === 'section').map(row => String(row.values[0]));
  assert.deepEqual(headings, [
    'FIRST YEAR – First Semester',
    'FIRST YEAR – Second Semester',
  ]);
});

test('generated workbook has no frozen pane and used range matches data rows', async () => {
  const groups = [
    ...SAMPLE_GROUPS,
    {
      yearLevel: '2nd Year',
      semester: '1st Semester',
      subjects: Array.from({ length: 12 }, (_, i) => ({
        subject_code: `IT ${200 + i}`,
        subject_name: i === 3 ? 'Very long laboratory title that must wrap inside the descriptive title column' : `Topic ${i + 1}`,
        lecture_hours: i % 3 === 0 ? 0 : 2,
        laboratory_hours: i % 3 === 0 ? 3 : 0,
        units: 3,
        prerequisites: i ? `IT ${199 + i}` : '',
        grade: '',
      })),
    },
  ];
  const model = buildCurriculumExportSheet({
    programName: 'Bachelor of Science in Information Technology',
    programCode: 'BSIT',
    curriculumLabel: 'Old Curriculum',
    groups,
  });
  const buffer = await buildCurriculumWorkbook({
    programName: 'Bachelor of Science in Information Technology',
    programCode: 'BSIT',
    curriculumLabel: 'Old Curriculum',
    groups,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'Curriculum');
  assert.equal(ws.rowCount, model.lastRow);
  assert.notEqual(ws.views?.[0]?.state, 'frozen');
  assert.equal(ws.pageSetup.printArea, `A1:G${model.lastRow}`);
  const merges = (ws.model.merges ?? []) as string[];
  for (const ref of merges) {
    const end = String(ref).split(':')[1] ?? '';
    const row = Number(end.replace(/^[A-Z]+/, ''));
    assert.ok(row <= model.lastRow, `merge ${ref} extends past last data row`);
  }
  assert.equal(ws.columnCount <= 7, true);
});

test('styled workbook round-trips through the existing importer', async () => {
  const buffer = await buildCurriculumWorkbook({
    programName: 'Bachelor of Science in Computer Science',
    programCode: 'BSCS',
    curriculumLabel: 'Old Curriculum',
    groups: SAMPLE_GROUPS,
  });
  const wb = XLSX.read(buffer, { type: 'buffer' });
  assert.ok(wb.SheetNames.includes('Curriculum'));
  const parsed = parseCurriculumWorkbook({
    fileName: 'BSCS_Old_Curriculum.xlsx',
    sheets: wb.SheetNames.map(name => ({
      name,
      rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '', raw: false }),
      merges: wb.Sheets[name]['!merges'] as Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> | undefined,
    })),
  });
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[1].prerequisites, 'CS 111');
  assert.equal(parsed.diagnostic.selectedSheets.includes('Curriculum'), true);
});

test('logo anchor is the pixel midpoint of columns A:G', () => {
  const logoPx = 72;
  const col = centeredImageCol(TABLE_COL_WIDTHS, logoPx);
  const pixels = TABLE_COL_WIDTHS.map(excelWidthToPx);
  const total = pixels.reduce((sum, px) => sum + px, 0);
  const left = pixels.slice(0, Math.floor(col)).reduce((sum, px) => sum + px, 0)
    + pixels[Math.floor(col)] * (col - Math.floor(col));
  assert.ok(col > 1 && col < 3, `expected logo in B–C band, got ${col}`);
  assert.ok(Math.abs(left + logoPx / 2 - total / 2) < 1);
});

test('header has no standalone Curriculum title and keeps Old Curriculum then the first semester', () => {
  const sheet = buildCurriculumExportSheet({
    programName: 'Bachelor of Science in Computer Science',
    programCode: 'BSCS',
    curriculumLabel: 'Old Curriculum',
    groups: SAMPLE_GROUPS,
  });
  const kinds = sheet.rows.map(row => row.kind);
  const texts = sheet.rows.map(row => String(row.values[0] ?? ''));
  assert.deepEqual(kinds.slice(0, 6), ['logo', 'logo', 'republic', 'university', 'program', 'version']);
  assert.equal(texts.includes('Curriculum'), false);
  assert.equal(texts.includes('OLD CURRICULUM'), true);
  const versionAt = kinds.indexOf('version');
  const sectionAt = kinds.indexOf('section');
  assert.ok(sectionAt === versionAt + 2);
  assert.equal(texts[sectionAt], 'FIRST YEAR – First Semester');
});
