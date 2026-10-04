import { query, transaction } from '@/database/db';
import { bumpTopics } from '@/services/realtime';
import { needsOneRoomSql } from '@shared/subjectCategory';

let ready = false;
let rcrSchemaReady = false;
let qrScanLogsSchemaReady = false;

/**
 * Ensures all v15+ columns exist on room_change_requests.
 * Safe to call on every request — exits immediately after the first successful run.
 * Covers databases that were created before v15 migration was added, and dev
 * environments where instrumentation.ts hot-reload skips migration re-runs.
 */
export async function ensureRoomRequestsSchema(): Promise<void> {
  if (rcrSchemaReady) return;

  // Widen status VARCHAR(20) → VARCHAR(30) for 'Pending Confirmation' (20 chars)
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE  table_name  = 'room_change_requests'
          AND  column_name = 'status'
          AND  character_maximum_length IS NOT NULL
          AND  character_maximum_length < 30
      ) THEN
        ALTER TABLE room_change_requests ALTER COLUMN status TYPE VARCHAR(30);
      END IF;
    END $$
  `).catch(() => {});

  // Add all v15+ columns — each ALTER is idempotent via IF NOT EXISTS
  const cols: string[] = [
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS confirmation_deadline TIMESTAMPTZ`,
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS auto_notes            TEXT`,
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS submitted_by          VARCHAR(20) DEFAULT 'admin'`,
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS approved_at           TIMESTAMPTZ`,
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS rejected_at           TIMESTAMPTZ`,
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS expired_at            TIMESTAMPTZ`,
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS confirmed_at          TIMESTAMPTZ`,
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS session_rooms         JSONB`,
  ];
  for (const sql of cols) {
    await query(sql).catch(() => {});
  }

  rcrSchemaReady = true;
}

/**
 * Adds scheduled_start / scheduled_end columns to qr_scan_logs so every scan
 * record stores the class timetable alongside the actual scan timestamp.
 * Idempotent — skips on subsequent calls within the same process.
 */
export async function ensureQrScanLogsSchema(): Promise<void> {
  if (qrScanLogsSchemaReady) return;
  const cols = [
    `ALTER TABLE qr_scan_logs ADD COLUMN IF NOT EXISTS scheduled_start TIME`,
    `ALTER TABLE qr_scan_logs ADD COLUMN IF NOT EXISTS scheduled_end   TIME`,
  ];
  for (const sql of cols) await query(sql).catch(() => {});
  qrScanLogsSchemaReady = true;
}

/**
 * Creates the room_occupancy table and its supporting index on first call.
 * Idempotent — safe to call on every request.
 *
 * Status lifecycle:
 *   Pending  → instructor reserved a room; expires after 15 min if not scanned
 *   Occupied → confirmed by QR scan; expires at class-end or 4 h for walk-ins
 *   Released → manually released before expiry
 *   Expired  → auto-transitioned when expires_at passes
 */
export async function ensureRoomOccupancy(): Promise<void> {
  if (ready) return;

  await query(`
    CREATE TABLE IF NOT EXISTS room_occupancy (
      id          SERIAL        PRIMARY KEY,
      room_id     INTEGER       NOT NULL REFERENCES rooms(id)   ON DELETE CASCADE,
      faculty_id  INTEGER       NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
      status      VARCHAR(20)   NOT NULL DEFAULT 'Pending'
                  CHECK (status IN ('Pending','Occupied','Released','Expired')),
      reserved_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ   NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
      occupied_at     TIMESTAMPTZ,
      released_at     TIMESTAMPTZ,
      scheduled_start TIME,
      scheduled_end   TIME
    )
  `);

  // Add scheduled columns to existing tables that pre-date this schema version
  await query(`ALTER TABLE room_occupancy ADD COLUMN IF NOT EXISTS scheduled_start TIME`).catch(() => {});
  await query(`ALTER TABLE room_occupancy ADD COLUMN IF NOT EXISTS scheduled_end   TIME`).catch(() => {});

  /*
   * Partial unique index: at most ONE active (Pending or Occupied) record per
   * room at any given moment.  INSERT will raise a unique-violation if another
   * request races in — the caller should catch and return a 409.
   */
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS room_occupancy_active_room_idx
    ON room_occupancy (room_id)
    WHERE status IN ('Pending', 'Occupied')
  `);

  ready = true;
}

