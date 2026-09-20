import assert from 'node:assert/strict';
import test from 'node:test';
import { compareImportRows } from './compareExisting';
import { matchHeader, normalizeHeader, scoreHeaderCells } from './columnMap';
import { parseCurriculumWorkbook } from './parseWorkbook';
import type { WorkbookInput } from './types';
import { detectProgramFromCourseCodes } from './programDetect';
import { detectYearSemester, isSectionHeadingRow } from './yearSemester';

function wb(fileName: string, sheets: Array<{ name: string; rows: unknown[][]; merges?: WorkbookInput['sheets'][0]['merges'] }>): WorkbookInput {
  return { fileName, sheets };
}

const STANDARD_ROWS: unknown[][] = [
  ['Curriculum', 'Old'],
  ['FIRST YEAR - First Semester'],
  ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units', 'Pre-requisite(s)'],
  ['CS 111', 'Introduction to Computing', 2, 3, 3, ''],
  ['CS 112', 'Fundamentals of Programming', 2, 3, 3, 'CS 111'],
];

test('1. standard curriculum Excel', () => {
  const result = parseCurriculumWorkbook(wb('standard.xlsx', [{ name: 'Program of Study', rows: STANDARD_ROWS }]));
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].subjectCode, 'CS 111');
  assert.equal(result.rows[0].yearLevel, '1st Year');
  assert.equal(result.rows[0].semester, '1st Semester');
});

test('2. Excel with blank rows', () => {
  const rows = [
    ['FIRST YEAR - First Semester'],
    [],
    ['Course Code', 'Descriptive Title', 'Lecture Hours', 'Laboratory Hours', 'Credit Units'],
    [],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
    [],
    ['CS 112', 'Fundamentals of Programming', 2, 3, 3],
  ];
  const result = parseCurriculumWorkbook(wb('blanks.xlsx', [{ name: 'Sheet1', rows }]));
  assert.equal(result.rows.length, 2);
});

test('3. Excel with merged cells', () => {
  const rows = [
    ['FIRST YEAR - First Semester', '', '', '', ''],
    ['Course Code', 'Descriptive Title', 'Lec', 'Lab', 'Units'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
  ];
  const result = parseCurriculumWorkbook(wb('merged.xlsx', [{
    name: 'Sheet1',
    rows,
    merges: [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }],
  }]));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].yearLevel, '1st Year');
});

