import assert from 'node:assert/strict';
import test from 'node:test';
import { clock12, clockRange12, times12InText } from './clock12';

test('clock times read as 12-hour with AM/PM', () => {
  assert.equal(clock12('07:00'), '7:00 AM');
  assert.equal(clock12('12:00'), '12:00 PM');
  assert.equal(clock12('13:30:00'), '1:30 PM');
  assert.equal(clock12('00:15'), '12:15 AM');
  assert.equal(clock12('24:00'), '12:00 AM');
  assert.equal(clock12(1080), '6:00 PM');
  assert.equal(clock12(''), '');
  assert.equal(clock12(null), '');
  assert.equal(clock12('TBA'), '');
});

test('ranges show AM/PM on both ends', () => {
  assert.equal(clockRange12('13:00', '14:30'), '1:00 PM – 2:30 PM');
  assert.equal(clockRange12('11:30', '13:00'), '11:30 AM – 1:00 PM');
  assert.equal(clockRange12('07:00', '08:30', '–'), '7:00 AM–8:30 AM');
  assert.equal(clockRange12('07:00', null), '7:00 AM');
  assert.equal(clockRange12(null, null), '');
});

test('older saved text with 24-hour times reads as 12-hour', () => {
  assert.equal(times12InText('On time — session: 13:00–14:30'), 'On time — session: 1:00 PM–2:30 PM');
  assert.equal(times12InText('Scan rejected — class session ended at 18:00'), 'Scan rejected — class session ended at 6:00 PM');
  assert.equal(times12InText('Class started at 07:30:00; you scanned at 07:41.'), 'Class started at 7:30 AM; you scanned at 7:41 AM.');
  assert.equal(times12InText('Already 1:00 PM – 2:30 PM'), 'Already 1:00 PM – 2:30 PM');
  assert.equal(times12InText('Room 12, 3 classes'), 'Room 12, 3 classes');
});
