import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryFromHours, categoryFromSubjectType, isMajorCourseCode, resolveSubjectCategory } from './subjectCategory';

test('CS / CPE / IT course codes are Major even when lecture only', () => {
  for (const code of ['CS 211', 'CS326', 'cs 121', 'CPE 101', 'CPE-12', 'IT 1', 'IT121', ' IT 222 ']) {
    assert.equal(isMajorCourseCode(code), true, code);
    assert.equal(categoryFromHours(3, 0, code), 'Major', code);
  }
});

test('other lecture-only codes stay Minor; similar prefixes do not count', () => {
  for (const code of ['GE-US', 'MATH 1', 'NSTP 1', 'PATH-FIT 1', 'ENTREP 1', 'ITE 101', 'CSS 1', 'RIZAL']) {
    assert.equal(isMajorCourseCode(code), false, code);
    assert.equal(categoryFromHours(3, 0, code), 'Minor', code);
  }
});

test('any lab hours is still Major whatever the code', () => {
  assert.equal(categoryFromHours(2, 3, 'GE-X'), 'Major');
  assert.equal(categoryFromSubjectType('Lecture + Laboratory', 'GE-X'), 'Major');
  assert.equal(categoryFromSubjectType('Lecture', 'CS 211'), 'Major');
  assert.equal(categoryFromSubjectType('Lecture', 'GE-AA'), 'Minor');
});

test('a Minor/Major picked on the form overrides the default and is marked manual', () => {
  assert.deepEqual(resolveSubjectCategory('Minor', 3, 0, 'IT 1'), { category: 'Minor', manual: true });
  assert.deepEqual(resolveSubjectCategory('major', 3, 0, 'GE-US'), { category: 'Major', manual: true });
});

test('picking the default, or nothing valid, follows the rule (not manual)', () => {
  assert.deepEqual(resolveSubjectCategory('Major', 3, 0, 'IT 1'), { category: 'Major', manual: false });
  assert.deepEqual(resolveSubjectCategory(undefined, 3, 0, 'IT 1'), { category: 'Major', manual: false });
  assert.deepEqual(resolveSubjectCategory('Elective', 3, 0, 'GE-US'), { category: 'Minor', manual: false });
});
