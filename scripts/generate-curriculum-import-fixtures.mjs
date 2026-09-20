import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'curriculum-import');
mkdirSync(outDir, { recursive: true });

function writeBook(fileName, sheets) {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    if (sheet.merges) ws['!merges'] = sheet.merges;
    ws['!cols'] = sheet.cols;
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.substring(0, 31));
  }
  const path = join(outDir, fileName);
  XLSX.writeFile(wb, path);
  console.log('wrote', path);
}

const y1s1 = [
  ['CS 111', 'Introduction to Computing', 2, 3, 3, ''],
  ['CS 112', 'Fundamentals of Programming', 2, 3, 3, ''],
  ['GE-US', 'Understanding the Self', 3, 0, 3, ''],
  ['GE-MMW', 'Mathematics in the Modern World', 3, 0, 3, ''],
];
const y1s2 = [
  ['CS 121', 'Computer Programming 2', 2, 3, 3, 'CS 112'],
  ['CS 122', 'Discrete Structures', 3, 0, 3, ''],
  ['GE-RPH', 'Readings in Philippine History', 3, 0, 3, ''],
];
const y2s1 = [
  ['CS 211', 'Data Structures and Algorithms', 2, 3, 3, 'CS 121'],
  ['CS 212', 'Object-Oriented Programming', 2, 3, 3, 'CS 121'],
];

writeBook('01-standard-official-headers.xlsx', [{
  name: 'Program of Study',
  rows: [
    ['Curriculum', 'Old'],
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units', 'Pre-requisite(s)'],
    ...y1s1,
    ['', 'TOTAL', 10, 6, 12, ''],
    [],
    ['FIRST YEAR - Second Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units', 'Pre-requisite(s)'],
    ...y1s2,
    ['', 'TOTAL', 8, 3, 9, ''],
  ],
}]);

writeBook('02-blank-rows-between-subjects.xlsx', [{
  name: 'Sheet1',
  rows: [
    ['Curriculum Title — BSCS'],
    [],
    ['FIRST YEAR - First Semester'],
    [],
    ['Course Code', 'Descriptive Title', 'Lecture Hours', 'Laboratory Hours', 'Credit Units'],
    [],
    y1s1[0],
    [],
    y1s1[1],
    [],
    y1s1[2],
  ],
}]);

writeBook('03-merged-year-semester.xlsx', [{
  name: 'Sheet1',
  merges: [{ s: { r: 0, c: 0 }, e: { r: 1, c: 4 } }],
  rows: [
    ['FIRST YEAR - First Semester', '', '', '', ''],
    ['', '', '', '', ''],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ...y1s1.slice(0, 2),
  ],
}]);

writeBook('04-header-not-on-row-1.xlsx', [{
  name: 'POS',
  rows: [
    ['NEMSU BSCS Revised Program'],
    ['College of Computing and Information Sciences'],
    [],
    ['FIRST YEAR FIRST SEMESTER'],
    ['Subject Code', 'Subject Name', 'Lecture', 'Laboratory', 'Units'],
    ...y1s1,
  ],
}]);

writeBook('05-template-B-subject-headers.xlsx', [{
  name: 'Curriculum',
  rows: [
    ['1st Year First Sem'],
    ['Subject Code', 'Subject Name', 'Lecture', 'Laboratory', 'Units', 'Prereq'],
    ...y1s1,
  ],
}]);

writeBook('06-template-C-abbreviations.xlsx', [{
  name: 'Courses',
  rows: [
    ['YEAR 1 - SEMESTER 1'],
    ['Code', 'Course Title', 'Lec.', 'Lab.', 'Credits', 'Prereq(s)'],
    ...y1s1,
  ],
}]);

writeBook('07-template-D-course-description.xlsx', [{
  name: 'Sheet1',
  rows: [
    ['First Year / First Semester'],
    ['Course', 'Description', 'Lecture Hours', 'Laboratory Hours', 'Credit Units', 'Prerequisite'],
    ...y1s1,
  ],
}]);