test('4. header not on row 1', () => {
  const rows = [
    ['NEMSU BSCS Revised Program'],
    [],
    ['FIRST YEAR FIRST SEMESTER'],
    ['Subject Code', 'Subject Name', 'Lecture', 'Laboratory', 'Units'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
  ];
  const result = parseCurriculumWorkbook(wb('late-header.xlsx', [{ name: 'POS', rows }]));
  assert.equal(result.diagnostic.headerRow, 4);
  assert.equal(result.rows.length, 1);
});

test('5. header with different capitalization', () => {
  const rows = [
    ['FIRST YEAR - First Semester'],
    ['COURSE CODE', 'DESCRIPTIVE TITLE', 'LEC HOURS', 'LAB HOURS', 'CREDIT UNITS'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
  ];
  assert.equal(parseCurriculumWorkbook(wb('caps.xlsx', [{ name: 'S', rows }])).rows.length, 1);
});

test('6. header with extra spaces', () => {
  const rows = [
    ['FIRST YEAR - First Semester'],
    ['  Course   Code  ', ' Descriptive  Title ', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
  ];
  assert.equal(parseCurriculumWorkbook(wb('spaces.xlsx', [{ name: 'S', rows }])).rows.length, 1);
});

test('7. header with underscores', () => {
  const rows = [
    ['FIRST YEAR - First Semester'],
    ['Course_Code', 'Course_Title', 'Lec_Hours', 'Lab_Hours', 'Credit_Units'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
  ];
  assert.equal(parseCurriculumWorkbook(wb('underscores.xlsx', [{ name: 'S', rows }])).rows.length, 1);
});

test('8. header with abbreviations', () => {
  const rows = [
    ['FIRST YEAR - First Semester'],
    ['Code', 'Title', 'Lec.', 'Lab.', 'CU'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
  ];
  const result = parseCurriculumWorkbook(wb('abbr.xlsx', [{ name: 'S', rows }]));
  assert.equal(result.rows.length, 1);
  assert.ok(result.mappings.some(m => m.field === 'creditUnits'));
});

test('9. different column order', () => {
  const rows = [
    ['FIRST YEAR - First Semester'],
    ['Credit Units', 'Descriptive Title', 'Course Code', 'Lab Hours', 'Lec Hours'],
    [3, 'Introduction to Computing', 'CS 111', 3, 2],
  ];
  const result = parseCurriculumWorkbook(wb('order.xlsx', [{ name: 'S', rows }]));
  assert.equal(result.rows[0].subjectCode, 'CS 111');
  assert.equal(result.rows[0].creditUnits, 3);
  assert.equal(result.rows[0].lectureHours, 2);
});

test('10. missing optional columns', () => {
  const rows = [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Credit Units'],
    ['CS 111', 'Introduction to Computing', 3],
  ];
  const result = parseCurriculumWorkbook(wb('optional.xlsx', [{ name: 'S', rows }]));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].lectureHours, 0);
  assert.equal(result.rows[0].laboratoryHours, 0);
  assert.ok(!result.rows[0].errors.some(e => /Lecture and Lab/.test(e)));
});

test('11. multiple year/semester sections', () => {
  const rows = [
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ['FIRST YEAR - First Semester'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
    ['SECOND YEAR - Second Semester'],
    ['CS 211', 'Data Structures', 2, 3, 3],
  ];
  const result = parseCurriculumWorkbook(wb('sections.xlsx', [{ name: 'S', rows }]));
  assert.equal(result.rows[0].yearLevel, '1st Year');
  assert.equal(result.rows[0].semester, '1st Semester');
  assert.equal(result.rows[1].yearLevel, '2nd Year');
  assert.equal(result.rows[1].semester, '2nd Semester');
});

test('12. multiple worksheets — strongest + all curriculum sheets', () => {
  const result = parseCurriculumWorkbook(wb('multi.xlsx', [
    { name: 'Cover', rows: [['Vision'], ['Mission']] },
    { name: '1Y-1S', rows: [
      ['FIRST YEAR - First Semester'],
      ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
      ['CS 111', 'Introduction to Computing', 2, 3, 3],
    ] },
    { name: '1Y-2S', rows: [
      ['FIRST YEAR - Second Semester'],
      ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
      ['CS 121', 'Computer Programming 2', 2, 3, 3],
    ] },
  ]));
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.diagnostic.ignoredSheets, ['Cover']);
  assert.ok(result.diagnostic.selectedSheets.includes('1Y-1S'));
  assert.ok(result.diagnostic.selectedSheets.includes('1Y-2S'));
});

test('13. TOTAL rows ignored', () => {
  const rows = [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
    ['', 'TOTAL', 24, 6, 26],
    ['GRAND TOTAL', '', 48, 12, 52],
  ];
  const result = parseCurriculumWorkbook(wb('totals.xlsx', [{ name: 'S', rows }]));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].subjectCode, 'CS 111');
});

test('14. duplicate subjects in file', () => {
  const parsed = parseCurriculumWorkbook(wb('dups.xlsx', [{ name: 'S', rows: [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
  ] }]));
  const compared = compareImportRows(parsed.rows, [], 1);
  assert.equal(compared[1].status, 'duplicate');
  assert.equal(compared[1].valid, false);
});

test('15. existing identical subjects', () => {
  const parsed = parseCurriculumWorkbook(wb('exist.xlsx', [{ name: 'S', rows: STANDARD_ROWS }]));
  const compared = compareImportRows(parsed.rows, [{
    program_id: 1, year_level: '1st Year', semester: '1st Semester',
    subject_code: 'CS 111', subject_name: 'Introduction to Computing',
    lecture_hours: 2, laboratory_hours: 3, units: 3, prerequisites: '', grade: '',
  }, {
    program_id: 1, year_level: '1st Year', semester: '1st Semester',
    subject_code: 'CS 112', subject_name: 'Fundamentals of Programming',
    lecture_hours: 2, laboratory_hours: 3, units: 3, prerequisites: 'CS 111', grade: '',
  }], 1);
  assert.ok(compared.every(r => r.status === 'existing'));
});

test('16. changed subjects', () => {
  const parsed = parseCurriculumWorkbook(wb('changed.xlsx', [{ name: 'S', rows: [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ['CS 212', 'Advanced Object-Oriented Programming', 3, 0, 3],
  ] }]));
  const compared = compareImportRows(parsed.rows, [{
    program_id: 1, year_level: '1st Year', semester: '1st Semester',
    subject_code: 'CS 212', subject_name: 'Object-Oriented Programming',
    lecture_hours: 3, laboratory_hours: 0, units: 3, prerequisites: '', grade: '',
  }], 1);
  assert.equal(compared[0].status, 'changed');
  assert.ok(compared[0].changes.some(c => c.field === 'Descriptive Title'));
});

test('17. missing course code is not a subject', () => {
  const result = parseCurriculumWorkbook(wb('no-code.xlsx', [{ name: 'S', rows: [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ['', 'Introduction to Computing', 2, 3, 3],
  ] }]));
  assert.equal(result.rows.length, 0);
});

test('18. missing title is not a subject', () => {
  const result = parseCurriculumWorkbook(wb('no-title.xlsx', [{ name: 'S', rows: [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ['CS 111', '', 2, 3, 3],
  ] }]));
  assert.equal(result.rows.length, 0);
});

test('19. missing credit units column is flagged', () => {
  const result = parseCurriculumWorkbook(wb('no-units.xlsx', [{ name: 'S', rows: [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours'],
    ['CS 111', 'Introduction to Computing', 2, 3],
  ] }]));
  assert.equal(result.rows.length, 1);
  assert.ok(result.rows[0].errors.some(e => /Credit Units/.test(e)));
});

test('20. empty worksheet', () => {
  const result = parseCurriculumWorkbook(wb('empty.xlsx', [{ name: 'Empty', rows: [] }]));
  assert.equal(result.rows.length, 0);
  assert.match(result.diagnostic.reason, /no worksheet|recognizable curriculum header/i);
});

test('21. completely unrelated Excel', () => {
  const result = parseCurriculumWorkbook(wb('budget.xlsx', [{
    name: 'Budget',
    rows: [['Item', 'Cost'], ['Paper', 100], ['Ink', 50]],
  }]));
  assert.equal(result.rows.length, 0);
  assert.ok(result.diagnostic.reason.length > 0);
  assert.notEqual(result.diagnostic.reason, 'No subject rows found.');
});

test('22. same Excel compared twice is idempotent (existing)', () => {
  const first = parseCurriculumWorkbook(wb('once.xlsx', [{ name: 'S', rows: STANDARD_ROWS }]));
  const existing = first.rows.map(r => ({
    program_id: 1, year_level: r.yearLevel, semester: r.semester,
    subject_code: r.subjectCode, subject_name: r.subjectName,
    lecture_hours: r.lectureHours, laboratory_hours: r.laboratoryHours,
    units: r.creditUnits, prerequisites: r.prerequisites, grade: r.grade,
  }));
  const second = compareImportRows(first.rows, existing, 1);
  assert.ok(second.every(r => r.status === 'existing' && !r.valid));
});

test('23. different templates map the same fields', () => {
  const a = parseCurriculumWorkbook(wb('A.xlsx', [{ name: 'S', rows: [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
  ] }]));
  const b = parseCurriculumWorkbook(wb('B.xlsx', [{ name: 'S', rows: [
    ['FIRST YEAR - First Semester'],
    ['Subject Code', 'Subject Name', 'Lecture', 'Laboratory', 'Units'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
  ] }]));
  const c = parseCurriculumWorkbook(wb('C.xlsx', [{ name: 'S', rows: [
    ['FIRST YEAR - First Semester'],
    ['Code', 'Course Title', 'Lec.', 'Lab.', 'Credits'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
  ] }]));
  assert.equal(a.rows[0].subjectCode, b.rows[0].subjectCode);
  assert.equal(b.rows[0].subjectName, c.rows[0].subjectName);
  assert.equal(a.rows[0].creditUnits, c.rows[0].creditUnits);
});

test('24. merged year/semester cells apply to following subjects', () => {
  const rows = [
    ['FIRST YEAR - First Semester', '', ''],
    ['', '', ''],
    ['Course Code', 'Descriptive Title', 'Units', 'Lec Hours', 'Lab Hours'],
    ['CS 111', 'Introduction to Computing', 3, 2, 3],
  ];
  const result = parseCurriculumWorkbook(wb('merged-ys.xlsx', [{
    name: 'S',
    rows,
    merges: [{ s: { r: 0, c: 0 }, e: { r: 1, c: 2 } }],
  }]));
  assert.equal(result.rows[0].yearLevel, '1st Year');
  assert.equal(result.rows[0].semester, '1st Semester');
});

test('25. additional irrelevant columns are ignored', () => {
  const rows = [
    ['FIRST YEAR - First Semester'],
    ['Remarks', 'Course Code', 'Notes', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units', 'Color'],
    ['ok', 'CS 111', 'n/a', 'Introduction to Computing', 2, 3, 3, 'blue'],
  ];
  const result = parseCurriculumWorkbook(wb('extra.xlsx', [{ name: 'S', rows }]));
  assert.equal(result.rows[0].subjectCode, 'CS 111');
  assert.equal(result.rows[0].subjectName, 'Introduction to Computing');
});

test('official branded workbook with repeated headers still imports subjects only', () => {
  const rows = [
    ['NORTH EASTERN MINDANAO STATE UNIVERSITY'],
    ['BACHELOR OF SCIENCE IN COMPUTER SCIENCE'],
    ['OLD CURRICULUM'],
    ['Curriculum'],
    ['FIRST YEAR – First Semester'],
    ['Course Code', 'Descriptive Title', 'No. of Hours', '', 'Credit Units', 'Pre-requisite(s)', 'Grade'],
    ['', '', 'Lec.', 'Lab', '', '', ''],
    ['CS 111', 'Introduction to Computing', 2, 3, 3, '', ''],
    ['', 'TOTAL', 2, 3, 3, '', ''],
    ['FIRST YEAR – Second Semester'],
    ['Course Code', 'Descriptive Title', 'No. of Hours', '', 'Credit Units', 'Pre-requisite(s)', 'Grade'],
    ['', '', 'Lec.', 'Lab', '', '', ''],
    ['CS 121', 'Discrete Structures 1', 3, 0, 3, 'CS 111', ''],
    ['', 'TOTAL', 3, 0, 3, '', ''],
    ['Cantilan, Surigao del Sur 8317 · www.nemsu.edu.ph'],
  ];
  const result = parseCurriculumWorkbook(wb('official-branded.xlsx', [{ name: 'Curriculum', rows }]));
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].subjectCode, 'CS 111');
  assert.equal(result.rows[1].subjectCode, 'CS 121');
  assert.equal(result.rows[1].yearLevel, '1st Year');
  assert.equal(result.rows[1].semester, '2nd Semester');
});

test('official two-row hours header still maps Lec/Lab', () => {
  const rows = [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'No. of Hours', '', 'Credit Units', 'Pre-requisite(s)', 'Grade'],
    ['', '', 'Lec.', 'Lab', '', '', ''],
    ['IT 111', 'Introduction to Computing', 2, 3, 3, '', ''],
  ];
  const result = parseCurriculumWorkbook(wb('official.xlsx', [{ name: '1Y-1S', rows }]));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].lectureHours, 2);
  assert.equal(result.rows[0].laboratoryHours, 3);
  assert.equal(result.rows[0].creditUnits, 3);
});

