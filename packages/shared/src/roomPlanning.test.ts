import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allowedPools, computeRoomPlanning, roomPoolOf, snapshotCell,
  type PlanningPendingInput, type PlanningRoomInput, type PlanningSessionInput,
} from './roomPlanning';

/* Lecture rooms are ids 1…, laboratories 101…, the PATHFIT venues 201 and 202 */
const lectureRooms = (n: number, extra: Partial<PlanningRoomInput> = {}): PlanningRoomInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, room_name: `Lecture-${i + 1}`, room_type: 'Lecture', active: true, ...extra }));
const labRooms = (n: number): PlanningRoomInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: 101 + i, room_name: `Lab ${i + 1}`, room_type: 'Laboratory', active: true }));
const venues: PlanningRoomInput[] = [
  { id: 201, room_name: 'CCA Gym', room_type: 'Lecture', active: true },
  { id: 202, room_name: 'Sao', room_type: 'Lecture', active: true },
];

let nextId = 1;
/** One class meeting of its own class (lecture-only unless `extra` says otherwise) */
function s(day: string, start: string, end: string, room: number | null, extra: Partial<PlanningSessionInput> = {}): PlanningSessionInput {
  const id = nextId++;
  return {
    id, ms_id: id, day, start_time: start, end_time: end, part: 'lec', room_id: room,
    subject_code: `GE ${id}`, subject_name: null, block: null,
    faculty_id: id, faculty_name: `Faculty ${id}`, has_lab: false, one_room: false,
    ...extra,
  };
}
const many = (n: number, f: (i: number) => PlanningSessionInput) => Array.from({ length: n }, (_, i) => f(i));
const plan = (sessions: PlanningSessionInput[], rooms: PlanningRoomInput[], pending: PlanningPendingInput[] = []) =>
  computeRoomPlanning({ sessions, rooms, pending });
/** Grid cell of a day (Monday = 0) and an hour (7 = 7–8 AM) */
const at = (day: number, hour: number) => [day, hour - 7] as const;

test('demand is the most classes at once — not the faculty or the classes counted', () => {
  const p = plan([
    ...many(6, i => s('Monday', '08:00', '09:00', i + 1)),
    ...many(9, i => s('Monday', '09:00', '10:00', i + 1)),
    ...many(5, i => s('Monday', '10:00', '11:00', i + 1)),
  ], lectureRooms(9));
  assert.equal(p.totals.meetings, 20);
  assert.equal(p.pools.lecture.peak, 9);
  assert.deepEqual(p.pools.lecture.peak_at, { day: 'Monday', start: '09:00', end: '10:00' });
  assert.equal(p.pools.lecture.required, 9);
  assert.equal(p.pools.lecture.additional, 0);
  // Every room in use at 9–10 is "fully booked", not a shortage
  const [d, h] = at(0, 9);
  assert.deepEqual(p.grid.lecture[d][h], { needed: 9, in_use: 9, usable: 9, short: 0 });
  assert.equal(p.pools.lecture.full_slots, 1);
  assert.equal(p.pools.lecture.short_slots, 0);
  assert.equal(p.totals.max_short, 0);
});

test('classes without a room add demand only where they overlap', () => {
  const p = plan([
    ...many(4, i => s('Monday', '08:00', '09:00', i + 1)), ...many(2, () => s('Monday', '08:00', '09:00', null)),
    ...many(5, i => s('Monday', '09:00', '10:00', i + 1)), s('Monday', '09:00', '10:00', null),
    ...many(3, i => s('Monday', '10:00', '11:00', i + 1)), ...many(4, () => s('Monday', '10:00', '11:00', null)),
  ], lectureRooms(5));
  assert.equal(p.pools.lecture.peak, 7);
  assert.equal(p.pools.lecture.additional, 2);  // not 7 classes without a room
  assert.equal(p.pools.lecture.max_short, 2);
  assert.equal(p.totals.without_room, 7);
  assert.equal(p.totals.faculty_affected, 7);
  const [d, h] = at(0, 10);
  assert.deepEqual(p.grid.lecture[d][h], { needed: 7, in_use: 3, usable: 5, short: 2 });
  assert.ok(p.issues.every(c => c.issues[0] === 'no_room'));
});

