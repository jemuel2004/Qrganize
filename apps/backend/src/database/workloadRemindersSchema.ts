import { query } from './db';

/**
 * workload_reminder_states — kept only for migration v56. It held the Faculty
 * Schedules "incomplete workload" reminders (Remind me later / Don't remind me),
 * which the user removed on 2026-10-11; nothing reads or writes it any more.
 * The migration stays so databases that already ran v56 keep the same order.
 */
export const WORKLOAD_REMINDERS_SQL = `
  CREATE TABLE IF NOT EXISTS workload_reminder_states (
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    faculty_id     INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    semester       VARCHAR(30) NOT NULL,
    academic_year  VARCHAR(20) NOT NULL,
    snoozed_until  TIMESTAMPTZ,
    dismissed_at   TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, faculty_id, semester, academic_year)
  );
  CREATE INDEX IF NOT EXISTS workload_reminder_states_term_idx
    ON workload_reminder_states (semester, academic_year, faculty_id);
`;

let tableReady: Promise<void> | null = null;
/** Creates the table once per process (also done by migration v56). */
export function ensureWorkloadRemindersTable(): Promise<void> {
  if (!tableReady) {
    tableReady = query(WORKLOAD_REMINDERS_SQL).then(() => undefined).catch(err => {
      tableReady = null; // retry on the next call
      throw err;
    });
  }
  return tableReady;
}