test('hyphenated title vs spaced title is identical, not changed', () => {
  const compared = compareImportRows([{
    rowNum: 1, sheetName: 'S', yearLevel: '1st Year', semester: '1st Semester',
    subjectCode: 'CS 212', subjectName: 'Object Oriented Programming',
    lectureHours: 3, laboratoryHours: 0, creditUnits: 3, prerequisites: '', grade: '', errors: [],
  }], [{
    program_id: 1, year_level: '1st Year', semester: '1st Semester',
    subject_code: 'CS 212', subject_name: 'Object-Oriented Programming',
    lecture_hours: 3, laboratory_hours: 0, units: 3, prerequisites: '', grade: '',
  }], 1);
  assert.equal(compared[0].status, 'existing');
});

test('header aliases normalize punctuation and case', () => {
  assert.equal(normalizeHeader('Pre-requisite(s)'), 'pre requisite s');
  assert.equal(matchHeader('Subject Name')?.field, 'descriptiveTitle');
  assert.equal(matchHeader('Lecture Hrs')?.field, 'lectureHours');
  const scored = scoreHeaderCells(['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units', 'Pre-requisite(s)']);
  assert.ok(scored.score >= 8);
});

test('year/semester variants normalize', () => {
  assert.deepEqual(detectYearSemester(['1st Year First Sem']), { yearLevel: '1st Year', semester: '1st Semester' });
  assert.deepEqual(detectYearSemester(['YEAR 1 - SEMESTER 1']), { yearLevel: '1st Year', semester: '1st Semester' });
  assert.deepEqual(detectYearSemester(['First Year / First Semester']), { yearLevel: '1st Year', semester: '1st Semester' });
});

