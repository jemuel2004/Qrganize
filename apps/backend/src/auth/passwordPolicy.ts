/**
 * Password rules shared by every route that sets a password (new accounts,
 * resets, self-service changes). Length is still checked where it was; this
 * adds what those checks miss: passwords everyone could guess — the system's
 * own defaults (admin123, chair123) and the most common ones — and inputs
 * that aren't text or are absurdly long (bcrypt only reads the first 72 bytes).
 */

/** Longest password accepted (bcrypt reads 72 bytes; anything far beyond is not a real password) */
export const PASSWORD_MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  // QRganize / school defaults
  'admin123', 'admin1234', 'admin12345', 'chair123', 'chair1234', 'faculty123', 'faculty1234',
  'teacher123', 'instructor', 'instructor123', 'nemsu123', 'nemsu1234', 'nemsu2024', 'nemsu2025',
  'nemsu2026', 'nemsu2027', 'qrganize', 'qrganize123', 'cantilan', 'cantilan123', 'default123',
  'changeme', 'changeme123', 'welcome123', 'welcome1', 'administrator',
  // Most common passwords of 8+ characters
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd',
  'p@ssword', '12345678', '123456789', '1234567890', '0123456789', '87654321', '11111111',
  '00000000', '12341234', '11223344', '12344321', 'abc12345', 'abcd1234', 'abcdefgh', 'qwerty123',
  'qwerty12', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm123', 'iloveyou', 'iloveyou1', 'letmein123',
  'sunshine', 'princess', 'football', 'baseball', 'superman', 'trustno1', 'whatever',
  'starwars', 'computer', 'internet', 'aa123456', 'a1234567', 'q1w2e3r4', '1q2w3e4r',
  '1qaz2wsx', 'zaq12wsx', 'monkey123', 'dragon123', 'master123', 'secret123', 'test1234',
  'testing123', 'philippines', 'pilipinas',
]);

/** Letters mixed with numbers or symbols (at least two of: upper, lower, digit, symbol) */
export function hasCharacterMix(password: string): boolean {
  const kinds = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(password)).length;
  return kinds >= 2;
}

/**
 * The defaults people are most likely still on (system seeds, the old import
 * default, the commonest picks) — checked against stored hashes once at
 * start-up (each check is a slow bcrypt compare, so the list stays short).
 */
export const DEFAULT_PASSWORDS_TO_CHECK = [
  'password', 'admin123', 'chair123', 'password123', '12345678', 'nemsu123', 'qrganize',
  'password1', '123456789', 'faculty123', 'admin',
] as const;

/**
 * Why `password` can't be used, or null when it can. Callers keep their own
 * "at least 8 characters" message; this catches what that check lets through.
 */
export function weakPasswordReason(password: unknown, username?: unknown): string | null {
  if (typeof password !== 'string') return 'Password must be text.';
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`;
  }
  const lower = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    return 'This password is too common and easy to guess. Please choose a different one.';
  }
  if (/^(.)\1+$/.test(password)) {
    return 'Please choose a password that is not one repeated character.';
  }
  const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (name && lower === name) {
    return 'Password must not be the same as the username.';
  }
  return null;
}
