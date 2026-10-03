import { query } from './db';

/**
 * faculty_activities — non-teaching time on a faculty member's timetable
 * (Consultation, Flag Ceremony, meetings…) for one school year + semester.
 * It is never teaching load; it only makes the faculty unavailable when a
 * class is scheduled (services/scheduleConflicts.ts). Created by migration
 * v50 and lazily by the routes that read it.
 */
export const FACULTY_ACTIVITIES_SQL = `
  CREATE TABLE IF NOT EXISTS faculty_activities (
    id            SERIAL PRIMARY KEY,
    faculty_id    INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    academic_year VARCHAR(20) NOT NULL,
    semester      VARCHAR(30) NOT NULL,
    day_of_week   VARCHAR(10) NOT NULL,
    start_time    TIME NOT NULL,
    end_time      TIME NOT NULL,
    activity      TEXT NOT NULL,
    source        VARCHAR(30) NOT NULL DEFAULT 'manual',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT faculty_activities_time_check CHECK (end_time > start_time)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS faculty_activities_slot_uidx
    ON faculty_activities (faculty_id, academic_year, semester, day_of_week, start_time, end_time, lower(activity));
`;

let tableReady: Promise<void> | null = null;
/** Creates the table once per process (also done by migration v50). */
export function ensureFacultyActivitiesTable(): Promise<void> {
  if (!tableReady) {
    tableReady = query(FACULTY_ACTIVITIES_SQL).then(() => undefined).catch(err => {
      tableReady = null; // retry on the next call
      throw err;
    });
  }
  return tableReady;
}
