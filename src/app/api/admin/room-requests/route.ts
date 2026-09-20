import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { expireStaleOccupancy, expireStaleRoomRequests } from '@/server/ensureRoomOccupancy';

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string } | null;
    if (!authUser || (authUser.role !== 'admin' && authUser.role !== 'department_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await expireStaleOccupancy();
    await expireStaleRoomRequests();

    const result = await query(`
      SELECT
        rcr.id,
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
        CONCAT_WS(' ', f.first_name, f.last_name) AS faculty_name,
        orig.room_name  AS original_room_name,
        req.room_name   AS requested_room_name,
        c.subject_code,
        c.subject_name,
        b.block_name,
        b.year_level,
        p.code          AS program_code,
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
      FROM room_change_requests rcr
      JOIN faculty f ON rcr.faculty_id = f.id
      LEFT JOIN rooms orig ON rcr.original_room_id  = orig.id
      LEFT JOIN rooms req  ON rcr.requested_room_id = req.id
      LEFT JOIN master_schedule ms ON rcr.master_schedule_id = ms.id
      LEFT JOIN block_subjects  bs ON ms.block_subject_id = bs.id
      LEFT JOIN curriculums     c  ON bs.curriculum_id = c.id
      LEFT JOIN blocks          b  ON bs.block_id = b.id
      LEFT JOIN programs        p  ON b.program_id = p.id
      ORDER BY
        CASE rcr.status
          WHEN 'Pending Confirmation' THEN 0
          WHEN 'In-Use'               THEN 1
          WHEN 'Pending'              THEN 2
          WHEN 'Approved'             THEN 3
          WHEN 'Rejected'             THEN 4
          WHEN 'Expired'              THEN 5
          ELSE 6
        END,
        rcr.created_at DESC
    `);

    return NextResponse.json({ requests: result.rows });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
