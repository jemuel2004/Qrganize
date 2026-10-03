import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { splitSqlStatements } from './migrate';

test('a comment that mentions a semicolon does not cut a statement in two', () => {
  const stmts = splitSqlStatements(`
    CREATE TABLE a (
      -- hour-based; everything else
      x INT
    );
    CREATE TABLE b (y INT);
  `);
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /^CREATE TABLE a \(\s+x INT\s+\)$/);
  assert.equal(stmts[1], 'CREATE TABLE b (y INT)');
});

test('semicolons and dashes inside quoted text are kept', () => {
  const stmts = splitSqlStatements(`INSERT INTO t VALUES ('a; b -- c', 'it''s; fine'); SELECT 1;`);
  assert.deepEqual(stmts, [`INSERT INTO t VALUES ('a; b -- c', 'it''s; fine')`, 'SELECT 1']);
});

test('schema.sql creates every table in one piece', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'schema.sql'), 'utf-8');
  const stmts = splitSqlStatements(sql);
  const faculty = stmts.find(s => /^CREATE TABLE IF NOT EXISTS faculty\b/.test(s));
  assert.ok(faculty, 'faculty table statement found');
  // The whole definition, past the comment that mentions a ';'
  assert.match(faculty, /employment_status VARCHAR\(20\) GENERATED ALWAYS/);
  assert.match(faculty, /updated_at TIMESTAMP DEFAULT NOW\(\)\s*\)$/);
  for (const table of ['users', 'programs', 'curriculums', 'blocks', 'block_subjects', 'master_schedule',
    'instructor_loads', 'overloads', 'rooms', 'schedule_sessions', 'qr_scan_logs', 'room_occupancy', 'room_change_requests']) {
    assert.ok(stmts.some(s => new RegExp(`^CREATE TABLE IF NOT EXISTS ${table} \\(`).test(s)), `${table} created`);
  }
  assert.ok(stmts.every(s => !s.startsWith('--') && !/^\w+\s*$/.test(s)), 'no comment-only or broken fragments');
});
