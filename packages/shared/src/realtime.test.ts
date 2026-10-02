import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  REALTIME_TOPICS, changedTopics, notificationTopicKey, realtimeWriteRule, topicsForRole, topicsForWrite,
} from './realtime';

test('reads never change anything', () => {
  assert.deepEqual(topicsForWrite('GET', '/api/workload/assign'), []);
  assert.deepEqual(topicsForWrite('head', '/api/rooms'), []);
});

test('class writes reach every page that shows classes', () => {
  for (const p of ['/api/workload/assign', '/api/workload/unassign', '/api/scheduling', '/api/blocks/4/subjects']) {
    assert.deepEqual(topicsForWrite('POST', p).sort(), ['blocks', 'schedule', 'workload'], p);
  }
  assert.deepEqual(topicsForWrite('PUT', '/api/praise-loads/3'), ['workload']);
  assert.deepEqual(topicsForWrite('POST', '/api/praise'), ['workload']);
  assert.ok(topicsForWrite('PUT', '/api/curriculum/9').includes('curriculum'));
  assert.ok(topicsForWrite('PUT', '/api/curriculum/9').includes('schedule'));
});

test('specific paths win over general ones', () => {
  assert.deepEqual(topicsForWrite('POST', '/api/rooms/qr-codes'), ['rooms']);
  assert.ok(topicsForWrite('DELETE', '/api/rooms/occupancy').includes('occupancy'));
  assert.deepEqual(topicsForWrite('POST', '/api/instructor-accounts/5/picture').sort(), ['accounts', 'faculty']);
  assert.deepEqual(topicsForWrite('POST', '/api/faculty/3/deductions').sort(), ['faculty', 'workload']);
  assert.ok(topicsForWrite('DELETE', '/api/faculty/3').includes('workload'));
});

test('checks, sign-in and personal settings change nothing shared', () => {
  for (const p of [
    '/api/scheduling/check-conflicts', '/api/settings/verify-password', '/api/curriculum/export',
    '/api/auth/login', '/api/auth/logout', '/api/account/change-password', '/api/instructor/profile/theme',
    '/api/notifications/5', '/api/notifications/read-all',
  ]) {
    assert.deepEqual(topicsForWrite('POST', p), [], p);
  }
  assert.deepEqual(topicsForWrite('POST', '/api/auth/verify-email-google'), ['accounts']);
});

test('new workload limits refresh loads; error-log writes are scoped', () => {
  assert.deepEqual(topicsForWrite('PUT', '/api/settings/workload-policy').sort(), ['faculty', 'settings', 'workload']);
  assert.deepEqual(topicsForWrite('PATCH', '/api/error-logs/12'), ['errors']);
  assert.deepEqual(topicsForWrite('PATCH', '/api/error-logs'), ['errors']);
  assert.deepEqual(topicsForWrite('POST', '/api/error-logs/report'), []);
});

test('a system reset refreshes every shared topic', () => {
  const t = topicsForWrite('POST', '/api/settings/reset');
  assert.equal(t.length, REALTIME_TOPICS.length - 1);
  assert.ok(!t.includes('notifications'));
});

test('roles only receive the topics their pages use', () => {
  assert.deepEqual(topicsForRole('admin'), [...REALTIME_TOPICS]);
  assert.deepEqual(topicsForRole('program_chair'), [...REALTIME_TOPICS]);
  const dept = topicsForRole('department_chair');
  assert.ok(!dept.includes('accounts') && !dept.includes('audit') && !dept.includes('errors') && dept.includes('schedule'));
  const faculty = topicsForRole('instructor');
  for (const hidden of ['accounts', 'audit', 'errors', 'blocks', 'curriculum', 'programs'] as const) assert.ok(!faculty.includes(hidden), hidden);
  for (const shown of ['schedule', 'workload', 'occupancy', 'room-requests', 'notifications'] as const) assert.ok(faculty.includes(shown), shown);
  assert.deepEqual(topicsForRole('guest'), []);
  assert.deepEqual(topicsForRole(undefined), []);
});

test('inbox keys follow how notifications are addressed', () => {
  assert.equal(notificationTopicKey('admin', 0), 'notifications:admin');
  assert.equal(notificationTopicKey('admin', 7), 'notifications:admin');
  assert.equal(notificationTopicKey('department_chair'), 'notifications:department_chair');
  assert.equal(notificationTopicKey('program_chair', 4), 'notifications:program_chair:4');
  assert.equal(notificationTopicKey('instructor', 12), 'notifications:instructor:12');
  assert.equal(notificationTopicKey('instructor', 0), null);
  assert.equal(notificationTopicKey('instructor', Number.NaN), null);
  assert.equal(notificationTopicKey('guest', 3), null);
});

test('changed topics compare by value, including resets and new topics', () => {
  assert.deepEqual(changedTopics({ rooms: 5, schedule: 2 }, { rooms: 5, schedule: 3 }), ['schedule']);
  assert.deepEqual(changedTopics({ rooms: 9 }, { rooms: 1 }), ['rooms']);
  assert.deepEqual(changedTopics({}, { audit: 4 }), ['audit']);
  assert.deepEqual(changedTopics({ term: 1 }, { term: 1 }), []);
});

test('every backend write route has a real-time rule', () => {
  const apiDir = path.resolve(__dirname, '../../../apps/backend/src/app/api');
  const routes: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'route.ts') routes.push(full);
    }
  })(apiDir);
  assert.ok(routes.length > 50, 'route files found');

  const missing: string[] = [];
  for (const file of routes) {
    const src = fs.readFileSync(file, 'utf8');
    if (!/export\s+(?:const|async\s+function|function)\s+(?:POST|PUT|PATCH|DELETE)\b/.test(src)) continue;
    const rel = path.relative(apiDir, path.dirname(file)).split(path.sep).join('/');
    const urlPath = `/api/${rel}`.replace(/\[[^\]]+\]/g, '1');
    if (!realtimeWriteRule(urlPath)) missing.push(urlPath);
  }
  assert.deepEqual(missing, []);
});
