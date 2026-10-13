import { query, transaction } from '@/database/db';
import { bumpTopics } from '@/services/realtime';
import { manilaDateAtSql } from '@/services/appTimezone';
import { holdEndSql } from '@/services/occupancyHold';
import { needsOneRoomSql } from '@shared/subjectCategory';
import { HOLD_BEFORE_MIN } from '@shared/roomRequestWindow';

let ready = false;
let rcrSchemaReady = false;
let qrScanLogsSchemaReady = false;

/*
  Room requests are for today only (@shared/roomRequestWindow): a request with a
  use_date holds its room for that one class time — from 15 minutes before the
  class until it ends — and never changes the class's schedule. Requests made
  before (no use_date) moved the class into the room until it was released and
  keep that behaviour.
*/

/** SQL: when today-only request `a` starts holding its room (15 minutes before its class time) */
const holdFromSql = (a: string) =>
  `(${manilaDateAtSql(`${a}.use_date`, `${a}.use_start`)} - INTERVAL '${HOLD_BEFORE_MIN} minutes')`;
/** SQL: when today-only request `a`'s class time ends */
const classEndSql = (a: string) => manilaDateAtSql(`${a}.use_date`, `${a}.use_end`);

/** SQL: occupancy `ro` belongs to an older In-Use request that moved its class into the room (held until released) */
export function legacyInUseHoldSql(ro: string): string {
  return `EXISTS (
    SELECT 1 FROM room_change_requests lr
    WHERE  lr.requested_room_id = ${ro}.room_id
      AND  lr.faculty_id        = ${ro}.faculty_id
      AND  lr.status            = 'In-Use'
      AND  lr.use_date IS NULL
  )`;
}

export { holdEndSql };

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
    // Today-only requests: the date and the class time the room is held for
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS use_date              DATE`,
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS use_start             TIME`,
    `ALTER TABLE room_change_requests ADD COLUMN IF NOT EXISTS use_end               TIME`,
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

/** Expire stale Pending/Occupied rows: a class's hold the moment its class ends
 *  (no running over — the user's rule, 2026-10-13), anything else once its
 *  expires_at has passed. Occupied rows tied to an older In-Use room request (one that moved its
 *  class) stay active until the instructor (or admin) explicitly releases
 *  them; a today-only request's hold ends with its class time. Then request
 *  statuses that time changes are brought up to date, and today-only requests
 *  whose time has come take their rooms. */
export async function expireStaleOccupancy(roomId?: number): Promise<void> {
  await ensureRoomRequestsSchema();
  const inUseGuard = `
    AND NOT (
      status = 'Occupied'
      AND ${legacyInUseHoldSql('room_occupancy')}
    )
  `;
  const expired = roomId !== undefined
    ? await query(`
      UPDATE room_occupancy
      SET    status = 'Expired', released_at = NOW()
      WHERE  room_id = $1
        AND  status IN ('Pending', 'Occupied')
        AND  ${holdEndSql('room_occupancy')} <= NOW()
        ${inUseGuard}
    `, [roomId])
    : await query(`
      UPDATE room_occupancy
      SET    status = 'Expired', released_at = NOW()
      WHERE  status IN ('Pending', 'Occupied')
        AND  ${holdEndSql('room_occupancy')} <= NOW()
        ${inUseGuard}
    `);
  // Time-based change — open tabs refresh the rooms that just freed up
  if ((expired.rowCount ?? 0) > 0) bumpTopics(['occupancy']);

  await closeTimedOutRequests();
  await activateDueReservations();
  await restoreSchedulesAfterReleasedRequests();
}

/**
 * Today-only requests whose time has come hold their room, from 15 minutes
 * before the class: one waiting for its QR scan gets a Pending hold until the
 * scan deadline; one an administrator approved is held (Occupied) until the
 * class ends. A hold left from a class that has already ended (the 30-minute
 * tail after a check-in) gives way first; anyone else still holding the room
 * keeps it, and the hold follows once it ends.
 */
