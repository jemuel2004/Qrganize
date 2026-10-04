import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { computeRegularLoadStatus, regularLoadLimit as termRegularLoadLimit } from '@shared/regularLoad';
import { getWorkloadPolicy } from '@/services/workloadPolicy';
import { canAccessProgram } from '@/services/programScope';
import { ensurePraiseSplitColumn } from '@/services/praiseSplit';
import { ensureSessionTypes } from '@/services/sessionTypeRepair';
import { needsOneRoomSql } from '@shared/subjectCategory';

/* Module-level flags — DDL and one-time data migrations run once per cold start,
 * not on every request. Avoids unnecessary write overhead on every GET. */
let schemaReady   = false;

async function ensureSchema() {
  if (schemaReady) return;
  await query(`ALTER TABLE instructor_loads ADD COLUMN IF NOT EXISTS overload_component VARCHAR(10) DEFAULT 'full'`);
  await query(`ALTER TABLE schedule_sessions ADD COLUMN IF NOT EXISTS type VARCHAR(3) DEFAULT 'lec'`);
  await query(`
    CREATE TABLE IF NOT EXISTS instructor_load_deductions (
      id            SERIAL PRIMARY KEY,
      faculty_id    INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
      deduction_type TEXT NOT NULL,
      description   TEXT DEFAULT '',
      deducted_units NUMERIC(4,2) NOT NULL DEFAULT 0,
      semester      TEXT NOT NULL,
      school_year   TEXT NOT NULL,
      created_at    TIMESTAMP DEFAULT NOW(),
      updated_at    TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await query(`ALTER TABLE faculty ALTER COLUMN designation_type TYPE TEXT`).catch(() => {});
  await ensurePraiseSplitColumn();
  schemaReady = true;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ facultyId: string }> }) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { facultyId } = await params;
    const { searchParams } = new URL(req.url);
    const academicYear = searchParams.get('academic_year');
    const semester = searchParams.get('semester');

    await ensureSchema();
    await ensureSessionTypes();

    const facultyResult = await query('SELECT * FROM faculty WHERE id=$1', [facultyId]);
    if (facultyResult.rows.length === 0) return NextResponse.json({ error: 'Faculty not found' }, { status: 404 });
    const faculty = facultyResult.rows[0];
    if (!(await canAccessProgram(auth, faculty.program_id))) {
      return NextResponse.json({ error: 'Faculty not found' }, { status: 404 });
    }

    // Compute regularLoadLimit from the normalized deductions table (semester-specific)
    const deductionResult = await query(
      `SELECT COALESCE(SUM(deducted_units), 0) AS total_deduction
       FROM instructor_load_deductions
       WHERE faculty_id = $1
         AND ($2 = '' OR semester    = $2)
         AND ($3 = '' OR school_year = $3)`,
      [facultyId, semester || '', academicYear || ''],
    );
    const totalDeduction  = parseFloat(deductionResult.rows[0].total_deduction) || 0;
    const regularLoadLimit = termRegularLoadLimit(faculty.employment_status === 'Permanent', totalDeduction, await getWorkloadPolicy());

    let loadsQuery = `
      SELECT DISTINCT ON (il.id)
        il.id, il.faculty_id, il.master_schedule_id, il.load_category,
        il.units, il.hours, il.academic_year, il.semester, il.created_at,
        COALESCE(il.overload_component, 'full') AS overload_component,
        ms.id as ms_id, ms.day_pattern, ms.start_time, ms.end_time, ms.status as schedule_status,
        c.subject_code, c.subject_name,
        c.units as curriculum_units, c.total_hours as curriculum_total_hours,
        c.lecture_hours, c.laboratory_hours,
        c.subject_category,
        -- Major subject with Lecture + Laboratory: both parts use one room (Scheduling enforces it)
        ${needsOneRoomSql('c')} AS one_room,
        b.id as block_id, b.block_name, b.year_level, b.semester as block_semester, b.academic_year as block_academic_year,
        b.number_of_students,
        p.code as program_code,
        COALESCE(
          r.room_name,
          (SELECT r2.room_name FROM schedule_sessions ss2
           JOIN rooms r2 ON ss2.room_id = r2.id
           WHERE ss2.master_schedule_id = ms.id AND ss2.room_id IS NOT NULL
           ORDER BY ss2.id LIMIT 1)
        ) AS room_name,
        (SELECT r2.room_name FROM schedule_sessions ss2
         JOIN rooms r2 ON ss2.room_id = r2.id
         WHERE ss2.master_schedule_id = ms.id AND ss2.room_id IS NOT NULL
           AND ss2.type = 'lec'
         ORDER BY ss2.id LIMIT 1) AS lec_room_name,
        (SELECT r2.room_name FROM schedule_sessions ss2
         JOIN rooms r2 ON ss2.room_id = r2.id
         WHERE ss2.master_schedule_id = ms.id AND ss2.room_id IS NOT NULL
           AND ss2.type = 'lab'
         ORDER BY ss2.id LIMIT 1) AS lab_room_name,
        (SELECT COALESCE(SUM(o2.units), 0) FROM overloads o2
         WHERE o2.faculty_id = il.faculty_id AND o2.master_schedule_id = il.master_schedule_id) AS split_overload_units,
        (SELECT COALESCE(SUM(o2.hours), 0) FROM overloads o2
         WHERE o2.faculty_id = il.faculty_id AND o2.master_schedule_id = il.master_schedule_id) AS split_overload_hours,
        -- Split portion is Praise Load (only the Lec or Lab), not Overload
        EXISTS(SELECT 1 FROM overloads o3
               WHERE o3.faculty_id = il.faculty_id AND o3.master_schedule_id = il.master_schedule_id
                 AND o3.is_praise = true) AS split_is_praise,
        EXISTS(SELECT 1 FROM schedule_sessions ss_l WHERE ss_l.master_schedule_id = ms.id AND ss_l.type = 'lec') AS lec_scheduled,
        EXISTS(SELECT 1 FROM schedule_sessions ss_b WHERE ss_b.master_schedule_id = ms.id AND ss_b.type = 'lab') AS lab_scheduled,
        (SELECT ss_lt.start_time FROM schedule_sessions ss_lt
         WHERE ss_lt.master_schedule_id = ms.id AND ss_lt.type = 'lec'
         ORDER BY ss_lt.id LIMIT 1) AS lec_start_time,
        (SELECT ss_lt.end_time FROM schedule_sessions ss_lt
         WHERE ss_lt.master_schedule_id = ms.id AND ss_lt.type = 'lec'
         ORDER BY ss_lt.id LIMIT 1) AS lec_end_time,
        (SELECT ss_lb.start_time FROM schedule_sessions ss_lb
         WHERE ss_lb.master_schedule_id = ms.id AND ss_lb.type = 'lab'
         ORDER BY ss_lb.id LIMIT 1) AS lab_start_time,
        (SELECT ss_lb.end_time FROM schedule_sessions ss_lb
         WHERE ss_lb.master_schedule_id = ms.id AND ss_lb.type = 'lab'
         ORDER BY ss_lb.id LIMIT 1) AS lab_end_time,
        (SELECT string_agg(d.day_of_week, '/' ORDER BY
            CASE d.day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2
              WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4
              WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 WHEN 'Sunday' THEN 7 ELSE 8 END)
         FROM (SELECT DISTINCT day_of_week FROM schedule_sessions
               WHERE master_schedule_id = ms.id AND type = 'lec') d) AS lec_day_pattern,
        (SELECT string_agg(d.day_of_week, '/' ORDER BY
            CASE d.day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2
              WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4
              WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 WHEN 'Sunday' THEN 7 ELSE 8 END)
         FROM (SELECT DISTINCT day_of_week FROM schedule_sessions
               WHERE master_schedule_id = ms.id AND type = 'lab') d) AS lab_day_pattern,
        (
          SELECT COALESCE(json_agg(
            json_build_object(
              'id',          ss_all.id,
              'day',         ss_all.day_of_week,
              'start_time',  ss_all.start_time::text,
              'end_time',    ss_all.end_time::text,
              'type',        COALESCE(ss_all.type, 'lec'),
              'room_id',     ss_all.room_id,
              'room_name',   r_all.room_name,
              'session_hours', ss_all.session_hours
            )
            ORDER BY
              CASE ss_all.day_of_week
                WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
                WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
                WHEN 'Sunday' THEN 7 ELSE 8 END,
              ss_all.start_time,
              ss_all.id
          ), '[]'::json)
          FROM schedule_sessions ss_all
          LEFT JOIN rooms r_all ON ss_all.room_id = r_all.id
          WHERE ss_all.master_schedule_id = ms.id
        ) AS sessions
      FROM instructor_loads il
      JOIN master_schedule ms ON il.master_schedule_id = ms.id
      JOIN block_subjects bs ON ms.block_subject_id = bs.id
      JOIN curriculums c ON bs.curriculum_id = c.id
      JOIN blocks b ON bs.block_id = b.id
      JOIN programs p ON b.program_id = p.id
      LEFT JOIN rooms r ON ms.room_id = r.id
      WHERE il.faculty_id = $1
    `;
    const params2: unknown[] = [facultyId];
    let idx = 2;

    if (academicYear) { loadsQuery += ` AND b.academic_year = $${idx++}`; params2.push(academicYear); }
    if (semester) { loadsQuery += ` AND b.semester = $${idx++}`; params2.push(semester); }
    // DISTINCT ON (il.id) requires ORDER BY to begin with il.id
    loadsQuery += ' ORDER BY il.id, il.load_category, c.subject_code';

    const loadsResult = await query(loadsQuery, params2);

    // Compute regular totals using curriculum-derived WU (mirrors client computeRegularRowValues)
    const regular = loadsResult.rows.filter(r => r.load_category === 'Regular');
    const totalRegularUnits = regular.reduce((sum, r) => {
      const splitOl = parseFloat(r.split_overload_units) || 0;
      if (splitOl > 0) return sum + (parseFloat(r.units) || 0); // split: use stored portion
      const lh   = parseFloat(r.lecture_hours)    || 0;
      const labh = parseFloat(r.laboratory_hours) || 0;
      return sum + lh * 1.0 + labh * 0.75; // non-split: curriculum WU
    }, 0);
    const totalRegularHours = regular.reduce((sum, r) => {
      // Split (Contractual): the row keeps only its regular hours — the rest is in
      // overloads, which is counted separately (same rule as the workload table)
      if ((parseFloat(r.split_overload_hours) || 0) > 0) return sum + (parseFloat(r.hours) || 0);
      return sum + (parseFloat(r.curriculum_total_hours) || parseFloat(r.hours) || 0);
    }, 0);

    // Compute overload totals from the overloads audit table.
    // Split-overload subjects have a Regular row in instructor_loads (regular portion)
    // and an overloads row for the excess — not an Overload row in instructor_loads.
    let overloadQuery = `
      SELECT COALESCE(SUM(units), 0) AS total_overload_units,
             COALESCE(SUM(hours), 0) AS total_overload_hours
      FROM overloads
      WHERE faculty_id = $1 AND is_praise = false
    `;
    const overloadParams: unknown[] = [facultyId];
    let oi = 2;
    if (academicYear) { overloadQuery += ` AND academic_year = $${oi++}`; overloadParams.push(academicYear); }
    if (semester)     { overloadQuery += ` AND semester = $${oi++}`;      overloadParams.push(semester); }

    const overloadTotalsResult = await query(overloadQuery, overloadParams);
    const totalOverloadUnits = parseFloat(overloadTotalsResult.rows[0].total_overload_units) || 0;
    const totalOverloadHours = parseFloat(overloadTotalsResult.rows[0].total_overload_hours) || 0;

    const praiseLoads = loadsResult.rows.filter(r => r.load_category === 'Praise');
    // Split Praise portions (only the Lec or Lab moved to Praise; the row stays Regular)
    const praiseSplitRows = loadsResult.rows.filter(r => r.load_category === 'Regular' && r.split_is_praise);
    const splitPraiseUnits = praiseSplitRows.reduce((s, r) => s + (parseFloat(r.split_overload_units) || 0), 0);
    const splitPraiseHours = praiseSplitRows.reduce((s, r) => {
      if (parseFloat(r.split_overload_hours) > 0) return s + parseFloat(r.split_overload_hours);
      // Permanent rows store work units; convert the moved component back to contact hours
      const comp = r.overload_component;
      return s + (comp === 'lab' ? (parseFloat(r.laboratory_hours) || 0) : comp === 'lec' ? (parseFloat(r.lecture_hours) || 0) : 0);
    }, 0);

    const totalPraiseUnits = praiseLoads.reduce((sum, r) => {
      const lh = parseFloat(r.lecture_hours) || 0;
      const labh = parseFloat(r.laboratory_hours) || 0;
      return sum + lh * 1.0 + labh * 0.75;
    }, 0) + splitPraiseUnits;
    const totalPraiseHours = praiseLoads.reduce((sum, r) => {
      return sum + (parseFloat(r.curriculum_total_hours) || parseFloat(r.hours) || 0);
    }, 0) + splitPraiseHours;

    const currentLoad = faculty.employment_status === 'Permanent' ? totalRegularUnits : totalRegularHours;
    const remainingLoad = regularLoadLimit - currentLoad;
    const totalInstructorUnits = faculty.employment_status === 'Permanent'
      ? totalRegularUnits + totalDeduction + totalOverloadUnits + totalPraiseUnits
      : totalRegularHours + totalOverloadHours + totalPraiseHours;

    const loadStatus = computeRegularLoadStatus(currentLoad, regularLoadLimit, faculty.employment_status === 'Permanent');

    // Get praise records
    let praiseQuery = 'SELECT * FROM praise WHERE faculty_id=$1';
    const praiseParams: unknown[] = [facultyId];
    let pi = 2;
    if (academicYear) { praiseQuery += ` AND academic_year=$${pi++}`; praiseParams.push(academicYear); }
    if (semester) { praiseQuery += ` AND semester=$${pi++}`; praiseParams.push(semester); }

    const praiseResult = faculty.employment_status === 'Permanent'
      ? await query(praiseQuery, praiseParams)
      : { rows: [] };

    // Fetch deduction breakdown for the current semester
    const deductionsResult = await query(
      `SELECT id, deduction_type, description, deducted_units
       FROM instructor_load_deductions
       WHERE faculty_id = $1
         AND ($2 = '' OR semester    = $2)
         AND ($3 = '' OR school_year = $3)
       ORDER BY id`,
      [facultyId, semester || '', academicYear || ''],
    );

    return NextResponse.json({
      faculty,
      loads: loadsResult.rows,
      praise: praiseResult.rows,
      deductions: deductionsResult.rows,
      summary: {
        regular_load_limit: regularLoadLimit,
        remaining_regular_load: remainingLoad,
        current_regular_load: currentLoad,
        total_regular_units: totalRegularUnits,
        total_regular_hours: totalRegularHours,
        total_deduction_units: totalDeduction,
        total_overload_units: totalOverloadUnits,
        total_overload_hours: totalOverloadHours,
        total_praise_units: totalPraiseUnits,
        total_praise_hours: totalPraiseHours,
        total_instructor_units: totalInstructorUnits,
        load_status: loadStatus
      }
    });
  } catch (error) {
    console.error('[GET /api/workload/[facultyId]]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
