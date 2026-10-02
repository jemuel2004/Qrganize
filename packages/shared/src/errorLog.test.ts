import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ERROR_LIMITS, errorFingerprintKey, formatLogArgs, moduleForError, parseLogTag, redactSecrets, routeFromSource, truncate,
} from './errorLog';

test('log tags are split from the message; untagged text is ignored', () => {
  assert.deepEqual(parseLogTag('[qr/scan] error: boom'), { tag: 'qr/scan', rest: 'error: boom' });
  assert.deepEqual(parseLogTag('[GET /api/faculty]'), { tag: 'GET /api/faculty', rest: '' });
  // route tags with brackets inside (found by the live check)
  assert.deepEqual(parseLogTag('[GET /api/workload/[facultyId]] boom'), { tag: 'GET /api/workload/[facultyId]', rest: 'boom' });
  assert.deepEqual(parseLogTag('[PATCH /api/error-logs/[id]]'), { tag: 'PATCH /api/error-logs/[id]', rest: '' });
  assert.equal(parseLogTag('[unclosed tag'), null);
  assert.equal(parseLogTag('[multi\nline]'), null);
  assert.equal(parseLogTag('plain message'), null);
  assert.equal(parseLogTag('⨯ Error: from Next'), null);
  assert.equal(parseLogTag(new Error('x')), null);
  assert.equal(parseLogTag('[]'), null);
});

test('routes are found inside sources', () => {
  assert.equal(routeFromSource('GET /api/faculty'), '/api/faculty');
  assert.equal(routeFromSource('/api/scheduling/[id]/route'), '/api/scheduling/[id]');
  assert.equal(routeFromSource('rooms/occupancy POST'), '/api/rooms/occupancy');
  assert.equal(routeFromSource('qr/scan'), '/api/qr/scan');
  assert.equal(routeFromSource('syncWorkloadMonitoringNotifications'), null);
  assert.equal(routeFromSource('v12'), null);
});

test('errors are filed under the module where they happened', () => {
  assert.equal(moduleForError({ source: 'qr/scan' }), 'Rooms');
  assert.equal(moduleForError({ source: 'rooms/occupancy GET' }), 'Rooms');
  assert.equal(moduleForError({ source: 'GET /api/faculty' }), 'Setup');
  assert.equal(moduleForError({ source: 'PUT /api/praise-loads/[id]' }), 'Workload');
  assert.equal(moduleForError({ source: '/api/scheduling/route' }), 'Scheduling');
  assert.equal(moduleForError({ source: 'syncWorkloadMonitoringNotifications' }), 'Notifications');
  assert.equal(moduleForError({ source: 'facultyLoadSummaries' }), 'Workload');
  assert.equal(moduleForError({ source: 'v32] users email index' }), 'Database');
  assert.equal(moduleForError({ source: 'schema-guard' }), 'Database');
  assert.equal(moduleForError({ source: 'DELETE dept-chair-account' }), 'Accounts');
  assert.equal(moduleForError({ source: 'geoip' }), 'Sign-in');
  // The source wins over the request that triggered it…
  assert.equal(moduleForError({ source: 'syncWorkloadMonitoringNotifications', path: '/api/workload/assign' }), 'Notifications');
  // …and a generic source falls back to the request
  assert.equal(moduleForError({ source: 'audit', path: '/api/workload/assign' }), 'Workload');
  assert.equal(moduleForError({ source: 'settings/reset' }), 'System');
  assert.equal(moduleForError({}), 'System');
});

test('page crashes are filed by page', () => {
  assert.equal(moduleForError({ page: true, path: '/workload' }), 'Workload');
  assert.equal(moduleForError({ page: true, path: '/program/blocks/12' }), 'Setup');
  assert.equal(moduleForError({ page: true, path: '/program/class-program?x=1' }), 'Scheduling');
  assert.equal(moduleForError({ page: true, path: '/instructor/scan' }), 'Faculty portal');
  assert.equal(moduleForError({ page: true, path: '/reports' }), 'Reports');
  assert.equal(moduleForError({ page: true, path: '/settings' }), 'System');
  assert.equal(moduleForError({ page: true, path: '/roomsx' }), 'System'); // whole segment only
});

