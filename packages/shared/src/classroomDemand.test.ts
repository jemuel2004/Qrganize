import assert from 'node:assert/strict';
import test from 'node:test';
import { computeClassroomDemand, type DemandSessionInput } from './classroomDemand';

let nextId = 1;
/** One class meeting; `room` = a usable lecture room id, null = no room */
function s(day: string, start: string, end: string, room: number | null, extra: Partial<DemandSessionInput> = {}): DemandSessionInput {
  const id = nextId++;
  return {
    id, ms_id: id, day, start_time: start, end_time: end, type: 'lec',
    room_id: room, room_name: room == null ? null : `Room ${room}`, room_type: room == null ? null : 'Lecture',
    room_usable: room == null ? null : true,
    subject_code: `IT ${id}`, subject_name: null, block: null, faculty_name: null,
    ...extra,
  };
}
const many = (n: number, f: (i: number) => DemandSessionInput) => Array.from({ length: n }, (_, i) => f(i));

test('demand is peak simultaneous classes, not faculty or total classes', () => {
  const sessions = [
    ...many(6, i => s('Monday', '08:00', '09:00', i + 1)),
    ...many(9, i => s('Monday', '09:00', '10:00', i + 1)),
    ...many(5, i => s('Monday', '10:00', '11:00', i + 1)),
  ];
  const d = computeClassroomDemand(sessions, 9);
  assert.equal(d.required, 9);
  assert.equal(d.total_classes, 20);
  assert.equal(d.peak?.start, '09:00');
  assert.equal(d.peak?.end, '10:00');
  assert.equal(d.verdict, 'enough');
});

test('unassigned classes add demand only where they overlap', () => {
  const sessions = [
    ...many(4, i => s('Monday', '08:00', '09:00', i + 1)), ...many(2, () => s('Monday', '08:00', '09:00', null)),
    ...many(5, i => s('Monday', '09:00', '10:00', i + 1)), s('Monday', '09:00', '10:00', null),
    ...many(3, i => s('Monday', '10:00', '11:00', i + 1)), ...many(4, () => s('Monday', '10:00', '11:00', null)),
  ];
  const d = computeClassroomDemand(sessions, 5);
  assert.equal(d.required, 7);
  assert.equal(d.additional, 2);          // not 7 unassigned
  assert.equal(d.unassigned, 7);
  assert.equal(d.peak?.assigned, 3);
  assert.equal(d.peak?.unassigned, 4);
  assert.equal(d.verdict, 'shortage');
});

test('capacity enough but rooms unassigned → assignment problem, not shortage', () => {
  const sessions = [...many(5, i => s('Tuesday', '08:00', '09:00', i + 1)), ...many(3, () => s('Tuesday', '08:00', '09:00', null))];
  const d = computeClassroomDemand(sessions, 8);
  assert.equal(d.required, 8);
  assert.equal(d.additional, 0);
  assert.equal(d.verdict, 'enough');
  assert.equal(d.assignment_issue, true);
});

test('surplus', () => {
  const d = computeClassroomDemand(many(7, i => s('Monday', '08:00', '09:00', i + 1)), 10);
  assert.equal(d.surplus, 3);
  assert.equal(d.verdict, 'surplus');
});

test('overlap across hours counts 2; back-to-back reuses one room', () => {
  const overlap = computeClassroomDemand([s('Monday', '08:00', '10:00', 1), s('Monday', '09:00', '11:00', 2)], 5);
  assert.equal(overlap.required, 2);
  assert.equal(overlap.peak?.start, '09:00');
  assert.equal(overlap.peak?.end, '10:00');

  const backToBack = computeClassroomDemand([s('Monday', '08:00', '09:00', 1), s('Monday', '09:00', '10:00', null)], 5);
  assert.equal(backToBack.required, 1);
});

test('laboratory sessions and lectures in an active lab room are excluded', () => {
  const d = computeClassroomDemand([
    s('Monday', '08:00', '09:00', 1),
    s('Monday', '08:00', '09:00', null, { type: 'lab' }),
    s('Monday', '08:00', '09:00', 50, { room_type: 'Laboratory' }),
    s('Monday', '08:00', '09:00', 51, { room_type: 'Computer Lab' }),
  ], 5);
  assert.equal(d.required, 1);
  assert.equal(d.excluded_lab, 1);
  assert.equal(d.lec_in_lab_room, 2);
});

test('a class in an inactive room still needs a classroom', () => {
  const d = computeClassroomDemand([s('Monday', '08:00', '09:00', 1), s('Monday', '08:00', '09:00', 2, { room_usable: false })], 1);
  assert.equal(d.required, 2);
  assert.equal(d.unassigned, 1);
  assert.equal(d.peak?.classes.find(c => c.status === 'Inactive room')?.room_name, 'Room 2');
});

test('different days are separate; ties pick the earlier day', () => {
  const d = computeClassroomDemand([
    ...many(3, i => s('Wednesday', '08:00', '09:00', i + 1)),
    ...many(3, i => s('Monday', '13:00', '14:00', i + 1)),
    ...many(2, i => s('Friday', '08:00', '09:00', i + 1)),
  ], 3);
  assert.equal(d.required, 3);
  assert.equal(d.peak?.day, 'Monday');
  assert.deepEqual(d.days.map(x => [x.day, x.peak]), [['Monday', 3], ['Wednesday', 3], ['Friday', 2]]);
});

