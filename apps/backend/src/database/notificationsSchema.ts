import { query } from './db';

/**
 * notifications — every inbox (services/notifications.ts). Created by
 * migration v37 and lazily on first use.
 */

/**
 * Condition-based alerts: one row per (recipient, type, item). They are
 * upserted while the condition holds and deleted as soon as it clears —
 * see syncWorkloadMonitoringNotifications. Everything else is a one-off event.
 */
export const CONDITION_TYPES = [
  'workload_incomplete',
  'workload_overload',
  'block_unassigned',
  'schedule_needed',
  'block_schedule_incomplete',
  'schedule_pending',
  'room_request_pending',
] as const;
/** SQL list for the partial unique index / ON CONFLICT predicate (must match exactly) */
export const CONDITION_TYPES_SQL = CONDITION_TYPES.map(t => `'${t}'`).join(', ');

let tableReady = false;

export async function ensureNotificationsTable(): Promise<void> {
  if (tableReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id             SERIAL PRIMARY KEY,
        recipient_id   INTEGER NOT NULL DEFAULT 0,
        recipient_role VARCHAR(20) NOT NULL,
        title          VARCHAR(255) NOT NULL,
        message        TEXT NOT NULL,
        type           VARCHAR(50) NOT NULL,
        is_read        BOOLEAN DEFAULT false,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        related_module VARCHAR(50),
        related_id     INTEGER
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_lookup
      ON notifications (recipient_role, recipient_id, is_read, created_at DESC)
    `);
    await query(`DROP INDEX IF EXISTS idx_notifications_monitoring_unique`);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_monitoring_unique
      ON notifications (recipient_role, recipient_id, type, related_module, related_id)
      WHERE type IN (${CONDITION_TYPES_SQL})
    `);
    tableReady = true;
  } catch (e) {
    console.error('[ensureNotificationsTable] DDL failed — will retry on next call:', e);
  }
}
