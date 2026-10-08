import assert from 'node:assert/strict';
import test from 'node:test';
import { PASSWORD_MAX_LENGTH, hasCharacterMix, weakPasswordReason } from './passwordPolicy';

test('the system defaults and common passwords are refused', () => {
  for (const pw of ['password', 'Password', 'admin123', 'chair123', 'password123', '12345678', 'nemsu123', 'qrganize', ' qrganize123 ']) {
    assert.ok(weakPasswordReason(pw), pw);
  }
});

test('ordinary strong passwords pass', () => {
  for (const pw of ['Cantilan#Campus7', 'blue-river-2026!', 'Mx7!qp2Lr']) assert.equal(weakPasswordReason(pw), null, pw);
});

test('not text, too long, one repeated character, or the username', () => {
  assert.ok(weakPasswordReason(12345678));
  assert.ok(weakPasswordReason(undefined));
  assert.ok(weakPasswordReason('x'.repeat(PASSWORD_MAX_LENGTH + 1)));
  assert.ok(weakPasswordReason('aaaaaaaaaa'));
  assert.ok(weakPasswordReason('jehu.rubenial', 'Jehu.Rubenial'));
  assert.equal(weakPasswordReason('jehu.rubenial!7', 'jehu.rubenial'), null);
});

test('letters must be mixed with numbers or symbols', () => {
  assert.equal(hasCharacterMix('abcdefghij'), false);
  assert.equal(hasCharacterMix('ABCDEFGHIJ'), false);
  assert.equal(hasCharacterMix('cantilan2026'), true);
  assert.equal(hasCharacterMix('Cantilan-campus'), true);
});
