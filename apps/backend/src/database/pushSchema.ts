import { query } from './db';

/**
 * Class reminders on faculty devices (Web Push — services/classPush.ts):
 *   push_subscriptions        — each browser or phone that turned reminders on,
 *                               always tied to the signed-in faculty who did it
 *   class_reminder_settings   — per faculty: on or off, and how long before class
 *   class_reminder_deliveries — one row per device and class time already
 *                               reminded; claimed before sending, so a retried
 *                               job or a restart never sends it twice
 *   push_vapid_keys           — the server's signing keys when they are not set in
 *                               the environment. Server only: no route returns
 *                               the private key (browsers get the public one).
 * Created by migration v55 and lazily by the routes and the reminder job.
 */
export const PUSH_SQL = `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id            SERIAL PRIMARY KEY,
    faculty_id    INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
    endpoint      TEXT NOT NULL,
    p256dh        TEXT NOT NULL,
    auth          TEXT NOT NULL,
    user_agent    VARCHAR(160),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_sent_at  TIMESTAMPTZ,
    CONSTRAINT push_subscriptions_endpoint_uniq UNIQUE (endpoint)
  );
  CREATE INDEX IF NOT EXISTS push_subscriptions_faculty_idx ON push_subscriptions (faculty_id);
  CREATE TABLE IF NOT EXISTS class_reminder_settings (
    faculty_id    INTEGER PRIMARY KEY REFERENCES faculty(id) ON DELETE CASCADE,
    enabled       BOOLEAN NOT NULL DEFAULT FALSE,
    lead_minutes  SMALLINT NOT NULL DEFAULT 15,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT class_reminder_settings_lead_chk CHECK (lead_minutes IN (5, 15, 30))
  );
  CREATE TABLE IF NOT EXISTS class_reminder_deliveries (
    id               SERIAL PRIMARY KEY,
    subscription_id  INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
    reminder_key     VARCHAR(80) NOT NULL,
    status           VARCHAR(10) NOT NULL DEFAULT 'sending',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT class_reminder_deliveries_uniq UNIQUE (subscription_id, reminder_key)
  );
  CREATE INDEX IF NOT EXISTS class_reminder_deliveries_created_idx ON class_reminder_deliveries (created_at);
  CREATE TABLE IF NOT EXISTS push_vapid_keys (
    id           SMALLINT PRIMARY KEY DEFAULT 1,
    public_key   TEXT NOT NULL,
    private_key  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT push_vapid_keys_single CHECK (id = 1)
  );
`;

let tablesReady: Promise<void> | null = null;
/** Creates the tables once per process (also done by migration v55). */
export function ensurePushTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = query(PUSH_SQL).then(() => undefined).catch(err => {
      tablesReady = null; // retry on the next call
      throw err;
    });
  }
  return tablesReady;
}
