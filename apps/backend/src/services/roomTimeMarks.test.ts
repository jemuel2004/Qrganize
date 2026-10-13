import assert from 'node:assert/strict';
import test from 'node:test';
import { minuteOfDay, roomTimeMarks } from './roomTimeMarks';

const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

test('a class 10:30 AM–12:00 PM changes rooms by itself at these minutes', () => {
  const marks = [...roomTimeMarks([{ start: '10:30', end: '12:00' }])].sort((a, b) => a - b).map(hm);
  // 15 early minutes · freed time opens · not scanned → free · last 30 minutes · ends · after-class hold ends
  assert.deepEqual(marks, ['10:15', '10:30', '10:45', '11:30', '12:00', '12:30']);
});

test('several class times share one set; a minute in between is not a mark', () => {
  const marks = roomTimeMarks([{ start: '07:00:00', end: '08:30:00' }, { start: '08:30', end: '10:00' }]);
  assert.ok(marks.has(minuteOfDay('08:30')));
  assert.ok(marks.has(minuteOfDay('09:30')));
  assert.ok(!marks.has(minuteOfDay('09:10')));
  assert.ok(marks.has(minuteOfDay('06:45')));
});