writeBook('08-different-column-order.xlsx', [{
  name: 'Sheet1',
  rows: [
    ['FIRST YEAR - First Semester'],
    ['Credit Units', 'Descriptive Title', 'Course Code', 'Lab Hours', 'Lec Hours', 'Pre-requisite(s)'],
    ...y1s1.map(([code, title, lec, lab, units, prereq]) => [units, title, code, lab, lec, prereq]),
  ],
}]);

writeBook('09-underscores-spaces-caps.xlsx', [{
  name: 'Sheet1',
  rows: [
    ['FIRST YEAR - First Semester'],
    ['  COURSE_CODE  ', ' Descriptive  Title ', 'LEC_HOURS', 'LAB_HOURS', 'CREDIT_UNITS'],
    ...y1s1.map(r => r.slice(0, 5)),
  ],
}]);

writeBook('10-multiple-year-semester-sections.xlsx', [{
  name: 'Program of Study',
  rows: [
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units', 'Pre-requisite(s)'],
    ['FIRST YEAR - First Semester'],
    ...y1s1,
    ['', 'TOTAL', 10, 6, 12, ''],
    [],
    ['FIRST YEAR - Second Semester'],
    ...y1s2,
    [],
    ['SECOND YEAR - First Semester'],
    ...y2s1,
  ],
}]);

writeBook('11-multiple-worksheets.xlsx', [
  {
    name: 'Cover',
    rows: [['Vision'], ['A leading university'], ['Mission'], ['Quality education']],
  },
  {
    name: '1Y-1S',
    rows: [
      ['FIRST YEAR - First Semester'],
      ['Course Code', 'Descriptive Title', 'No. of Hours', '', 'Credit Units', 'Pre-requisite(s)', 'Grade'],
      ['', '', 'Lec.', 'Lab', '', '', ''],
      ...y1s1.map(([code, title, lec, lab, units, prereq]) => [code, title, lec, lab, units, prereq, '']),
      ['', 'TOTAL', 10, 6, 12, '', ''],
    ],
    merges: [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
      { s: { r: 1, c: 2 }, e: { r: 1, c: 3 } },
    ],
  },
  {
    name: '1Y-2S',
    rows: [
      ['FIRST YEAR - Second Semester'],
      ['Course Code', 'Descriptive Title', 'No. of Hours', '', 'Credit Units', 'Pre-requisite(s)', 'Grade'],
      ['', '', 'Lec.', 'Lab', '', '', ''],
      ...y1s2.map(([code, title, lec, lab, units, prereq]) => [code, title, lec, lab, units, prereq, '']),
    ],
  },
]);

writeBook('12-with-totals-and-notes.xlsx', [{
  name: 'Sheet1',
  rows: [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ...y1s1,
    ['', 'TOTAL', 10, 6, 12],
    ['GRAND TOTAL', '', 10, 6, 12],
    ['NOTES', 'This row should be ignored'],
    ['REMARKS', 'Also ignored'],
  ],
}]);

writeBook('13-missing-optional-columns.xlsx', [{
  name: 'Sheet1',
  rows: [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Credit Units'],
    ['CS 111', 'Introduction to Computing', 3],
    ['GE-US', 'Understanding the Self', 3],
  ],
}]);

writeBook('14-duplicate-course-codes.xlsx', [{
  name: 'Sheet1',
  rows: [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    y1s1[0],
    y1s1[0],
    y1s1[1],
  ],
}]);

writeBook('15-unrelated-budget.xlsx', [{
  name: 'Budget',
  rows: [
    ['Item', 'Cost', 'Notes'],
    ['Paper', 100, 'Office'],
    ['Ink', 50, 'Printer'],
  ],
}]);

writeBook('16-changed-title-for-compare.xlsx', [{
  name: 'Sheet1',
  rows: [
    ['FIRST YEAR - First Semester'],
    ['Course Code', 'Descriptive Title', 'Lec Hours', 'Lab Hours', 'Credit Units'],
    ['CS 111', 'Introduction to Computing', 2, 3, 3],
    ['CS 212', 'Advanced Object-Oriented Programming', 2, 3, 3],
  ],
}]);

console.log('\nAll test Excel files are in fixtures/curriculum-import/');
