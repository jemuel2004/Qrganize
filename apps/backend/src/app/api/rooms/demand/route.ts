import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { computeClassroomDemand, isLabRoomType, type DemandSessionInput } from '@shared/classroomDemand';

/**
 * GET /api/rooms/demand[?semester=…&academic_year=…]
 *
 * Classroom Construction Recommendation — regular classrooms the class
 * schedule needs (peak simultaneous classes, see @shared/classroomDemand) vs.
 * usable lecture rooms. Schedule-based only, never QR scans. Defaults to the
 * active term.
 *
 * `history` lists the peak demand of every other term that still has saved
 * schedules — demand only, since room inventory is not kept per term.
 */

const SEMESTER_ORDER = ['1st Semester', '2nd Semester', 'Summer'];
const termOrder = (t: { academic_year: string; semester: string }) =>
  `${t.academic_year}|${String(SEMESTER_ORDER.indexOf(t.semester) + 1 || 9)}`;

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const active = await getActiveAcademicPeriod();
    const semester = searchParams.get('semester')?.trim() || active.semester || '';
    const academicYear = searchParams.get('academic_year')?.trim() || active.schoolYear || '';

    const [sessRes, roomsRes] = await Promise.all([
      // Every class meeting with a day and time, with or without a room, all
      // terms (one query feeds both the selected term and history). Same
      // active-status rule as Scheduling.
      query(`
        SELECT ss.id, ms.id AS ms_id, ss.day_of_week AS day,
               ss.start_time::text AS start_time, ss.end_time::text AS end_time,
               COALESCE(ss.type, 'lec') AS type, ss.room_id, r.room_name, r.room_type,
               (r.status = 'Active') AS room_usable,
               c.subject_code, c.subject_name,
               CONCAT_WS(' ', p.code, CONCAT(SUBSTRING(COALESCE(b.year_level, '') FROM '[0-9]+'), b.block_name)) AS block,
               COALESCE(NULLIF(TRIM(f.name), ''), NULLIF(TRIM(CONCAT_WS(' ', f.first_name, f.last_name)), '')) AS faculty_name,
               COALESCE(b.academic_year, '') AS academic_year, COALESCE(b.semester, '') AS semester
        FROM schedule_sessions ss
        JOIN master_schedule ms ON ms.id = ss.master_schedule_id
        JOIN block_subjects bs ON bs.id = ms.block_subject_id
        JOIN curriculums c ON c.id = bs.curriculum_id
        JOIN blocks b ON b.id = bs.block_id
        LEFT JOIN programs p ON p.id = b.program_id
        LEFT JOIN rooms r ON r.id = ss.room_id
        LEFT JOIN faculty f ON f.id = ms.faculty_id
        WHERE ss.day_of_week IS NOT NULL AND ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL
          AND ms.status IN ('Assigned', 'Scheduled', 'Completed')
      `),
      // Usable rooms per Room Management: status Active
      query(`SELECT id, room_type FROM rooms WHERE status = 'Active'`),
    ]);

    const usableClassrooms = roomsRes.rows.filter(r => !isLabRoomType(r.room_type)).length;

    const byTerm = new Map<string, { academic_year: string; semester: string; sessions: DemandSessionInput[] }>();
    for (const r of sessRes.rows) {
      const key = `${r.academic_year}|${r.semester}`;
      if (!byTerm.has(key)) byTerm.set(key, { academic_year: r.academic_year, semester: r.semester, sessions: [] });
      byTerm.get(key)!.sessions.push({
        id: Number(r.id), ms_id: Number(r.ms_id), day: r.day, start_time: r.start_time, end_time: r.end_time,
        type: r.type, room_id: r.room_id == null ? null : Number(r.room_id), room_name: r.room_name ?? null,
        room_type: r.room_type ?? null, room_usable: r.room_id == null ? null : r.room_usable === true,
        subject_code: r.subject_code ?? null, subject_name: r.subject_name ?? null,
        block: (r.block as string | null)?.trim() || null, faculty_name: r.faculty_name ?? null,
      });
    }

    const selectedKey = `${academicYear}|${semester}`;
    const demand = computeClassroomDemand(byTerm.get(selectedKey)?.sessions ?? [], usableClassrooms);

    const history = [...byTerm.entries()]
      .filter(([key, t]) => key !== selectedKey && t.academic_year && t.semester)
      .map(([, t]) => ({ academic_year: t.academic_year, semester: t.semester, peak: computeClassroomDemand(t.sessions, usableClassrooms).required }))
      .filter(t => t.peak > 0)
      .sort((a, b) => termOrder(a).localeCompare(termOrder(b)));

    return NextResponse.json({
      term: { semester: semester || null, school_year: academicYear || null },
      demand,
      history,
    });
  } catch (error) {
    console.error('[GET /api/rooms/demand]', error);
    return NextResponse.json({ error: 'Failed to load classroom demand.' }, { status: 500 });
  }
}
