/**
 * Lazy schema guard — ensures columns exist before routes that depend on them
 * are served, without requiring a server restart.
 *
 * Each guard is a module-level Promise that resolves after executing an
 * idempotent DDL statement (ALTER TABLE … ADD COLUMN IF NOT EXISTS).
 * Because module-level state persists for the lifetime of the Node.js process,
 * the DDL runs exactly once per process regardless of how many requests arrive
 * concurrently — subsequent awaits on the same guard return the already-resolved
 * Promise immediately at zero cost.
 *
 * This is necessary because Next.js instrumentation.ts only runs at process
 * startup; in development, hot-reload does not re-trigger it. Adding a new
 * migration after the server is already running therefore requires either a
 * full restart or this lazy guard.
 */

import { query } from './db';

const _guards = new Map<string, Promise<void>>();

export function ensureColumn(
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const key = `${table}.${column}`;
  if (!_guards.has(key)) {
    const sql = `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`;
    _guards.set(
      key,
      query(sql)
        .then(() => void 0)
        .catch(err => {
          console.error(`[schema-guard] Failed to ensure ${key}:`, err);
          // Remove so the next request retries rather than silently skipping
          _guards.delete(key);
        }),
    );
  }
  return _guards.get(key)!;
}

/** Pre-built guard for users.profile_picture — used by auth/me and account/me/picture routes. */
export const ensureUserProfilePicture = () =>
  ensureColumn('users', 'profile_picture', 'VARCHAR(500)');

export const ensureInstructorGooglePicture = () =>
  ensureColumn('instructor_accounts', 'google_picture', 'VARCHAR(1000)');

export const ensureOtpPurposeColumn = () =>
  ensureColumn('login_otp_challenges', 'purpose', `VARCHAR(40) NOT NULL DEFAULT 'login'`);

export async function ensureOtpEnabledColumns(): Promise<void> {
  await Promise.all([
    ensureColumn('users', 'otp_enabled', 'BOOLEAN NOT NULL DEFAULT FALSE'),
    ensureColumn('instructor_accounts', 'otp_enabled', 'BOOLEAN NOT NULL DEFAULT FALSE'),
  ]);
}

export async function ensureTrustedDeviceActivityColumns(): Promise<void> {
  await Promise.all([
    ensureColumn('trusted_devices', 'device_type', 'VARCHAR(20)'),
    ensureColumn('trusted_devices', 'os_name', 'VARCHAR(64)'),
    ensureColumn('trusted_devices', 'browser_name', 'VARCHAR(64)'),
    ensureColumn('trusted_devices', 'last_ip', 'VARCHAR(64)'),
    ensureColumn('trusted_devices', 'city', 'VARCHAR(120)'),
    ensureColumn('trusted_devices', 'region', 'VARCHAR(120)'),
    ensureColumn('trusted_devices', 'country', 'VARCHAR(120)'),
    ensureColumn('trusted_devices', 'location_label', 'VARCHAR(255)'),
  ]);
}

export function ensureSystemSettingsTable(): Promise<void> {
  const key = 'system_settings.table';
  if (!_guards.has(key)) {
    _guards.set(
      key,
      query(`
        CREATE TABLE IF NOT EXISTS system_settings (
          key         VARCHAR(100) PRIMARY KEY,
          value       TEXT,
          updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )
      `)
        .then(() => void 0)
        .catch(err => {
          console.error('[schema-guard] Failed to ensure system_settings:', err);
          _guards.delete(key);
        }),
    );
  }
  return _guards.get(key)!;
}

const FACULTY_PROFILE_COLUMNS: Array<[string, string, string]> = [
  ['faculty', 'years_in_service', 'INTEGER'],
  ['faculty', 'educational_qualification', 'VARCHAR(255)'],
  ['faculty', 'major', 'VARCHAR(255)'],
  ['faculty', 'eligibility', 'VARCHAR(255)'],
  ['instructor_accounts', 'google_sub', 'VARCHAR(255)'],
  ['instructor_accounts', 'google_verified', 'BOOLEAN NOT NULL DEFAULT FALSE'],
  ['instructor_accounts', 'google_verified_at', 'TIMESTAMPTZ'],
  ['instructor_accounts', 'google_picture', 'VARCHAR(1000)'],
];

export async function ensureFacultyProfileColumns(): Promise<void> {
  await Promise.all(
    FACULTY_PROFILE_COLUMNS.map(([table, column, definition]) =>
      ensureColumn(table, column, definition),
    ),
  );
}

export function resetFacultyProfileColumns(): void {
  for (const [table, column] of FACULTY_PROFILE_COLUMNS) {
    _guards.delete(`${table}.${column}`);
  }
}