export async function activateDueReservations(): Promise<void> {
  await ensureRoomRequestsSchema();
  try {
    const madeWay = await query(`
      UPDATE room_occupancy ro
      SET    status = 'Expired', released_at = NOW()
      FROM   room_change_requests rcr
      WHERE  rcr.use_date IS NOT NULL
        AND  rcr.status IN ('Pending Confirmation', 'Approved')
        AND  (rcr.status = 'Approved' OR rcr.confirmation_deadline > NOW())
        AND  NOW() >= ${holdFromSql('rcr')}
        AND  NOW() <  ${classEndSql('rcr')}
        AND  ro.room_id     = rcr.requested_room_id
        AND  ro.faculty_id <> rcr.faculty_id
        AND  ro.status IN ('Pending', 'Occupied')
        AND  ro.scheduled_end IS NOT NULL
        AND  ${holdEndSql('ro')} <= NOW()
        AND  NOT ${legacyInUseHoldSql('ro')}
    `);
    const held = await query(`
      INSERT INTO room_occupancy (room_id, faculty_id, status, reserved_at, expires_at, scheduled_start, scheduled_end)
      SELECT DISTINCT ON (rcr.requested_room_id)
             rcr.requested_room_id, rcr.faculty_id, 'Pending', NOW(), rcr.confirmation_deadline, rcr.use_start, rcr.use_end
      FROM   room_change_requests rcr
      WHERE  rcr.use_date IS NOT NULL
        AND  rcr.status = 'Pending Confirmation'
        AND  rcr.confirmation_deadline > NOW()
        AND  NOW() >= ${holdFromSql('rcr')}
        AND  NOT EXISTS (
               SELECT 1 FROM room_occupancy ro
               WHERE  ro.room_id = rcr.requested_room_id
                 AND  ro.status IN ('Pending', 'Occupied')
             )
      ORDER  BY rcr.requested_room_id, rcr.use_start
      ON CONFLICT DO NOTHING
    `);
    const approved = await query(`
      SELECT DISTINCT ON (rcr.requested_room_id) rcr.id
      FROM   room_change_requests rcr
      WHERE  rcr.use_date IS NOT NULL
        AND  rcr.status = 'Approved'
        AND  NOW() >= ${holdFromSql('rcr')}
        AND  NOW() <  ${classEndSql('rcr')}
        AND  NOT EXISTS (
               SELECT 1 FROM room_occupancy ro
               WHERE  ro.room_id     = rcr.requested_room_id
                 AND  ro.faculty_id <> rcr.faculty_id
                 AND  ro.status IN ('Pending', 'Occupied')
             )
      ORDER  BY rcr.requested_room_id, rcr.use_start
    `);
    let changed = (madeWay.rowCount ?? 0) + (held.rowCount ?? 0);
    for (const r of approved.rows as { id: number }[]) {
      if (await holdRoomForRequest(Number(r.id))) changed++;
    }
    if (changed > 0) bumpTopics(['occupancy', 'room-requests']);
  } catch (err) {
    console.error('[activateDueReservations]', err);
  }
}

/**
 * Hold the room for a today-only request now, until its class ends: the
 * faculty's own hold of the room (the Pending one from the request, or one
 * they already had) becomes Occupied, otherwise a new one is made, and the
 * request becomes In-Use. False when another faculty holds the room.
 */
