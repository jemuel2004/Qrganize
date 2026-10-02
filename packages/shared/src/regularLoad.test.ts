import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_WORKLOAD_POLICY, LOAD_GRACE_UNITS,
  computeRegularLoadStatus, formatLoadCap, isRegularLoadComplete, maxDeductionUnits,
  normalizeWorkloadPolicy, overloadUnitsCap, parseWorkloadPolicy, permanentRegularLoadLimit,
  regularLoadLimit, regularUnitsCap, sameWorkloadPolicy, shownUnitsCap, shownUnitsLeft, shownUnitsOver,
  type WorkloadPolicy,
} from './regularLoad';

const P = DEFAULT_WORKLOAD_POLICY;

test('default caps carry the 0.25 grace and are shown without it', () => {
  assert.equal(regularUnitsCap(P), 18.25);
  assert.equal(overloadUnitsCap(P), 6.25);
  assert.equal(formatLoadCap(shownUnitsCap(regularUnitsCap(P))), '18');
  assert.equal(formatLoadCap(shownUnitsCap(overloadUnitsCap(P))), '6');
  assert.equal(formatLoadCap(shownUnitsCap(permanentRegularLoadLimit(3, P))), '15');
  assert.equal(formatLoadCap(shownUnitsCap(permanentRegularLoadLimit(1.5, P))), '16.50');
});

test('remaining is shown without the grace and never below 0', () => {
  assert.equal(shownUnitsLeft(18.25), 18);
  assert.equal(shownUnitsLeft(0.25), 0);
  assert.equal(shownUnitsLeft(0), 0);
});

test('over is 0 within the grace, then measured from the shown cap', () => {
  assert.equal(shownUnitsOver(18.25, 18.25), 0);
  assert.equal(shownUnitsOver(20.25, 18.25), 2.25);
});

test('18 of 18.25 is complete for Permanent; Contractual needs the exact cap', () => {
  assert.equal(isRegularLoadComplete(0.25, true), true);
  assert.equal(isRegularLoadComplete(0.5, true), false);
  assert.equal(isRegularLoadComplete(0.25, false), false);
  assert.equal(computeRegularLoadStatus(18, 18.25, true), 'Regular load complete');
  assert.equal(computeRegularLoadStatus(18.25, 18.25, true), 'Regular load complete');
  assert.equal(computeRegularLoadStatus(18.5, 18.25, true), 'Regular load exceeded');
  assert.equal(computeRegularLoadStatus(17.75, 18.25, true), 'Has remaining load');
});

test('a changed policy changes every limit the same way', () => {
  const p: WorkloadPolicy = { regularUnits: 21, overloadUnits: 9, contractualHours: 24 };
  assert.equal(regularUnitsCap(p), 21.25);
  assert.equal(overloadUnitsCap(p), 9.25);
  assert.equal(regularLoadLimit(true, 3, p), 18.25);
  assert.equal(regularLoadLimit(false, 3, p), 24); // deloading is for Permanent only
  assert.equal(formatLoadCap(shownUnitsCap(regularLoadLimit(true, 0, p))), '21');
  assert.equal(computeRegularLoadStatus(21, regularLoadLimit(true, 0, p), true), 'Regular load complete');
  assert.equal(computeRegularLoadStatus(21.5, regularLoadLimit(true, 0, p), true), 'Regular load exceeded');
  assert.equal(computeRegularLoadStatus(24, regularLoadLimit(false, 0, p), false), 'Regular load complete');
  assert.equal(maxDeductionUnits(p), 21.25);
});

test('no Overload allowed means a cap of 0, not the grace', () => {
  assert.equal(overloadUnitsCap({ ...P, overloadUnits: 0 }), 0);
  assert.equal(shownUnitsCap(overloadUnitsCap({ ...P, overloadUnits: 0 })), 0);
});

test('deloading larger than a lowered limit leaves 0, never a negative limit', () => {
  const lowered = { ...P, regularUnits: 12 };
  assert.equal(permanentRegularLoadLimit(15, lowered), 0);
  assert.equal(permanentRegularLoadLimit(-2, lowered), 12.25); // bad input is ignored
  assert.equal(permanentRegularLoadLimit(Number.NaN, lowered), 12.25);
});

test('the Settings form input is checked and rounded', () => {
  const ok = parseWorkloadPolicy({ regularUnits: '21', overloadUnits: 6.256, contractualHours: 27.5 });
  assert.deepEqual(ok, { ok: true, policy: { regularUnits: 21, overloadUnits: 6.26, contractualHours: 27.5 } });
  assert.deepEqual(parseWorkloadPolicy({ regularUnits: 18, overloadUnits: 0, contractualHours: 30 }),
    { ok: true, policy: { regularUnits: 18, overloadUnits: 0, contractualHours: 30 } });

  const bad = (input: unknown) => {
    const r = parseWorkloadPolicy(input);
    return r.ok ? null : `${r.field ?? ''}|${r.error}`;
  };
  assert.equal(bad(null), '|Enter the workload limits.');
  assert.equal(bad([18, 6, 30]), '|Enter the workload limits.');
  assert.equal(bad({ regularUnits: '', overloadUnits: 6, contractualHours: 30 }), 'regularUnits|Regular load (Permanent): enter a number.');
  assert.equal(bad({ regularUnits: 'abc', overloadUnits: 6, contractualHours: 30 }), 'regularUnits|Regular load (Permanent): enter a number.');
  assert.equal(bad({ regularUnits: 0, overloadUnits: 6, contractualHours: 30 }), 'regularUnits|Regular load (Permanent) must be from 1 to 40 units.');
  assert.equal(bad({ regularUnits: 18, overloadUnits: -1, contractualHours: 30 }), 'overloadUnits|Overload limit (Permanent) must be from 0 to 20 units.');
  assert.equal(bad({ regularUnits: 18, overloadUnits: 6, contractualHours: 61 }), 'contractualHours|Regular load (Contractual) must be from 1 to 60 hours.');
  assert.equal(bad({ regularUnits: Infinity, overloadUnits: 6, contractualHours: 30 }), 'regularUnits|Regular load (Permanent): enter a number.');
});

test('a stored policy is read safely, falling back per limit', () => {
  assert.deepEqual(normalizeWorkloadPolicy(null), P);
  assert.deepEqual(normalizeWorkloadPolicy('not json'), P);
  assert.deepEqual(normalizeWorkloadPolicy('{"regularUnits":21,"overloadUnits":9,"contractualHours":24}'),
    { regularUnits: 21, overloadUnits: 9, contractualHours: 24 });
  assert.deepEqual(normalizeWorkloadPolicy({ regularUnits: 21, overloadUnits: 'x', contractualHours: 999 }),
    { regularUnits: 21, overloadUnits: 6, contractualHours: 30 });
  assert.equal(sameWorkloadPolicy(normalizeWorkloadPolicy({}), P), true);
  assert.equal(sameWorkloadPolicy({ ...P, regularUnits: 21 }, P), false);
  assert.equal(LOAD_GRACE_UNITS, 0.25);
});
