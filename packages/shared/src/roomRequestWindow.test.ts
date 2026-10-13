import assert from 'node:assert/strict';
import test from 'node:test';
import { classTimes, requestWindow, shiftTime, time12, timeRange12, type PartSession } from './roomRequestWindow';

const s = (part: 'lec' | 'lab', start: string, end: string): PartSession => ({ part, start, end });

test('a Lecture followed by its Laboratory is one class time; a gap makes two', () => {
  const joined = classTimes([s('lab', '11:30:00', '13:00:00'), s('lec', '10:00:00', '11:30:00')]);
  assert.deepEqual(joined.map(t => [t.start, t.end, t.parts]), [['10:00', '13:00', ['lec', 'lab']]]);

  const apart = classTimes([s('lec', '07:30', '08:30'), s('lab', '13:00', '14:30')]);
  assert.deepEqual(apart.map(t => [t.start, t.end, t.parts]), [['07:30', '08:30', ['lec']], ['13:00', '14:30', ['lab']]]);
});

test('overlapping or duplicate sessions join, and the longer end wins', () => {
  const t = classTimes([s('lec', '08:00', '09:30'), s('lec', '08:00', '09:30'), s('lab', '09:00', '11:00')]);
  assert.equal(t.length, 1);
  assert.equal(t[0].end, '11:00');
  assert.equal(t[0].sessions.length, 3);
});

test('a laboratory room takes the whole class time, a lecture room only its Lecture', () => {
  const day = [s('lec', '10:00', '11:30'), s('lab', '11:30', '13:00')];
  assert.deepEqual(
    [requestWindow(day, '10:00', 'lab')?.start, requestWindow(day, '10:00', 'lab')?.end],
    ['10:00', '13:00'],
  );
  assert.deepEqual(
    [requestWindow(day, '10:00:00', 'lec')?.start, requestWindow(day, '10:00', 'lec')?.end],
    ['10:00', '11:30'],
  );
  // A Laboratory alone never goes into a lecture room
  assert.equal(requestWindow([s('lab', '13:00', '14:30')], '13:00', 'lec'), null);
  // Only a class time's own start picks it
  assert.equal(requestWindow(day, '11:30', 'lab'), null);
  assert.equal(requestWindow([], '10:00', 'lab'), null);
});

test('time labels', () => {
  assert.equal(time12('13:00'), '1:00 PM');
  assert.equal(time12('07:05:00'), '7:05 AM');
  assert.equal(timeRange12('13:00', '14:30'), '1:00 PM – 2:30 PM');
  assert.equal(timeRange12('11:30', '13:00'), '11:30 AM – 1:00 PM');
  assert.equal(shiftTime('13:00', -15), '12:45');
  assert.equal(shiftTime('00:10', -15), '00:00');
});
