import assert from 'node:assert/strict';
import test from 'node:test';
import { PATHFIT_VENUE_RULE, isPathfitSubject, isPathfitVenue, pathfitRoomAllowed } from './pathfitVenue';

test('PATHFIT subject codes are recognised however they are written', () => {
  for (const code of ['PATH-FIT 1', 'PATHFIT 3', 'path fit 2', ' PATH-FIT4 ']) assert.equal(isPathfitSubject(code), true, code);
  for (const code of ['NSTP 1', 'GE-US', 'IT 111', 'PE', '', null, undefined]) assert.equal(isPathfitSubject(code), false, String(code));
});

test('only the CCA Gym and the SAO Room are PATHFIT venues', () => {
  for (const name of ['CCA Gym', 'cca gym', 'CCA-Gym', 'Sao', 'SAO Room', 'sao room']) assert.equal(isPathfitVenue(name), true, name);
  for (const name of ['Lecture-1', 'M.P. 1', 'Lab 5', 'Gym', 'SAO Annex', 'Rob. Lab', '', null]) assert.equal(isPathfitVenue(name), false, String(name));
});

test('PATHFIT is limited to the venues; other subjects are not limited by this rule', () => {
  assert.equal(pathfitRoomAllowed('PATH-FIT 1', 'CCA Gym'), true);
  assert.equal(pathfitRoomAllowed('PATH-FIT 1', 'Sao'), true);
  assert.equal(pathfitRoomAllowed('PATH-FIT 1', 'Lecture-2'), false);
  assert.equal(pathfitRoomAllowed('PATH-FIT 3', 'Lab 1'), false);
  assert.equal(pathfitRoomAllowed('GE-US', 'Lecture-2'), true);
  assert.equal(pathfitRoomAllowed('GE-US', 'CCA Gym'), true);
  assert.match(PATHFIT_VENUE_RULE, /CCA Gym/);
  assert.match(PATHFIT_VENUE_RULE, /SAO Room/);
});
