import { query } from '@/server/db';

/** Room types DCS registers (Scheduling also recognises legacy 'Computer Lab'). */
export const ROOM_TYPES = ['Lecture', 'Laboratory'] as const;
export const ROOM_STATUSES = ['Active', 'Inactive'] as const;

export interface RoomInput {
  room_name: string;
  room_type: string;
  capacity: number;
  building: string;
}

/**
 * Normalise + validate a room payload. Returns the cleaned values, or an
 * error message for the user.
 */
export function validateRoom(body: Record<string, unknown>): { ok: true; room: RoomInput } | { ok: false; error: string } {
  const room_name = String(body.room_name ?? '').trim().replace(/\s+/g, ' ');
  const room_type = String(body.room_type ?? '').trim();
  const capacityRaw = body.capacity === '' || body.capacity == null ? 0 : Number(body.capacity);
  const building = String(body.building ?? 'DCS').trim() || 'DCS';

  if (!room_name) return { ok: false, error: 'Room number / name is required.' };
  if (room_name.length > 50) return { ok: false, error: 'Room number / name must be 50 characters or fewer.' };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._\-/#()]*$/u.test(room_name)) {
    return { ok: false, error: 'Room number / name can only use letters, numbers, spaces and - _ . / # ( ).' };
  }
  if (!(ROOM_TYPES as readonly string[]).includes(room_type)) {
    return { ok: false, error: 'Room type must be Lecture or Laboratory.' };
  }
  if (!Number.isInteger(capacityRaw) || capacityRaw < 0 || capacityRaw > 500) {
    return { ok: false, error: 'Capacity must be a whole number from 0 to 500.' };
  }
  return { ok: true, room: { room_name, room_type, capacity: capacityRaw, building } };
}

/** True when another room already uses this name (case- and space-insensitive). */
export async function roomNameTaken(name: string, excludeId?: number): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM rooms
     WHERE LOWER(REGEXP_REPLACE(TRIM(room_name), '\\s+', ' ', 'g')) = LOWER($1)
       AND ($2::int IS NULL OR id <> $2)
     LIMIT 1`,
    [name, excludeId ?? null],
  );
  return r.rows.length > 0;
}

export function canManageRooms(role: unknown): boolean {
  return role === 'admin' || role === 'department_chair' || role === 'program_chair';
}