/** Expire stale Pending/Occupied rows whose expires_at has passed.
 *  Occupied rows tied to an In-Use room request stay active until the
 *  instructor (or admin) explicitly releases them. */
export async function expireStaleOccupancy(roomId?: number): Promise<void> {
  const inUseGuard = `
    AND NOT (
      status = 'Occupied'
      AND EXISTS (
        SELECT 1 FROM room_change_requests rcr
        WHERE rcr.requested_room_id = room_occupancy.room_id
          AND rcr.faculty_id        = room_occupancy.faculty_id
          AND rcr.status            = 'In-Use'
      )
    )
  `;
  const expired = roomId !== undefined
    ? await query(`
      UPDATE room_occupancy
      SET    status = 'Expired', released_at = NOW()
      WHERE  room_id = $1
        AND  status IN ('Pending', 'Occupied')
        AND  expires_at < NOW()
        ${inUseGuard}
    `, [roomId])
    : await query(`
      UPDATE room_occupancy
      SET    status = 'Expired', released_at = NOW()
      WHERE  status IN ('Pending', 'Occupied')
        AND  expires_at < NOW()
        ${inUseGuard}
    `);
  // Time-based change — open tabs refresh the rooms that just freed up
  if ((expired.rowCount ?? 0) > 0) bumpTopics(['occupancy']);

  await restoreSchedulesAfterReleasedRequests();
}

/**
 * Put a class into the room its request was approved or confirmed for.
 * Only sessions allowed in that room move — a lecture room never takes a
 * Laboratory session (the Scheduling rule), and a Major subject's Lecture and
 * Laboratory share one room, so they move together or not at all — and each
 * moved session's previous room is kept on the request (session_rooms), so
 * releasing the room puts every session back exactly where it was, even when
 * Lecture and Laboratory use different rooms.
 */
export async function applyRequestedRoom(rcr: {
  id: number;
  master_schedule_id: number;
  requested_room_id: number;
}): Promise<void> {
  await ensureRoomRequestsSchema();
  await transaction(async (client) => {
    const moving = await client.query<{ id: number; room_id: number | null }>(`
      SELECT ss.id, ss.room_id
      FROM   schedule_sessions ss
      JOIN   rooms r ON r.id = $2
      JOIN   master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN   block_subjects bs ON bs.id = ms.block_subject_id
      JOIN   curriculums c ON c.id = bs.curriculum_id
      WHERE  ss.master_schedule_id = $1
        AND  ss.room_id IS DISTINCT FROM $2
        AND  (LOWER(TRIM(r.room_type)) IN ('laboratory', 'computer lab')
              OR (COALESCE(ss.type, 'lec') = 'lec' AND NOT ${needsOneRoomSql('c')}))
      ORDER BY ss.id
      FOR UPDATE OF ss
    `, [rcr.master_schedule_id, rcr.requested_room_id]);

    const previous: Record<string, number | null> = {};
    for (const s of moving.rows) previous[String(s.id)] = s.room_id;

    if (moving.rows.length > 0) {
      await client.query(
        `UPDATE schedule_sessions SET room_id = $1 WHERE id = ANY($2::int[])`,
        [rcr.requested_room_id, moving.rows.map(s => s.id)],
      );
    }
    await client.query(`UPDATE master_schedule SET room_id = $1 WHERE id = $2`, [rcr.requested_room_id, rcr.master_schedule_id]);
    await client.query(
      `UPDATE room_change_requests SET session_rooms = $1::jsonb WHERE id = $2`,
      [JSON.stringify(previous), rcr.id],
    );
  });
}

