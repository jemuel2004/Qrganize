import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { expireStaleOccupancy, expireStaleRoomRequests } from '@/server/ensureRoomOccupancy';
import { createNotification } from '@/server/notifications';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authUser = await getAuthUser(req) as { role?: string } | null;
    if (!authUser || (authUser.role !== 'admin' && authUser.role !== 'program_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await expireStaleOccupancy();
    await expireStaleRoomRequests();

    const { id } = await params;
    const rid = parseInt(id);
    const body = await req.json();
    const { status, admin_notes } = body;

    if (!['Approved', 'Rejected'].includes(status)) {
      return NextResponse.json({ error: 'Invalid status.' }, { status: 400 });
    }

    const reqRes = await query(`
      SELECT id, master_schedule_id, original_room_id, requested_room_id,
             faculty_id, status AS current_status
      FROM   room_change_requests
      WHERE  id = $1
    `, [rid]);

    if (reqRes.rows.length === 0) {
      return NextResponse.json({ error: 'Request not found.' }, { status: 404 });
    }

    const rcr = reqRes.rows[0];

    if (!['Pending', 'Pending Confirmation'].includes(rcr.current_status)) {
      return NextResponse.json(
        { error: 'This request is no longer pending and cannot be updated.' },
        { status: 409 },
      );
    }

    const nextStatus = status === 'Approved' ? 'In-Use' : 'Rejected';

    let roomChangeApplied = false;

    if (status === 'Approved' && rcr.master_schedule_id && rcr.requested_room_id) {
      await query(`
        UPDATE schedule_sessions
        SET    room_id = $1
        WHERE  master_schedule_id = $2
      `, [rcr.requested_room_id, rcr.master_schedule_id]);

      await query(`
        UPDATE master_schedule
        SET    room_id = $1
        WHERE  id = $2
      `, [rcr.requested_room_id, rcr.master_schedule_id]);

      roomChangeApplied = true;
    }

    if (rcr.requested_room_id) {
      if (status === 'Rejected') {
        await query(`
          UPDATE room_occupancy
          SET    status = 'Released', released_at = NOW()
          WHERE  room_id    = $1
            AND  faculty_id = $2
            AND  status     = 'Pending'
        `, [rcr.requested_room_id, rcr.faculty_id]).catch(() => {});
      } else {
        const occUpd = await query(`
          UPDATE room_occupancy
          SET    status      = 'Occupied',
                 occupied_at = COALESCE(occupied_at, NOW()),
                 expires_at  = NOW() + INTERVAL '4 hours',
                 released_at = NULL
          WHERE  room_id    = $1
            AND  faculty_id = $2
            AND  status     = 'Pending'
          RETURNING id
        `, [rcr.requested_room_id, rcr.faculty_id]);

        if (occUpd.rows.length === 0) {
          try {
            await query(`
              INSERT INTO room_occupancy
                (room_id, faculty_id, status, reserved_at, expires_at, occupied_at)
              VALUES ($1, $2, 'Occupied', NOW(), NOW() + INTERVAL '4 hours', NOW())
            `, [rcr.requested_room_id, rcr.faculty_id]);
          } catch {
            return NextResponse.json(
              { error: 'The requested room is currently occupied by another instructor.' },
              { status: 409 },
            );
          }
        }

        if (rcr.master_schedule_id) {
          const sessRes = await query(`
            SELECT ss.start_time, ss.end_time
            FROM   schedule_sessions ss
            WHERE  ss.master_schedule_id = $1
              AND  ss.end_time IS NOT NULL
            ORDER BY ss.end_time DESC
            LIMIT 1
          `, [rcr.master_schedule_id]);
          if (sessRes.rows.length > 0) {
            await query(`
              UPDATE room_occupancy
              SET    expires_at      = GREATEST(
                       expires_at,
                       CURRENT_DATE + $1::time + INTERVAL '30 minutes'
                     ),
                     scheduled_start = $2::time,
                     scheduled_end   = $1::time
              WHERE  room_id    = $3
                AND  faculty_id = $4
                AND  status     = 'Occupied'
                AND  CURRENT_DATE + $1::time + INTERVAL '30 minutes' > NOW()
            `, [
              sessRes.rows[0].end_time,
              sessRes.rows[0].start_time,
              rcr.requested_room_id,
              rcr.faculty_id,
            ]).catch(() => {});
          }
        }
      }
    }

    await query(`
      UPDATE room_change_requests
      SET    status      = $1::text,
             admin_notes = $2,
             updated_at  = NOW(),
             approved_at = CASE WHEN $3::text = 'Approved' THEN NOW() ELSE approved_at END,
             rejected_at = CASE WHEN $3::text = 'Rejected' THEN NOW() ELSE rejected_at END,
             confirmed_at = CASE WHEN $3::text = 'Approved' THEN NOW() ELSE confirmed_at END,
             confirmation_deadline = CASE
               WHEN $3::text = 'Approved' THEN NOW()
               ELSE confirmation_deadline
             END
      WHERE  id = $4
    `, [nextStatus, admin_notes || null, status, rid]);

    createNotification({
      recipientId: Number(rcr.faculty_id), recipientRole: 'instructor',
      title: status === 'Approved' ? 'Room Request Approved' : 'Room Request Rejected',
      message: status === 'Approved'
        ? roomChangeApplied
          ? 'Your room request was approved. The room is now occupied and your schedule has been updated. No QR scan is required.'
          : 'Your room request was approved. The room is now occupied. No QR scan is required.'
        : `Your room change request was rejected.${admin_notes ? ` Reason: ${admin_notes}` : ''}`,
      type: status === 'Approved' ? 'room_request_approved' : 'room_request_rejected',
      relatedModule: 'room_request', relatedId: rid,
    }).catch(() => {});

    return NextResponse.json({
      success:             true,
      room_change_applied: roomChangeApplied,
      occupancy_applied:   status === 'Approved',
      message:             status === 'Approved'
        ? 'Request approved. The room is now occupied. QR scan is not required.'
        : 'Request rejected.',
    });
  } catch (error) {
    console.error('[PATCH /api/admin/room-requests]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
