import { query } from './db';

/**
 * error_logs — server errors, warnings and page crashes (services/errorLog.ts).
 * Repeats of an open error update one row (occurrences, last_seen) instead of
 * adding new ones; once resolved, the next repeat opens a fresh row.
 * Created by migration v49 and lazily by the first write.
 */
const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS error_logs (
    id           BIGSERIAL PRIMARY KEY,
    fingerprint  TEXT NOT NULL,
    level        TEXT NOT NULL,
    module       TEXT NOT NULL,
    source       TEXT NOT NULL,
    message      TEXT NOT NULL,
    detail       TEXT,
    method       TEXT,
    path         TEXT,
    actor_id     INTEGER,
    actor_role   TEXT,
    actor_name   TEXT,
    occurrences  INTEGER NOT NULL DEFAULT 1,
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at  TIMESTAMPTZ,
    resolved_by  TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS error_logs_open_fingerprint_uidx ON error_logs (fingerprint) WHERE resolved_at IS NULL;
  CREATE INDEX IF NOT EXISTS error_logs_last_seen_idx ON error_logs (last_seen DESC, id DESC);
`;

let tableReady: Promise<void> | null = null;
/** Creates the table once per process (also done by migration v49). */
export function ensureErrorLogTable(): Promise<void> {
  if (!tableReady) {
    tableReady = query(CREATE_SQL).then(() => undefined).catch(err => {
      tableReady = null; // retry on the next call
      throw err;
    });
  }
  return tableReady;
}
