import assert from 'node:assert/strict';
import test from 'node:test';
import { firstFreeTime, freedDayPhrase, mergeFreedTimes } from './freedTime';

const room = { id: 7, room_name: 'Lecture-1', room_type: 'Lecture' };

test('the notice names the day: today, tomorrow, or the weekday and date', () => {
  assert.equal(freedDayPhrase('2026-10-13', '2026-10-13'), 'today (Oct 13)');
  assert.equal(freedDayPhrase('2026-10-14', '2026-10-13'), 'tomorrow (Oct 14)');
  assert.equal(freedDayPhrase('2026-10-19', '2026-10-13'), 'Monday, Oct 19');
});

test('one room\'s freed class times that touch become one time; other rooms and dates stay apart', () => {
  const t = (start: string, end: string, r = room, date = '2026-10-14') => ({ room: r, date, weekday: 'Wednesday', start, end });
  const out = mergeFreedTimes([t('11:00', '12:00'), t('10:00', '11:00'), t('13:00', '14:30'), t('10:00', '11:00', { ...room, id: 8 }), t('10:00', '11:00', room, '2026-10-15')]);
  assert.deepEqual(out.map(x => `${x.room.id} ${x.date} ${x.start}-${x.end}`), [
    '7 2026-10-14 10:00-12:00', '7 2026-10-14 13:00-14:30', '7 2026-10-15 10:00-11:00', '8 2026-10-14 10:00-11:00',
  ]);
});

test('the dashboard shows a room\'s earliest free time, joined with the times right after it', () => {
  assert.equal(firstFreeTime([]), null);
  assert.deepEqual(firstFreeTime([{ start: '13:00', end: '14:30' }, { start: '10:15', end: '11:30' }, { start: '11:30', end: '12:00' }]), { start: '10:15', end: '12:00' });
  assert.deepEqual(firstFreeTime([{ start: '10:00', end: '12:00' }, { start: '10:15', end: '11:00' }]), { start: '10:00', end: '12:00' });
});
