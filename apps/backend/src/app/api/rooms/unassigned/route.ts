import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';

/**
 * GET /api/rooms/unassigned
 * Classes this term that already have a day and time but no room, grouped by
 * faculty. Each session also lists the active rooms of the matching type
 * (lab session → laboratory rooms, otherwise lecture rooms) that are free in
 * that slot — so the admin can tell whether a room can still be found.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { semester, schoolYear } = await getActiveAcademicPeriod();
    const term = [semester ?? '', schoolYear ?? ''];

    const [sessRes, roomsRes, busyRes] = await Promise.all([
      query(`
        SELECT ss.id, ss.day_of_week AS day, ss.start_time::text AS start_time, ss.end_time::text AS end_time,
               COALESCE(ss.type, 'lec') AS type,
               ms.id AS ms_id, ms.faculty_id,
               COALESCE(NULLIF(TRIM(f.name), ''), NULLIF(TRIM(CONCAT_WS(' ', f.first_name, f.last_name)), ''), 'Unassigned faculty') AS faculty_name,
               f.employee_id, c.subject_code, c.subject_name,
               p.code AS program_code, b.year_level, b.block_name
        FROM schedule_sessions ss
        JOIN master_schedule ms ON ms.id = ss.master_schedule_id
        JOIN block_subjects bs ON bs.id = ms.block_subject_id
        JOIN curriculums c ON c.id = bs.curriculum_id
        JOIN blocks b ON b.id = bs.block_id
        LEFT JOIN programs p ON p.id = b.program_id
        LEFT JOIN faculty f ON f.id = ms.faculty_id
        WHERE ss.room_id IS NULL
          AND ss.day_of_week IS NOT NULL AND ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
          AND ms.status IN ('Assigned', 'Scheduled', 'Completed')
          AND ($1 = '' OR b.semester = $1) AND ($2 = '' OR b.academic_year = $2)
        ORDER BY faculty_name,
                 array_position(ARRAY['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], ss.day_of_week),
                 ss.start_time
      `, term),
      query(`SELECT id, room_name, room_type FROM rooms WHERE status = 'Active' ORDER BY room_name`),
      // Every room booking this term (to find free rooms per slot)
      query(`
        SELECT ss.room_id, ss.day_of_week AS day, ss.start_time::text AS start_time, ss.end_time::text AS end_time
        FROM schedule_sessions ss
        JOIN master_schedule ms ON ms.id = ss.master_schedule_id
        JOIN block_subjects bs ON bs.id = ms.block_subject_id
        JOIN blocks b ON b.id = bs.block_id
        WHERE ss.room_id IS NOT NULL AND ss.day_of_week IS NOT NULL
          AND ms.status IN ('Assigned', 'Scheduled', 'Completed')
          AND ($1 = '' OR b.semester = $1) AND ($2 = '' OR b.academic_year = $2)
      `, term),
    ]);

    const isLab = (t: string) => t === 'Laboratory' || t === 'Computer Lab';
    const rooms = roomsRes.rows as { id: number; room_name: string; room_type: string }[];
    const busy = busyRes.rows as { room_id: number; day: string; start_time: string; end_time: string }[];

    type Row = {
      id: number; day: string; start_time: string; end_time: string; type: string; ms_id: number;
      faculty_id: number | null; faculty_name: string; employee_id: string | null;
      subject_code: string; subject_name: string; program_code: string | null; year_level: string | null; block_name: string | null;
    };
    const groups = new Map<string, {
      faculty_id: number | null; faculty_name: string; employee_id: string | null;
      sessions: (Omit<Row, 'faculty_id' | 'faculty_name' | 'employee_id'> & { free_rooms: string[] })[];
    }>();
    for (const r of sessRes.rows as Row[]) {
      const wantLab = r.type === 'lab';
      const free = rooms
        .filter(room => isLab(room.room_type) === wantLab)
        .filter(room => !busy.some(b => b.room_id === room.id && b.day === r.day && b.start_time < r.end_time && b.end_time > r.start_time))
        .map(room => room.room_name);
      const key = String(r.faculty_id ?? 'none');
      if (!groups.has(key)) groups.set(key, { faculty_id: r.faculty_id, faculty_name: r.faculty_name, employee_id: r.employee_id, sessions: [] });
      const { faculty_id: _f, faculty_name: _n, employee_id: _e, ...session } = r;
      void _f; void _n; void _e;
      groups.get(key)!.sessions.push({ ...session, free_rooms: free });
    }

    const faculty = [...groups.values()];
    return NextResponse.json({
      faculty,
      total_sessions: faculty.reduce((n, f) => n + f.sessions.length, 0),
      no_room_available: faculty.reduce((n, f) => n + f.sessions.filter(s => s.free_rooms.length === 0).length, 0),
    });
  } catch (error) {
    console.error('[GET /api/rooms/unassigned]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
