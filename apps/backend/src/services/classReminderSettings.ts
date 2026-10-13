import type { NextRequest } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { ensurePushTables } from '@/database/pushSchema';
import { vapidPublicKey } from '@/services/webPush';
import { DEFAULT_REMINDER_LEAD } from '@shared/classReminderTiming';

/**
 * The faculty member whose reminder settings and devices a request may touch:
 * always the signed-in faculty account — never an id sent by the browser.
 */
export async function reminderFacultyId(req: NextRequest): Promise<number | null> {
  const auth = await getAuthUser(req) as { role?: string; faculty_id?: unknown } | null;
  if (!auth || auth.role !== 'instructor') return null;
  const id = Number(auth.faculty_id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export interface ReminderSettings {
  enabled: boolean;
  lead_minutes: number;
  /** Devices (browsers / phones) that get this faculty member's reminders */
  devices: number;
  /** What a browser subscribes with — public by design; null if push is unavailable */
  public_key: string | null;
}

/** A faculty member's own settings (off, 15 minutes when never set) */
export async function reminderSettings(facultyId: number): Promise<ReminderSettings> {
  await ensurePushTables();
  const [row, devices, publicKey] = await Promise.all([
    query(`SELECT enabled, lead_minutes FROM class_reminder_settings WHERE faculty_id = $1`, [facultyId]),
    query(`SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE faculty_id = $1`, [facultyId]),
    vapidPublicKey().catch(err => {
      console.warn('[classReminders] push keys unavailable:', (err as Error).message);
      return null;
    }),
  ]);
  const s = row.rows[0] as { enabled: boolean; lead_minutes: number } | undefined;
  return {
    enabled: !!s?.enabled,
    lead_minutes: Number(s?.lead_minutes ?? DEFAULT_REMINDER_LEAD),
    devices: Number((devices.rows[0] as { n: number } | undefined)?.n ?? 0),
    public_key: publicKey,
  };
}