test('enough rooms but some classes have none → a room to give, not a shortage', () => {
  const p = plan([...many(5, i => s('Tuesday', '08:00', '09:00', i + 1)), ...many(3, () => s('Tuesday', '08:00', '09:00', null))], lectureRooms(8));
  assert.equal(p.pools.lecture.peak, 8);
  assert.equal(p.pools.lecture.additional, 0);
  assert.equal(p.totals.max_short, 0);
  assert.equal(p.totals.without_room, 3);
});

test('back-to-back meetings share a room; a room is never counted twice in one slot', () => {
  const overlap = plan([s('Monday', '08:00', '10:00', 1), s('Monday', '09:00', '11:00', 2)], lectureRooms(5));
  assert.equal(overlap.pools.lecture.peak, 2);
  assert.deepEqual(overlap.pools.lecture.peak_at, { day: 'Monday', start: '09:00', end: '10:00' });

  const backToBack = plan([s('Monday', '08:00', '09:00', 1), s('Monday', '09:00', '10:00', 1)], lectureRooms(5));
  assert.equal(backToBack.totals.peak, 1);

  const sameHour = plan([s('Monday', '08:00', '08:30', 1), s('Monday', '08:30', '09:00', 1)], lectureRooms(5));
  const [d, h] = at(0, 8);
  assert.deepEqual(sameHour.grid.lecture[d][h], { needed: 1, in_use: 1, usable: 5, short: 0 });
});

test('a 7:30–9:00 class fills the 7 and 8 o\'clock slots', () => {
  const p = plan([s('Wednesday', '07:30', '09:00', 1)], lectureRooms(2));
  assert.equal(p.grid.lecture[2][0].needed, 1);
  assert.equal(p.grid.lecture[2][1].needed, 1);
  assert.equal(p.grid.lecture[2][2].needed, 0);
});

test('kinds of room follow Class Assignment', () => {
  const base = { subject_code: 'IT 311', has_lab: true, one_room: false };
  assert.deepEqual(allowedPools({ ...base, part: 'lab' }), ['laboratory']);
  assert.deepEqual(allowedPools({ ...base, part: 'lec', one_room: true }), ['laboratory']);
  assert.deepEqual(allowedPools({ ...base, part: 'lec' }), ['lecture', 'laboratory', 'pathfit']);
  assert.deepEqual(allowedPools({ ...base, part: 'lec', has_lab: false }), ['lecture', 'pathfit']);
  assert.deepEqual(allowedPools({ part: 'lec', subject_code: 'PATH-FIT 1', has_lab: false, one_room: false }), ['pathfit']);
  assert.equal(roomPoolOf({ room_name: 'CCA Gym', room_type: 'Lecture' }), 'pathfit');
  assert.equal(roomPoolOf({ room_name: 'Lab 4', room_type: 'Laboratory' }), 'laboratory');
  assert.equal(roomPoolOf({ room_name: 'Old Lab', room_type: 'Computer Lab' }), 'laboratory');
  assert.equal(roomPoolOf({ room_name: 'M.P. 1', room_type: 'Lecture' }), 'lecture');
});

test('a Major subject\'s Lecture in its laboratory is lab demand; a lecture-only class in a lab is the wrong kind', () => {
  const major = { has_lab: true, one_room: true, subject_code: 'IT 311', ms_id: 500, faculty_id: 7 };
  const p = plan([
    s('Monday', '08:00', '09:00', 101, { ...major, part: 'lab' }),
    s('Monday', '09:00', '10:00', 101, { ...major, part: 'lec' }),
    s('Monday', '08:00', '09:00', 102, { subject_code: 'GE 1' }),
  ], [...lectureRooms(1), ...labRooms(2)]);
  assert.equal(p.pools.laboratory.meetings, 2);
  assert.equal(p.pools.lecture.meetings, 1);
  assert.deepEqual(p.issues.map(c => [c.subject_code, c.issues]), [['GE 1', ['wrong_type']]]);
  const [d, h] = at(0, 8);
  // The lab it sits in is still in use — but lab demand at 8 is the Major's lab only
  assert.deepEqual(p.grid.laboratory[d][h], { needed: 1, in_use: 2, usable: 2, short: 0 });
  assert.deepEqual(p.grid.lecture[d][h], { needed: 1, in_use: 0, usable: 1, short: 0 });
});