test('year/semester as a data column is not treated as a section heading', () => {
  const heading = ['FIRST YEAR - First Semester'];
  const data = ['FIRST YEAR - First Semester', 'CS 111', 'Introduction to Computing', 2, 3, 3, 'C.H.E.D. CARAGA'];
  assert.equal(isSectionHeadingRow(heading), true);
  assert.equal(isSectionHeadingRow(data.map(String)), false);

  const result = parseCurriculumWorkbook(wb('year-col.xlsx', [{
    name: 'Program of Study',
    rows: [
      ['Year / Semester', 'Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units', 'Pre-requisite(s)'],
      ['FIRST YEAR - First Semester', 'CS 111', 'Introduction to Computing', 2, 3, 3, 'C.H.E.D. CARAGA'],
      ['FIRST YEAR - First Semester', 'CS 112', 'Fundamentals of Programming', 2, 3, 3, 'BUTUAN CITY'],
      ['FIRST YEAR - First Semester', 'GE-US', 'Understanding the Self', 3, 0, 3, ''],
      ['FIRST YEAR - First Semester', 'GE-MMW', 'Mathematics in the Modern World', 3, 0, 3, ''],
      ['FIRST YEAR - First Semester', 'GE-PC', 'Purposive Communication', 3, 0, 3, ''],
      ['FIRST YEAR - First Semester', 'MATH 1', 'Advanced College Algebra', 3, 0, 3, ''],
      ['FIRST YEAR - First Semester', 'IT 1', 'Living in the IT Era', 3, 0, 3, ''],
      ['FIRST YEAR - First Semester', 'PATH-Fit 1', 'Movement Competency Training', 2, 0, 2, ''],
      ['FIRST YEAR - First Semester', 'NSTP1', 'National Service Training Program 1', 3, 0, 3, ''],
      ['FIRST YEAR - First Semester', 'TOTAL', '', 24, 6, 26, ''],
    ],
  }]));
  assert.equal(result.rows.length, 9);
  assert.ok(result.rows.every(r => r.yearLevel === '1st Year' && r.semester === '1st Semester'));
  assert.ok(result.rows.some(r => r.subjectCode === 'CS 111'));
  assert.ok(result.rows.some(r => r.subjectCode === 'GE-US'));
  assert.ok(result.rows.some(r => r.subjectCode === 'MATH 1'));
  assert.ok(result.rows.some(r => r.subjectCode === 'IT 1'));
  assert.ok(result.rows.some(r => r.subjectCode === 'PATH-FIT 1'));
  assert.ok(result.rows.some(r => r.subjectCode === 'NSTP1'));
  assert.ok(!result.rows.some(r => r.subjectCode === 'TOTAL'));
  assert.equal(result.rows.find(r => r.subjectCode === 'GE-US')?.laboratoryHours, 0);
});

test('program detection uses CS prefixes and ignores GE/IT 1/NSTP', () => {
  const programs = [
    { id: 10, code: 'BSCS', name: 'Bachelor of Science in Computer Science' },
    { id: 20, code: 'BSIT', name: 'Bachelor of Science in Information Technology' },
  ];
  const detected = detectProgramFromCourseCodes([
    'CS 111', 'CS 112', 'GE-US', 'GE-MMW', 'MATH 1', 'IT 1', 'PATH-Fit 1', 'NSTP1', 'CS 211',
  ], programs);
  assert.equal(detected.program?.code, 'BSCS');
  assert.equal(detected.program?.id, 10);
  assert.equal(detected.confidence, 'high');
});
