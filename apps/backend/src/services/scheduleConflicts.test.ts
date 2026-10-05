import assert from 'node:assert/strict';
import test from 'node:test';
import { findOverlappingSessions, validateSessions, type ConflictSessionInput } from './scheduleConflicts';

const s = (day: string, start_time: string, hours: number | string): ConflictSessionInput => ({ day, start_time, hours });

test('the same day and time entered twice is refused', () => {
  const found = findOverlappingSessions([s('Monday', '08:00', 2), s('Monday', '08:00', 2)]);
  assert.equal(found.length, 1);
  assert.equal(found[0].session_index, 1);
  assert.equal(found[0].type, 'duplicate');
  assert.equal(found[0].message, 'Session 2 overlaps with Session 1 on Monday (8:00 AM–10:00 AM).');
  assert.deepEqual([found[0].existing_start, found[0].existing_end], ['08:00', '10:00']);
});

test('partial overlaps on the same day are refused', () => {
  const found = findOverlappingSessions([s('Tuesday', '13:00', 1.5), s('Tuesday', '14:00', 1)]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /Session 2 overlaps with Session 1 on Tuesday \(1:00 PM–2:30 PM\)/);
});

test('back-to-back sessions and different days are fine', () => {
  assert.deepEqual(findOverlappingSessions([s('Monday', '08:00', 1), s('Monday', '09:00', 1)]), []);
  assert.deepEqual(findOverlappingSessions([s('Monday', '08:00', 2), s('Wednesday', '08:00', 2), s('Friday', '08:00', 2)]), []);
  assert.deepEqual(findOverlappingSessions([s('Monday', '08:00', 2)]), []);
  assert.deepEqual(findOverlappingSessions([]), []);
});

test('each overlapping session is reported once, against the first it hits', () => {
  const found = findOverlappingSessions([s('Monday', '08:00', 3), s('Monday', '09:00', 1), s('Monday', '10:00', 1)]);
  assert.deepEqual(found.map(c => c.session_index), [1, 2]);
  assert.match(found[1].message, /^Session 3 overlaps with Session 1 /);
});

test('session rules: valid day and time, 7:00 AM–6:00 PM, no lunch overlap', () => {
  assert.equal(validateSessions([s('Monday', '08:00', 2)]), null);
  assert.equal(validateSessions([s('Someday', '08:00', 2)]), 'Session 1: choose a valid day.');
  assert.equal(validateSessions([s('Monday', '8am', 2)]), 'Session 1: invalid start time.');
  assert.equal(validateSessions([s('Monday', '08:00', 0)]), 'Session 1: hours must be between 0 and 12.');
  assert.equal(validateSessions([s('Monday', '06:30', 1)]), "Session 1: classes can't start before 7:00 AM.");
  // Faculty are out by 6:00 PM: 4:30–6:00 is the last slot that fits, 5:00–6:30 is not
  assert.equal(validateSessions([s('Monday', '16:30', 1.5)]), null);
  assert.equal(validateSessions([s('Monday', '17:00', 1.5)]), 'Session 1: classes must end by 6:00 PM — faculty are out by then.');
  assert.equal(validateSessions([s('Monday', '20:00', 1.5)]), 'Session 1: classes must end by 6:00 PM — faculty are out by then.');
  assert.equal(validateSessions([s('Monday', '08:00', 1), s('Monday', '11:30', 1)]), 'Session 2: overlaps the lunch break (12:00–1:00 PM).');
  assert.equal(validateSessions([s('Monday', '11:00', 1), s('Monday', '13:00', 1)]), null);
});
