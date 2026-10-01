import { query } from './db';

/**
 * realtime_versions — one row per real-time topic (services/realtime.ts).
 * Created by migration v48 and lazily by the first bump or version read.
 */
const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS realtime_versions (
    topic      TEXT PRIMARY KEY,
    version    BIGINT NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

let tableReady: Promise<void> | null = null;
/** Creates the table once per process (also done by migration v48). */
export function ensureRealtimeTable(): Promise<void> {
  if (!tableReady) {
    tableReady = query(CREATE_SQL).then(() => undefined).catch(err => {
      tableReady = null; // retry on the next call
      throw err;
    });
  }
  return tableReady;
}
