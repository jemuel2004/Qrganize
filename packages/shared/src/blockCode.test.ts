import assert from 'node:assert/strict';
import test from 'node:test';
import { blockCode } from './blockCode';

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
