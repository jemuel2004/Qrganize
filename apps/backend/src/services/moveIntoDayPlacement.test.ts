import assert from 'node:assert/strict';
import test from 'node:test';
import type { WeekDay } from '@shared/dayCombination';
import { insideSchoolDay, placeClassInDay, placeInDay, type BusyKind, type ClassPlacementInput, type PlacementInput } from './moveIntoDayPlacement';

const hm = (h: number, m = 0) => h * 60 + m;
const ROOMS = [{ id: 1, name: 'Lecture-2' }, { id: 2, name: 'Lecture-3' }];
type Taken = { kind: BusyKind; id: number; day: string; start: number; end: number }[];
const busyFrom = (taken: Taken) => (kind: BusyKind, id: number, day: string, start: number, end: number) =>
  taken.some(t => t.kind === kind && t.id === id && t.day === day && start < t.end && end > t.start);
const input = (over: Partial<PlacementInput> & { taken?: Taken } = {}): PlacementInput => ({
  meetings: [{ day: 'Monday', minutes: 90 }, { day: 'Thursday', minutes: 90 }],
  rooms: ROOMS, lockedDays: null, combos: [['Monday', 'Thursday'], ['Tuesday', 'Friday'], ['Wednesday']],
  facultyId: 7, blockId: 3, busy: busyFrom(over.taken ?? []), ...over,
});

test('the school day is 7:00 AM–6:00 PM with lunch kept free', () => {
  assert.equal(insideSchoolDay(hm(17, 30), hm(19)), false);
  assert.equal(insideSchoolDay(hm(16, 30), hm(18)), true);
  assert.equal(insideSchoolDay(hm(11, 30), hm(13)), false);
  assert.equal(insideSchoolDay(hm(7), hm(8, 30)), true);
  assert.equal(insideSchoolDay(hm(6, 30), hm(8)), false);
  assert.equal(insideSchoolDay(hm(23), hm(0, 30)), false);
});

test('same days, same room, the latest free time — as close to where it was as possible', () => {
  assert.deepEqual(placeInDay(input()), [
    { day: 'Monday', start: hm(16, 30), end: hm(18), roomId: 1 },
    { day: 'Thursday', start: hm(16, 30), end: hm(18), roomId: 1 },
  ]);
});

test('the faculty, the block and the room must all be free on every day', () => {
  // The faculty teaches Monday 4:30–6:00 → the same time on both days is 3:00–4:30
  const placed = placeInDay(input({ taken: [{ kind: 'fac', id: 7, day: 'Monday', start: hm(16, 30), end: hm(18) }] }));
  assert.deepEqual(placed?.map(p => [p.day, p.start, p.end]), [['Monday', hm(15), hm(16, 30)], ['Thursday', hm(15), hm(16, 30)]]);
  // Its room is taken all Monday afternoon → the next room
  const roomBusy = placeInDay(input({ taken: [{ kind: 'room', id: 1, day: 'Monday', start: hm(7), end: hm(18) }] }));
  assert.equal(roomBusy?.[0].roomId, 2);
});

test('locked days (a Major Lec + Lab part) are kept; otherwise another day set is tried', () => {
  const locked = placeInDay(input({ meetings: [{ day: 'Tuesday', minutes: 90 }, { day: 'Friday', minutes: 90 }], lockedDays: ['Monday', 'Thursday'] as WeekDay[] }));
  assert.deepEqual(locked?.map(p => p.day), ['Monday', 'Thursday']);
  // The block is busy all Monday and Thursday → Tue/Fri, the next quick pick
  const full: Taken = ['Monday', 'Thursday'].map(day => ({ kind: 'blk' as BusyKind, id: 3, day, start: hm(7), end: hm(18) }));
  assert.deepEqual(placeInDay(input({ taken: full }))?.map(p => p.day), ['Tuesday', 'Friday']);
  // ...but not when the days are locked
  assert.equal(placeInDay(input({ taken: full, lockedDays: ['Monday', 'Thursday'] as WeekDay[] })), null);
});

test('a lab meeting of 3 hours never crosses lunch or 6:00 PM', () => {
  const placed = placeInDay(input({ meetings: [{ day: 'Wednesday', minutes: 180 }] }));
  assert.ok(placed);
  assert.ok(placed.every(p => insideSchoolDay(p.start, p.end)));
  assert.deepEqual(placed.map(p => [p.start, p.end]), [[hm(15), hm(18)]]);
});

/* ── A Major Lec + Lab class moving whole: one laboratory, the same days ── */

const LABS = [{ id: 3, name: 'Lab 3' }, { id: 4, name: 'Lab 4' }];
const classInput = (over: Partial<ClassPlacementInput> & { taken?: Taken } = {}): ClassPlacementInput => ({
  lec: [{ day: 'Wednesday', minutes: 120 }], lab: [{ day: 'Wednesday', minutes: 180 }],
  rooms: LABS, combos: [['Monday', 'Thursday'], ['Tuesday', 'Friday'], ['Wednesday']],
  near: { lec: hm(13), lab: hm(18) }, facultyId: 7, blockId: 3, busy: busyFrom(over.taken ?? []), ...over,
});
const at = (m: { day: string; start: number; end: number; roomId: number }[]) => m.map(x => [x.day, x.start, x.end, x.roomId]);

test('a class with no room for both parts on its day moves whole to another day, back to back, ending by 6:00 PM', () => {
  // Wednesday: the faculty teaches all morning and the block has a class 5–6 PM → 4 free hours, 5 needed
  const placed = placeClassInDay(classInput({ taken: [
    { kind: 'fac', id: 7, day: 'Wednesday', start: hm(7), end: hm(12) },
    { kind: 'blk', id: 3, day: 'Wednesday', start: hm(17), end: hm(18) },
  ] }));
  assert.ok(placed);
  assert.deepEqual(at(placed.lec), [['Monday', hm(13), hm(15), 3]]);
  assert.deepEqual(at(placed.lab), [['Monday', hm(15), hm(18), 3]]);
});

