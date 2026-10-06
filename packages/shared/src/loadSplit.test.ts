import assert from 'node:assert/strict';
import test from 'node:test';
import { isSplitLoad, loadParts, movedComponent, movedParts, sumParts } from './loadSplit';

// CS 111: Lec 2 h + Lab 3 h = 2 + 2.25 units
const cs111 = { lecture_hours: '2.00', laboratory_hours: '3.00' };

test('a Regular subject with nothing moved stays whole', () => {
  const parts = loadParts({ ...cs111, load_category: 'Regular', split_overload_units: 0 }, true);
  assert.deepEqual(parts.lec, { regularUnits: 2, regularHours: 2, movedUnits: 0, movedHours: 0 });
  assert.deepEqual(parts.lab, { regularUnits: 2.25, regularHours: 3, movedUnits: 0, movedHours: 0 });
});

test('a whole Overload / Praise subject is all moved', () => {
  const parts = loadParts({ ...cs111, load_category: 'Praise' }, true);
  assert.deepEqual(sumParts(parts), { regularUnits: 0, regularHours: 0, movedUnits: 4.25, movedHours: 5 });
});

test('CS 111: Lecture all Praise, Laboratory 1 unit Regular + 1.25 units Praise', () => {
  const load = { ...cs111, load_category: 'Regular', split_overload_units: '3.25', split_lec_part: '2.00', overload_component: 'full' };
  assert.equal(isSplitLoad(load, true), true);
  const parts = loadParts(load, true);
  assert.deepEqual(parts.lec, { regularUnits: 0, regularHours: 0, movedUnits: 2, movedHours: 2 });
  assert.deepEqual(parts.lab, { regularUnits: 1, regularHours: 1, movedUnits: 1.25, movedHours: 2 });
});

test('older rows without lec_part follow overload_component', () => {
  // Lab partly in Overload, Lecture all Regular
  assert.deepEqual(movedParts({ ...cs111, split_overload_units: 1.25, overload_component: 'lab' }, true), { lec: 0, lab: 1.25 });
  // Lecture moved, Laboratory all Regular
  assert.deepEqual(movedParts({ ...cs111, split_overload_units: 2, overload_component: 'lec' }, true), { lec: 2, lab: 0 });
  // Whole-subject split (Excel import): the Lecture first, then the Laboratory
  assert.deepEqual(movedParts({ ...cs111, split_overload_units: 3.5, overload_component: 'full' }, true), { lec: 2, lab: 1.5 });
});

test('single-part subjects and Contractual hours', () => {
  const lab = loadParts({ lecture_hours: 0, laboratory_hours: 3, split_overload_units: 1.5 }, true);
  assert.equal(lab.lec, null);
  assert.deepEqual(lab.lab, { regularUnits: 0.75, regularHours: 1, movedUnits: 1.5, movedHours: 2 });
  const contractual = loadParts({ ...cs111, split_overload_hours: 1, overload_component: 'lab' }, false);
  assert.deepEqual(contractual.lab, { regularUnits: 1.5, regularHours: 2, movedUnits: 0.75, movedHours: 1 });
});

test('movedComponent names what moved', () => {
  assert.equal(movedComponent(2, 0), 'lec');
  assert.equal(movedComponent(0, 1.25), 'lab');
  assert.equal(movedComponent(2, 1.25), 'full');
});
