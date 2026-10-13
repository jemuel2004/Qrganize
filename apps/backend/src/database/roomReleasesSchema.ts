import { query } from './db';

/**
 * room_releases — a faculty member's class session whose room is free on one
 * date ("Make Classroom Available"; rules in services/roomReleases.ts).
 * Created by migration v53 and lazily by the routes that read it.
 */
export const ROOM_RELEASES_SQL = `
  CREATE TABLE IF NOT EXISTS room_releases (
    id                 SERIAL PRIMARY KEY,
    session_id         INTEGER NOT NULL REFERENCES schedule_sessions(id) ON DELETE CASCADE,
    faculty_id         INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    release_date       DATE NOT NULL,
    reason             VARCHAR(60),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT room_releases_session_date_uniq UNIQUE (session_id, release_date)
  );
  CREATE INDEX IF NOT EXISTS room_releases_faculty_date_idx ON room_releases (faculty_id, release_date);
  CREATE INDEX IF NOT EXISTS room_releases_date_idx ON room_releases (release_date);
`;

let tableReady: Promise<void> | null = null;
/** Creates the table once per process (also done by migration v53). */
export function ensureRoomReleasesTable(): Promise<void> {
  if (!tableReady) {
    tableReady = query(ROOM_RELEASES_SQL).then(() => undefined).catch(err => {
      tableReady = null; // retry on the next call
      throw err;
    });
  }
  return tableReady;
}
