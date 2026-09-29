import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { expireStaleOccupancy, expireStaleRoomRequests } from '@/services/ensureRoomOccupancy';
import { createNotification } from '@/services/notifications';
import { withAudit } from '@/services/audit';

/* ─── GET /api/instructor/room-requests ─────────────────────────────────────
   Returns the faculty's full request history with subject, sessions, and
   room details. Expires stale Pending Confirmation records before responding.
─────────────────────────────────────────────────────────────────────────── */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await expireStaleOccupancy();
    await expireStaleRoomRequests();

    if (req.nextUrl.searchParams.get('count') === '1') {
      const countResult = await query(
        `SELECT COUNT(*)::int AS n
         FROM room_change_requests
         WHERE faculty_id = $1
           AND status IN ('Pending', 'Pending Confirmation')`,
        [authUser.faculty_id],
      );
      return NextResponse.json({ pendingCount: countResult.rows[0]?.n ?? 0 });
    }

    const result = await query(`
      SELECT
        rcr.id,
        rcr.master_schedule_id,
        rcr.reason,
        rcr.status,
        rcr.admin_notes,
        rcr.auto_notes,
        rcr.confirmation_deadline,
        rcr.approved_at,
        rcr.rejected_at,
        rcr.expired_at,
        rcr.confirmed_at,
        rcr.created_at,
        rcr.updated_at,
        orig.room_name    AS original_room_name,
        orig.room_type    AS original_room_type,
        req.room_name     AS requested_room_name,
        req.room_type     AS requested_room_type,
        c.subject_code,
        c.subject_name,
        c.lecture_hours,
        c.laboratory_hours,
        b.block_name,
        b.year_level,
        p.code            AS program_code,
        (
          SELECT json_agg(json_build_object(
            'day',        ss.day_of_week,
            'start_time', ss.start_time::text,
            'end_time',   ss.end_time::text
          ) ORDER BY ss.day_of_week, ss.start_time)
          FROM schedule_sessions ss
          WHERE ss.master_schedule_id = rcr.master_schedule_id
            AND ss.day_of_week IS NOT NULL
            AND ss.start_time  IS NOT NULL
            AND ss.end_time    IS NOT NULL
        ) AS sessions
      FROM  room_change_requests rcr
      LEFT JOIN rooms         orig ON rcr.original_room_id  = orig.id
      LEFT JOIN rooms         req  ON rcr.requested_room_id = req.id
      LEFT JOIN master_schedule ms ON rcr.master_schedule_id = ms.id
      LEFT JOIN block_subjects  bs ON ms.block_subject_id = bs.id
      LEFT JOIN curriculums      c ON bs.curriculum_id    = c.id
      LEFT JOIN blocks           b ON bs.block_id         = b.id
      LEFT JOIN programs         p ON b.program_id        = p.id
      WHERE rcr.faculty_id = $1
      ORDER BY rcr.created_at DESC
    `, [authUser.faculty_id]);

    return NextResponse.json({ requests: result.rows });
  } catch (error) {
    console.error('[GET /api/instructor/room-requests]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/* ─── POST /api/instructor/room-requests ────────────────────────────────────
   Creates an auto-resolved room change request.

   NEW FLOW — no manual admin approval:
   • All conflicts detected          → 409 error (no record created)
   • No conflict found               → status = 'Pending Confirmation'
                                       confirmation_deadline = NOW() + 15 min
                                       room_occupancy Pending created (locks the room)
   • Faculty scans QR within 15m → status → 'In-Use', room applied to schedule
   • No scan after 15 minutes       → status → 'Expired', occupancy auto-expires

   VALIDATION CHAIN (server-side, never trust frontend):
   1.  Auth             — must be faculty with faculty_id
   2.  Required fields  — master_schedule_id, requested_room_id, reason (≥10 chars)
   3+4. Schedule        — must belong to faculty + have ≥1 valid session
   5.  Room             — must exist and be Active
   6.  Not same room    — requested ≠ current assigned room (unless last request for that room already ended)
   7.  No duplicate     — no existing Pending/Pending Confirmation/In-Use for same schedule
   8.  No session clash — requested room has no other class at same day/time
   9.  No pending clash — no other faculty's Pending Confirmation for same room/time
  10.  No live occupancy— room has no active room_occupancy (Pending or Occupied)
  11.  Insert           — status = 'Pending Confirmation', deadline = NOW() + 15 min
  12.  Lock room        — create room_occupancy Pending for the 15-min window
─────────────────────────────────────────────────────────────────────────── */
async function POST_handler(req: NextRequest) {
  try {
    /* 1. Auth ─────────────────────────────────────────────────────────────── */
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const facultyId = authUser.faculty_id;

    /* Expire stale records before validating ─────────────────────────────── */
    await expireStaleOccupancy();
    await expireStaleRoomRequests();

    /* 2. Required fields ─────────────────────────────────────────────────── */
    const body = await req.json();
    const { master_schedule_id, requested_room_id, reason } = body;

    if (!master_schedule_id) {
      return NextResponse.json(
        { error: 'A teaching schedule must be selected. Room requests must be linked to an official schedule.' },
        { status: 400 },
      );
    }
    if (!requested_room_id) {
      return NextResponse.json(
        { error: 'A preferred room must be selected.' },
        { status: 400 },
      );
    }
    if (!reason?.trim() || reason.trim().length < 10) {
      return NextResponse.json(
        { error: 'Reason must be at least 10 characters.' },
        { status: 400 },
      );
    }

    /* 3 + 4. Schedule ownership + valid sessions ─────────────────────────── */
    const schedRes = await query(`
      SELECT
        ms.id,
        ms.faculty_id,
        ms.room_id                             AS current_room_id,
        r.room_name                            AS current_room_name,
        c.subject_code,
        c.subject_name,
        COALESCE(c.laboratory_hours, 0)        AS laboratory_hours,
        b.block_name,
        COUNT(ss.id) FILTER (
          WHERE ss.day_of_week IS NOT NULL
            AND ss.start_time  IS NOT NULL
            AND ss.end_time    IS NOT NULL
        ) AS valid_session_count
      FROM  master_schedule  ms
      JOIN  block_subjects   bs ON ms.block_subject_id = bs.id
      JOIN  curriculums       c ON bs.curriculum_id    = c.id
      JOIN  blocks            b ON bs.block_id         = b.id
      LEFT JOIN rooms         r ON ms.room_id = r.id
      LEFT JOIN schedule_sessions ss ON ss.master_schedule_id = ms.id
      WHERE ms.id = $1
        AND ms.status IN ('Assigned', 'Scheduled')
        AND (
          ms.faculty_id = $2
          OR EXISTS (
            SELECT 1 FROM instructor_loads il
            WHERE il.master_schedule_id = ms.id
              AND il.faculty_id = $2
          )
        )
      GROUP BY ms.id, ms.faculty_id, ms.room_id, r.room_name,
               c.subject_code, c.subject_name, c.laboratory_hours, b.block_name
    `, [master_schedule_id, facultyId]);

    if (schedRes.rows.length === 0) {
      return NextResponse.json(
        { error: 'Schedule not found or you are not assigned to it. Only your officially assigned schedules are accepted.' },
        { status: 403 },
      );
    }

    const sched = schedRes.rows[0];

    if (Number(sched.valid_session_count) === 0) {
      return NextResponse.json(
        { error: `Schedule "${sched.subject_code}" has no valid time slots assigned yet. Contact your administrator.` },
        { status: 400 },
      );
    }

    /* 5. Requested room must exist and be Active ──────────────────────────── */
    const roomRes = await query(
      `SELECT id, room_name, room_type FROM rooms WHERE id = $1 AND status = 'Active'`,
      [requested_room_id],
    );
    if (roomRes.rows.length === 0) {
      return NextResponse.json(
        { error: 'Selected room does not exist or is not active.' },
        { status: 400 },
      );
    }
    const requestedRoom = roomRes.rows[0];

    /* 5b. Lecture-only subjects may only use lecture rooms */
    const isLabRoom = ['laboratory', 'computer lab'].includes(String(requestedRoom.room_type ?? '').trim().toLowerCase());
    if (isLabRoom && !(Number(sched.laboratory_hours) > 0)) {
      return NextResponse.json(
        { error: `${sched.subject_code} is a lecture subject, so it can only use a lecture room. Please choose a lecture room.` },
        { status: 400 },
      );
    }

    /* 6. Not the same as currently assigned room — unless a prior request
          for this room already ended (Released / Expired / Rejected).
          Admin approval writes the requested room onto the schedule; after
          release that assignment can linger until we restore original_room_id. */
    if (sched.current_room_id && Number(requested_room_id) === Number(sched.current_room_id)) {
      const lastForRoom = await query(`
        SELECT status FROM room_change_requests
        WHERE  master_schedule_id = $1
          AND  faculty_id         = $2
          AND  requested_room_id  = $3
        ORDER BY created_at DESC
        LIMIT 1
      `, [master_schedule_id, facultyId, requested_room_id]);
      const lastStatus = lastForRoom.rows[0]?.status as string | undefined;
      const priorEnded = lastStatus != null && ['Released', 'Expired', 'Rejected'].includes(lastStatus);
      if (!priorEnded) {
        return NextResponse.json(
          { error: `${requestedRoom.room_name} is already your assigned room for ${sched.subject_code}. No change needed.` },
          { status: 400 },
        );
      }
    }

    /* 7. Duplicate: no active request for the same schedule */
    const dupRes = await query(`
      SELECT id FROM room_change_requests
      WHERE  master_schedule_id = $1
        AND  faculty_id         = $2
        AND  status IN ('Pending', 'Pending Confirmation', 'In-Use')
    `, [master_schedule_id, facultyId]);

    if (dupRes.rows.length > 0) {
      return NextResponse.json(
        { error: `You already have an active room request for ${sched.subject_code}. Cancel or release it before submitting a new one.` },
        { status: 409 },
      );
    }

    /* 8. Session conflict: requested room must have no scheduled class at same time */
    const sessionConflictRes = await query(`
      SELECT ss2.id
      FROM   schedule_sessions ss2
      JOIN   master_schedule   ms2 ON ss2.master_schedule_id = ms2.id
      WHERE  ss2.room_id = $1
        AND  ms2.status IN ('Assigned', 'Scheduled')
        AND  ms2.id != $2
        AND  EXISTS (
               SELECT 1
               FROM   schedule_sessions ss_mine
               WHERE  ss_mine.master_schedule_id = $2
                 AND  ss_mine.day_of_week IS NOT NULL
                 AND  ss_mine.start_time  IS NOT NULL
                 AND  ss_mine.end_time    IS NOT NULL
                 AND  ss_mine.day_of_week = ss2.day_of_week
                 AND  ss_mine.start_time  < ss2.end_time
                 AND  ss_mine.end_time    > ss2.start_time
             )
      LIMIT  1
    `, [requested_room_id, master_schedule_id]);

    if (sessionConflictRes.rows.length > 0) {
      return NextResponse.json(
        { error: `${requestedRoom.room_name} already has a scheduled class during your ${sched.subject_code} sessions. Please choose a different room.` },
        { status: 409 },
      );
    }

    /* 9. Pending Confirmation clash: no other instructor has already requested same room/time */
    const pendConflictRes = await query(`
      SELECT rcr.id
      FROM   room_change_requests rcr
      JOIN   schedule_sessions    ss_rcr ON ss_rcr.master_schedule_id = rcr.master_schedule_id
      WHERE  rcr.requested_room_id = $1
        AND  rcr.status            = 'Pending Confirmation'
        AND  rcr.faculty_id       != $2
        AND  ss_rcr.day_of_week   IS NOT NULL
        AND  EXISTS (
               SELECT 1
               FROM   schedule_sessions ss_mine
               WHERE  ss_mine.master_schedule_id = $3
                 AND  ss_mine.day_of_week IS NOT NULL
                 AND  ss_mine.start_time  IS NOT NULL
                 AND  ss_mine.end_time    IS NOT NULL
                 AND  ss_mine.day_of_week = ss_rcr.day_of_week
                 AND  ss_mine.start_time  < ss_rcr.end_time
                 AND  ss_mine.end_time    > ss_rcr.start_time
             )
      LIMIT  1
    `, [requested_room_id, facultyId, master_schedule_id]);

    if (pendConflictRes.rows.length > 0) {
      return NextResponse.json(
        { error: `Another faculty has already submitted a pending request for ${requestedRoom.room_name} during the same time slot. Please choose a different room or try again later.` },
        { status: 409 },
      );
    }

    /* 10. Live occupancy check: room must not be currently Pending or Occupied ─ */
    const liveOccRes = await query(`
      SELECT id, status FROM room_occupancy
      WHERE  room_id = $1
        AND  status IN ('Pending', 'Occupied')
      LIMIT 1
    `, [requested_room_id]);

    if (liveOccRes.rows.length > 0) {
      const occStatus = liveOccRes.rows[0].status;
      return NextResponse.json(
        { error: `${requestedRoom.room_name} is currently ${occStatus === 'Occupied' ? 'occupied' : 'reserved'} by another faculty member. Please choose a different room or try again later.` },
        { status: 409 },
      );
    }

    /* 11. Insert room request — status = 'Pending Confirmation' ──────────── */
    const insertRes = await query(`
      INSERT INTO room_change_requests
        (faculty_id, master_schedule_id, original_room_id, requested_room_id,
         reason, status, confirmation_deadline, submitted_by)
      VALUES ($1, $2, $3, $4, $5, 'Pending Confirmation', NOW() + INTERVAL '15 minutes', 'instructor')
      RETURNING id, confirmation_deadline
    `, [
      facultyId,
      master_schedule_id,
      sched.current_room_id ?? null,
      requested_room_id,
      reason.trim(),
    ]);

    const newRequest = insertRes.rows[0];

    /* 12. Lock the room — create room_occupancy Pending for the 15-min window */
    try {
      await query(`
        INSERT INTO room_occupancy (room_id, faculty_id, status, expires_at)
        VALUES ($1, $2, 'Pending', NOW() + INTERVAL '15 minutes')
      `, [requested_room_id, facultyId]);
    } catch {
      // Race condition: room was just grabbed — roll back the request
      await query(
        `DELETE FROM room_change_requests WHERE id = $1`,
        [newRequest.id]
      ).catch(() => {});
      return NextResponse.json(
        { error: `${requestedRoom.room_name} was just reserved by another faculty member. Please choose a different room.` },
        { status: 409 },
      );
    }

    // Notify instructor
    createNotification({
      recipientId: facultyId, recipientRole: 'instructor',
      title: 'Room Request Submitted',
      message: `Your request for ${requestedRoom.room_name} (${sched.subject_code}) is pending. Scan the QR code within 15 minutes to confirm.`,
      type: 'room_request_submitted', relatedModule: 'room_request', relatedId: newRequest.id,
    }).catch(() => {});
    // Admin side: the live "Room Request Pending" alert (syncWorkloadMonitoringNotifications) covers it

    return NextResponse.json(
      {
        id:                   newRequest.id,
        confirmation_deadline: newRequest.confirmation_deadline,
        message:              `Room request for ${sched.subject_code} submitted. Scan the QR code at ${requestedRoom.room_name} within 15 minutes to confirm your reservation.`,
      },
      { status: 201 },
    );

  } catch (error) {
    console.error('[POST /api/instructor/room-requests]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
