import { NextRequest, NextResponse } from 'next/server';
import { manilaCalendarDateString, manilaClock, manilaTodayAtSql } from '@/services/appTimezone';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import {
  applyRequestedRoom,
  confirmReservationByScan,
  ensureRoomOccupancy,
  expireStaleOccupancy,
  ensureRoomRequestsSchema,
  ensureQrScanLogsSchema,
  nextReservationHoldFrom,
  upcomingReservation,
  type ConfirmedReservation,
} from '@/services/ensureRoomOccupancy';
import { createNotification } from '@/services/notifications';
import { withAudit } from '@/services/audit';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { qrCodeFromScan } from '@/services/roomQr';
import { ensureRoomReleasesTable, freedOnSql, releasedOnSql, unclaimedNowSql } from '@/services/roomReleases';
import { isQrCode } from '@shared/qrLink';
import { HOLD_BEFORE_MIN, shiftTime, time12, timeRange12 } from '@shared/roomRequestWindow';
import { needsOneRoomSql } from '@shared/subjectCategory';
import { holdEndSql } from '@/services/occupancyHold';
import {
  BORROW_MIN_LEFT, borrowRoomFitError, earlierTime, fitsFreeTime, freedTimeUntil, minutesLeft, notEnoughTimeMessage, tooLateMessage,
} from '@/services/borrowedRoom';

/*
  QR Scan Logic — Thesis Hybrid Room Request System
  ─────────────────────────────────────────────────
  Session timing rules (scheduled rooms):
    Scan window    : scheduled_start âˆ’ 15 min  →  scheduled_end
    On Time (Valid): scan_time â‰¤ scheduled_start + 5 min
    Late           : scan_time > scheduled_start + 5 min  AND  â‰¤ scheduled_end
    Rejected       : scan_time > scheduled_end  (class already over)

  Room occupancy expiry always uses SCHEDULED end time (never scan time):
    expires_at = today (Manila) + scheduled_end + INTERVAL '30 minutes'

  Using a room that isn't your class's own (services/borrowedRoom.ts — the
  user's rules, 2026-10-13): a room freed today (Free My Room, or no scan
  within 15 minutes of the start) or a lecture room with no class now. Only a
  faculty whose class right now has NO room may, the room must suit the class,
  and the class must END by the time the room is free until (the freed class's
  end, the room's next class, or another faculty's reservation) — it may have
  started earlier, but only the rest of the time is used. The hold ends when
  that class ends: the scan time never moves or stretches anyone's schedule.
  Admins / chairs may still occupy a free room, never past that time.
  A freed class time is free only from its own start (never the 15 minutes
  before), a room can't be taken with 30 minutes or less of its free time
  left, and a faculty already holding another room (whose time hasn't ended)
  can't take a second one (2026-10-13).

  Back-to-back classes: once a class has ended, its faculty's check-in (the
  30-minute tail) gives way to a scan that gets the room — the next class
  never waits for it.

  Room Request (separate flow, today only — @shared/roomRequestWindow):
    Submit request for one class time today → from 15 min before the class the
    room is held (Pending) → QR scan by 15 min after the start confirms it,
    OCCUPIED until the class ends (the class's own schedule never changes)
    OR admin accepts → held without a QR scan
    A scan before the hold starts only says when to come back; anyone walking
    in earlier must leave by the time the hold starts.

  Laboratory rooms:
    Follow scheduled-session rules only. No walk-in occupancy, no room-request hold.

  A class nobody checked in for (services/roomReleases.ts): 15 minutes after
  the start with no check-in, its room is free to anyone until the class ends —
  like a room its faculty released for today. The class's own faculty can still
  check in late while nobody else has taken it.
*/

function isLaboratoryRoom(roomType: unknown): boolean {
  const t = String(roomType ?? '').trim().toLowerCase();
  return t === 'laboratory' || t === 'computer lab';
}

