import { query } from './db';

// Singleton promise — resolved after the first successful run, skipped on all
// subsequent calls within the same process. Uses IF NOT EXISTS so it is fully
// idempotent and safe to call from multiple route handlers concurrently.
let ready: Promise<void> | null = null;

export function ensureUsersSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`
      );
      await query(
        `UPDATE users SET is_active = TRUE WHERE is_active IS NULL`
      );
      await query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL`
      ).catch(() => {});
      await query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255)`
      ).catch(() => {});
      await query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_verified BOOLEAN NOT NULL DEFAULT FALSE`
      ).catch(() => {});
      await query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_verified_at TIMESTAMPTZ`
      ).catch(() => {});
      await query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_picture VARCHAR(1000)`
      ).catch(() => {});
      await query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_enabled BOOLEAN NOT NULL DEFAULT FALSE`
      ).catch(() => {});
      await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique
        ON users (google_sub)
        WHERE google_sub IS NOT NULL
      `).catch(() => {});
    })().catch(err => {
      // Reset so the next request retries rather than caching a failure.
      ready = null;
      throw err;
    });
  }
  return ready;
}

/** Shared SELECT for Program Chair account rows (includes Program + Google status). */
export const DEPT_CHAIR_ACCOUNT_SELECT = `
  SELECT
    u.id, u.username, u.email, u.role, u.is_active,
    u.created_at, u.updated_at,
    u.program_id, u.google_verified, u.google_verified_at, u.otp_enabled,
    p.code AS program_code, p.name AS program_name
  FROM users u
  LEFT JOIN programs p ON u.program_id = p.id
  WHERE u.role = 'program_chair'
`.trim();

/**
 * Shared SELECT for Department Chair account rows. Department Chair is
 * department-wide (oversees every program), so there is deliberately no
 * program join/filter here — unlike Program Chair, which is scoped to one.
 */
export const DEPARTMENT_CHAIR_ACCOUNT_SELECT = `
  SELECT
    u.id, u.username, u.email, u.role, u.is_active,
    u.created_at, u.updated_at,
    u.google_verified, u.google_verified_at, u.otp_enabled
  FROM users u
  WHERE u.role = 'department_chair'
`.trim();