/**
 * Sessions a released request moved go back to their own previous rooms.
 * Only sessions still in the requested room are touched (a class rescheduled
 * since then is left alone). Requests from before session_rooms was kept send
 * them back to the class's original room.
 */
async function restoreRequestSessionRooms(r: {
  master_schedule_id: number;
  original_room_id: number | null;
  requested_room_id: number | null;
  session_rooms: Record<string, number | null> | null;
}): Promise<void> {
  if (r.session_rooms) {
    await query(`
      UPDATE schedule_sessions ss
      SET    room_id = ($3::jsonb ->> ss.id::text)::int
      WHERE  ss.master_schedule_id = $1
        AND  ss.room_id IS NOT DISTINCT FROM $2
        AND  $3::jsonb ? ss.id::text
    `, [r.master_schedule_id, r.requested_room_id, JSON.stringify(r.session_rooms)]);
    return;
  }
  await query(
    `UPDATE schedule_sessions SET room_id = $1 WHERE master_schedule_id = $2 AND room_id IS NOT DISTINCT FROM $3`,
    [r.original_room_id, r.master_schedule_id, r.requested_room_id],
  );
}

/**
 * If the latest request for a class is Released but the schedule still
 * points at the requested room (leftover from admin approval), restore
 * the previous rooms so the room can be requested again.
 */
async function restoreSchedulesAfterReleasedRequests(): Promise<void> {
  await ensureRoomRequestsSchema();
  const classes = await query(`
    WITH latest AS (
      SELECT DISTINCT ON (master_schedule_id)
             master_schedule_id,
             original_room_id,
             requested_room_id,
             faculty_id,
             status
      FROM   room_change_requests
      WHERE  master_schedule_id IS NOT NULL
      ORDER BY master_schedule_id, created_at DESC, id DESC
    )
    UPDATE master_schedule ms
    SET    room_id = latest.original_room_id
    FROM   latest
    WHERE  ms.id = latest.master_schedule_id
      AND  latest.status = 'Released'
      AND  ms.room_id IS NOT DISTINCT FROM latest.requested_room_id
      AND  ms.room_id IS DISTINCT FROM latest.original_room_id
      AND  NOT EXISTS (
             SELECT 1 FROM room_occupancy ro
             WHERE  ro.room_id    = latest.requested_room_id
               AND  ro.faculty_id = latest.faculty_id
               AND  ro.status IN ('Pending', 'Occupied')
           )
  `).catch(() => null);

  // Each moved session goes back to its own previous room (session_rooms);
  // requests without that record fall back to the class's original room.
  const sessions = await query(`
    WITH latest AS (
      SELECT DISTINCT ON (master_schedule_id)
             master_schedule_id,
             original_room_id,
             requested_room_id,
             faculty_id,
             status,
             session_rooms
      FROM   room_change_requests
      WHERE  master_schedule_id IS NOT NULL
      ORDER BY master_schedule_id, created_at DESC, id DESC
    )
    UPDATE schedule_sessions ss
    SET    room_id = CASE
                       WHEN latest.session_rooms IS NULL THEN latest.original_room_id
                       ELSE (latest.session_rooms ->> ss.id::text)::int
                     END
    FROM   latest
    WHERE  ss.master_schedule_id = latest.master_schedule_id
      AND  latest.status = 'Released'
      AND  ss.room_id IS NOT DISTINCT FROM latest.requested_room_id
      AND  (
             (latest.session_rooms IS NULL AND ss.room_id IS DISTINCT FROM latest.original_room_id)
             OR latest.session_rooms ? ss.id::text
           )
      AND  NOT EXISTS (
             SELECT 1 FROM room_occupancy ro
             WHERE  ro.room_id    = latest.requested_room_id
               AND  ro.faculty_id = latest.faculty_id
               AND  ro.status IN ('Pending', 'Occupied')
           )
  `).catch(() => null);

  if ((classes?.rowCount ?? 0) + (sessions?.rowCount ?? 0) > 0) bumpTopics(['schedule', 'workload']);
}

