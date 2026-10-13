import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { query } from '@/database/db';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { classTimes, type ClassPart } from '@shared/roomRequestWindow';

const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * GET /api/instructor/my-classes?day=Friday — the signed-in faculty's own class
 * times on one weekday (active term), each with its Lecture / Laboratory parts,
 * for Find Available Rooms: one tap on a class searches at exactly its time.
 * A Lecture followed by its Laboratory is one class time — the same class
 * times a room request is made for (@shared/roomRequestWindow).
 * Classes without a room are included — that is when a room is looked for.
 * Read-only.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!auth || auth.role !== 'instructor' || !auth.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const day = req.nextUrl.searchParams.get('day') ?? '';
    if (!WEEK.includes(day)) return NextResponse.json({ error: 'Choose a valid day.' }, { status: 400 });

    const period = await getActiveAcademicPeriod();
    const res = await query(`
      SELECT ms.id AS ms_id, c.subject_code, c.subject_name, b.year_level, b.block_name, p.code AS program_code,
             to_char(ss.start_time, 'HH24:MI') AS start_time, to_char(ss.end_time, 'HH24:MI') AS end_time,
             COALESCE(ss.type, 'lec') AS part,
             r.room_name
      FROM   schedule_sessions ss
      JOIN   master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN   block_subjects  bs ON bs.id = ms.block_subject_id
      JOIN   curriculums      c ON c.id  = bs.curriculum_id
      JOIN   blocks           b ON b.id  = bs.block_id
      LEFT JOIN programs      p ON p.id  = b.program_id
      LEFT JOIN rooms         r ON r.id  = ss.room_id
      WHERE  ms.faculty_id = $1
        AND  ms.status IN ('Assigned', 'Scheduled')
        AND  ss.day_of_week = $2
        AND  ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
        AND  ($3 = '' OR b.academic_year = $3)
        AND  ($4 = '' OR b.semester      = $4)
      ORDER  BY ss.start_time, c.subject_code
    `, [auth.faculty_id, day, period.schoolYear ?? '', period.semester ?? '']);

    type Row = {
      ms_id: number; subject_code: string; subject_name: string; year_level: string | null; block_name: string | null;
      program_code: string | null; start_time: string; end_time: string; room_name: string | null; part: string;
    };
    const byClass = new Map<number, (Row & { start: string; end: string; part: ClassPart })[]>();
    for (const r of res.rows as Row[]) {
      const list = byClass.get(r.ms_id) ?? [];
      list.push({ ...r, start: r.start_time, end: r.end_time, part: r.part === 'lab' ? 'lab' : 'lec' });
      byClass.set(r.ms_id, list);
    }
    const classes = [...byClass.values()]
      .flatMap(rows => classTimes(rows).map(t => {
        const c = t.sessions[0];
        const year = String(c.year_level ?? '').match(/\d+/)?.[0] ?? '';
        const rooms = [...new Set(t.sessions.map(x => x.room_name).filter((n): n is string => !!n))];
        return {
          ms_id: c.ms_id,
          subject_code: c.subject_code,
          subject_name: c.subject_name,
          block: [c.program_code, `${year}${c.block_name ?? ''}`].filter(Boolean).join(' '),
          start_time: t.start,
          end_time: t.end,
          room_name: rooms.length > 0 ? rooms.join(' / ') : null,
          /** The parts of the subject that meet then (Lecture first) */
          parts: t.parts,
        };
      }))
      .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.subject_code.localeCompare(b.subject_code));
    return NextResponse.json({ day, classes });
  } catch (error) {
    console.error('[GET /api/instructor/my-classes]', error);
    return NextResponse.json({ error: 'Could not load your classes.' }, { status: 500 });
  }
}
