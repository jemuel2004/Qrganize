import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { ensureRoomOccupancy, expireStaleOccupancy, completeRoomRelease } from '@/server/ensureRoomOccupancy';

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/rooms/occupancy
   Returns all active (Pending / Occupied) records and the list of free rooms.
   Admin / department chair only. Instructors cannot list occupancy records.
───────────────────────────────────────────────────────────────────────────── */
export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string } | null;
    if (!authUser || (authUser.role !== 'admin' && authUser.role !== 'department_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureRoomOccupancy();
    await expireStaleOccupancy();

    const occupancies = await query(`
      SELECT
        ro.id,
        ro.room_id,
        ro.faculty_id,
        ro.status,
        ro.reserved_at,
        ro.expires_at,
        ro.occupied_at,
        r.room_name,
        r.room_type,
        r.building,
        COALESCE(
          NULLIF(trim(COALESCE(f.name, '')), ''),
          NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')
        ) AS faculty_name
      FROM  room_occupancy ro
      JOIN  rooms   r ON ro.room_id   = r.id
      JOIN  faculty f ON ro.faculty_id = f.id
      WHERE ro.status IN ('Pending', 'Occupied')
      ORDER BY ro.reserved_at DESC
    `);

    const available = await query(`
      SELECT r.id, r.room_name, r.room_type, r.building, r.capacity
      FROM   rooms r
      WHERE  r.status = 'Active'
        AND  NOT EXISTS (
               SELECT 1 FROM room_occupancy ro
               WHERE  ro.room_id = r.id
                 AND  ro.status  IN ('Pending', 'Occupied')
             )
      ORDER BY r.room_name
    `);

    return NextResponse.json({
      occupancies:     occupancies.rows,
      available_rooms: available.rows,
    });
  } catch (error) {
    console.error('[rooms/occupancy GET]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/rooms/occupancy
   Body: { room_id: number, faculty_id: number }

   Security rules:
     • Caller must be authenticated.
     • Instructor role: faculty_id in body MUST match session faculty_id
       (prevents an instructor from reserving on behalf of another person).
     • Admin role: may pass any faculty_id (management override).
───────────────────────────────────────────────────────────────────────────── */
export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureRoomOccupancy();

    const body        = await req.json();
    const room_id     = Number(body.room_id);
    const faculty_id  = Number(body.faculty_id);

    if (!room_id || !faculty_id) {
      return NextResponse.json({ error: 'room_id and faculty_id are required' }, { status: 400 });
    }

    // Instructors can only reserve for themselves — block impersonation
    if (authUser.role === 'instructor') {
      if (!authUser.faculty_id || faculty_id !== authUser.faculty_id) {
        return NextResponse.json(
          { error: 'Forbidden: instructors may only reserve rooms for themselves.' },
          { status: 403 },
        );
      }
    } else if (authUser.role !== 'admin' && authUser.role !== 'department_chair') {
      // Only instructor, admin, and department_chair roles may create reservations
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Auto-expire this room's stale records first
    await expireStaleOccupancy(room_id);

    // Check if the room is already active
    const roomOcc = await query(`
      SELECT ro.status,
             CONCAT_WS(' ', f.first_name, f.last_name) AS faculty_name,
             ro.expires_at
      FROM   room_occupancy ro
      JOIN   faculty f ON ro.faculty_id = f.id
      WHERE  ro.room_id = $1
        AND  ro.status IN ('Pending', 'Occupied')
      LIMIT 1
    `, [room_id]);

    if (roomOcc.rows.length > 0) {
      const o = roomOcc.rows[0];
      return NextResponse.json({
        error:            `Room is currently ${o.status} by ${o.faculty_name}.`,
        conflict_status:  o.status,
        faculty_name:     o.faculty_name,
        expires_at:       o.expires_at,
      }, { status: 409 });
    }

    // Check if this faculty already holds an active reservation elsewhere
    await expireStaleOccupancy();
    const facOcc = await query(`
      SELECT ro.status, r.room_name
      FROM   room_occupancy ro
      JOIN   rooms r ON ro.room_id = r.id
      WHERE  ro.faculty_id = $1
        AND  ro.status IN ('Pending', 'Occupied')
      LIMIT 1
    `, [faculty_id]);

    if (facOcc.rows.length > 0) {
      const fo = facOcc.rows[0];
      return NextResponse.json({
        error: `You already have a ${fo.status} reservation for ${fo.room_name}. Release it before reserving another room.`,
      }, { status: 409 });
    }

    // Create Pending reservation — 15-minute window
    const result = await query(`
      INSERT INTO room_occupancy (room_id, faculty_id, status, expires_at)
      VALUES ($1, $2, 'Pending', NOW() + INTERVAL '15 minutes')
      RETURNING *
    `, [room_id, faculty_id]);

    return NextResponse.json({ occupancy: result.rows[0] }, { status: 201 });

  } catch (error) {
    const msg = String(error);
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return NextResponse.json({ error: 'Room was just reserved by another instructor.' }, { status: 409 });
    }
    console.error('[rooms/occupancy POST]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   DELETE /api/rooms/occupancy
   Body: { room_id: number, faculty_id?: number }

   Security rules:
     • Instructor: releases only their own occupancy (faculty_id comes from
       the session, not the request body).
     • Admin / department chair: may pass faculty_id to release any occupancy.
───────────────────────────────────────────────────────────────────────────── */
export async function DELETE(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureRoomOccupancy();

    const body       = await req.json();
    const room_id    = Number(body.room_id);
    const bodyFacultyId = Number(body.faculty_id);

    if (!room_id) {
      return NextResponse.json({ error: 'room_id is required' }, { status: 400 });
    }

    let faculty_id: number;
    if (authUser.role === 'instructor') {
      if (!authUser.faculty_id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      faculty_id = Number(authUser.faculty_id);
    } else if (authUser.role === 'admin' || authUser.role === 'department_chair') {
      if (!bodyFacultyId) {
        return NextResponse.json({ error: 'room_id and faculty_id are required' }, { status: 400 });
      }
      faculty_id = bodyFacultyId;
    } else {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await expireStaleOccupancy(room_id);

    const ended = await completeRoomRelease(room_id, faculty_id);
    if (!ended) {
      return NextResponse.json(
        { error: 'No active occupancy found for this room.' },
        { status: 409 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[rooms/occupancy DELETE]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
