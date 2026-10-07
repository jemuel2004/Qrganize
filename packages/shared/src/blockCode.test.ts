import assert from 'node:assert/strict';
import test from 'node:test';
import { blockCode, isBlockQuery, matchesBlockQuery, programBlockCode, programShortCode } from './blockCode';

test('program short name drops the BS degree prefix', () => {
  assert.equal(programShortCode('BSIT'), 'IT');
  assert.equal(programShortCode('BSCS'), 'CS');
  assert.equal(programShortCode('BSCpE'), 'CPE');
  assert.equal(programShortCode(' bsit '), 'IT');
  assert.equal(programShortCode('BS'), 'BS');
  assert.equal(programShortCode(null), '');
});

test('program + year + block become the timetable code', () => {
  assert.equal(programBlockCode('BSIT', '4th Year', 'B'), 'IT4B');
  assert.equal(programBlockCode('BSCS', '4th Year', 'A'), 'CS4A');
  assert.equal(programBlockCode('BSCpE', '2nd Year', 'A'), 'CPE2A');
  assert.equal(programBlockCode('BSIT', '1st Year', 'B'), 'IT1B');
  assert.equal(programBlockCode(null, '3rd Year', 'C'), '3C');
  assert.equal(programBlockCode('BSIT', 'Irregular', 'G'), 'IT Block G');
});

test('year level + block become the short code', () => {
  assert.equal(blockCode('1st Year', 'G'), '1G');
  assert.equal(blockCode('2nd Year', 'A'), '2A');
  assert.equal(blockCode('4th Year', ' B '), '4B');
});

test('missing or number-less year falls back safely', () => {
  assert.equal(blockCode(null, 'G'), 'Block G');
  assert.equal(blockCode('', 'G'), 'Block G');
  assert.equal(blockCode('Irregular', 'G'), 'Block G');
  assert.equal(blockCode('3rd Year', ''), '3');
  assert.equal(blockCode(undefined, undefined), '');
});

test('a search shaped like a block is recognised', () => {
  for (const q of ['2D', '2d', 'BSIT 2D', 'IT2D', 'it-2d', 'CPE 1A', '2nd Year Block D', '2nd year D', 'Block D'])
    assert.equal(isBlockQuery(q), true, q);
  for (const q of ['IT 416', 'Animation', '2D/3D', 'Lea Medrano', '2', 'IT', ''])
    assert.equal(isBlockQuery(q), false, q);
});

test('a block search finds that block (any program unless one is named)', () => {
  assert.equal(matchesBlockQuery('2D', 'BSIT', '2nd Year', 'D'), true);
  assert.equal(matchesBlockQuery('2D', 'BSCS', '2nd Year', 'D'), true);
  assert.equal(matchesBlockQuery('2D', 'BSIT', '4th Year', 'B'), false);
  assert.equal(matchesBlockQuery('2D', 'BSIT', '2nd Year', 'B'), false);
  assert.equal(matchesBlockQuery('BSIT 2D', 'BSIT', '2nd Year', 'D'), true);
  assert.equal(matchesBlockQuery('BSIT 2D', 'BSCS', '2nd Year', 'D'), false);
  assert.equal(matchesBlockQuery('IT2D', 'BSIT', '2nd Year', 'D'), true);
  assert.equal(matchesBlockQuery('CPE 1A', 'BSCpE', '1st Year', 'A'), true);
  assert.equal(matchesBlockQuery('2nd Year Block D', 'BSIT', '2nd Year', 'D'), true);
  assert.equal(matchesBlockQuery('Block D', 'BSIT', '3rd Year', 'D'), true);
});
