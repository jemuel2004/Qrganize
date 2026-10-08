import assert from 'node:assert/strict';
import test from 'node:test';
import { formLoadValue, formParts, isSplitLoad, loadParts, movedComponent, movedParts, sumParts } from './loadSplit';

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

test('formParts: only the parts with a class time, both while neither has one', () => {
  const both = { lecture_hours: 2, laboratory_hours: 3 };
  assert.deepEqual(formParts({ ...both, lec_scheduled: true, lab_scheduled: true }), ['lec', 'lab']);
  assert.deepEqual(formParts({ ...both, lec_scheduled: true, lab_scheduled: false }), ['lec']);
  assert.deepEqual(formParts({ ...both, lec_scheduled: false, lab_scheduled: true }), ['lab']);
  assert.deepEqual(formParts({ ...both, lec_scheduled: false, lab_scheduled: false }), ['lec', 'lab']);
  assert.deepEqual(formParts(both), ['lec', 'lab']);
  assert.deepEqual(formParts({ lecture_hours: 3, laboratory_hours: 0, lec_scheduled: false }), ['lec']);
  assert.deepEqual(formParts({ lecture_hours: 0, laboratory_hours: 3, lab_scheduled: false }), ['lab']);
});

test('formLoadValue: what Faculty Schedules counts = what the forms count', () => {
  const it111 = { load_category: 'Regular', lecture_hours: '2.00', laboratory_hours: '3.00' };
  // Lecture + Laboratory both scheduled: 2 + 3 × 0.75, whatever units were stored
  assert.equal(formLoadValue({ ...it111, lec_scheduled: true, lab_scheduled: true }, true, 'regular'), 4.25);
  // Laboratory without its class time yet: only the Lecture is on the form
  assert.equal(formLoadValue({ ...it111, lec_scheduled: true, lab_scheduled: false }, true, 'regular'), 2);
  // Contractual counts contact hours
  assert.equal(formLoadValue({ ...it111, lec_scheduled: true, lab_scheduled: false }, false, 'regular'), 2);
  assert.equal(formLoadValue({ ...it111, lec_scheduled: true, lab_scheduled: true }, false, 'regular'), 5);
  // Nothing scheduled yet: the whole subject
  assert.equal(formLoadValue({ ...it111, lec_scheduled: false, lab_scheduled: false }, true, 'regular'), 4.25);
  // Laboratory moved to Overload: Lecture stays Regular, the moved row counts the Laboratory
  const split = { ...it111, overload_component: 'lab', split_overload_units: '2.25', lec_scheduled: true, lab_scheduled: true };
  assert.equal(formLoadValue(split, true, 'regular'), 2);
  assert.equal(formLoadValue(split, true, 'moved'), 2.25);
  // A whole Overload subject is all moved
  assert.equal(formLoadValue({ ...it111, load_category: 'Overload', lec_scheduled: true, lab_scheduled: true }, true, 'moved'), 4.25);
  assert.equal(formLoadValue({ ...it111, load_category: 'Overload', lec_scheduled: true, lab_scheduled: true }, true, 'regular'), 0);
});
