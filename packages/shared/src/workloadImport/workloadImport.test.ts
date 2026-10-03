import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySheet, classifyStatus, codeKey, parseClockRange, parseCourse, parseDayHeading, parsePersonName,
  parseWorkloadSheet, roomKey, samePerson,
} from './index';

const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const range = (text: string, period: 'morning' | 'afternoon' | null = null) => {
  const r = parseClockRange(text, period);
  return r ? `${hm(r.range.start)}-${hm(r.range.end)}` : null;
};

test('day headings of the form, including DAILY and M-F', () => {
  assert.deepEqual(parseDayHeading('MTh/Morning'), { group: 'MTh', days: ['Monday', 'Thursday'], period: 'morning' });
  assert.deepEqual(parseDayHeading('Tf/Afternoon')?.days, ['Tuesday', 'Friday']);
  assert.deepEqual(parseDayHeading('MTH/Afternoon')?.days, ['Monday', 'Thursday']);
  assert.deepEqual(parseDayHeading('TTh/Morning')?.days, ['Tuesday', 'Thursday']);
  assert.deepEqual(parseDayHeading('WED/Morning')?.days, ['Wednesday']);
  assert.equal(parseDayHeading('DAILY/Afternoon')?.days.length, 5);
  assert.deepEqual(parseDayHeading('M-F/Morning')?.days, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
  assert.deepEqual(parseDayHeading('SATURDAY'), { group: 'SATURDAY', days: ['Saturday'], period: null });
  assert.equal(parseDayHeading('7:00-8:30'), null);
  assert.equal(parseDayHeading('Consultation'), null);
});

test('12-hour times without AM/PM follow school hours', () => {
  assert.equal(range('7:00-8:30'), '7:00-8:30');
  assert.equal(range('1:00-2:30'), '13:00-14:30');
  assert.equal(range('11:00 - 12:00'), '11:00-12:00');
  assert.equal(range('7:00 - 12:00'), '7:00-12:00');
  assert.equal(range('5:30 - 7:00'), '17:30-19:00');
  assert.equal(range('5:00-8:00'), '17:00-20:00');
  assert.equal(range('7:00-7:10'), '7:00-7:10');
  assert.equal(range('6:00-7:30', 'morning'), '6:00-7:30');
  assert.equal(range('6:00 -7:00', 'afternoon'), '18:00-19:00');
  const noDash = parseClockRange('1:006:00');
  assert.equal(noDash && `${hm(noDash.range.start)}-${hm(noDash.range.end)}`, '13:00-18:00');
  assert.match(noDash?.note ?? '', /without its dash/);
  assert.equal(range('Consultation'), null);
});

test('a form: header, rows, missing heading, named-day activity, footers', () => {
  const rows = [
    [], [],
    ['Name: ENGR. MARCEL L. BUDLONG', '', '', "Educt'l Qualification: : MS AMS"],
    ['Years in Service: 5 years', '', '', 'Major: Mathematics'],
    ['Status: Permanent', '', '', 'Eligibility/PRC: CSE'],
    ['TIME/DAY', 'Subject Code', 'Description', 'Course', 'No. of', 'Units', 'No. of', 'Room No.'],
    ['', '', '', '', 'Students', '', 'Hours'],
    ['MTh/Morning'],
    ['7:00-7:10', '', 'Flag Ceremony (Monday)'],
    ['7:00-8:30', 'IT 112', 'Fundamentals of Programming (Lec)', 'BSIT 1E', '40', '2', '2', 'Lab. 4'],
    ['Wed/Afternoon'],
    ['1:00-6:00', 'IT 212', 'Object Oriented Programming', 'BSIT 2E', '34', '4.25', '5', 'Lab. 3'],
    ['8:30-10:00', 'IT 212', 'Object Oriented Programming(Lab)', 'BSIT 2C', '33', '2.25', '3', 'Lab. 3'],
    ['TF/Afternoon'],
    ['1:00-2:30', '', 'Consultation'],
    ['4:00-5:30', '', '', '', '0', '0', '0'],
    ['No. of Units', '', '', '', '', '13.5'],
    ['Designation ', '', 'DCS Extension Coordinator |      GAD Coordinator', '', '', '6'],
    ['Add: Research/Extension:', '', 'Research', '', '', '3'],
    ['Total No. of Units', '', 'Regular Load ', '', '', '22.5'],
  ];
  const s = parseWorkloadSheet({ name: 'BUDLONG', rows });
  assert.equal(s.facultyName, 'ENGR. MARCEL L. BUDLONG');
  assert.equal(s.status, 'Permanent');
  assert.equal(s.qualification, 'MS AMS');
  assert.equal(s.yearsInService, '5 years');
  assert.equal(s.category, 'Regular Load');
  assert.equal(s.rows.length, 5, 'numbers alone (template formulas) are not an entry');

  const [flag, lec, both, swappedGroup, consult] = s.rows;
  assert.equal(flag.kind, 'activity');
  assert.deepEqual(flag.days, ['Monday'], '"(Monday)" narrows the MTh group');
  assert.equal(lec.kind, 'class');
  assert.equal(lec.marker, 'lec');
  assert.equal(lec.units, 2);
  assert.equal(both.dayGroup, 'Wed');
  assert.equal(both.time?.end, 18 * 60);
  // a morning time under an afternoon heading belongs to the next group
  assert.deepEqual(swappedGroup.days, ['Tuesday', 'Friday']);
  assert.match(swappedGroup.notes[0], /day heading missing/);
  assert.equal(consult.kind, 'activity');
  assert.deepEqual(consult.days, ['Tuesday', 'Friday']);

  assert.deepEqual(s.footers.map(f => [f.label, f.units]), [['Designation', 6], ['Research/Extension', 3]]);
});

test('names, status and sheet kind', () => {
  assert.deepEqual(parsePersonName('ENGR. MARCEL L. BUDLONG'), { first: 'MARCEL', middle: 'L.', last: 'BUDLONG' });
  assert.deepEqual(parsePersonName('JOSEPHINE A.BASADRE'), { first: 'JOSEPHINE', middle: 'A.', last: 'BASADRE' });
  assert.deepEqual(parsePersonName('Jennifer Orozco, PhD'), { first: 'Jennifer', middle: '', last: 'Orozco' });
  assert.deepEqual(parsePersonName('MATT SIMON URBIZTONDO'), { first: 'MATT SIMON', middle: '', last: 'URBIZTONDO' });
  assert.equal(parsePersonName('IT 9'), null);

  assert.equal(samePerson({ first: 'Russel', last: 'Labial' }, { first: 'RUSSELL', last: 'LABIAL' }), 'spelling');
  assert.equal(samePerson({ first: 'Clyde Chectoper', last: 'Tiu' }, { first: 'CLYDE CHECTOPHER', last: 'TIU' }), 'spelling');
  assert.equal(samePerson({ first: 'jeanny', last: 'hungoy' }, { first: 'JEANNY', last: 'HUNGOY' }), 'exact');
  assert.equal(samePerson({ first: 'Jhon Fred', last: 'Plaza' }, { first: 'JUSPHER ANGELO', last: 'PLAZA' }), null);
  assert.equal(samePerson({ first: 'Feil BJ', last: 'Falcon' }, { first: 'QUENNIE MARIE', last: 'FALCON' }), null);

  assert.equal(classifyStatus('Temporary Permanent'), 'Permanent');
  assert.equal(classifyStatus('Contractual Instructor'), 'Contractual');
  assert.equal(classifyStatus('Part-time Instructor'), 'Part-time');
  assert.equal(classifyStatus('Part-timer'), 'Part-time');
  assert.equal(classifyStatus('Instructor I'), null);
  assert.equal(classifyStatus(''), null);

  assert.equal(classifySheet('Z. ROSIL actual', 'Regular Load'), 'actual');
  assert.equal(classifySheet('L. ROSAS actual', 'Acual Load'), 'actual');
  assert.equal(classifySheet('J. BASADREPraise', 'Service Credit'), 'praise');
  assert.equal(classifySheet('JAYPEE OVERLOAD', 'Overload'), 'overload');
  assert.equal(classifySheet('J. BASADRE', 'Regular Load Load'), 'regular');
  assert.equal(classifySheet('IT_9', ''), 'unknown');
});

test('courses, codes and rooms', () => {
  assert.deepEqual(parseCourse('BSIT 2F'), { program: 'BSIT', year: 2, block: 'F' });
  assert.deepEqual(parseCourse('BSIT2H'), { program: 'BSIT', year: 2, block: 'H' });
  assert.deepEqual(parseCourse('CS 3B'), { program: 'BSCS', year: 3, block: 'B' });
  assert.deepEqual(parseCourse('CpE 1C'), { program: 'BSCPE', year: 1, block: 'C' });
  assert.deepEqual(parseCourse('1F'), { program: null, year: 1, block: 'F' });
  assert.deepEqual(parseCourse('BSIT 2'), { program: 'BSIT', year: 2, block: null });

  assert.equal(codeKey('GE--PC'), codeKey('GE-PC'));
  assert.equal(codeKey('PathFit 3'), codeKey('PATH-FIT 3'));
  assert.equal(codeKey('IT412'), codeKey('IT 412'));

  assert.equal(roomKey('Lab. 12').key, roomKey('Laboratory-12').key);
  assert.equal(roomKey('LAB 1').key, 'lab:1');
  assert.equal(roomKey('Lec.3').key, roomKey('Lecture-3').key);
  assert.equal(roomKey('M.P 3').key, roomKey('M.P. 3').key);
  assert.notEqual(roomKey('CS Lab 4').key, roomKey('Laboratory-4').key);
});
