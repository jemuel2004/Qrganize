import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OVERLOAD_MAX_UNITS, REGULAR_LOAD_MAX_UNITS,
  computeRegularLoadStatus, formatLoadCap, isRegularLoadComplete,
  permanentRegularLoadLimit, shownUnitsCap, shownUnitsLeft, shownUnitsOver,
} from './regularLoad';

test('caps are shown without the 0.25 grace', () => {
  assert.equal(formatLoadCap(shownUnitsCap(REGULAR_LOAD_MAX_UNITS)), '18');
  assert.equal(formatLoadCap(shownUnitsCap(OVERLOAD_MAX_UNITS)), '6');
  assert.equal(formatLoadCap(shownUnitsCap(permanentRegularLoadLimit(3))), '15');
  assert.equal(formatLoadCap(shownUnitsCap(permanentRegularLoadLimit(1.5))), '16.50');
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
