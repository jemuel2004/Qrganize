import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { qrCodeFromScan } from '@/services/roomQr';
import { manilaClock } from '@/services/appTimezone';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { ensureRoomOccupancy, expireStaleOccupancy } from '@/services/ensureRoomOccupancy';
import { isQrCode } from '@shared/qrLink';

/**
 * GET /api/rooms/by-qr?code=<qr_code_id> — the room a QR belongs to, for the
 * room page a phone's camera opens (/room/<code>) and for Room Monitoring.
 * Any signed-in role. Read-only: it shows the room, its status right now and
 * today's classes in it; checking in still goes through POST /api/qr/scan.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string; faculty_id?: unknown } | null;
    if (!auth?.role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const raw = req.nextUrl.searchParams.get('code') ?? '';
    const code = qrCodeFromScan(raw.slice(0, 512));
    if (!isQrCode(code)) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

    const roomRes = await query(
      `SELECT id, room_name, room_type, building, capacity, qr_code_id FROM rooms WHERE qr_code_id = $1 AND status = 'Active'`,
      [code],
    );
    const room = roomRes.rows[0] as {
      id: number; room_name: string; room_type: string; building: string | null; capacity: number | null; qr_code_id: string;
    } | undefined;
    if (!room) return NextResponse.json({ error: 'Room not found' }, { status: 404 });

    // Status now — the same occupancy records Room Monitoring and the scan use
    await ensureRoomOccupancy();
    await expireStaleOccupancy(room.id);
    const occRes = await query(`
      SELECT ro.status, ro.occupied_at, ro.reserved_at, ro.expires_at, ro.faculty_id,
             COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                      NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')) AS faculty_name
      FROM   room_occupancy ro
      JOIN   faculty f ON f.id = ro.faculty_id
      WHERE  ro.room_id = $1 AND ro.status IN ('Pending', 'Occupied')
      ORDER  BY (ro.status = 'Occupied') DESC, ro.reserved_at DESC
      LIMIT  1
    `, [room.id]);
    const occ = occRes.rows[0] as {
      status: 'Pending' | 'Occupied'; occupied_at: string | null; reserved_at: string | null; expires_at: string | null;
      faculty_id: number; faculty_name: string | null;
    } | undefined;

    // Today's classes in this room (active term), by start time
    const { time, dayOfWeek } = manilaClock();
    const period = await getActiveAcademicPeriod();
    const classesRes = await query(`
      SELECT ms.id AS ms_id, ms.faculty_id, c.subject_code, c.subject_name, b.year_level, b.block_name, p.code AS program_code,
             ss.start_time::text AS start_time, ss.end_time::text AS end_time,
             COALESCE(NULLIF(trim(COALESCE(f.name, '')), ''),
                      NULLIF(trim(COALESCE(f.first_name,'') || ' ' || COALESCE(f.last_name,'')), '')) AS faculty_name
      FROM   schedule_sessions ss
      JOIN   master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN   block_subjects bs ON ms.block_subject_id = bs.id
      JOIN   curriculums     c  ON bs.curriculum_id    = c.id
      JOIN   blocks          b  ON bs.block_id         = b.id
      LEFT JOIN programs     p  ON b.program_id        = p.id
      LEFT JOIN faculty      f  ON ms.faculty_id       = f.id
      WHERE  COALESCE(ss.room_id, ms.room_id) = $1
        AND  ss.day_of_week = $2
        AND  ms.status IN ('Assigned', 'Scheduled')
        AND  ($3 = '' OR b.academic_year = $3)
        AND  ($4 = '' OR b.semester      = $4)
      ORDER  BY ss.start_time
    `, [room.id, dayOfWeek, period.schoolYear ?? '', period.semester ?? '']);

    const facultyId = auth.role === 'instructor' ? Number(auth.faculty_id) || null : null;
    const seen = new Set<string>();
    const today = (classesRes.rows as {
      ms_id: number; faculty_id: number | null; subject_code: string; subject_name: string; year_level: string | null;
      block_name: string | null; program_code: string | null; start_time: string; end_time: string; faculty_name: string | null;
    }[])
      .filter(c => { const k = `${c.ms_id}|${c.start_time}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(c => {
        const year = String(c.year_level ?? '').match(/\d+/)?.[0] ?? '';
        return {
          ms_id: c.ms_id,
          subject_code: c.subject_code,
          subject_name: c.subject_name,
          block: [c.program_code, `${year}${c.block_name ?? ''}`].filter(Boolean).join(' '),
          faculty_name: c.faculty_name,
          start_time: c.start_time.slice(0, 5),
          end_time: c.end_time.slice(0, 5),
          is_mine: facultyId != null && Number(c.faculty_id) === facultyId,
        };
      });

    return NextResponse.json({
      room,
      status: occ
        ? {
            state: occ.status,
            faculty_name: occ.faculty_name,
            is_mine: facultyId != null && Number(occ.faculty_id) === facultyId,
            since: occ.status === 'Occupied' ? occ.occupied_at : occ.reserved_at,
            until: occ.expires_at,
          }
        : { state: 'Available' as const },
      today,
      now: time.slice(0, 5),
      day: dayOfWeek,
      viewer: { role: auth.role, faculty_id: facultyId },
    });
  } catch (error) {
    console.error('[GET /api/rooms/by-qr]', error);
    return NextResponse.json({ error: 'Could not load this room. Please try again.' }, { status: 500 });
  }
}
