import bcrypt from 'bcryptjs';
import { query } from '@/database/db';
import { ensureSystemSettingsTable } from '@/database/schema-guard';
import { DEFAULT_PASSWORDS_TO_CHECK, weakPasswordReason } from '@/auth/passwordPolicy';

/**
 * "Change your password on next sign-in" for accounts on a default or common
 * password. `must_change_password` is set when someone signs in with such a
 * password (and once at start-up for accounts still on a well-known default);
 * while it is set the API gate (proxy.ts) only lets the password change through
 * and the frontend sends every page to /change-password. Changing the password
 * clears it.
 */

type AccountKind = 'user' | 'instructor';
const TABLE: Record<AccountKind, 'users' | 'instructor_accounts'> = { user: 'users', instructor: 'instructor_accounts' };

let columnsReady: Promise<void> | null = null;
/** must_change_password on both account tables (added once per process, like otp_enabled) */
export function ensurePasswordChangeColumns(): Promise<void> {
  if (!columnsReady) {
    columnsReady = (async () => {
      await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE`);
      await query(`ALTER TABLE instructor_accounts ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE`);
    })().catch(err => {
      columnsReady = null; // retry on the next call
      throw err;
    });
  }
  return columnsReady;
}

/** A password that has to be changed: too short, a default / common one, or the username */
export function needsPasswordChange(password: string, username?: string | null): boolean {
  return password.length < 8 || weakPasswordReason(password, username ?? undefined) !== null;
}

/** At sign-in (the password is known then): mark the account when its password is weak, clear the mark when it is not. */
export async function recordPasswordStrength(kind: AccountKind, id: number, password: string, username?: string | null): Promise<void> {
  await ensurePasswordChangeColumns();
  const weak = needsPasswordChange(password, username);
  await query(
    `UPDATE ${TABLE[kind]} SET must_change_password = $1 WHERE id = $2 AND must_change_password IS DISTINCT FROM $1`,
    [weak, id],
  );
}

/** How long after signing in a default password may be replaced without typing it again */
const RECENT_SIGN_IN_SECONDS = 30 * 60;

/** Signed in within the last 30 minutes (the session token's issue time) */
export function isRecentSignIn(payload: Record<string, unknown>): boolean {
  const iat = Number(payload.iat);
  return Number.isFinite(iat) && Date.now() / 1000 - iat <= RECENT_SIGN_IN_SECONDS;
}

/** Whether this session's account still has to change its password */
export async function mustChangePassword(payload: Record<string, unknown>): Promise<boolean> {
  const id = Number(payload.id);
  if (!id) return false;
  await ensurePasswordChangeColumns();
  const kind: AccountKind = payload.role === 'instructor' ? 'instructor' : 'user';
  const result = await query(`SELECT must_change_password FROM ${TABLE[kind]} WHERE id = $1`, [id]);
  return result.rows[0]?.must_change_password === true;
}

/** Bumped when DEFAULT_PASSWORDS_TO_CHECK grows, so the start-up check runs again */
const SCAN_VERSION = '1';

/**
 * Once per database: accounts still on a well-known default password are
 * marked, so people who were already signed in are asked to change it too —
 * not only those who sign in again. Runs in the background after start-up.
 */
export async function scanForDefaultPasswordsOnce(): Promise<void> {
  await ensureSystemSettingsTable();
  const done = await query(`SELECT value FROM system_settings WHERE key = 'default_password_scan'`);
  if (done.rows[0]?.value === SCAN_VERSION) return;
  await ensurePasswordChangeColumns();

  const accounts = (await query(`
    SELECT 'user' AS kind, id, username, password_hash FROM users
     WHERE COALESCE(is_active, true) AND NOT must_change_password
    UNION ALL
    SELECT 'instructor', id, username, password_hash FROM instructor_accounts
     WHERE COALESCE(is_active, true) AND NOT must_change_password
  `)).rows as { kind: AccountKind; id: number; username: string | null; password_hash: string | null }[];

  let marked = 0;
  for (const a of accounts) {
    if (!a.password_hash) continue;
    const candidates = [...DEFAULT_PASSWORDS_TO_CHECK, ...(a.username ? [a.username, a.username.toLowerCase()] : [])];
    for (const pw of candidates) {
      // bcryptjs' async compare works in small steps, so requests keep being served meanwhile
      if (await bcrypt.compare(pw, a.password_hash).catch(() => false)) {
        await query(`UPDATE ${TABLE[a.kind]} SET must_change_password = TRUE WHERE id = $1`, [a.id]);
        marked++;
        break;
      }
    }
  }
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('default_password_scan', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [SCAN_VERSION],
  );
  console.log(`[startup] Default-password check: ${accounts.length} accounts checked, ${marked} must change their password.`);
}