test('invalid times and duplicates are ignored', () => {
  const dup = s('Monday', '08:00:00', '09:00:00', 1);
  const d = computeClassroomDemand([
    dup, { ...dup, id: 999 }, { ...dup, id: 998, room_id: null },
    s('Monday', '25:00', '26:00', null), s('Funday', '08:00', '09:00', null), s('Monday', '08:00', '08:00', null),
  ], 2);
  assert.equal(d.required, 1);
  assert.equal(d.invalid, 3);
});

test('double-booked room is flagged; zero classes and zero rooms', () => {
  const d = computeClassroomDemand([s('Monday', '08:00', '09:00', 1), s('Monday', '08:30', '09:30', 1)], 0);
  assert.equal(d.required, 2);
  assert.equal(d.additional, 2);
  assert.ok(d.peak?.classes.every(c => c.double_booked));

  const empty = computeClassroomDemand([], 4);
  assert.equal(empty.required, 0);
  assert.equal(empty.verdict, 'none');
  assert.equal(empty.peak, null);
});

test('class running past midnight overlaps a late class', () => {
  const d = computeClassroomDemand([s('Monday', '20:00', '00:00', 1), s('Monday', '21:00', '22:00', 2)], 2);
  assert.equal(d.required, 2);
  assert.equal(d.peak?.start, '21:00');
});

test('construction: 18 at peak vs 14 usable → recommend 4 (not faculty, not unassigned count)', () => {
  // 20 faculty teach; 18 classes overlap at 9–10, 5 of them without a room; others reuse rooms
  const sessions = [
    ...many(13, i => s('Monday', '09:00', '10:00', i + 1, { faculty_name: `Faculty ${i}` })),
    ...many(5, i => s('Monday', '09:00', '10:00', null, { faculty_name: `Faculty ${13 + i}` })),
    s('Monday', '10:00', '11:00', null, { faculty_name: 'Faculty 18' }),
    s('Monday', '07:00', '08:00', 1, { faculty_name: 'Faculty 19' }),
  ];
  const d = computeClassroomDemand(sessions, 14);
  assert.equal(d.required, 18);
  assert.equal(d.additional, 4);
  assert.equal(d.unassigned, 6);
  assert.equal(d.peak?.unassigned, 5);
  const c = d.peak!.classes[0];
  assert.equal(c.day, 'Monday');
  assert.equal(c.room_type, 'Lecture');
});

test('construction: 15 at peak vs 15 usable with 3 unassigned → 0 to build, assignment issue', () => {
  const d = computeClassroomDemand([
    ...many(12, i => s('Thursday', '13:00', '14:00', i + 1)),
    ...many(3, () => s('Thursday', '13:00', '14:00', null)),
  ], 15);
  assert.equal(d.additional, 0);
  assert.equal(d.assignment_issue, true);
  assert.equal(d.unassigned, 3);
});

test('all schedules are laboratories → no classroom requirement', () => {
  const d = computeClassroomDemand(many(4, () => s('Monday', '08:00', '11:00', null, { type: 'lab' })), 3);
  assert.equal(d.verdict, 'none');
  assert.equal(d.additional, 0);
  assert.equal(d.excluded_lab, 4);
});

test('a day with more class hours than its rooms can hold inside 7 AM–6 PM needs more rooms', () => {
  // 12 two-hour classes, never more than 2 at once, but 24 hours of class on one day:
  // a classroom holds 10 hours a day (7–12, 1–6), so at least 3 rooms are needed
  const sessions = many(12, i => {
    const start = 7 + 2 * Math.floor(i / 2) + (i >= 6 ? 1 : 0); // 7, 9, 11 … then 2 PM, 4 PM, 6 PM
    const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
    return s('Tuesday', hh(start), hh(start + 2), (i % 2) + 1);
  });
  const d = computeClassroomDemand(sessions, 2);
  assert.equal(d.peak?.peak, 2);
  assert.equal(d.days[0].class_minutes, 24 * 60);
  assert.equal(d.days[0].rooms_by_hours, 3);
  assert.equal(d.required, 3);
  assert.equal(d.basis, 'hours');
  assert.equal(d.hours_day?.day, 'Tuesday');
  assert.equal(d.verdict, 'shortage');
  assert.equal(d.additional, 1);
});

test('classes past 6:00 PM are listed as after-hours; the busiest moment still decides when it is higher', () => {
  const sessions = [
    ...many(5, i => s('Monday', '09:00', '10:30', i + 1)),
    s('Monday', '17:30', '19:00', 1),
    s('Wednesday', '18:00', '21:00', null),
  ];
  const d = computeClassroomDemand(sessions, 5);
  assert.equal(d.required, 5);
  assert.equal(d.basis, 'peak');
  assert.deepEqual(d.after_hours.map(c => `${c.day} ${c.start}-${c.end}`), ['Monday 17:30-19:00', 'Wednesday 18:00-21:00']);
});