/**
 * End occupancy and close matching In-Use room requests.
 * Restores the class to original_room_id so the released room can be
 * requested again without being treated as still assigned.
 */
export async function completeRoomRelease(
  roomId: number,
  facultyId: number,
): Promise<boolean> {
  const released = await query(`
    UPDATE room_occupancy
    SET    status = 'Released', released_at = NOW()
    WHERE  room_id    = $1
      AND  faculty_id = $2
      AND  status IN ('Pending', 'Occupied')
    RETURNING id
  `, [roomId, facultyId]);

  if (released.rows.length === 0) return false;
  bumpTopics(['occupancy']);

  await ensureRoomRequestsSchema();
  const closed = await query(`
    UPDATE room_change_requests
    SET    status     = 'Released',
           updated_at = NOW(),
           auto_notes = COALESCE(NULLIF(trim(auto_notes), ''), 'Room released by faculty.')
    WHERE  faculty_id        = $1
      AND  requested_room_id = $2
      AND  status            = 'In-Use'
    RETURNING master_schedule_id, original_room_id, requested_room_id, session_rooms
  `, [facultyId, roomId]);
  if (closed.rows.length > 0) bumpTopics(['room-requests', 'schedule', 'workload']);

  for (const row of closed.rows) {
    if (!row.master_schedule_id) continue;
    await query(
      `UPDATE master_schedule SET room_id = $1 WHERE id = $2 AND room_id IS NOT DISTINCT FROM $3`,
      [row.original_room_id ?? null, row.master_schedule_id, row.requested_room_id ?? null],
    );
    await restoreRequestSessionRooms({
      master_schedule_id: Number(row.master_schedule_id),
      original_room_id: row.original_room_id ?? null,
      requested_room_id: row.requested_room_id ?? null,
      session_rooms: row.session_rooms ?? null,
    });
  }

  await restoreSchedulesAfterReleasedRequests();
  return true;
}

/**
 * Expire room_change_requests whose 15-minute QR confirmation window has passed.
 * Calls ensureRoomRequestsSchema() first so this is self-healing on any database
 * that hasn't had the v15 migration applied yet (e.g. after a hot-reload in dev).
 */
export async function expireStaleRoomRequests(): Promise<void> {
  await ensureRoomRequestsSchema();
  const expired = await query(`
    UPDATE room_change_requests
    SET    status     = 'Expired',
           updated_at = NOW(),
           expired_at = COALESCE(expired_at, NOW()),
           auto_notes = COALESCE(
             auto_notes,
             'QR scan window expired — room returned to available.'
           )
    WHERE  status               = 'Pending Confirmation'
      AND  confirmation_deadline < NOW()
  `).catch(() => null);
  if ((expired?.rowCount ?? 0) > 0) bumpTopics(['room-requests']);
  await purgeOldRoomRequestHistory();
}

/**
 * Finished requests (Approved / Rejected / Released / Expired) only live for the
 * day they were decided — from the next day (Manila time) they are deleted.
 * An Approved request whose room is still held is kept until it ends.
 */
async function purgeOldRoomRequestHistory(): Promise<void> {
  const purged = await query(`
    DELETE FROM room_change_requests rcr
    WHERE  rcr.status IN ('Approved', 'Rejected', 'Released', 'Expired')
      -- updated_at / created_at are naive timestamps already in Manila local time
      AND  COALESCE(rcr.updated_at, rcr.created_at)::date < (NOW() AT TIME ZONE 'Asia/Manila')::date
      AND  NOT (
             rcr.status = 'Approved'
             AND EXISTS (
               SELECT 1 FROM room_occupancy ro
               WHERE  ro.room_id    = rcr.requested_room_id
                 AND  ro.faculty_id = rcr.faculty_id
                 AND  ro.status IN ('Pending', 'Occupied')
             )
           )
  `).catch(err => { console.error('[purgeOldRoomRequestHistory]', err); return null; });
  if ((purged?.rowCount ?? 0) > 0) bumpTopics(['room-requests']);
}
