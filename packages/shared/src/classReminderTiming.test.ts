import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REMINDER_LEAD, REMINDER_LEADS, dueClassReminders, isReminderLead, reminderText, startsIn,
  type ReminderSession,
} from './classReminderTiming';

const DATE = '2026-10-09';
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const session = (over: Partial<ReminderSession> = {}): ReminderSession => ({
  facultyId: 7, classId: 100, subjectCode: 'IT 221', subjectName: 'Web Systems', block: 'BSIT 2A',
  room: 'Room 205', part: 'lec', start: '13:00:00', end: '14:00:00', ...over,
});
const leads = (entries: [number, number][]) => new Map(entries);

test('reminder timings offered: 30, 15 and 5 minutes; 15 by default', () => {
  assert.deepEqual([...REMINDER_LEADS], [30, 15, 5]);
  assert.equal(DEFAULT_REMINDER_LEAD, 15);
  for (const ok of [30, 15, 5]) assert.equal(isReminderLead(ok), true, String(ok));
  for (const bad of [0, 10, 60, '15', null, undefined, 15.5]) assert.equal(isReminderLead(bad), false, String(bad));
});

test('due from the chosen minutes before class until it starts — never after', () => {
  const s = [session()];
  const l = leads([[7, 15]]);
  assert.equal(dueClassReminders(s, l, at('12:44'), DATE).length, 0, '16 minutes before: not yet');
  const first = dueClassReminders(s, l, at('12:45'), DATE);
  assert.equal(first.length, 1, '15 minutes before: due');
  assert.equal(first[0].minutesLeft, 15);
  assert.equal(dueClassReminders(s, l, at('12:59'), DATE)[0].minutesLeft, 1, 'a late run still reminds before the start');
  assert.equal(dueClassReminders(s, l, at('13:00'), DATE).length, 0, 'started: no reminder');
  assert.equal(dueClassReminders(s, l, at('13:30'), DATE).length, 0, 'in session: no reminder');
  assert.equal(dueClassReminders(s, l, at('14:30'), DATE).length, 0, 'ended: no reminder');
});

test('each faculty member uses their own timing; reminders off means none', () => {
  const s = [session({ facultyId: 1, classId: 1 }), session({ facultyId: 2, classId: 2 }), session({ facultyId: 3, classId: 3 })];
  const due = dueClassReminders(s, leads([[1, 30], [2, 5]]), at('12:40'), DATE);
  assert.deepEqual(due.map(d => d.facultyId), [1], 'faculty 2 (5 min) not yet; faculty 3 has reminders off');
  const later = dueClassReminders(s, leads([[1, 30], [2, 5]]), at('12:56'), DATE);
  assert.deepEqual(later.map(d => d.facultyId), [1, 2]);
});

test('a reminder only ever goes to the class’s own faculty member', () => {
  const s = [session({ facultyId: 1, classId: 1, subjectName: 'Mine' }), session({ facultyId: 2, classId: 2, subjectName: 'Theirs' })];
  const due = dueClassReminders(s, leads([[1, 15], [2, 15]]), at('12:50'), DATE);
  assert.deepEqual(due.map(d => [d.facultyId, d.subjectName]), [[1, 'Mine'], [2, 'Theirs']]);
});

test('a Lecture followed by its Laboratory is one class time: one reminder at its start', () => {
  const s = [
    session({ part: 'lec', start: '10:00:00', end: '11:30:00', room: 'Lab 1' }),
    session({ part: 'lab', start: '11:30:00', end: '13:00:00', room: 'Lab 1' }),
  ];
  const l = leads([[7, 15]]);
  const due = dueClassReminders(s, l, at('09:50'), DATE);
  assert.equal(due.length, 1);
  assert.deepEqual([due[0].start, due[0].end, due[0].room], ['10:00', '13:00', 'Lab 1']);
  assert.equal(dueClassReminders(s, l, at('11:20'), DATE).length, 0, 'no second reminder before the Laboratory part');
});

test('a class meeting twice a day is reminded before each meeting', () => {
  const s = [
    session({ start: '08:00', end: '09:00', room: 'Room 101' }),
    session({ start: '13:00', end: '14:00', room: 'Room 205' }),
  ];
  const l = leads([[7, 30]]);
  const morning = dueClassReminders(s, l, at('07:45'), DATE);
  const afternoon = dueClassReminders(s, l, at('12:45'), DATE);
  assert.deepEqual(morning.map(d => [d.start, d.room]), [['08:00', 'Room 101']]);
  assert.deepEqual(afternoon.map(d => [d.start, d.room]), [['13:00', 'Room 205']]);
  assert.notEqual(morning[0].key, afternoon[0].key);
});

test('no reminder once the faculty member checked in to that class', () => {
  const s = [session({ classId: 5 }), session({ classId: 6, start: '13:05', end: '14:00' })];
  const due = dueClassReminders(s, leads([[7, 15]]), at('12:50'), DATE, new Set(['7|5']));
  assert.deepEqual(due.map(d => d.classId), [6]);
});

test('the key names the day, the class and its start — one reminder per class time and day', () => {
  const [d] = dueClassReminders([session()], leads([[7, 15]]), at('12:50'), DATE);
  assert.equal(d.key, '2026-10-09|100|13:00');
  const [tomorrow] = dueClassReminders([session()], leads([[7, 15]]), at('12:50'), '2026-10-10');
  assert.notEqual(tomorrow.key, d.key);
});

test('a class without a room still reminds, and says so', () => {
  const [d] = dueClassReminders([session({ room: null })], leads([[7, 15]]), at('12:50'), DATE);
  assert.equal(d.room, null);
  assert.match(reminderText(d, 10).body, /Room: No room assigned yet/);
});

test('the device notification reads like the calendar example', () => {
  const [d] = dueClassReminders([session()], leads([[7, 15]]), at('12:45'), DATE);
  const text = reminderText(d, d.minutesLeft);
  assert.equal(text.title, 'QRganize — Upcoming Class');
  assert.equal(text.body, [
    'Your Web Systems class starts in 15 minutes.',
    'Room: Room 205',
    'Block: BSIT 2A',
    'Time: 1:00 PM – 2:00 PM',
  ].join('\n'));
  assert.equal(startsIn(1), 'starts in 1 minute');
  assert.equal(startsIn(0), 'starts now');
  assert.match(reminderText({ ...d, subjectName: ' ' }, 5).body, /^Your IT 221 class starts in 5 minutes\./);
});
