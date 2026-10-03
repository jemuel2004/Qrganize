import { NextRequest, NextResponse } from 'next/server';
import { manilaCalendarDateString, manilaClock, manilaTodayAtSql } from '@/services/appTimezone';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import {
  applyRequestedRoom,
  ensureRoomOccupancy,
  expireStaleOccupancy,
  ensureRoomRequestsSchema,
  ensureQrScanLogsSchema,
} from '@/services/ensureRoomOccupancy';
import { createNotification } from '@/services/notifications';
import { withAudit } from '@/services/audit';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';

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

  Walk-in (lecture room, no class assigned, room available):
    Faculty or admin → OCCUPIED immediately (QR is the presence check)

  Room Request (separate flow):
    Submit request → occupancy Pending + 15-min countdown → QR scan confirms
    OR admin accepts → OCCUPIED immediately (no QR required)

  Laboratory rooms:
    Follow scheduled-session rules only. No walk-in occupancy, no room-request hold.
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
 * Insert a scan log only when no successful entry already exists for this
 * faculty + room within the last 10 seconds (dedup guard for concurrent requests).
 * Blocked / Unauthorized / Overuse logs are always inserted — they are audit records.
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
): Promise<void> {
  const isAuditOnly = status === 'Blocked' || status === 'Unauthorized' || status === 'Overuse';
  if (isAuditOnly) {
    await query(
      `INSERT INTO qr_scan_logs
         (room_id, faculty_id, master_schedule_id, scan_time, scan_date,
          status, notes, scheduled_start, scheduled_end)
       VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8)`,
      [roomId, facultyId, scheduleId, scanDate, status, notes,
       scheduledStart ?? null, scheduledEnd ?? null],
    ).catch(() => {});
    return;
  }
  // Idempotent insert for successful scans — prevents duplicate rows when
  // concurrent requests race through before the unique occupancy index fires.
  await query(
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
     )`,
    [roomId, facultyId, scheduleId, scanDate, status, notes,
     scheduledStart ?? null, scheduledEnd ?? null],
  ).catch(() => {});
}

async function POST_handler(req: NextRequest) {
  try {
    await ensureRoomOccupancy();
    await ensureRoomRequestsSchema();
    await ensureQrScanLogsSchema();

    // ── Input validation ────────────────────────────────────────────────────
    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

    const rawQr        = body.qr_code_id;
    const rawFacultyId = body.faculty_id;

    if (typeof rawQr !== 'string' || !rawQr.trim() || rawQr.length > 512) {
      return NextResponse.json({ error: 'Invalid QR code' }, { status: 400 });
    }
    const qr_code_id = rawQr.trim();

    const faculty_id = Number(rawFacultyId);
    if (!Number.isInteger(faculty_id) || faculty_id <= 0) {
      return NextResponse.json({ error: 'Invalid faculty ID' }, { status: 400 });
    }

    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: unknown } | null;
    if (!authUser) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    const isAdmin  = authUser.role === 'admin' || authUser.role === 'department_chair' || authUser.role === 'program_chair';

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

    // Instructors may only scan on behalf of their own faculty_id (prevent impersonation).
    if (authUser.role === 'instructor') {
      const jwtFacultyId = Number(authUser.faculty_id);
      if (!jwtFacultyId || jwtFacultyId !== faculty_id) {
        return NextResponse.json({ error: 'Forbidden: faculty ID mismatch' }, { status: 403 });
      }
    }

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
    await expireStaleOccupancy(room.id);

    // ── STEP 3 · Check current active occupancy ───────────────────────────────
    const occRes = await query(`
      SELECT
        ro.*,
        COALESCE(
          NULLIF(trim(COALESCE(f.name, '')), ''),
          NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')
        ) AS faculty_name
      FROM  room_occupancy ro
      JOIN  faculty f ON ro.faculty_id = f.id
      WHERE ro.room_id = $1
        AND ro.status IN ('Pending', 'Occupied')
      LIMIT 1
    `, [room.id]);
    const occ = occRes.rows[0] ?? null;

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

      await insertScanLogIfUnique(
        room.id, faculty_id, null, scanDate, 'Blocked',
        `Room ${occ.status} by ${occ.faculty_name}`,
      );

      createNotification({
        recipientId: Number(faculty_id), recipientRole: 'instructor',
        title: 'Room Scan Blocked',
        message: `${room.room_name} is currently ${occ.status === 'Pending' ? 'reserved' : 'occupied'} by ${occ.faculty_name}. Please choose another room.`,
        type: 'qr_scan_denied', relatedModule: 'room', relatedId: room.id,
      }).catch(() => {});

      return NextResponse.json({
        status:    'Blocked',
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
        title: 'Room Occupied via QR',
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
      return NextResponse.json({
        status:           'In-Use',
        already_occupied: true,
        message:          'You are already occupying this room. This room has already been successfully scanned.',
        scan_time:        scanTime,
        checked_in_at:    occ.occupied_at ?? occ.reserved_at ?? null,
        room:             { id: room.id, name: room.room_name, type: room.room_type },
        occupancy_status: 'Occupied',
      });
    }

    // ── STEP 4 · Walk-in: no current occupancy ────────────────────────────────
    //
    // Query for the instructor's scheduled class for this room.
    // Scan window:  (scheduled_start âˆ’ 15 min)  →  (scheduled_end + 30 min)
    //   The +30min tail lets us detect post-session scans and reject them,
    //   rather than silently turning them into walk-in reservations.
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
      ORDER  BY ss.start_time ASC
      LIMIT  1
    `, [room.id, dayOfWeek, scanTime, termYear, termSemester]);

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
        await insertScanLogIfUnique(
          room.id, faculty_id, sched.ms_id, scanDate, 'Unauthorized',
          `Unauthorized — room assigned to ${sched.assigned_faculty_name} for ${sched.subject_name}`,
          String(sched.start_time), String(sched.end_time),
        );

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
        const endLabel = String(sched.end_time).slice(0, 5);
        const note     = `Scan rejected — class session ended at ${endLabel}`;

        await insertScanLogIfUnique(
          room.id, faculty_id, sched.ms_id, scanDate, 'Overuse', note,
          String(sched.start_time), String(sched.end_time),
        );
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
        ? `On time — session: ${String(sched.start_time).slice(0, 5)}–${String(sched.end_time).slice(0, 5)}`
        : `Late check-in — class started at ${String(sched.start_time).slice(0, 5)}`;

      // Create OCCUPIED — expires_at always based on scheduled end time (not scan time)
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
          title: 'Late QR Check-In',
          message: `${room.room_name} — ${sched.subject_name}. Class started at ${String(sched.start_time).slice(0,5)}; you scanned at ${scanTime.slice(0,5)}.`,
          type: 'qr_scan_success', relatedModule: 'room', relatedId: room.id,
        }).catch(() => {});
      } else {
        createNotification({
          recipientId: Number(faculty_id), recipientRole: 'instructor',
          title: 'QR Scan Successful',
          message: `${room.room_name} — ${sched.subject_name} (${sched.block_name}). Session: ${String(sched.start_time).slice(0,5)}–${String(sched.end_time).slice(0,5)}.`,
          type: 'qr_scan_success', relatedModule: 'room', relatedId: room.id,
        }).catch(() => {});
      }
      createNotification({
        recipientRole: 'admin',
        title: scanStatus === 'Late' ? 'Late Room Check-In' : 'Room Occupied via QR',
        message: `${scannerName} checked in to ${room.room_name} for ${sched.subject_name} (${scanStatus}).`,
        type: 'room_occupied', relatedModule: 'room', relatedId: room.id,
      }).catch(() => {});

      return NextResponse.json({
        status:      'In-Use',
        scan_status: scanStatus, // 'Valid' (On Time) | 'Late'
        message:     scanStatus === 'Valid'
          ? `Access granted. Session runs ${String(sched.start_time).slice(0,5)}–${String(sched.end_time).slice(0,5)}.`
          : `Late check-in. Class started at ${String(sched.start_time).slice(0,5)}.`,
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
    // Laboratory: assigned/scheduled only — do not walk-in occupy or start a request countdown.
    if (isLaboratoryRoom(room.room_type) && !isAdmin) {
      await insertScanLogIfUnique(
        room.id, faculty_id, null, scanDate, 'Blocked',
        'Laboratory walk-in rejected — no active scheduled session',
      );
      return NextResponse.json({
        status:    'Blocked',
        message:   'Laboratory rooms can only be occupied during a scheduled class. There is no active session in this room right now.',
        scan_time: scanTime,
        room:      { id: room.id, name: room.room_name, type: room.room_type },
      });
    }

    // Lecture walk-in (or admin override): QR scan is physical presence — occupy immediately.
    // Do NOT create a room request or a 15-minute countdown.
    try {
      await query(`
        INSERT INTO room_occupancy
          (room_id, faculty_id, status, reserved_at, expires_at, occupied_at)
        VALUES ($1, $2, 'Occupied', NOW(), NOW() + INTERVAL '4 hours', NOW())
      `, [room.id, faculty_id]);
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
          message:          'You are already occupying this room. This room has already been successfully scanned.',
          scan_time:        scanTime,
          checked_in_at:    rcRow.occupied_at ?? null,
          room:             { id: room.id, name: room.room_name, type: room.room_type },
          occupancy_status: 'Occupied',
        });
      }
      if (rcRow && Number(rcRow.faculty_id) !== Number(faculty_id)) {
        return NextResponse.json({
          status:    'Blocked',
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
      room.id, faculty_id, null, scanDate, 'Valid',
      isAdmin ? 'Admin walk-in — direct occupancy' : 'Walk-in lecture room — occupied on first QR scan',
    );

    createNotification({
      recipientId: Number(faculty_id), recipientRole: 'instructor',
      title: 'Room Occupied Successfully',
      message: `You are now occupying ${room.room_name}.`,
      type: 'qr_scan_success', relatedModule: 'room', relatedId: room.id,
    }).catch(() => {});
    createNotification({
      recipientRole: 'admin',
      title: 'Room Occupied via QR',
      message: `${scannerName} occupied ${room.room_name} (walk-in).`,
      type: 'room_occupied', relatedModule: 'room', relatedId: room.id,
    }).catch(() => {});

    return NextResponse.json({
      status:           'In-Use',
      scan_status:      'Valid',
      message:          'Room occupied successfully.',
      scan_time:        scanTime,
      room:             { id: room.id, name: room.room_name, type: room.room_type },
      occupancy_status: 'Occupied',
    });

  } catch (error) {
    console.error('[qr/scan] error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
