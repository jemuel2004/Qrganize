import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkloadRow } from '@shared/workloadImport';
import { candidatesFromDraft, describeSessions, draftsFromSheet, resolveRowComponent, type TimedRow } from './components';
import { buildCategoryPlan } from './plan';
import type { CatalogSubject } from './types';

const row = (over: Partial<WorkloadRow>): WorkloadRow => ({
  sheet: 'S', row: 10, kind: 'class', dayGroup: 'MTh', days: ['Monday', 'Thursday'], timeText: '',
  time: { start: 7 * 60, end: 8 * 60 + 30 }, code: 'IT 112', description: '', course: 'BSIT 1E',
  students: 40, units: null, hours: null, room: '', marker: null, notes: [], ...over,
});
const t = (h: number, m = 0) => h * 60 + m;
const subject = (lec: number, lab: number): CatalogSubject => ({
  id: 1, programId: 1, yearLevel: '1st Year', semester: '1st Semester', version: 'old',
  code: 'IT 112', name: 'Fundamentals of Programming', lecHours: lec, labHours: lab, totalHours: lec + lab,
});

test('a row\'s part of the subject is read from its units first, then hours, then the marker', () => {
  assert.equal(resolveRowComponent(row({ units: 2, hours: 2 }), 2, 3).component.kind, 'lec');
  assert.equal(resolveRowComponent(row({ units: 2.25, hours: 3 }), 2, 3).component.kind, 'lab');
  assert.equal(resolveRowComponent(row({ units: 4.25, hours: 5, marker: 'lab' }), 2, 3).component.kind, 'both');
  // marked (Lec) but units of the Laboratory → Laboratory, and said so
  const swapped = resolveRowComponent(row({ units: 2.25, hours: 3, marker: 'lec' }), 2, 3);
  assert.equal(swapped.component.kind, 'lab');
  assert.match(swapped.note ?? '', /units are those of the Laboratory/);
  // part of a component (split between two load forms)
  assert.deepEqual(resolveRowComponent(row({ units: 0.75, hours: 1, marker: 'lab' }), 2, 3).component, { kind: 'partial', type: 'lab', value: 0.75 });
  // one 3-unit item for a 2 h Lec + 3 h Lab subject cannot be split without guessing
  assert.equal(resolveRowComponent(row({ units: 3, hours: 3 }), 2, 3).component.kind, 'unknown');
  // single-component subjects
  assert.equal(resolveRowComponent(row({ units: 1, hours: 1 }), 3, 0).component.kind, 'lec');
  assert.equal(resolveRowComponent(row({ units: 2.25, marker: 'lec' }), 0, 6).component.kind, 'lab');
});

test('90 minutes on two days is 3 hours a week; a 1-hour lecture in a 90-minute slot keeps its days and start', () => {
  const lab = draftsFromSheet([{ row: row({ time: { start: t(8, 30), end: t(10) } }), kind: 'lab', room: null }], 2, 3);
  const asWritten = candidatesFromDraft(lab.lab!, 'lab', 3);
  assert.equal(asWritten.asWritten?.fit, 'as-written');
  assert.equal(describeSessions(asWritten.asWritten!.sessions), 'Mon/Thu 8:30 AM–10:00 AM');

  const lec = draftsFromSheet([{ row: row({ time: { start: t(7), end: t(8, 30) } }), kind: 'lec', room: null }], 2, 3);
  const adjusted = candidatesFromDraft(lec.lec!, 'lec', 2);
  assert.equal(adjusted.asWritten, undefined);
  assert.equal(describeSessions(adjusted.adjusted!.sessions), 'Mon/Thu 7:00 AM–8:00 AM');
  assert.match(adjusted.adjusted!.notes.at(-1) ?? '', /3 h a week; set to Mon\/Thu 7:00 AM–8:00 AM = 2 h/);

  // keeping the start would cross lunch → the end is kept
  const late = draftsFromSheet([{ row: row({ time: { start: t(11), end: t(12) } }), kind: 'lab', room: null }], 2, 3);
  assert.equal(describeSessions(candidatesFromDraft(late.lab!, 'lab', 3).adjusted!.sessions), 'Mon/Thu 10:30 AM–12:00 PM');
});