test('its days are kept when they can be: the Lecture and Laboratory at separate times in a free laboratory', () => {
  // Tue/Fri: the faculty is free 7:00–7:30, 11–12 and 4–6 PM; Lab 3 is full until 4 PM
  const taken: Taken = ['Tuesday', 'Friday'].flatMap(day => [
    { kind: 'fac' as BusyKind, id: 7, day, start: hm(7, 30), end: hm(11) },
    { kind: 'fac' as BusyKind, id: 7, day, start: hm(13), end: hm(14, 30) },
    { kind: 'blk' as BusyKind, id: 3, day, start: hm(14, 30), end: hm(16) },
    { kind: 'room' as BusyKind, id: 3, day, start: hm(7, 30), end: hm(16) },
  ]);
  const placed = placeClassInDay(classInput({
    lec: [{ day: 'Tuesday', minutes: 60 }, { day: 'Friday', minutes: 60 }],
    lab: [{ day: 'Tuesday', minutes: 90 }, { day: 'Friday', minutes: 90 }],
    near: { lec: hm(16), lab: hm(17) },
    taken,
  }));
  assert.ok(placed);
  assert.deepEqual(at(placed.lec), [['Tuesday', hm(11), hm(12), 4], ['Friday', hm(11), hm(12), 4]]);
  assert.deepEqual(at(placed.lab), [['Tuesday', hm(16, 30), hm(18), 4], ['Friday', hm(16, 30), hm(18), 4]]);
});

test('different times per day when no time works on both, closest to where they were, never overlapping', () => {
  const placed = placeClassInDay(classInput({
    lec: [{ day: 'Monday', minutes: 60 }, { day: 'Thursday', minutes: 60 }],
    lab: [{ day: 'Monday', minutes: 90 }, { day: 'Thursday', minutes: 90 }],
    near: { lec: hm(9, 30), lab: hm(10, 30) },
    taken: [
      { kind: 'fac', id: 7, day: 'Monday', start: hm(13), end: hm(18) },
      { kind: 'fac', id: 7, day: 'Thursday', start: hm(7), end: hm(12) },
    ],
  }));
  assert.ok(placed);
  assert.deepEqual(at(placed.lec), [['Monday', hm(9, 30), hm(10, 30), 3], ['Thursday', hm(13), hm(14), 3]]);
  assert.deepEqual(at(placed.lab), [['Monday', hm(10, 30), hm(12), 3], ['Thursday', hm(14), hm(15, 30), 3]]);
  for (const [i, lec] of placed.lec.entries()) {
    const lab = placed.lab[i];
    assert.ok(lec.end <= lab.start || lab.end <= lec.start);
    assert.ok(insideSchoolDay(lec.start, lec.end) && insideSchoolDay(lab.start, lab.end));
  }
});

test('nothing free, or parts that meet a different number of times → not placed', () => {
  const allWeek: Taken = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(day => ({ kind: 'blk' as BusyKind, id: 3, day, start: hm(7), end: hm(18) }));
  assert.equal(placeClassInDay(classInput({ taken: allWeek })), null);
  assert.equal(placeClassInDay(classInput({ lab: [{ day: 'Tuesday', minutes: 90 }, { day: 'Friday', minutes: 90 }] })), null);
});

test('a class moving early in the day stays near its times — a short gap in another laboratory beats a far split in its own', () => {
  // Lecture 7:30–8:30, Laboratory 8:30–10:00 in Lab 3; the faculty is now busy 8:30–10:00 (Tue/Fri)
  const taken: Taken = ['Tuesday', 'Friday'].flatMap(day => [
    { kind: 'fac' as BusyKind, id: 7, day, start: hm(8, 30), end: hm(10) },
    // Lab 3 is free only before 10:00 and 5–6 PM: it could hold the class only split far apart (7:00 and 5 PM)
    { kind: 'room' as BusyKind, id: 3, day, start: hm(10), end: hm(12) },
    { kind: 'room' as BusyKind, id: 3, day, start: hm(13), end: hm(17) },
  ]);
  const placed = placeClassInDay(classInput({
    lec: [{ day: 'Tuesday', minutes: 60 }, { day: 'Friday', minutes: 60 }],
    lab: [{ day: 'Tuesday', minutes: 90 }, { day: 'Friday', minutes: 90 }],
    near: { lec: hm(7, 30), lab: hm(8, 30) },
    taken,
  }));
  assert.ok(placed);
  assert.deepEqual(at(placed.lec), [['Tuesday', hm(7, 30), hm(8, 30), 4], ['Friday', hm(7, 30), hm(8, 30), 4]]);
  assert.deepEqual(at(placed.lab), [['Tuesday', hm(10), hm(11, 30), 4], ['Friday', hm(10), hm(11, 30), 4]]);
});

test('a single part is placed closest to where it starts now', () => {
  // An early class (8:00) that must leave 8:00–9:30 goes to 9:30, not to the end of the day
  const placed = placeInDay(input({
    meetings: [{ day: 'Monday', minutes: 90, start: hm(8) }, { day: 'Thursday', minutes: 90, start: hm(8) }],
    taken: [{ kind: 'fac', id: 7, day: 'Monday', start: hm(7), end: hm(9, 30) }],
  }));
  assert.deepEqual(placed?.map(p => [p.day, p.start]), [['Monday', hm(9, 30)], ['Thursday', hm(9, 30)]]);
});
