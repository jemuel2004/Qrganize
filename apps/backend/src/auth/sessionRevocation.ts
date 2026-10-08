import { query } from '@/database/db';

/**
 * Signed-out sessions. Every session token carries a random id (jti); signing
 * out records it here, so a copy of that cookie stops working at once instead
 * of staying valid until the token expires. Rows are only kept until then.
 * (Password changes, deactivation and "sign out other devices" end every
 * session of an account through auth_version instead — see trustedDevices.ts.)
 */
const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS revoked_sessions (
    jti        TEXT PRIMARY KEY,
    expires_at TIMESTAMPTZ NOT NULL
  )
`;

let tableReady: Promise<void> | null = null;
/** Creates the table once per process. */
export function ensureRevokedSessionsTable(): Promise<void> {
  if (!tableReady) {
    tableReady = query(CREATE_SQL).then(() => undefined).catch(err => {
      tableReady = null; // retry on the next call
      throw err;
    });
  }
  return tableReady;
}

/** The session id of a verified token payload, or null for tokens issued before ids existed */
export function sessionIdOf(payload: Record<string, unknown>): string | null {
  return typeof payload.jti === 'string' && payload.jti ? payload.jti : null;
}

/** Ends one session on the server (sign-out). */
export async function revokeSession(payload: Record<string, unknown>): Promise<void> {
  const jti = sessionIdOf(payload);
  const exp = Number(payload.exp);
  if (!jti || !Number.isFinite(exp)) return;
  await ensureRevokedSessionsTable();
  await query(
    `INSERT INTO revoked_sessions (jti, expires_at) VALUES ($1, to_timestamp($2))
     ON CONFLICT (jti) DO NOTHING`,
    [jti, exp],
  );
  // Expired tokens are rejected anyway — their rows are no longer needed
  void query(`DELETE FROM revoked_sessions WHERE expires_at < NOW()`).catch(() => {});
}