test('a whole-subject block is split Lecture first: one long meeting, or whole days for DAILY', () => {
  const wed: TimedRow = { row: row({ days: ['Wednesday'], time: { start: t(13), end: t(18) } }), kind: 'both', room: null };
  const d = draftsFromSheet([wed], 2, 3);
  assert.equal(describeSessions(d.lec!.sessions), 'Wed 1:00 PM–3:00 PM');
  assert.equal(describeSessions(d.lab!.sessions), 'Wed 3:00 PM–6:00 PM');

  const daily: TimedRow = {
    row: row({ days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], time: { start: t(17), end: t(18) } }),
    kind: 'both', room: null,
  };
  const dd = draftsFromSheet([daily], 2, 3);
  assert.equal(describeSessions(dd.lec!.sessions), 'Mon/Tue 5:00 PM–6:00 PM');
  assert.equal(describeSessions(dd.lab!.sessions), 'Wed/Thu/Fri 5:00 PM–6:00 PM');
});

test('Lec/Lab labels that are the other way round from their times are swapped, times kept', () => {
  const rows: TimedRow[] = [
    { row: row({ days: ['Wednesday'], time: { start: t(7), end: t(9) } }), kind: 'lab', room: null },
    { row: row({ days: ['Wednesday'], time: { start: t(9), end: t(12) } }), kind: 'lec', room: null },
  ];
  const d = draftsFromSheet(rows, 2, 3);
  assert.equal(describeSessions(d.lec!.sessions), 'Wed 7:00 AM–9:00 AM');
  assert.equal(describeSessions(d.lab!.sessions), 'Wed 9:00 AM–12:00 PM');
  assert.match(d.lec!.notes.join(' '), /labels swapped/);
});

test('load categories are stored the way Faculty Workload stores them', () => {
  const s = subject(2, 3);
  const r = (role: 'regular' | 'overload' | 'praise', comp: ReturnType<typeof resolveRowComponent>['component'], timeText = 'x') =>
    ({ role, comp, row: row({ timeText }) });

  const regular = buildCategoryPlan([r('regular', { kind: 'both' })], s, true).plan!;
  assert.deepEqual([regular.loadCategory, regular.loadValue, regular.overloadRow], ['Regular', 4.25, null]);

  const split = buildCategoryPlan([r('regular', { kind: 'lec' }, 'a'), r('overload', { kind: 'lab' }, 'b')], s, true).plan!;
  assert.deepEqual([split.loadCategory, split.loadValue, split.overloadComponent], ['Regular', 2, 'lab']);
  assert.deepEqual(split.overloadRow && [split.overloadRow.value, split.overloadRow.isPraise], [2.25, false]);

  const praiseAmount = buildCategoryPlan([
    r('regular', { kind: 'partial', type: 'lab', value: 0.75 }, 'a'),
    r('praise', { kind: 'partial', type: 'lab', value: 1.5 }, 'b'),
    r('praise', { kind: 'lec' }, 'c'),
  ], s, true).plan!;
  assert.deepEqual([praiseAmount.loadValue, praiseAmount.overloadComponent, praiseAmount.overloadRow?.value, praiseAmount.overloadRow?.isPraise],
    [0.75, 'full', 3.5, true]);

  const overload = buildCategoryPlan([r('overload', { kind: 'unknown' })], s, true).plan!;
  assert.deepEqual([overload.loadCategory, overload.loadValue, overload.overloadRow?.value], ['Overload', 4.25, 4.25]);

  // Overload + Praise in one subject is not a state QRganize allows → reported, not stored
  const both = buildCategoryPlan([r('overload', { kind: 'lab' }, 'a'), r('praise', { kind: 'lec' }, 'b')], s, true);
  assert.equal(both.plan, undefined);
  assert.match(both.problem ?? '', /never Overload \+ Praise/);

  // Contractual loads are in hours
  const contractual = buildCategoryPlan([r('regular', { kind: 'both' })], s, false).plan!;
  assert.equal(contractual.loadValue, 5);
});
