import { query } from '@/server/db';

export type NotificationType =
  | 'qr_scan_success'
  | 'qr_scan_pending'
  | 'qr_scan_denied'
  | 'qr_scan_unauthorized'
  | 'room_request_submitted'
  | 'room_request_approved'
  | 'room_request_rejected'
  | 'room_request_expired'
  | 'room_occupied'
  | 'room_released'
  | 'schedule_updated'
  | 'workload_updated'
  | 'workload_incomplete'
  | 'workload_overload'
  | 'block_unassigned'
  | 'system_alert';

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
      WHERE type IN ('workload_incomplete', 'workload_overload', 'block_unassigned')
    `);
    tableReady = true;
  } catch (e) {
    console.error('[ensureNotificationsTable] DDL failed — will retry on next call:', e);
  }
}

export interface NotificationPayload {
  recipientId?: number;
  recipientRole: 'admin' | 'department_chair' | 'instructor' | 'program_chair';
  title: string;
  message: string;
  type: NotificationType;
  relatedModule?: string;
  relatedId?: number;
}

export async function createNotification(payload: NotificationPayload): Promise<void> {
  try {
    await ensureNotificationsTable();

    const isRoomRequestEvent =
      payload.type.startsWith('room_request_') && payload.relatedId != null;

    if (isRoomRequestEvent) {
      await query(`
        INSERT INTO notifications
          (recipient_id, recipient_role, title, message, type, related_module, related_id)
        SELECT $1, $2, $3, $4, $5, $6, $7
        WHERE NOT EXISTS (
          SELECT 1 FROM notifications
          WHERE recipient_id   = $1
            AND recipient_role = $2
            AND type           = $5
            AND related_id     = $7
        )
      `, [
        payload.recipientId ?? 0,
        payload.recipientRole,
        payload.title,
        payload.message,
        payload.type,
        payload.relatedModule ?? null,
        payload.relatedId,
      ]);
      return;
    }

    await query(`
      INSERT INTO notifications
        (recipient_id, recipient_role, title, message, type, related_module, related_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      payload.recipientId ?? 0,
      payload.recipientRole,
      payload.title,
      payload.message,
      payload.type,
      payload.relatedModule ?? null,
      payload.relatedId ?? null,
    ]);
  } catch (e) {
    console.error('[createNotification]', e);
  }
}