test('console arguments become one readable message with the stack as detail', () => {
  const err = Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: '23505', detail: 'Key (id)=(5) already exists.', name: 'error' });
  const out = formatLogArgs(['', err]);
  assert.equal(out.message, 'duplicate key value violates unique constraint "x" (23505)');
  assert.match(out.detail ?? '', /^error: duplicate key/);
  assert.match(out.detail ?? '', /Detail: Key \(id\)=\(5\) already exists\.$/);

  const plain = formatLogArgs(['could not record', '/api/rooms', 'connection refused']);
  assert.deepEqual(plain, { message: 'could not record /api/rooms connection refused', detail: null });
  assert.equal(formatLogArgs([{ a: 1 }, 42, null]).message, '{"a":1} 42 null');
  assert.equal(formatLogArgs(['']).message, '(no message)');
  assert.equal(formatLogArgs(['x'.repeat(900)]).message.length, ERROR_LIMITS.message);
});

test('secrets never reach the log', () => {
  assert.equal(redactSecrets('cookie eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0abc.c2lnbmF0dXJlMTIz'), 'cookie <token>');
  assert.equal(redactSecrets('Authorization: Bearer abc.def-123'), 'Authorization: Bearer <token>');
  assert.equal(redactSecrets('connect postgres://app:S3cr3t@db.neon.tech/qr failed'), 'connect postgres://app:***@db.neon.tech/qr failed');
  assert.equal(redactSecrets('password=hunter2&user=a'), 'password=***&user=a');
  assert.equal(redactSecrets('{"token":"abc123"}'), '{"token":"***"}');
  assert.equal(redactSecrets('nothing secret here'), 'nothing secret here');
});

test('repeats of the same error share a fingerprint', () => {
  const a = errorFingerprintKey('error', 'qr/scan', 'Room 12 not found for faculty 7');
  const b = errorFingerprintKey('error', 'qr/scan', 'Room 305 not found for faculty 81');
  assert.equal(a, b);
  assert.notEqual(a, errorFingerprintKey('warning', 'qr/scan', 'Room 12 not found for faculty 7'));
  assert.notEqual(a, errorFingerprintKey('error', 'rooms', 'Room 12 not found for faculty 7'));
  assert.equal(
    errorFingerprintKey('error', 'x', 'user ana@nemsu.edu.ph failed, id 6f1c2a1e-0b7e-4f7a-9a51-2b1f0d7e9c11'),
    errorFingerprintKey('error', 'x', 'user ben@nemsu.edu.ph failed, id 0e8b7d6c-1a2b-4c3d-8e9f-001122334455'),
  );
  // database errors quote the offending value — still one error (found by the live check)
  assert.equal(
    errorFingerprintKey('error', 'GET /api/workload/[facultyId]', 'invalid input syntax for type integer: "not-a-number" (22P02)'),
    errorFingerprintKey('error', 'GET /api/workload/[facultyId]', 'invalid input syntax for type integer: "xyz" (22P02)'),
  );
  assert.equal(
    errorFingerprintKey('error', 'x', 'Key (email)=(ana@x.ph) already exists.'),
    errorFingerprintKey('error', 'x', 'Key (email)=(ben@y.ph) already exists.'),
  );
  // …but different constraints stay apart
  assert.notEqual(
    errorFingerprintKey('error', 'x', 'duplicate key value violates unique constraint "users_email_key"'),
    errorFingerprintKey('error', 'x', 'duplicate key value violates unique constraint "users_username_key"'),
  );
  assert.equal(truncate('abcdef', 4), 'abc…');
});
