import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHandlerName, isNstpSubject, nstpHours, nstpTimeSet, validateNstpSchedule } from './nstp';

test('NSTP subjects are found by their code, however it is written', () => {
  for (const code of ['NSTP 1', 'NSTP1', 'nstp 2', ' NSTP-2']) assert.equal(isNstpSubject(code), true, code);
  for (const code of ['IT 101', 'GE-NSTP', 'PATHFIT 1', '', null, undefined]) assert.equal(isNstpSubject(code), false, String(code));
});

test('a complete NSTP setting is kept as typed, times as HH:MM', () => {
  const r = validateNstpSchedule({ start_time: '07:00:00', end_time: '10:00', handler_name: '  Roy   Sumaoy ' });
  assert.deepEqual(r, { ok: true, value: { start_time: '07:00', end_time: '10:00', handler_name: 'Roy Sumaoy' } });
});

test('NSTP needs both times, in order, within the school day, and a handler', () => {
  const bad = (input: Parameters<typeof validateNstpSchedule>[0]) => {
    const r = validateNstpSchedule(input);
    return r.ok ? '' : r.error;
  };
  assert.match(bad({ start_time: '', end_time: '10:00', handler_name: 'Roy' }), /start and end time/);
  assert.match(bad({ start_time: '7:00', end_time: '10:00', handler_name: 'Roy' }), /start and end time/);
  assert.match(bad({ start_time: '10:00', end_time: '10:00', handler_name: 'Roy' }), /after its start/);
  assert.match(bad({ start_time: '06:00', end_time: '09:00', handler_name: 'Roy' }), /school day/);
  assert.match(bad({ start_time: '16:00', end_time: '19:00', handler_name: 'Roy' }), /school day/);
  assert.match(bad({ start_time: '07:00', end_time: '10:00', handler_name: '   ' }), /handler/);
  assert.match(bad({ start_time: '07:00', end_time: '10:00', handler_name: 'x'.repeat(101) }), /at most 100/);
});

test('handler names lose control characters and extra spaces', () => {
  assert.equal(cleanHandlerName('Roy\tSumaoy\n'), 'Roy Sumaoy');
  assert.equal(cleanHandlerName(null), '');
});

test('hours follow the set time; nothing until it is set', () => {
  assert.equal(nstpHours({ start_time: '07:00', end_time: '10:00', handler_name: '' }), 3);
  assert.equal(nstpHours({ start_time: '13:00', end_time: '14:30', handler_name: '' }), 1.5);
  assert.equal(nstpHours({ start_time: null, end_time: null, handler_name: 'Roy' }), 0);
  assert.equal(nstpTimeSet({ start_time: '10:00', end_time: '09:00', handler_name: '' }), false);
});