test('PATHFIT only in its venues; the venues are counted on their own', () => {
  const p = plan([
    s('Tuesday', '08:00', '10:00', 1, { subject_code: 'PATHFIT 1' }),
    s('Tuesday', '08:00', '10:00', 202, { subject_code: 'PATHFIT 3' }),
    s('Tuesday', '10:00', '12:00', 201, { subject_code: 'GE 5' }), // a lecture may use a venue
  ], [...lectureRooms(2), ...venues]);
  assert.equal(p.pools.lecture.usable, 2);
  assert.equal(p.pools.pathfit.usable, 2);
  assert.equal(p.pools.pathfit.meetings, 3);
  assert.equal(p.pools.lecture.meetings, 0);
  assert.deepEqual(p.issues.map(c => [c.subject_code, c.issues]), [['PATHFIT 1', ['not_pathfit_venue']]]);
});

test('an inactive room is not usable, and its class still needs a room', () => {
  const p = plan(
    [s('Monday', '08:00', '09:00', 1), s('Monday', '08:00', '09:00', 2)],
    [...lectureRooms(1), { id: 2, room_name: 'Lecture-2', room_type: 'Lecture', active: false }],
  );
  assert.equal(p.totals.usable, 1);
  assert.equal(p.pools.lecture.peak, 2);
  assert.equal(p.pools.lecture.additional, 1);
  assert.deepEqual(p.issues.map(c => c.issues), [['inactive_room']]);
});

test('a double-booked room: both classes flagged, the room counted once', () => {
  const p = plan([s('Monday', '08:00', '09:00', 1), s('Monday', '08:30', '09:30', 1)], lectureRooms(1));
  assert.equal(p.pools.lecture.peak, 2);
  assert.equal(p.pools.lecture.max_short, 1);
  assert.ok(p.issues.length === 2 && p.issues.every(c => c.issues.includes('double_booked')));
  const [d, h] = at(0, 8);
  assert.deepEqual(p.grid.lecture[d][h], { needed: 2, in_use: 1, usable: 1, short: 1 });
});

test('kinds of room never stand in for each other', () => {
  const lab = { part: 'lab', has_lab: true, one_room: true };
  const p = plan([
    s('Monday', '08:00', '09:00', 101, lab),
    s('Monday', '08:00', '09:00', null, lab),
    s('Monday', '08:00', '09:00', 1),
  ], [...lectureRooms(3), ...labRooms(1)]);
  assert.equal(p.pools.laboratory.max_short, 1);
  assert.equal(p.pools.laboratory.additional, 1);
  assert.equal(p.totals.peak, 3);
  assert.equal(p.totals.max_short, 1); // two free lecture rooms don't help a lab class
  const [d, h] = at(0, 8);
  assert.deepEqual(p.grid.all[d][h], { needed: 3, in_use: 2, usable: 4, short: 1, by_pool: { lecture: 1, laboratory: 1, pathfit: 0 } });
});

test('all rooms: each hour says how many rooms of each kind are in use at its moment, adding up to in use', () => {
  const lab = { part: 'lab', has_lab: true, one_room: true };
  const p = plan([
    // 9:00–9:30 two lecture rooms and a lab; 9:30–10:00 one lecture room and two labs
    s('Monday', '09:00', '09:30', 1), s('Monday', '09:00', '10:00', 2),
    s('Monday', '09:00', '10:00', 101, lab), s('Monday', '09:30', '10:00', 102, lab),
    s('Monday', '09:00', '10:00', 201, { subject_code: 'PATHFIT 1' }),
  ], [...lectureRooms(3), ...labRooms(2), ...venues]);
  const [d, h] = at(0, 9);
  const all = p.grid.all[d][h];
  assert.ok(all.by_pool);
  assert.equal(all.by_pool.lecture + all.by_pool.laboratory + all.by_pool.pathfit, all.in_use);
  assert.equal(all.by_pool.pathfit, 1);
  // Each kind on its own peaks at a different moment, so their own cells add up to more
  assert.equal(p.grid.lecture[d][h].in_use + p.grid.laboratory[d][h].in_use + p.grid.pathfit[d][h].in_use, 5);
  assert.equal(all.in_use, 4);
  // An hour with nothing on: all zero
  const [d2, h2] = at(0, 15);
  assert.deepEqual(p.grid.all[d2][h2].by_pool, { lecture: 0, laboratory: 0, pathfit: 0 });
});

