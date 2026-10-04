import assert from 'node:assert/strict';
import test from 'node:test';
import { planOneRoom, type PlanRoom, type PlanSession } from './majorRoomRule';

const rooms: PlanRoom[] = [
  { id: 1, room_name: 'Lab 1', room_type: 'Laboratory' },
  { id: 2, room_name: 'Lab 2', room_type: 'Laboratory' },
  { id: 3, room_name: 'Lab 3', room_type: 'Laboratory' },
  { id: 9, room_name: 'CS lab12', room_type: 'Laboratory' }, // special room
  { id: 20, room_name: 'Lecture-2', room_type: 'Lecture' },
];
const h = (hour: number, min = 0) => hour * 60 + min;
const s = (ms: number, type: 'lec' | 'lab', day: string, start: number, end: number, room: number | null): PlanSession =>
  ({ ms, type, day, start, end, room });

test("keeps the class in its Laboratory's room when that room is free at the Lecture's times", () => {
  const sessions = [s(1, 'lec', 'Monday', h(7), h(8), 1), s(1, 'lab', 'Monday', h(13), h(14, 30), 2)];
  assert.deepEqual(planOneRoom([1], sessions, rooms).get(1), { room: 2, from: 'lab' });
});

test("uses its Lecture's room when the Laboratory's room is taken at the Lecture's time", () => {
  const sessions = [
    s(1, 'lec', 'Monday', h(7), h(8), 1), s(1, 'lab', 'Monday', h(13), h(14, 30), 2),
    s(2, 'lec', 'Monday', h(7, 30), h(9), 2), // another class in Lab 2 during the Lecture
  ];
  assert.deepEqual(planOneRoom([1], sessions, rooms).get(1), { room: 1, from: 'lec' });
});

test('otherwise the first general lab free at every time — never a special room or a lecture room', () => {
  const sessions = [
    s(1, 'lec', 'Tuesday', h(7), h(8), 20), s(1, 'lab', 'Tuesday', h(13), h(14, 30), 2),
    s(2, 'lab', 'Tuesday', h(7), h(8), 2),   // Lab 2 taken at the Lecture's time
    s(3, 'lec', 'Tuesday', h(13), h(14), 1), // Lab 1 taken at the Laboratory's time
  ];
  assert.deepEqual(planOneRoom([1], sessions, rooms).get(1), { room: 3, from: 'other' });
});

test('no lab free at all its times → left as it is (null)', () => {
  const sessions = [
    s(1, 'lec', 'Friday', h(7), h(8), 1), s(1, 'lab', 'Friday', h(13), h(14), 2),
    s(2, 'lec', 'Friday', h(7), h(8), 2), s(3, 'lab', 'Friday', h(13), h(14), 1), s(4, 'lab', 'Friday', h(7), h(14), 3),
  ];
  assert.equal(planOneRoom([1], sessions, rooms).get(1), null);
});

test('classes that can keep their own room go first, and planned moves count as bookings', () => {
  // Class 1 can only use Lab 3 (both own rooms are taken); class 2 can keep its own Lab 3 —
  // planned in this order, class 2 still keeps Lab 3 and class 1 is left without a free lab.
  const sessions = [
    s(1, 'lec', 'Wednesday', h(8), h(9), 1), s(1, 'lab', 'Wednesday', h(9), h(10), 2),
    s(5, 'lec', 'Wednesday', h(9), h(10), 1), s(6, 'lab', 'Wednesday', h(8), h(9), 2),
    s(2, 'lec', 'Wednesday', h(8), h(9), 3), s(2, 'lab', 'Wednesday', h(9), h(10), 1),
  ];
  const plan = planOneRoom([1, 2], sessions, rooms);
  assert.deepEqual(plan.get(2), { room: 3, from: 'lec' });
  assert.equal(plan.get(1), null);
});

test('back-to-back meetings in the same room are not a clash', () => {
  const sessions = [
    s(1, 'lec', 'Thursday', h(7), h(8), 1), s(1, 'lab', 'Thursday', h(8), h(9, 30), 2),
    s(2, 'lec', 'Thursday', h(8), h(9), 1), s(3, 'lab', 'Thursday', h(9, 30), h(11), 2),
  ];
  assert.deepEqual(planOneRoom([1], sessions, rooms).get(1), { room: 2, from: 'lab' });
});