/** Parse "HH:MM:SS" or "HH:MM" into total minutes since midnight. */
function timeToMins(t: string): number {
  const parts = String(t).split(':').map(Number);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

/**
 * The scanner's camera keeps running after a refused scan, so pointing it at
 * the same room again repeats the same answer: within this many minutes that
 * repeat is not logged again (nor its violation and alerts).
 */
const REPEAT_REFUSAL_MINUTES = 2;

/**
 * Insert a scan log only when no successful entry already exists for this
 * faculty + room within the last 10 seconds (dedup guard for concurrent requests).
 * Blocked / Unauthorized / Overuse logs are audit records: one per faculty,
 * room and answer every REPEAT_REFUSAL_MINUTES. Returns whether a row was added.
 * Stores scheduled_start / scheduled_end alongside the actual scan_time.
 */
async function insertScanLogIfUnique(
  roomId: number,
  facultyId: number,
  scheduleId: number | null,
  scanDate: string,
  status: string,
  notes: string,
  scheduledStart?: string | null,
  scheduledEnd?: string | null,
): Promise<boolean> {
  const isAuditOnly = status === 'Blocked' || status === 'Unauthorized' || status === 'Overuse';
  if (isAuditOnly) {
    // Explicit casts: a parameter used twice must not be read as two types (42P08)
    const res = await query(
      `INSERT INTO qr_scan_logs
         (room_id, faculty_id, master_schedule_id, scan_time, scan_date,
          status, notes, scheduled_start, scheduled_end)
       SELECT $1::int, $2::int, $3::int, NOW(), $4::date, $5::varchar, $6::text, $7::time, $8::time
       WHERE NOT EXISTS (
         SELECT 1 FROM qr_scan_logs
         WHERE  room_id    = $1::int
           AND  faculty_id = $2::int
           AND  scan_date  = $4::date
           AND  status     = $5::varchar
           AND  scan_time  > NOW() - INTERVAL '${REPEAT_REFUSAL_MINUTES} minutes'
       )
       RETURNING id`,
      [roomId, facultyId, scheduleId, scanDate, status, notes,
       scheduledStart ?? null, scheduledEnd ?? null],
    ).catch(() => null);
    return (res?.rowCount ?? 0) > 0;
  }
  // Idempotent insert for successful scans — prevents duplicate rows when
  // concurrent requests race through before the unique occupancy index fires.
  const res = await query(
    `INSERT INTO qr_scan_logs
       (room_id, faculty_id, master_schedule_id, scan_time, scan_date,
        status, notes, scheduled_start, scheduled_end)
     SELECT $1, $2, $3, NOW(), $4, $5, $6, $7, $8
     WHERE NOT EXISTS (
       SELECT 1 FROM qr_scan_logs
       WHERE  room_id    = $1
         AND  faculty_id = $2
         AND  scan_date  = $4
         AND  status     NOT IN ('Blocked', 'Unauthorized', 'Overuse')
         AND  scan_time  > NOW() - INTERVAL '10 seconds'
     )
     RETURNING id`,
    [roomId, facultyId, scheduleId, scanDate, status, notes,
     scheduledStart ?? null, scheduledEnd ?? null],
  ).catch(() => null);
  return (res?.rowCount ?? 0) > 0;
}

async function POST_handler(req: NextRequest) {
  try {
    await ensureRoomOccupancy();
    await ensureRoomRequestsSchema();
    await ensureQrScanLogsSchema();
    await ensureRoomReleasesTable();

    // ── Input validation ────────────────────────────────────────────────────
    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: unknown } | null;
    if (!authUser) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const isAdmin  = authUser.role === 'admin' || authUser.role === 'department_chair' || authUser.role === 'program_chair';

    const rawQr = body.qr_code_id;
    if (typeof rawQr !== 'string' || !rawQr.trim() || rawQr.length > 512) {
      return NextResponse.json({ error: 'Invalid QR code' }, { status: 400 });
    }
    // A /q/<code> link (phone camera), the older JSON text, or the bare code
    const qr_code_id = qrCodeFromScan(rawQr);
    // Only a room code as issued (letters, digits, dashes) is looked up — anything else in a QR is ignored
    if (!isQrCode(qr_code_id)) {
      return NextResponse.json({ status: 'Invalid', message: 'Invalid Room QR Code.', scan_time: manilaClock().time }, { status: 404 });
    }

    // Who scanned comes from the sign-in: a faculty account always scans as
    // itself (a faculty_id sent along is only checked against it, never used)
    const faculty_id = authUser.role === 'instructor' ? Number(authUser.faculty_id) : Number(body.faculty_id);
    if (authUser.role === 'instructor') {
      const sent = body.faculty_id;
      if (!Number.isInteger(faculty_id) || faculty_id <= 0 || (sent != null && Number(sent) !== faculty_id)) {
        return NextResponse.json({ error: 'Forbidden: faculty ID mismatch' }, { status: 403 });
      }
    }
    if (!Number.isInteger(faculty_id) || faculty_id <= 0) {
      return NextResponse.json({ error: 'Invalid faculty ID' }, { status: 400 });
    }

    // Resolve the scanning instructor's display name once for human-readable admin notifications.
    const nameRes = await query(
      `SELECT COALESCE(
         NULLIF(trim(COALESCE(name, '')), ''),
         NULLIF(trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '')
       ) AS display_name
       FROM faculty WHERE id = $1`,
      [faculty_id],
    ).catch(() => ({ rows: [] as { display_name: string }[] }));
    const scannerName: string = (nameRes.rows[0] as { display_name?: string } | undefined)?.display_name || `Faculty #${faculty_id}`;

    // ── STEP 1 · Resolve room ─────────────────────────────────────────────────
    const roomResult = await query(
      "SELECT * FROM rooms WHERE qr_code_id = $1 AND status = 'Active'",
      [qr_code_id],
    );
    if (roomResult.rows.length === 0) {
      return NextResponse.json({
        status:    'Invalid',
        message:   'Invalid Room QR Code.',
        scan_time: manilaClock().time,
      }, { status: 404 });
    }
    const room = roomResult.rows[0];

    // Manila wall clock, like scanDate — the server's own timezone may be UTC
    const now      = new Date();
    const { time: scanTime, dayOfWeek } = manilaClock(now); // HH:MM:SS, "Monday"
    const scanDate = manilaCalendarDateString(now);
    // Only classes of the active school year + semester are running — the
    // conflict rules keep each term separate, so another term's class at the
    // same time must not count as the class in this room now.
    const period = await getActiveAcademicPeriod();
    const termYear = period.schoolYear ?? '';
    const termSemester = period.semester ?? '';

    // ── STEP 2 · Expire stale occupancy for this room ─────────────────────────
    // (also: today-only room requests whose time has come take their rooms)
    await expireStaleOccupancy(room.id);

    /** The scan confirmed the faculty's today-only room request: the room is theirs until the class ends */
    const reservationConfirmed = async (r: ConfirmedReservation) => {
      const startMins = timeToMins(r.use_start);
      const scanStatus = timeToMins(scanTime) <= startMins + 5 ? 'Valid' : 'Late';
      await query(`
        INSERT INTO room_utilization_logs
          (room_id, faculty_id, master_schedule_id, usage_date, start_time, end_time, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [room.id, faculty_id, r.master_schedule_id, scanDate, r.use_start, r.use_end, scanStatus]).catch(() => {});
      await insertScanLogIfUnique(
        room.id, faculty_id, r.master_schedule_id, scanDate, scanStatus,
        `Room request confirmed by QR scan — held ${r.use_start}–${r.use_end} today`,
        r.use_start, r.use_end,
      );
      createNotification({
        recipientId: Number(faculty_id), recipientRole: 'instructor',
        title: 'Room Request Confirmed',
        message: `${room.room_name} is yours until ${time12(r.use_end)} today.`,
        type: 'qr_scan_success', relatedModule: 'room', relatedId: room.id,
      }).catch(() => {});
      createNotification({
        recipientRole: 'admin',
        title: 'Room Scanned',
        message: `${scannerName} confirmed their room request for ${room.room_name}${r.subject_name ? ` (${r.subject_name})` : ''}, ${timeRange12(r.use_start, r.use_end)} today.`,
        type: 'room_occupied', relatedModule: 'room', relatedId: room.id,
      }).catch(() => {});
      return NextResponse.json({
        status:       'In-Use',
        scan_status:  scanStatus,
        message:      `Room confirmed. ${room.room_name} is yours until ${time12(r.use_end)}.`,
        scan_time:    scanTime,
        room:         { id: room.id, name: room.room_name, type: room.room_type },
        schedule: {
          subject_name:  r.subject_name,
          block_name:    r.block_name,
          session_start: r.use_start,
          session_end:   r.use_end,
        },
        occupancy_status:       'Occupied',
        room_request_confirmed: true,
      });
    };

    // ── STEP 3 · Check current active occupancy ───────────────────────────────
    const occRes = await query(`
      SELECT
        ro.*,
        COALESCE(
          NULLIF(trim(COALESCE(f.name, '')), ''),
          NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')
        ) AS faculty_name,
        (ro.status = 'Occupied' AND ro.scheduled_end IS NOT NULL AND ${holdEndSql('ro')} <= NOW()) AS in_tail
      FROM  room_occupancy ro
      JOIN  faculty f ON ro.faculty_id = f.id
      WHERE ro.room_id = $1
        AND ro.status IN ('Pending', 'Occupied')
      LIMIT 1
    `, [room.id]);
    let occ = occRes.rows[0] ?? null;
    /** Another faculty's check-in whose class has already ended (its 30-minute tail):
     *  it no longer holds the room — a scan granted the room ends it (giveWay), so the
     *  next class never waits; a refused scan leaves it as it is */
    let tailOcc: { id: number } | null = null;
    if (occ && Number(occ.faculty_id) !== Number(faculty_id) && occ.in_tail === true) {
      tailOcc = { id: Number(occ.id) };
      occ = null;
    }
    const giveWay = async () => {
      if (!tailOcc) return;
      await query(
        `UPDATE room_occupancy SET status = 'Expired', released_at = NOW() WHERE id = $1 AND status IN ('Pending', 'Occupied')`,
        [tailOcc.id],
      );
      tailOcc = null;
    };

    // ── 3a · Room held by a DIFFERENT instructor ──────────────────────────────
    if (occ && Number(occ.faculty_id) !== Number(faculty_id)) {
      const availRes = await query(`
        SELECT r.id, r.room_name, r.room_type, r.building
        FROM   rooms r
        WHERE  r.status = 'Active'
          AND  NOT EXISTS (
                 SELECT 1 FROM room_occupancy ro2
                 WHERE ro2.room_id = r.id AND ro2.status IN ('Pending','Occupied')
               )
        ORDER BY r.room_name LIMIT 8
      `);

      const firstTry = await insertScanLogIfUnique(
        room.id, faculty_id, null, scanDate, 'Blocked',
        `Room ${occ.status} by ${occ.faculty_name}`,
      );

      if (firstTry) {
        createNotification({
          recipientId: Number(faculty_id), recipientRole: 'instructor',
          title: 'Room Scan Blocked',
          message: `${room.room_name} is currently ${occ.status === 'Pending' ? 'reserved' : 'occupied'} by ${occ.faculty_name}. Please choose another room.`,
          type: 'qr_scan_denied', relatedModule: 'room', relatedId: room.id,
        }).catch(() => {});
      }

      return NextResponse.json({
        status:    'Blocked',
        reason:    'in_use',
        message:   `This room is currently ${occ.status === 'Pending' ? 'reserved' : 'occupied'}.`,
        scan_time: scanTime,
        room:      { id: room.id, name: room.room_name, type: room.room_type },
        occupancy: {
          faculty_name: occ.faculty_name,
          status:       occ.status,
          expires_at:   occ.status === 'Pending' ? occ.expires_at : null,
        },
        available_rooms: availRes.rows,
      });
    }

    // ── 3b · Own PENDING → confirm → IN-USE ──────────────────────────────────
    if (occ && Number(occ.faculty_id) === Number(faculty_id) && occ.status === 'Pending') {
      // The hold of a today-only room request: the scan confirms it
      const reserved = await confirmReservationByScan(Number(faculty_id), Number(room.id));
      if (reserved) return reservationConfirmed(reserved);

      // Set to Occupied with a 4-hour fallback; override below if a schedule is found.
      await query(`
        UPDATE room_occupancy
        SET    status = 'Occupied', occupied_at = NOW(),
               expires_at = NOW() + INTERVAL '4 hours'
        WHERE  id = $1
      `, [occ.id]);

      // Look up the instructor's class that is currently active today.
      // Deliberately NOT filtering by ss.room_id because walk-in scans may
      // occupy a room that wasn't assigned to the schedule.
      const schedRes = await query(`
        SELECT ss.start_time, ss.end_time, ms.id AS ms_id,
               c.subject_name, b.block_name
        FROM   schedule_sessions ss
        JOIN   master_schedule ms ON ss.master_schedule_id = ms.id
        JOIN   block_subjects  bs ON ms.block_subject_id   = bs.id
        JOIN   curriculums      c ON bs.curriculum_id       = c.id
        JOIN   blocks           b ON bs.block_id            = b.id
        WHERE  ms.faculty_id  = $1
          AND  ss.day_of_week = $2
          AND  $3::time BETWEEN (ss.start_time - INTERVAL '15 minutes')
                            AND (ss.end_time   + INTERVAL '15 minutes')
          AND  ms.status IN ('Assigned', 'Scheduled')
          AND  ($4 = '' OR b.academic_year = $4)
          AND  ($5 = '' OR b.semester      = $5)
        ORDER  BY ss.start_time ASC
        LIMIT  1
      `, [faculty_id, dayOfWeek, scanTime, termYear, termSemester]);

      let scheduleInfo: {
        ms_id: number; start_time: string; end_time: string;
        subject_name: string; block_name: string;
      } | null = null;

      if (schedRes.rows.length > 0) {
        scheduleInfo = schedRes.rows[0] as {
          ms_id: number; start_time: string; end_time: string;
          subject_name: string; block_name: string;
        };
        const endTime   = scheduleInfo.end_time;
        const startTime = scheduleInfo.start_time;
        // Override expires_at to use scheduled end time (+ 30-min buffer)
        await query(`
          UPDATE room_occupancy
          SET    expires_at      = ${manilaTodayAtSql('$1::time')} + INTERVAL '30 minutes',
                 scheduled_start = $2::time,
                 scheduled_end   = $1::time
          WHERE  room_id    = $3
            AND  faculty_id = $4
            AND  status     = 'Occupied'
        `, [endTime, startTime, room.id, faculty_id]).catch(() => {});
      }

      // Check if this confirmation closes a Pending Confirmation room request
      let roomRequestConfirmed = false;
      const rcrRes = await query(`
        UPDATE room_change_requests
        SET    status        = 'In-Use',
               updated_at   = NOW(),
               confirmed_at = NOW()
        WHERE  faculty_id              = $1
          AND  requested_room_id       = $2
          AND  status                  = 'Pending Confirmation'
          AND  confirmation_deadline   > NOW()
          AND  use_date IS NULL
        RETURNING id, master_schedule_id
      `, [faculty_id, room.id]);

      if (rcrRes.rows.length > 0) {
        roomRequestConfirmed = true;
        const rcr = rcrRes.rows[0];
        if (rcr.master_schedule_id) {
          await applyRequestedRoom({
            id: Number(rcr.id),
            master_schedule_id: Number(rcr.master_schedule_id),
            requested_room_id: Number(room.id),
          }).catch(err => console.error('[qr/scan] applying the requested room failed:', err));
        }
      }

      await insertScanLogIfUnique(
        room.id, faculty_id, scheduleInfo?.ms_id ?? null, scanDate, 'Valid',
        roomRequestConfirmed
          ? 'Room request confirmed by QR scan — schedule updated'
          : 'Occupancy confirmed by QR scan',
        scheduleInfo?.start_time ?? null,
        scheduleInfo?.end_time   ?? null,
      );

      createNotification({
        recipientId: Number(faculty_id), recipientRole: 'instructor',
        title: roomRequestConfirmed ? 'Room Request Confirmed' : 'Room Scan Successful',
        message: roomRequestConfirmed
          ? `You are now using ${room.room_name}. Your schedule has been updated.`
          : `You are now occupying ${room.room_name}.`,
        type: 'qr_scan_success', relatedModule: 'room', relatedId: room.id,
      }).catch(() => {});
      createNotification({
        recipientRole: 'admin',
        title: 'Room Scanned',
        message: `${scannerName} confirmed occupancy of ${room.room_name}${scheduleInfo ? ` for ${scheduleInfo.subject_name}` : ''}.`,
        type: 'room_occupied', relatedModule: 'room', relatedId: room.id,
      }).catch(() => {});

      return NextResponse.json({
        status:       'In-Use',
        scan_status:  'Valid',
        message:      roomRequestConfirmed
          ? `Room confirmed. Your schedule has been updated to ${room.room_name}.`
          : 'Room confirmed. You are now occupying this room.',
        scan_time:    scanTime,
        room:         { id: room.id, name: room.room_name, type: room.room_type },
        schedule:     scheduleInfo ? {
          subject_name:  scheduleInfo.subject_name,
          block_name:    scheduleInfo.block_name,
          session_start: scheduleInfo.start_time,
          session_end:   scheduleInfo.end_time,
        } : null,
        occupancy_status:       'Occupied',
        room_request_confirmed: roomRequestConfirmed,
      });
    }

    // ── 3c · Own OCCUPIED already (intentional re-scan → Already Checked In) ──
    // Backend is source of truth; client shows modal (does not create a new session).
    if (occ && Number(occ.faculty_id) === Number(faculty_id) && occ.status === 'Occupied') {
      // Already in the room when a today-only room request's time comes: the scan confirms it
      const reserved = await confirmReservationByScan(Number(faculty_id), Number(room.id));
      if (reserved) return reservationConfirmed(reserved);
      return NextResponse.json({
        status:           'In-Use',
        already_occupied: true,
        message:          'You already scanned this room. It is yours for this class.',
        scan_time:        scanTime,
        checked_in_at:    occ.occupied_at ?? occ.reserved_at ?? null,
        room:             { id: room.id, name: room.room_name, type: room.room_type },
        occupancy_status: 'Occupied',
      });
    }

    // ── STEP 4a · The faculty's own today-only room request for this room ─────
    // whose time has come → confirmed (before the scheduled-class check: a class
    // ending just before it must not make this an unauthorized scan)
    const reserved = await confirmReservationByScan(Number(faculty_id), Number(room.id));
    if (reserved) return reservationConfirmed(reserved);
    // …or reserved for a class later today: a scan now only says when to come
    // back (never a walk-in, nor an unauthorized scan of the class there now)
    const early = await upcomingReservation(Number(faculty_id), Number(room.id));
    const scanAgainLater = (e: { use_start: string; use_end: string }) => NextResponse.json({
      status:    'Pending',
      message:   `Your reservation of ${room.room_name} is for ${timeRange12(e.use_start, e.use_end)} today. Scan again from ${time12(shiftTime(e.use_start, -HOLD_BEFORE_MIN))}.`,
      scan_time: scanTime,
      room:      { id: room.id, name: room.room_name, type: room.room_type },
    });

    // ── STEP 4 · Walk-in: no current occupancy ────────────────────────────────
    //
    // Query for the instructor's scheduled class for this room. A class whose
    // faculty made the room available for today (services/roomReleases.ts) does
    // not hold it — the room is open to others during that class time — and
    // neither does one nobody checked in for in time, except for its own faculty
    // (who may still check in late).
    // Scan window:  (scheduled_start âˆ’ 15 min)  →  (scheduled_end + 30 min)
    //   The +30min tail lets us detect post-session scans and reject them,
    //   rather than silently turning them into walk-in reservations — only the
    //   class's own faculty's: for anyone else the room is free once it ends
    //   (unless still checked in, 3a), so a class right after it is matched.
    const schedNowRes = await query(`
      SELECT
        ms.id           AS ms_id,
        ms.faculty_id   AS assigned_faculty_id,
        ss.start_time,
        ss.end_time,
        c.subject_name,
        b.block_name,
        b.program_id,
        p.code          AS program_code,
        COALESCE(
          NULLIF(trim(COALESCE(f.name, '')), ''),
          NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')
        ) AS assigned_faculty_name
      FROM   schedule_sessions ss
      JOIN   master_schedule ms ON ss.master_schedule_id = ms.id
      JOIN   block_subjects  bs ON ms.block_subject_id   = bs.id
      JOIN   curriculums      c ON bs.curriculum_id       = c.id
      JOIN   blocks           b ON bs.block_id            = b.id
      JOIN   programs         p ON b.program_id           = p.id
      JOIN   faculty          f ON ms.faculty_id          = f.id
      WHERE  ss.room_id     = $1
        AND  ss.day_of_week = $2
        AND  $3::time BETWEEN (ss.start_time - INTERVAL '15 minutes')
                          AND (ss.end_time   + INTERVAL '30 minutes')
        AND  ms.status IN ('Assigned', 'Scheduled')
        AND  ($4 = '' OR b.academic_year = $4)
        AND  ($5 = '' OR b.semester      = $5)
        AND  NOT ${releasedOnSql('ss', 'ms', '$6::date')}
        AND  NOT (ms.faculty_id IS DISTINCT FROM $7::int AND ${unclaimedNowSql('ss', 'ms')})
        AND  ($3::time < ss.end_time OR ms.faculty_id = $7::int)
      ORDER  BY ($3::time < ss.end_time) DESC, ss.start_time ASC
      LIMIT  1
    `, [room.id, dayOfWeek, scanTime, termYear, termSemester, scanDate, faculty_id]);

    // ── 4b · Room has a scheduled class in the scan window ───────────────────
    if (schedNowRes.rows.length > 0) {
      const sched             = schedNowRes.rows[0];
      const assignedFacultyId = Number(sched.assigned_faculty_id);
      const scanFacultyId     = Number(faculty_id);
      const startMins         = timeToMins(String(sched.start_time));
      const endMins           = timeToMins(String(sched.end_time));
      const scanMins          = timeToMins(scanTime);

      // ── 4b-i · Unauthorized instructor ───────────────────────────────────
      if (scanFacultyId !== assignedFacultyId && !isAdmin) {
        // Reserved this room for a class later today — just early, not unauthorized
        if (early) return scanAgainLater(early);
        const firstTry = await insertScanLogIfUnique(
          room.id, faculty_id, sched.ms_id, scanDate, 'Unauthorized',
          `Unauthorized — room assigned to ${sched.assigned_faculty_name} for ${sched.subject_name}`,
          String(sched.start_time), String(sched.end_time),
        );

        if (firstTry) {
          await query(`
            INSERT INTO violations
              (violation_type, faculty_id, room_id, master_schedule_id, description)
            VALUES ('Invalid Access', $1, $2, $3, $4)
          `, [
            faculty_id, room.id, sched.ms_id,
            `Unauthorized scan: room is scheduled for ${sched.assigned_faculty_name}`,
          ]).catch(() => {});

          createNotification({
            recipientId: Number(faculty_id), recipientRole: 'instructor',
            title: 'Unauthorized Room Access',
            message: `${room.room_name} is assigned to ${sched.assigned_faculty_name} right now. You are not authorized to enter.`,
            type: 'qr_scan_unauthorized', relatedModule: 'room', relatedId: room.id,
          }).catch(() => {});
          createNotification({
            recipientRole: 'admin',
            title: 'Unauthorized QR Scan Attempt',
            message: `${scannerName} attempted to access ${room.room_name}, assigned to ${sched.assigned_faculty_name} for ${sched.subject_name}.`,
            type: 'qr_scan_unauthorized', relatedModule: 'room', relatedId: room.id,
          }).catch(() => {});
        }

        return NextResponse.json({
          status:    'Unauthorized',
          message:   `This room is assigned to ${sched.assigned_faculty_name} for "${sched.subject_name}" at this time. You are not authorized to occupy it.`,
          scan_time: scanTime,
          room:      { id: room.id, name: room.room_name, type: room.room_type },
          authorized_faculty: sched.assigned_faculty_name,
          schedule: {
            subject_name:  sched.subject_name,
            block_name:    sched.block_name,
            session_start: sched.start_time,
            session_end:   sched.end_time,
          },
        });
      }

      // ── 4b-ii · Authorized instructor (or admin) scans ───────────────────
      //
      // Attendance timing (based on scheduled times, NOT scan time):
      //   On Time (Valid) : scan â‰¤ scheduled_start + 5 min
      //   Late            : scan > scheduled_start + 5 min  AND â‰¤ scheduled_end
      //   Rejected        : scan > scheduled_end  (class already ended)
      //
      // Room occupancy always uses the scheduled end time for expires_at.

      if (scanMins > endMins) {
        // ── Post-session scan: class has already ended — reject ────────────
        const endLabel = time12(String(sched.end_time));
        const note     = `Scan rejected — class session ended at ${endLabel}`;

        const firstTry = await insertScanLogIfUnique(
          room.id, faculty_id, sched.ms_id, scanDate, 'Overuse', note,
          String(sched.start_time), String(sched.end_time),
        );
        if (firstTry) {
          await query(`
            INSERT INTO violations
              (violation_type, faculty_id, room_id, master_schedule_id, description)
            VALUES ('Room Overuse', $1, $2, $3, $4)
          `, [faculty_id, room.id, sched.ms_id, note]).catch(() => {});

          createNotification({
            recipientId: Number(faculty_id), recipientRole: 'instructor',
            title: 'Scan Window Closed',
            message: `The scan window for ${room.room_name} closed at ${endLabel}. Class session has ended.`,
            type: 'qr_scan_denied', relatedModule: 'room', relatedId: room.id,
          }).catch(() => {});
        }

        return NextResponse.json({
          status:    'Overuse',
          message:   `Class session ended at ${endLabel}. The scan window is now closed.`,
          scan_time: scanTime,
          room:      { id: room.id, name: room.room_name, type: room.room_type },
          schedule:  {
            subject_name:  sched.subject_name,
            block_name:    sched.block_name,
            session_start: sched.start_time,
            session_end:   sched.end_time,
          },
        });
      }

      // Determine attendance status
      const scanStatus = scanMins <= startMins + 5 ? 'Valid' : 'Late';
      const scanNote   = scanStatus === 'Valid'
        ? `On time — session: ${timeRange12(String(sched.start_time), String(sched.end_time))}`
        : `Late scan — class started at ${time12(String(sched.start_time))}`;

      // Create OCCUPIED — expires_at always based on scheduled end time (not scan time)
      await giveWay();
      try {
        await query(`
          INSERT INTO room_occupancy
            (room_id, faculty_id, status, reserved_at, expires_at, occupied_at,
             scheduled_start, scheduled_end)
          VALUES ($1, $2, 'Occupied', NOW(),
                  ${manilaTodayAtSql('$3::time')} + INTERVAL '30 minutes',
                  NOW(), $4::time, $3::time)
        `, [room.id, faculty_id, sched.end_time, sched.start_time]);
      } catch (insertErr) {
        // Race condition: another request claimed it first
        const rc = await query(`
          SELECT faculty_id FROM room_occupancy
          WHERE room_id = $1 AND status IN ('Pending','Occupied') LIMIT 1
        `, [room.id]);
        const rcRow = rc.rows[0];
        if (rcRow && Number(rcRow.faculty_id) !== Number(faculty_id)) {
          return NextResponse.json({
            status:    'Blocked',
            reason:    'in_use',
            message:   'Room was just reserved by another faculty member.',
            scan_time: scanTime,
            room:      { id: room.id, name: room.room_name, type: room.room_type },
          });
        }
        console.error('[qr/scan] scheduled insert race:', insertErr);
      }

      // Log utilization (scheduled times) + scan log
      await query(`
        INSERT INTO room_utilization_logs
          (room_id, faculty_id, master_schedule_id, usage_date, start_time, end_time, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [room.id, faculty_id, sched.ms_id, scanDate, sched.start_time, sched.end_time, scanStatus])
        .catch(() => {});

      await insertScanLogIfUnique(
        room.id, faculty_id, sched.ms_id, scanDate, scanStatus, scanNote,
        String(sched.start_time), String(sched.end_time),
      );

      if (scanStatus === 'Late') {
        createNotification({
          recipientId: Number(faculty_id), recipientRole: 'instructor',
          title: 'Late QR Scan',
          message: `${room.room_name} — ${sched.subject_name}. Class started at ${time12(String(sched.start_time))}; you scanned at ${time12(scanTime)}.`,
          type: 'qr_scan_success', relatedModule: 'room', relatedId: room.id,
        }).catch(() => {});
      } else {
        createNotification({
          recipientId: Number(faculty_id), recipientRole: 'instructor',
          title: 'QR Scan Successful',
          message: `${room.room_name} — ${sched.subject_name} (${sched.block_name}). Session: ${timeRange12(String(sched.start_time), String(sched.end_time))}.`,
          type: 'qr_scan_success', relatedModule: 'room', relatedId: room.id,
        }).catch(() => {});
      }
      createNotification({
        recipientRole: 'admin',
        title: scanStatus === 'Late' ? 'Late Room Scan' : 'Room Scanned',
        message: `${scannerName} scanned ${room.room_name} for ${sched.subject_name}${scanStatus === 'Late' ? ' (late)' : ''}.`,
        type: 'room_occupied', relatedModule: 'room', relatedId: room.id,
      }).catch(() => {});

      return NextResponse.json({
        status:      'In-Use',
        scan_status: scanStatus, // 'Valid' (On Time) | 'Late'
        message:     scanStatus === 'Valid'
          ? `Your class runs ${timeRange12(String(sched.start_time), String(sched.end_time))}.`
          : `Your class started at ${time12(String(sched.start_time))} and still ends at ${time12(String(sched.end_time))}.`,
        scan_time:   scanTime,
        room:        { id: room.id, name: room.room_name, type: room.room_type },
        schedule: {
          subject_name:  sched.subject_name,
          block_name:    sched.block_name,
          program_code:  sched.program_code,
          session_start: sched.start_time,
          session_end:   sched.end_time,
        },
        occupancy_status: 'Occupied',
      });
    }

    // ── 4c · Unscheduled room ──────────────────────────────────────────────
    // The faculty reserved this room for a class later today: only say when to
    // come back (a walk-in now would not be that class time)
    if (early) return scanAgainLater(early);

    // Freed class time: its faculty freed this room for today (Free My Room), or
    // nobody scanned within 15 minutes of the start — another faculty may use it,
    // laboratories included, from the freed time's own start (never earlier) until
    // it ends (never longer). Freed class times back to back count as one.
    const freedRes = await query(`
      SELECT to_char(ss.start_time, 'HH24:MI:SS') AS start_time, to_char(ss.end_time, 'HH24:MI:SS') AS end_time,
             NOT ${releasedOnSql('ss', 'ms', '$5::date')} AS unclaimed
      FROM   schedule_sessions ss
      JOIN   master_schedule ms ON ss.master_schedule_id = ms.id
      JOIN   block_subjects  bs ON ms.block_subject_id   = bs.id
      JOIN   blocks           b ON bs.block_id            = b.id
      WHERE  ss.room_id     = $1
        AND  ss.day_of_week = $2
        AND  ss.end_time    > $6::time
        AND  ms.status IN ('Assigned', 'Scheduled')
        AND  ($3 = '' OR b.academic_year = $3)
        AND  ($4 = '' OR b.semester      = $4)
        AND  ${freedOnSql('ss', 'ms', '$5::date')}
      ORDER  BY ss.start_time
    `, [room.id, dayOfWeek, termYear, termSemester, scanDate, scanTime]);
    const freedTimes = freedRes.rows as { start_time: string; end_time: string; unclaimed: boolean }[];
    const releasedUntil = freedTimeUntil(freedTimes, scanTime);
    /** Freed because nobody scanned for the class now (not freed by its faculty) */
    const unclaimed = releasedUntil != null
      && freedTimes.some(f => f.unclaimed && f.start_time <= scanTime && scanTime < f.end_time);

    // Laboratory: assigned/scheduled only — do not walk-in occupy or start a request countdown.
    if (isLaboratoryRoom(room.room_type) && !isAdmin && !releasedUntil) {
      await insertScanLogIfUnique(
        room.id, faculty_id, null, scanDate, 'Blocked',
        'Laboratory walk-in rejected — no active scheduled session',
      );
      return NextResponse.json({
        status:    'Blocked',
        reason:    'not_assigned',
        message:   'Laboratory rooms can only be occupied during a scheduled class. There is no active session in this room right now.',
        scan_time: scanTime,
        room:      { id: room.id, name: room.room_name, type: room.room_type },
      });
    }

    // How long the room is free: a freed class time until it ends; an empty room until
    // the next class that holds it today (a freed one doesn't). Never past another
    // faculty's today-only reservation (room request) of it.
    // An empty room is free until its next class — a freed one too: a freed class time is
    // free for others only from its own start, so the stretch before it ends there (opensAt)
    let freeUntil: string | null = releasedUntil;
    let opensAt: string | null = null;
    if (!freeUntil) {
      const nextRes = await query(`
        SELECT to_char(ss.start_time, 'HH24:MI:SS') AS next_start,
               ${freedOnSql('ss', 'ms', '$6::date')} AS freed
        FROM   schedule_sessions ss
        JOIN   master_schedule ms ON ss.master_schedule_id = ms.id
        JOIN   block_subjects  bs ON ms.block_subject_id   = bs.id
        JOIN   blocks           b ON bs.block_id            = b.id
        WHERE  ss.room_id     = $1
          AND  ss.day_of_week = $2
          AND  ss.start_time  > $3::time
          AND  ms.status IN ('Assigned', 'Scheduled')
          AND  ($4 = '' OR b.academic_year = $4)
          AND  ($5 = '' OR b.semester      = $5)
        ORDER  BY ss.start_time
        LIMIT  1
      `, [room.id, dayOfWeek, scanTime, termYear, termSemester, scanDate]);
      const next = nextRes.rows[0] as { next_start: string; freed: boolean } | undefined;
      freeUntil = next?.next_start ?? null;
      if (next?.freed) opensAt = next.next_start;
    }
    const reservedFrom = await nextReservationHoldFrom(Number(room.id), Number(faculty_id));
    const roomFreeUntil = earlierTime(freeUntil, reservedFrom ? manilaClock(reservedFrom).time : null);

    /** A refusal: logged once per REPEAT_REFUSAL_MINUTES; the room stays as it is */
    const refuse = async (reason: 'not_eligible' | 'wrong_room' | 'not_enough_time' | 'too_late' | 'already_in_room' | 'not_yet_free', message: string) => {
      await insertScanLogIfUnique(room.id, faculty_id, null, scanDate, 'Blocked', message);
      return NextResponse.json({
        status:    'Blocked',
        reason,
        message,
        scan_time: scanTime,
        room:      { id: room.id, name: room.room_name, type: room.room_type },
      });
    };

    // Faculty: only for their class right now that has no room — one that suits this
    // room and ends by the time it is free until. Admins / chairs may occupy it as before.
    type BorrowSession = {
      ms_id: number; part: 'lec' | 'lab'; start_time: string; end_time: string;
      subject_code: string; subject_name: string; block_name: string;
      lecture_hours: number; laboratory_hours: number; one_room: boolean;
    };
    let borrow: BorrowSession | null = null;
    if (!isAdmin) {
      const candRes = await query(`
        SELECT ms.id AS ms_id, CASE WHEN ss.type = 'lab' THEN 'lab' ELSE 'lec' END AS part,
               to_char(ss.start_time, 'HH24:MI:SS') AS start_time, to_char(ss.end_time, 'HH24:MI:SS') AS end_time,
               c.subject_code, c.subject_name, b.block_name,
               COALESCE(c.lecture_hours, 0)::float AS lecture_hours, COALESCE(c.laboratory_hours, 0)::float AS laboratory_hours,
               ${needsOneRoomSql('c')} AS one_room
        FROM   schedule_sessions ss
        JOIN   master_schedule ms ON ss.master_schedule_id = ms.id
        JOIN   block_subjects  bs ON ms.block_subject_id   = bs.id
        JOIN   curriculums      c ON bs.curriculum_id       = c.id
        JOIN   blocks           b ON bs.block_id            = b.id
        LEFT JOIN rooms        r0 ON r0.id = ss.room_id AND r0.status = 'Active'
        WHERE  ms.faculty_id  = $1
          AND  ss.day_of_week = $2
          AND  $3::time >= (ss.start_time - INTERVAL '15 minutes')
          AND  $3::time <  ss.end_time
          AND  ms.status IN ('Assigned', 'Scheduled')
          AND  ($4 = '' OR b.academic_year = $4)
          AND  ($5 = '' OR b.semester      = $5)
          AND  r0.id IS NULL
        ORDER  BY ss.start_time
      `, [faculty_id, dayOfWeek, scanTime, termYear, termSemester]);
      const candidates = candRes.rows as BorrowSession[];
      const noRoomClass = releasedUntil
        ? `${room.room_name} is free now, but only for a class of yours that has no room at this time.`
        : `You can use ${room.room_name} only for a class of yours that has no room at this time.`;
      if (candidates.length === 0) return refuse('not_eligible', noRoomClass);

      // Already holding another room whose time hasn't ended (a check-in or a reservation): not a second one
      const holding = await query(`
        SELECT r.room_name, to_char(${holdEndSql('ro')} AT TIME ZONE 'Asia/Manila', 'HH24:MI') AS until
        FROM   room_occupancy ro JOIN rooms r ON r.id = ro.room_id
        WHERE  ro.faculty_id = $1 AND ro.room_id <> $2
          AND  ro.status IN ('Pending', 'Occupied')
          AND  ${holdEndSql('ro')} > NOW()
        ORDER  BY ro.id DESC
        LIMIT  1
      `, [faculty_id, room.id]);
      const held = holding.rows[0] as { room_name: string; until: string } | undefined;
      if (held) {
        return refuse('already_in_room',
          `You already have ${held.room_name} until ${time12(held.until)}. Free that room first (Free My Room on your dashboard) before taking another.`);
      }

      /** Just before a freed class time: the room is free for others only from its start */
      const notYetFree = opensAt && roomFreeUntil === opensAt
        ? `${room.room_name} is free for others from ${time12(opensAt)}, when its freed class time starts. Please scan again then.`
        : null;
      // Never with 30 minutes or less of the room's free time left
      if (roomFreeUntil && minutesLeft(scanTime, roomFreeUntil) <= BORROW_MIN_LEFT) {
        return notYetFree ? refuse('not_yet_free', notYetFree) : refuse('too_late', tooLateMessage(room.room_name, scanTime, roomFreeUntil));
      }

      let why: { reason: 'wrong_room' | 'not_enough_time' | 'not_yet_free'; message: string } | null = null;
      for (const cnd of candidates) {
        const kindError = borrowRoomFitError(
          { part: cnd.part, subject_code: cnd.subject_code, lecture_hours: Number(cnd.lecture_hours), laboratory_hours: Number(cnd.laboratory_hours), one_room: !!cnd.one_room },
          { room_name: room.room_name, room_type: room.room_type },
        );
        if (kindError) { why ??= { reason: 'wrong_room', message: kindError }; continue; }
        if (!fitsFreeTime(cnd.end_time, roomFreeUntil)) {
          why ??= notYetFree
            ? { reason: 'not_yet_free', message: notYetFree }
            : { reason: 'not_enough_time', message: notEnoughTimeMessage(cnd.subject_code, cnd.end_time, room.room_name, roomFreeUntil ?? cnd.end_time) };
          continue;
        }
        borrow = cnd;
        break;
      }
      if (!borrow) return refuse(why?.reason ?? 'not_eligible', why?.message ?? noRoomClass);
    }

    // Occupy: a faculty until their class ends (never later — it fits the free time);
    // an admin until the room's free time ends (or 4 hours). Before another faculty's
    // reservation it always ends when that hold starts.
    const untilTime = borrow ? borrow.end_time : roomFreeUntil;
    let walkInUntil: string | null = null;
    await giveWay();
    try {
      const ins = await query(`
        INSERT INTO room_occupancy
          (room_id, faculty_id, status, reserved_at, expires_at, occupied_at, scheduled_start, scheduled_end)
        VALUES ($1, $2, 'Occupied', NOW(),
                LEAST(CASE WHEN $3::time IS NULL THEN NOW() + INTERVAL '4 hours' ELSE ${manilaTodayAtSql('$3::time')} END,
                      COALESCE($4::timestamptz, 'infinity')),
                NOW(), $5::time, $6::time)
        RETURNING to_char(expires_at AT TIME ZONE 'Asia/Manila', 'HH24:MI') AS until,
                  $4::timestamptz IS NOT NULL AND expires_at = $4::timestamptz AS before_reservation
      `, [room.id, faculty_id, untilTime, reservedFrom, borrow?.start_time ?? null, borrow?.end_time ?? null]);
      if (ins.rows[0]?.before_reservation) walkInUntil = String(ins.rows[0].until);
    } catch (insertErr) {
      const rc = await query(`
        SELECT ro.faculty_id, ro.status, ro.expires_at, ro.occupied_at,
               COALESCE(
                 NULLIF(trim(COALESCE(f.name, '')), ''),
                 NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')
               ) AS faculty_name
        FROM   room_occupancy ro
        JOIN   faculty f ON ro.faculty_id = f.id
        WHERE  ro.room_id = $1 AND ro.status IN ('Pending','Occupied')
        LIMIT  1
      `, [room.id]);
      const rcRow = rc.rows[0];
      if (rcRow && Number(rcRow.faculty_id) === Number(faculty_id) && rcRow.status === 'Occupied') {
        return NextResponse.json({
          status:           'In-Use',
          already_occupied: true,
          message:          'You already scanned this room. It is yours for this class.',
          scan_time:        scanTime,
          checked_in_at:    rcRow.occupied_at ?? null,
          room:             { id: room.id, name: room.room_name, type: room.room_type },
          occupancy_status: 'Occupied',
        });
      }
      if (rcRow && Number(rcRow.faculty_id) !== Number(faculty_id)) {
        return NextResponse.json({
          status:    'Blocked',
          reason:    'in_use',
          message:   `This room is currently occupied.`,
          scan_time: scanTime,
          room:      { id: room.id, name: room.room_name, type: room.room_type },
          occupancy: { faculty_name: rcRow.faculty_name, status: rcRow.status, expires_at: rcRow.expires_at },
          available_rooms: [],
        });
      }
      console.error('[qr/scan] unscheduled insert race:', insertErr);
    }

    await insertScanLogIfUnique(
      room.id, faculty_id, borrow?.ms_id ?? null, scanDate, 'Valid',
      borrow
        ? `For ${borrow.subject_code} (no room) — ${releasedUntil ? `a class time ${unclaimed ? 'nobody scanned for' : 'made available by its faculty'}` : 'a free room'} — until ${time12(borrow.end_time)}`
        : releasedUntil
          ? `Admin walk-in during a class time ${unclaimed ? 'nobody scanned for' : 'made available by its faculty'} — until ${time12(releasedUntil)}`
          : 'Admin walk-in — direct occupancy',
      borrow?.start_time ?? null,
      borrow?.end_time ?? null,
    );

    createNotification({
      recipientId: Number(faculty_id), recipientRole: 'instructor',
      title: 'QR Scan Successful',
      message: borrow
        ? `You are now using ${room.room_name} for ${borrow.subject_code} until ${time12(borrow.end_time)}.`
        : `You are now occupying ${room.room_name}.`,
      type: 'qr_scan_success', relatedModule: 'room', relatedId: room.id,
    }).catch(() => {});
    createNotification({
      recipientRole: 'admin',
      title: 'Room Scanned',
      message: borrow
        ? `${scannerName} is using ${room.room_name} for ${borrow.subject_code} (no room), ${timeRange12(borrow.start_time, borrow.end_time)}.`
        : `${scannerName} occupied ${room.room_name} (walk-in).`,
      type: 'room_occupied', relatedModule: 'room', relatedId: room.id,
    }).catch(() => {});

    return NextResponse.json({
      status:           'In-Use',
      scan_status:      'Valid',
      message:          borrow
        // Their class keeps its own times: the room is theirs until it ends
        ? `${room.room_name} is yours for ${borrow.subject_code} until ${time12(borrow.end_time)}.`
        : walkInUntil
          ? `This room is yours until ${time12(walkInUntil)} — a class uses it after that.`
          : roomFreeUntil
            ? `This room is yours until ${time12(roomFreeUntil)}.`
            : 'This room is yours.',
      scan_time:        scanTime,
      room:             { id: room.id, name: room.room_name, type: room.room_type },
      ...(borrow ? {
        schedule: {
          subject_name:  borrow.subject_name,
          block_name:    borrow.block_name,
          session_start: borrow.start_time,
          session_end:   borrow.end_time,
        },
      } : {}),
      occupancy_status: 'Occupied',
    });

  } catch (error) {
    console.error('[qr/scan] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
