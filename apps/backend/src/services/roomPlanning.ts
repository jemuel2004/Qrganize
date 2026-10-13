import { query } from '@/database/db';
import { needsOneRoomSql } from '@shared/subjectCategory';
import {
  computeRoomPlanning,
  type PlanningPendingInput, type PlanningRoomInput, type PlanningSessionInput, type RoomPlanning,
} from '@shared/roomPlanning';

/**
 * Room Planning for one term — reads the term's class schedule, the rooms and
 * the class parts not scheduled yet, then works it out with @shared/roomPlanning
 * (pure, tested). Used by Room Utilization → Room Planning (GET /api/rooms/demand)
 * and Analytics, so both always show the same numbers.
 *
 * Same live-class rule as Scheduling and Analytics: offerings Assigned /
 * Scheduled / Completed, meetings with a day and time. Room usability is Room
 * Management's Active status.
 */

const LIVE = `ms.status IN ('Assigned', 'Scheduled', 'Completed')`;
const IN_TERM = `($1 = '' OR b.semester = $1) AND ($2 = '' OR b.academic_year = $2)`;
const HAS_TIME = `ss.day_of_week IS NOT NULL AND ss.start_time IS NOT NULL AND ss.end_time IS NOT NULL`;

export async function loadRoomPlanning(term: { semester: string; academicYear: string }): Promise<RoomPlanning> {
  const params = [term.semester, term.academicYear];
  const [sessRes, roomsRes, pendingRes] = await Promise.all([
    query(`
      SELECT ss.id, ms.id AS ms_id, ss.day_of_week AS day,
             ss.start_time::text AS start_time, ss.end_time::text AS end_time,
             COALESCE(ss.type, 'lec') AS part, ss.room_id,
             c.subject_code, c.subject_name,
             CONCAT_WS(' ', p.code, CONCAT(SUBSTRING(COALESCE(b.year_level, '') FROM '[0-9]+'), b.block_name)) AS block,
             ms.faculty_id,
             COALESCE(NULLIF(TRIM(f.name), ''), NULLIF(TRIM(CONCAT_WS(' ', f.first_name, f.last_name)), '')) AS faculty_name,
             (COALESCE(c.laboratory_hours, 0) > 0) AS has_lab,
             ${needsOneRoomSql('c')} AS one_room
      FROM schedule_sessions ss
      JOIN master_schedule ms ON ms.id = ss.master_schedule_id
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN curriculums c ON c.id = bs.curriculum_id
      JOIN blocks b ON b.id = bs.block_id
      LEFT JOIN programs p ON p.id = b.program_id
      LEFT JOIN faculty f ON f.id = ms.faculty_id
      WHERE ${LIVE} AND ${IN_TERM} AND ${HAS_TIME}
    `, params),
    query(`SELECT id, room_name, room_type, (status = 'Active') AS active FROM rooms`),
    // Each Lecture / Laboratory part of the term's classes with no counted meeting yet,
    // with its weekly hours from the curriculum
    query(`
      SELECT ms.id AS ms_id, part.part, part.hours, c.subject_code,
             (COALESCE(c.laboratory_hours, 0) > 0) AS has_lab,
             ${needsOneRoomSql('c')} AS one_room,
             (ms.faculty_id IS NOT NULL AND ms.status <> 'Unassigned') AS has_faculty
      FROM master_schedule ms
      JOIN block_subjects bs ON bs.id = ms.block_subject_id
      JOIN curriculums c ON c.id = bs.curriculum_id
      JOIN blocks b ON b.id = bs.block_id
      CROSS JOIN LATERAL (VALUES
        ('lec', COALESCE(c.lecture_hours, 0)::float),
        ('lab', COALESCE(c.laboratory_hours, 0)::float)
      ) AS part(part, hours)
      WHERE ${IN_TERM} AND part.hours > 0
        AND NOT (${LIVE} AND EXISTS (
          SELECT 1 FROM schedule_sessions ss
           WHERE ss.master_schedule_id = ms.id AND COALESCE(ss.type, 'lec') = part.part AND ${HAS_TIME}
        ))
    `, params),
  ]);

  const num = (v: unknown) => (v == null ? null : Number(v));
  const sessions: PlanningSessionInput[] = sessRes.rows.map(r => ({
    id: Number(r.id),
    ms_id: Number(r.ms_id),
    day: String(r.day),
    start_time: String(r.start_time),
    end_time: String(r.end_time),
    part: String(r.part),
    room_id: num(r.room_id),
    subject_code: r.subject_code ?? null,
    subject_name: r.subject_name ?? null,
    block: (r.block as string | null)?.trim() || null,
    faculty_id: num(r.faculty_id),
    faculty_name: r.faculty_name ?? null,
    has_lab: r.has_lab === true,
    one_room: r.one_room === true,
  }));
  const rooms: PlanningRoomInput[] = roomsRes.rows.map(r => ({
    id: Number(r.id),
    room_name: String(r.room_name ?? ''),
    room_type: r.room_type ?? null,
    active: r.active === true,
  }));
  const pending: PlanningPendingInput[] = pendingRes.rows.map(r => ({
    ms_id: Number(r.ms_id),
    part: r.part === 'lab' ? 'lab' : 'lec',
    minutes: Math.round(Number(r.hours) * 60),
    subject_code: r.subject_code ?? null,
    has_lab: r.has_lab === true,
    one_room: r.one_room === true,
    has_faculty: r.has_faculty === true,
  }));

  return computeRoomPlanning({ sessions, rooms, pending });
}

const SEMESTER_ORDER = ['1st Semester', '2nd Semester', 'Summer'];

/** Terms with classes (offerings), newest first — the Term filter's choices */
export async function loadPlanningTerms(): Promise<{ semester: string; academic_year: string }[]> {
  const res = await query(`
    SELECT DISTINCT b.semester, b.academic_year
    FROM master_schedule ms
    JOIN block_subjects bs ON bs.id = ms.block_subject_id
    JOIN blocks b ON b.id = bs.block_id
    WHERE COALESCE(b.semester, '') <> '' AND COALESCE(b.academic_year, '') <> ''
  `);
  const order = (s: string) => (SEMESTER_ORDER.indexOf(s) + 1) || 9;
  return res.rows
    .map(r => ({ semester: String(r.semester), academic_year: String(r.academic_year) }))
    .sort((a, b) => b.academic_year.localeCompare(a.academic_year) || order(b.semester) - order(a.semester));
}