test('more class hours than the rooms hold between 7 AM and 6 PM need more rooms; late classes are flagged', () => {
  // 12 two-hour classes, never more than 2 at once, but 24 hours on one day: 10 hours fit a room → 3 rooms
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const p = plan(many(12, i => {
    const start = 7 + 2 * Math.floor(i / 2) + (i >= 6 ? 1 : 0); // 7, 9, 11, then 2 PM, 4 PM, 6 PM
    return s('Tuesday', hh(start), hh(start + 2), (i % 2) + 1);
  }), lectureRooms(2));
  assert.equal(p.pools.lecture.peak, 2);
  assert.equal(p.pools.lecture.hours_day, 'Tuesday');
  assert.equal(p.pools.lecture.hours_day_minutes, 24 * 60);
  assert.equal(p.pools.lecture.rooms_by_hours, 3);
  assert.equal(p.pools.lecture.required, 3);
  assert.equal(p.pools.lecture.additional, 1);
  assert.equal(p.totals.after_hours, 2);
  assert.equal(p.totals.without_room, 0);
});

test('invalid times and duplicate rows are ignored', () => {
  const dup = s('Monday', '08:00:00', '09:00:00', 1);
  const p = plan([
    dup, { ...dup, id: 999 }, { ...dup, id: 998, room_id: null },
    s('Monday', '25:00', '26:00', null), s('Funday', '08:00', '09:00', null), s('Monday', '08:00', '08:00', null),
  ], lectureRooms(2));
  assert.equal(p.totals.meetings, 1);
  assert.equal(p.totals.invalid, 3);
  assert.equal(p.totals.without_room, 0); // the copy with a room is kept
});

test('a class running past midnight overlaps a late class', () => {
  const p = plan([s('Monday', '20:00', '00:00', 1), s('Monday', '21:00', '22:00', 2)], lectureRooms(2));
  assert.equal(p.pools.lecture.peak, 2);
  assert.equal(p.pools.lecture.peak_at?.start, '21:00');
  assert.equal(p.totals.after_hours, 2);
});

test('a Major Lecture outside its Laboratory\'s room breaks the one-room rule', () => {
  const major = { has_lab: true, one_room: true, ms_id: 600, subject_code: 'IT 212' };
  const p = plan([
    s('Monday', '08:00', '09:00', 101, { ...major, part: 'lab' }),
    s('Thursday', '08:00', '09:00', 102, { ...major, part: 'lec' }),
  ], labRooms(2));
  assert.deepEqual(p.issues.map(c => [c.part, c.issues]), [['lec', ['split_rooms']]]);
});

test('projection: classes with no time yet against the room hours still free (at least)', () => {
  const lab = { part: 'lab', has_lab: true, one_room: true };
  // One laboratory, booked Monday–Thursday 7–12 and 1–6: 40 of its 50 weekly hours
  const sessions = ['Monday', 'Tuesday', 'Wednesday', 'Thursday'].flatMap(d => [
    s(d, '07:00', '12:00', 101, lab), s(d, '13:00', '18:00', 101, lab),
  ]);
  const pending = (n: number, minutes: number, withFaculty: number): PlanningPendingInput[] =>
    Array.from({ length: n }, (_, i) => ({
      ms_id: 900 + i, part: 'lab', minutes, subject_code: `IT ${i}`, has_lab: true, one_room: true, has_faculty: i < withFaculty,
    }));

  const fits = plan(sessions, labRooms(1), pending(3, 180, 3));
  assert.equal(fits.week_minutes, 5 * 600);
  assert.equal(fits.pools.laboratory.booked_minutes, 2400);
  assert.equal(fits.pools.laboratory.free_minutes, 600);
  assert.equal(fits.pools.laboratory.projected.additional, 0);

  const short = plan(sessions, labRooms(1), pending(6, 180, 4));
  assert.equal(short.pools.laboratory.projected.classes, 6);
  assert.equal(short.pools.laboratory.projected.minutes, 1080);
  assert.equal(short.pools.laboratory.projected.additional, 1);
  assert.equal(short.pools.laboratory.additional, 0); // nothing short right now
  assert.equal(short.totals.pending_classes, 6);
  assert.equal(short.totals.pending_without_faculty, 2);
  assert.equal(short.totals.projected_additional, 1);
});

