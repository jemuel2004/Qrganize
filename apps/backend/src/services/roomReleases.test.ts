import assert from 'node:assert/strict';
import test from 'node:test';
import { daysBetween, freedOnSql, occupancyCoversSql, releasedOnSql, unclaimedNowSql, weekdayOfDate } from './roomReleases';

test('a release date is a real calendar date with its weekday', () => {
  assert.equal(weekdayOfDate('2026-10-15'), 'Thursday');
  assert.equal(weekdayOfDate('2026-10-12'), 'Monday');
  assert.equal(weekdayOfDate('2028-02-29'), 'Tuesday'); // leap day
  assert.equal(weekdayOfDate('2026-02-30'), null);
  assert.equal(weekdayOfDate('2026-13-01'), null);
  assert.equal(weekdayOfDate('15/10/2026'), null);
  assert.equal(weekdayOfDate(''), null);
});

test('days between two dates (past = negative)', () => {
  assert.equal(daysBetween('2026-10-08', '2026-10-08'), 0);
  assert.equal(daysBetween('2026-10-08', '2026-10-15'), 7);
  assert.equal(daysBetween('2026-10-08', '2026-10-07'), -1);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
});

test('a release only counts for that session, that date and the faculty who made it', () => {
  const sql = releasedOnSql('ss', 'ms', '$6::date').replace(/\s+/g, ' ');
  assert.match(sql, /rr\.session_id = ss\.id/);
  assert.match(sql, /rr\.release_date = \$6::date/);
  assert.match(sql, /rr\.faculty_id = ms\.faculty_id/);
});

test('a class nobody checked in for frees its room only today, from 15 minutes after the start until it ends', () => {
  const sql = unclaimedNowSql('ss', 'ms').replace(/\s+/g, ' ');
  assert.match(sql, /ss\.room_id IS NOT NULL/);
  assert.match(sql, /ss\.day_of_week = to_char\(NOW\(\) AT TIME ZONE 'Asia\/Manila', 'FMDay'\)/);
  assert.match(sql, /NOW\(\) >= .*ss\.start_time.* \+ INTERVAL '15 minutes'/);
  assert.match(sql, /NOW\(\) < .*ss\.end_time/);
  // Only the class's own faculty in that room claims it
  assert.match(sql, /ro_cover\.room_id = ss\.room_id AND ro_cover\.faculty_id = ms\.faculty_id/);
  assert.match(unclaimedNowSql('ss', 'ms', 'COALESCE(ss.room_id, ms.room_id)').replace(/\s+/g, ' '), /ro_cover\.room_id = COALESCE\(ss\.room_id, ms\.room_id\)/);
});

test('being in the room when the class started covers it — one scan for back-to-back classes', () => {
  const sql = occupancyCoversSql('ro', 'ss', 'd').replace(/\s+/g, ' ');
  assert.match(sql, /ro\.occupied_at IS NOT NULL/);
  assert.match(sql, /ro\.occupied_at < .*ss\.end_time/);
  assert.match(sql, /LEAST\(ro\.released_at, .*\) > .*ss\.start_time.* - INTERVAL '15 minutes'/);
});

test('a freed room is released for that date, or unclaimed today — never on a weekly search (no date)', () => {
  const sql = freedOnSql('ss', 'ms', '$8::date').replace(/\s+/g, ' ');
  assert.match(sql, /rr\.release_date = \$8::date/);
  assert.match(sql, /\$8::date IS NOT DISTINCT FROM \(NOW\(\) AT TIME ZONE 'Asia\/Manila'\)::date AND/);
});
