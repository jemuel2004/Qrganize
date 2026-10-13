import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BORROW_MIN_LEFT, borrowRoomFitError, earlierTime, fitsFreeTime, freedTimeUntil, minutesLeft, notEnoughTimeMessage, tooLateMessage, type BorrowClass,
} from './borrowedRoom';

const lecture: BorrowClass = { part: 'lec', subject_code: 'GE 1', lecture_hours: 3, laboratory_hours: 0, one_room: false };
const lecOfLab: BorrowClass = { part: 'lec', subject_code: 'IT 214', lecture_hours: 2, laboratory_hours: 3, one_room: false };
const labPart: BorrowClass = { part: 'lab', subject_code: 'IT 214', lecture_hours: 2, laboratory_hours: 3, one_room: false };
const major: BorrowClass = { part: 'lec', subject_code: 'IT 316', lecture_hours: 2, laboratory_hours: 3, one_room: true };
const pathfit: BorrowClass = { part: 'lec', subject_code: 'PATHFIT 1', lecture_hours: 2, laboratory_hours: 0, one_room: false };
const lectureRoom = { room_name: 'Room 3', room_type: 'Lecture' };
const lab = { room_name: 'Lab 2', room_type: 'Laboratory' };

test('a class may use a freed room only when the room suits it', () => {
  assert.equal(borrowRoomFitError(lecture, lectureRoom), null);
  assert.match(borrowRoomFitError(lecture, lab) ?? '', /lecture subject/);
  assert.equal(borrowRoomFitError(lecOfLab, lab), null);
  assert.equal(borrowRoomFitError(lecOfLab, lectureRoom), null);
  assert.equal(borrowRoomFitError(labPart, lab), null);
  assert.match(borrowRoomFitError(labPart, lectureRoom) ?? '', /Laboratory needs a laboratory/);
  assert.match(borrowRoomFitError(major, lectureRoom) ?? '', /Major subject/);
  assert.equal(borrowRoomFitError(major, lab), null);
  assert.match(borrowRoomFitError(pathfit, lectureRoom) ?? '', /PATHFIT/);
  assert.equal(borrowRoomFitError(pathfit, { room_name: 'CCA Gym', room_type: 'Lecture' }), null);
});

test('the class must end by the time the room is free until — never past it', () => {
  // Room freed 10:15–12:00: a class until 11:30 or 12:00 fits (even one that started at 10:00)
  assert.equal(fitsFreeTime('11:30', '12:00:00'), true);
  assert.equal(fitsFreeTime('12:00:00', '12:00'), true);
  // …one until 12:30 or 1:00 PM does not
  assert.equal(fitsFreeTime('12:30', '12:00'), false);
  assert.equal(fitsFreeTime('13:00:00', '12:00:00'), false);
  // An empty room with no class after it: free the rest of the day
  assert.equal(fitsFreeTime('17:00', null), true);
  assert.equal(notEnoughTimeMessage('IT 214', '13:00', 'Room 3', '12:00'),
    'IT 214 runs until 1:00 PM, but Room 3 is free only until 12:00 PM today. Your whole class must fit in that time.');
});

test('the earlier limit wins (the next class or a reservation)', () => {
  assert.equal(earlierTime('12:00', '11:45'), '11:45');
  assert.equal(earlierTime(null, '11:45'), '11:45');
  assert.equal(earlierTime('12:00', null), '12:00');
  assert.equal(earlierTime(null, null), null);
});

test('the 30-minute rule — the example from the rules, a room free 10:30 AM–12:00 PM', () => {
  const freed = [{ start_time: '10:30:00', end_time: '12:00:00' }];
  const canTake = (now: string) => {
    const until = freedTimeUntil(freed, now);
    return until != null && minutesLeft(now, until) > BORROW_MIN_LEFT;
  };
  assert.equal(canTake('10:15:00'), false); // not yet free — never before its own start
  assert.equal(canTake('10:30:00'), true);
  assert.equal(canTake('10:40:00'), true);
  assert.equal(canTake('11:00:00'), true);
  assert.equal(canTake('11:29:00'), true);
  assert.equal(canTake('11:30:00'), false); // only 30 minutes left
  assert.equal(canTake('11:40:00'), false);
  assert.equal(canTake('12:00:00'), false); // its free time has ended
  assert.equal(tooLateMessage('Lecture-3', '11:40:00', '12:00:00'),
    'Lecture-3 is free only until 12:00 PM — 20 minutes are left. A room can be taken only while more than 30 minutes of its free time remain.');
});

test('freed class times back to back count as one', () => {
  const freed = [{ start_time: '11:00:00', end_time: '12:00:00' }, { start_time: '10:00:00', end_time: '11:00:00' }, { start_time: '13:00:00', end_time: '14:00:00' }];
  assert.equal(freedTimeUntil(freed, '10:20:00'), '12:00:00');
  assert.equal(freedTimeUntil(freed, '12:30:00'), null);
  assert.equal(freedTimeUntil(freed, '13:10:00'), '14:00:00');
});
