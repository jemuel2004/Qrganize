import { query } from './db';

/** audit_logs table — created by migration v41 and lazily by the audit logger. */
const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor_id    INTEGER,
    actor_role  TEXT,
    actor_name  TEXT,
    category    TEXT NOT NULL,
    action      TEXT NOT NULL,
    summary     TEXT NOT NULL,
    method      TEXT NOT NULL,
    path        TEXT NOT NULL,
    status      INTEGER NOT NULL,
    success     BOOLEAN NOT NULL DEFAULT TRUE,
    ip          TEXT,
    details     JSONB
  );
  CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);
  CREATE INDEX IF NOT EXISTS audit_logs_category_idx ON audit_logs (category, created_at DESC);
`;

let tableReady: Promise<void> | null = null;
/** Creates the table once per process (also done by migration v41). */
export function ensureAuditTable(): Promise<void> {
  if (!tableReady) {
    tableReady = query(CREATE_SQL).then(() => undefined).catch(err => {
      tableReady = null; // retry on the next call
      throw err;
    });
  }
  return tableReady;
}