export async function holdRoomForRequest(requestId: number): Promise<boolean> {
  const own = await query(`
    UPDATE room_occupancy ro
    SET    status          = 'Occupied',
           occupied_at     = COALESCE(ro.occupied_at, NOW()),
           expires_at      = ${classEndSql('rcr')},
           scheduled_start = rcr.use_start,
           scheduled_end   = rcr.use_end
    FROM   room_change_requests rcr
    WHERE  rcr.id = $1
      AND  rcr.use_date IS NOT NULL
      AND  ro.room_id    = rcr.requested_room_id
      AND  ro.faculty_id = rcr.faculty_id
      AND  ro.status IN ('Pending', 'Occupied')
    RETURNING ro.id
  `, [requestId]);
  if ((own.rowCount ?? 0) === 0) {
    const made = await query(`
      INSERT INTO room_occupancy
        (room_id, faculty_id, status, reserved_at, expires_at, occupied_at, scheduled_start, scheduled_end)
      SELECT rcr.requested_room_id, rcr.faculty_id, 'Occupied', NOW(), ${classEndSql('rcr')}, NOW(), rcr.use_start, rcr.use_end
      FROM   room_change_requests rcr
      WHERE  rcr.id = $1 AND rcr.use_date IS NOT NULL
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [requestId]);
    if ((made.rowCount ?? 0) === 0) return false;
  }
  await query(`
    UPDATE room_change_requests
    SET    status       = 'In-Use',
           confirmed_at = COALESCE(confirmed_at, NOW()),
           updated_at   = NOW()
    WHERE  id = $1
  `, [requestId]);
  bumpTopics(['occupancy', 'room-requests']);
  return true;
}

export interface ConfirmedReservation {
  id: number;
  master_schedule_id: number | null;
  /** "HH:MM" */
  use_start: string;
  use_end: string;
  subject_name: string | null;
  block_name: string | null;
}

/**
 * The faculty's today-only request for this room whose time has come (from 15
 * minutes before its class; one waiting for its scan only until the
 * deadline): the scan confirms it and holds the room until the class ends.
 * Null when there is none, or another faculty holds the room.
 */
export async function confirmReservationByScan(facultyId: number, roomId: number): Promise<ConfirmedReservation | null> {
  await ensureRoomRequestsSchema();
  const res = await query(`
    SELECT rcr.id, rcr.master_schedule_id,
           to_char(rcr.use_start, 'HH24:MI') AS use_start,
           to_char(rcr.use_end,   'HH24:MI') AS use_end,
           c.subject_name, b.block_name
    FROM   room_change_requests rcr
    LEFT JOIN master_schedule ms ON ms.id = rcr.master_schedule_id
    LEFT JOIN block_subjects  bs ON bs.id = ms.block_subject_id
    LEFT JOIN curriculums      c ON c.id  = bs.curriculum_id
    LEFT JOIN blocks           b ON b.id  = bs.block_id
    WHERE  rcr.faculty_id        = $1
      AND  rcr.requested_room_id = $2
      AND  rcr.use_date IS NOT NULL
      AND  rcr.status IN ('Pending Confirmation', 'Approved')
      AND  (rcr.status = 'Approved' OR rcr.confirmation_deadline > NOW())
      AND  NOW() >= ${holdFromSql('rcr')}
      AND  NOW() <  ${classEndSql('rcr')}
    ORDER  BY rcr.use_start
    LIMIT  1
  `, [facultyId, roomId]);
  const found = res.rows[0] as ConfirmedReservation | undefined;
  if (!found) return null;
  return (await holdRoomForRequest(Number(found.id))) ? found : null;
}

/** The faculty's today-only request for this room whose time hasn't come yet (its scan opens 15 minutes before the class) */
export async function upcomingReservation(facultyId: number, roomId: number): Promise<{ use_start: string; use_end: string } | null> {
  await ensureRoomRequestsSchema();
  const res = await query(`
    SELECT to_char(rcr.use_start, 'HH24:MI') AS use_start, to_char(rcr.use_end, 'HH24:MI') AS use_end
    FROM   room_change_requests rcr
    WHERE  rcr.faculty_id        = $1
      AND  rcr.requested_room_id = $2
      AND  rcr.use_date IS NOT NULL
      AND  rcr.status IN ('Pending Confirmation', 'Approved')
      AND  NOW() < ${holdFromSql('rcr')}
    ORDER  BY rcr.use_date, rcr.use_start
    LIMIT  1
  `, [facultyId, roomId]);
  return (res.rows[0] as { use_start: string; use_end: string } | undefined) ?? null;
}

/** When another faculty's today-only request next starts holding this room
 *  (15 minutes before its class) — someone walking in must be out by then */
export async function nextReservationHoldFrom(roomId: number, facultyId: number): Promise<Date | null> {
  await ensureRoomRequestsSchema();
  const res = await query(`
    SELECT MIN(${holdFromSql('rcr')}) AS hold_from
    FROM   room_change_requests rcr
    WHERE  rcr.requested_room_id = $1
      AND  rcr.faculty_id       <> $2
      AND  rcr.use_date IS NOT NULL
      AND  rcr.status IN ('Pending Confirmation', 'Approved')
      AND  ${holdFromSql('rcr')} > NOW()
  `, [roomId, facultyId]);
  const at = res.rows[0]?.hold_from;
  return at ? new Date(at) : null;
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
 * the previous rooms so the room can be requested again. Today-only
 * requests never moved the class, so there is nothing to restore for them.
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
             status,
             use_date
      FROM   room_change_requests
      WHERE  master_schedule_id IS NOT NULL
      ORDER BY master_schedule_id, created_at DESC, id DESC
    )
    UPDATE master_schedule ms
    SET    room_id = latest.original_room_id
    FROM   latest
    WHERE  ms.id = latest.master_schedule_id
      AND  latest.status = 'Released'
      AND  latest.use_date IS NULL
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
             session_rooms,
             use_date
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
      AND  latest.use_date IS NULL
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
 * End occupancy and close matching In-Use room requests (and a today-only
 * request whose hold was just given up, so it doesn't take the room back).
 * An older request's class goes back to original_room_id so the released room
 * can be requested again without being treated as still assigned.
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
      AND  (status = 'In-Use'
            OR (use_date IS NOT NULL
                AND status IN ('Pending Confirmation', 'Approved')
                AND NOW() >= ${holdFromSql('room_change_requests')}))
    RETURNING master_schedule_id, original_room_id, requested_room_id, session_rooms, use_date
  `, [facultyId, roomId]);
  if (closed.rows.length > 0) bumpTopics(['room-requests', 'schedule', 'workload']);

  for (const row of closed.rows) {
    // Today-only requests never moved the class
    if (!row.master_schedule_id || row.use_date) continue;
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
 * Expire room_change_requests whose QR confirmation window has passed, and
 * close today-only requests whose class time is over.
 * Calls ensureRoomRequestsSchema() first so this is self-healing on any database
 * that hasn't had the v15 migration applied yet (e.g. after a hot-reload in dev).
 */
export async function expireStaleRoomRequests(): Promise<void> {
  await ensureRoomRequestsSchema();
  await closeTimedOutRequests();
  await purgeOldRoomRequestHistory();
}

/** Request statuses that time alone changes: a QR scan that didn't come in
 *  time, and a today-only request whose class time is over. */
async function closeTimedOutRequests(): Promise<void> {
  await ensureRoomRequestsSchema();
  const expired = await query(`
    UPDATE room_change_requests
    SET    status     = 'Expired',
           updated_at = NOW(),
           expired_at = COALESCE(expired_at, NOW()),
           auto_notes = COALESCE(
             auto_notes,
             CASE WHEN use_date IS NULL
                  THEN 'QR scan window expired — room returned to available.'
                  ELSE 'The QR code was not scanned in time, so the room was given back.'
             END
           )
    WHERE  status               = 'Pending Confirmation'
      AND  confirmation_deadline < NOW()
  `).catch(err => { console.error('[closeTimedOutRequests] expire', err); return null; });
  const ended = await query(`
    UPDATE room_change_requests rcr
    SET    status     = 'Released',
           updated_at = NOW(),
           auto_notes = COALESCE(NULLIF(trim(rcr.auto_notes), ''), 'Ended after the class time.')
    WHERE  rcr.use_date IS NOT NULL
      AND  rcr.status IN ('In-Use', 'Approved')
      AND  ${classEndSql('rcr')} <= NOW()
  `).catch(err => { console.error('[closeTimedOutRequests] end', err); return null; });
  if ((expired?.rowCount ?? 0) + (ended?.rowCount ?? 0) > 0) bumpTopics(['room-requests']);
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
