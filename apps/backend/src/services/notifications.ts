import { query } from '@/database/db';
import { ensureNotificationsTable } from '@/database/notificationsSchema';
import { bumpNotifications } from '@/services/realtime';

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
  | 'schedule_needed'
  | 'block_schedule_incomplete'
  | 'schedule_pending'
  | 'room_request_pending'
  | 'workload_completed'
  | 'schedule_completed'
  | 'system_alert';

// Table DDL and the condition-alert types live with the schema (the migrations use them too)
export { CONDITION_TYPES, CONDITION_TYPES_SQL, ensureNotificationsTable } from '@/database/notificationsSchema';

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
      const added = await query(`
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
      if ((added.rowCount ?? 0) > 0) bumpNotifications(payload.recipientRole, payload.recipientId);
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
    bumpNotifications(payload.recipientRole, payload.recipientId);
  } catch (e) {
    console.error('[createNotification]', e);
  }
}
