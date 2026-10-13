import { query } from './db';

/**
 * NSTP (Settings → Day Combinations → NSTP) — Class Program only, see @shared/nstp.
 *
 * nstp_schedule — the one NSTP setting: time (every Saturday) and the handler's
 *   typed name. A single row (id = 1); it holds for every term.
 * nstp_archived_classes — NSTP class rows that were taken out of the regular
 *   scheduling by migration v57 (with their sessions and workload rows), kept as
 *   JSON so nothing is lost.
 */
export const NSTP_SQL = `
  CREATE TABLE IF NOT EXISTS nstp_schedule (
    id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    start_time    TIME,
    end_time      TIME,
    handler_name  VARCHAR(100) NOT NULL DEFAULT '',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (start_time IS NULL OR end_time IS NULL OR start_time < end_time)
  );
  CREATE TABLE IF NOT EXISTS nstp_archived_classes (
    id                  SERIAL PRIMARY KEY,
    master_schedule_id  INTEGER NOT NULL,
    data                JSONB NOT NULL,
    archived_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

let tablesReady: Promise<void> | null = null;
/** Creates the tables once per process (also done by migration v57). */
export function ensureNstpTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = query(NSTP_SQL).then(() => undefined).catch(err => {
      tablesReady = null; // retry on the next call
      throw err;
    });
  }
  return tablesReady;
}