test('projection: a Major Lecture goes to the laboratories, PATHFIT to its venues, other lectures to lecture rooms', () => {
  const p = plan([], [...lectureRooms(1), ...labRooms(1), ...venues], [
    { ms_id: 1, part: 'lec', minutes: 120, subject_code: 'IT 1', has_lab: true, one_room: true, has_faculty: true },
    { ms_id: 2, part: 'lec', minutes: 120, subject_code: 'PATHFIT 2', has_lab: false, one_room: false, has_faculty: true },
    { ms_id: 3, part: 'lec', minutes: 180, subject_code: 'GE 3', has_lab: false, one_room: false, has_faculty: false },
  ]);
  assert.equal(p.pools.laboratory.projected.minutes, 120);
  assert.equal(p.pools.pathfit.projected.minutes, 120);
  assert.equal(p.pools.lecture.projected.minutes, 180);
  assert.equal(p.totals.projected_additional, 0);
});

test('Saturday joins the school week only when classes meet then', () => {
  assert.deepEqual(plan([s('Monday', '08:00', '09:00', 1)], lectureRooms(1)).days, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
  const sat = plan([s('Saturday', '08:00', '09:00', 1)], lectureRooms(1));
  assert.equal(sat.days.length, 6);
  assert.equal(sat.week_minutes, 6 * 600);
});

test('the busiest hour slots, busiest first', () => {
  const p = plan([
    ...many(3, i => s('Monday', '09:00', '10:00', i + 1)),
    ...many(2, i => s('Tuesday', '13:00', '14:00', i + 1)),
    s('Friday', '07:00', '08:00', 1),
  ], lectureRooms(3));
  assert.deepEqual(p.busiest.map(b => [b.day, b.hour, b.needed]), [['Monday', 9, 3], ['Tuesday', 13, 2], ['Friday', 7, 1]]);
});

test('nothing scheduled: zeros, no issues', () => {
  const p = plan([], [...lectureRooms(2), ...labRooms(1)]);
  assert.equal(p.totals.peak, 0);
  assert.equal(p.totals.peak_at, null);
  assert.equal(p.totals.usable, 3);
  assert.equal(p.pools.lecture.required, 0);
  assert.deepEqual(p.busiest, []);
  assert.deepEqual(p.issues, []);
});

test('the rooms behind the busiest-time numbers: in use with their class, free until their next class', () => {
  const p = plan([
    s('Monday', '09:00', '10:00', 1, { subject_code: 'IT 1', block: 'BSIT 1A', faculty_name: 'Ana' }),
    s('Monday', '09:00', '10:30', 2),
    s('Monday', '09:00', '10:00', 101, { part: 'lab', has_lab: true }),
    s('Monday', '11:00', '12:00', 3),   // Lecture-3 is free at 9, busy again at 11
    s('Monday', '08:00', '09:00', 4),   // ended before the busiest time
  ], [...lectureRooms(4), ...labRooms(2)]);
  const lec = p.busiest_rooms.lecture;
  assert.deepEqual(lec.at, { day: 'Monday', start: '09:00', end: '10:00' });
  assert.deepEqual(lec.in_use.map(r => r.room_name), ['Lecture-1', 'Lecture-2']);
  assert.deepEqual(lec.in_use[0].classes[0], { subject_code: 'IT 1', block: 'BSIT 1A', faculty_name: 'Ana', part: 'lec', start: '09:00', end: '10:00' });
  assert.deepEqual(lec.free.map(r => [r.room_name, r.until]), [['Lecture-3', '11:00'], ['Lecture-4', null]]);
  // The lists always add up to the numbers shown (same hour slot as the answer)
  for (const key of ['lecture', 'laboratory', 'pathfit', 'all'] as const) {
    const cell = snapshotCell(p, key);
    const c = cell ? p.grid[key][cell[0]][cell[1]] : null;
    const usable = key === 'all' ? p.totals.usable : p.pools[key].usable;
    assert.equal(p.busiest_rooms[key].in_use.length, Math.min(c?.in_use ?? 0, usable), key);
    assert.equal(p.busiest_rooms[key].free.length, usable - p.busiest_rooms[key].in_use.length, key);
  }
  assert.deepEqual(p.busiest_rooms.all.in_use.map(r => r.room_name), ['Lab 1', 'Lecture-1', 'Lecture-2']);
});
