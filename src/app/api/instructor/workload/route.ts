import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import {
  getActiveAcademicPeriod,
  isActivePeriodConfigured,
} from '@/server/activeAcademicPeriod';
import {
  CONTRACTUAL_REGULAR_HOURS_LIMIT,
  computeRegularLoadStatus,
  permanentRegularLoadLimit,
} from '@/lib/regularLoad';

/**
 * GET /api/instructor/workload
 *
 * Security: Uses the authenticated session to derive faculty_id.
 * Period is the Admin-configured active school year + semester only.
 * Query params that do not match the active period are rejected.
 */
let schemaReady = false;
let migrationDone = false;

async function ensureInstructorWorkloadSchema() {
  if (!schemaReady) {
    try {
      await query(`ALTER TABLE instructor_loads ADD COLUMN IF NOT EXISTS overload_component VARCHAR(10) DEFAULT 'full'`);
      await query(`ALTER TABLE schedule_sessions ADD COLUMN IF NOT EXISTS type VARCHAR(3) DEFAULT 'lec'`);
      schemaReady = true;
    } catch (e) {
      console.error('[instructor/workload] schema DDL failed — will retry:', e);
    }
  }
  if (!migrationDone && schemaReady) {
    try {
      await query(`
        UPDATE schedule_sessions
        SET type = 'lab'
        WHERE type = 'lec'
          AND room_id IN (SELECT id FROM rooms WHERE room_type IN ('Laboratory', 'Computer Lab'))
      `);
      migrationDone = true;
    } catch (e) {
      console.error('[instructor/workload] session type migration failed — will retry:', e);
    }
  }
}

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const facultyId = authUser.faculty_id;
    const period = await getActiveAcademicPeriod();
    if (!isActivePeriodConfigured(period)) {
      return NextResponse.json(
        { error: 'No active academic period is currently configured.' },
        { status: 409 },
      );
    }

    const { searchParams } = new URL(req.url);
    const requestedYear = (searchParams.get('academic_year') ?? '').trim();
    const requestedSem  = (searchParams.get('semester') ?? '').trim();
    if (requestedYear && requestedYear !== period.schoolYear) {
      return NextResponse.json(
        { error: 'Requested academic year is not the active period.' },
        { status: 403 },
      );
    }
    if (requestedSem && requestedSem !== period.semester) {
      return NextResponse.json(
        { error: 'Requested semester is not the active period.' },
        { status: 403 },
      );
    }

    const academicYear = period.schoolYear;
    const semester = period.semester;

    await ensureInstructorWorkloadSchema();

    // Faculty
    const facultyResult = await query('SELECT * FROM faculty WHERE id = $1', [facultyId]);
    if (facultyResult.rows.length === 0) {
      return NextResponse.json({ error: 'Faculty not found' }, { status: 404 });
    }
    const faculty = facultyResult.rows[0];

    // Deductions for this semester (drives regular load limit for Permanent)
    const deductionResult = await query(
      `SELECT COALESCE(SUM(deducted_units), 0) AS total_deduction
       FROM instructor_load_deductions
       WHERE faculty_id = $1
         AND ($2 = '' OR semester    = $2)
         AND ($3 = '' OR school_year = $3)`,
      [facultyId, semester, academicYear],
    );
    const totalDeduction   = parseFloat(deductionResult.rows[0].total_deduction) || 0;
    const regularLoadLimit = faculty.employment_status === 'Permanent'
      ? permanentRegularLoadLimit(totalDeduction)
      : CONTRACTUAL_REGULAR_HOURS_LIMIT;

    // Loads
    let loadsQuery = `
      SELECT DISTINCT ON (il.id)
        il.id, il.faculty_id, il.master_schedule_id, il.load_category,
        il.units, il.hours, il.academic_year, il.semester, il.created_at,
        COALESCE(il.overload_component, 'full') AS overload_component,
        ms.id as ms_id, ms.day_pattern, ms.start_time, ms.end_time, ms.status as schedule_status,
        c.subject_code, c.subject_name,
        c.units as curriculum_units, c.total_hours as curriculum_total_hours,
        c.lecture_hours, c.laboratory_hours,
        b.block_name, b.year_level, b.semester as block_semester, b.academic_year as block_academic_year,
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
           AND r2.room_type NOT IN ('Laboratory', 'Computer Lab')
         ORDER BY ss2.id LIMIT 1) AS lec_room_name,
        (SELECT r2.room_name FROM schedule_sessions ss2
         JOIN rooms r2 ON ss2.room_id = r2.id
         WHERE ss2.master_schedule_id = ms.id AND ss2.room_id IS NOT NULL
           AND r2.room_type IN ('Laboratory', 'Computer Lab')
         ORDER BY ss2.id LIMIT 1) AS lab_room_name,
        (SELECT COALESCE(SUM(o2.units), 0) FROM overloads o2
         WHERE o2.faculty_id = il.faculty_id AND o2.master_schedule_id = il.master_schedule_id) AS split_overload_units,
        (SELECT COALESCE(SUM(o2.hours), 0) FROM overloads o2
         WHERE o2.faculty_id = il.faculty_id AND o2.master_schedule_id = il.master_schedule_id) AS split_overload_hours,
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
               WHERE master_schedule_id = ms.id AND type = 'lab') d) AS lab_day_pattern
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
    if (semester)     { loadsQuery += ` AND b.semester      = $${idx++}`; params2.push(semester); }
    loadsQuery += ' ORDER BY il.id, il.load_category, c.subject_code';

    const loadsResult = await query(loadsQuery, params2);

    const regular = loadsResult.rows.filter(r => r.load_category === 'Regular');
    const totalRegularUnits = regular.reduce((s, r) => {
      const splitOl = parseFloat(r.split_overload_units) || 0;
      if (splitOl > 0) return s + (parseFloat(r.units) || 0); // split: use stored portion
      const lh   = parseFloat(r.lecture_hours)    || 0;
      const labh = parseFloat(r.laboratory_hours) || 0;
      return s + lh * 1.0 + labh * 0.75; // non-split: curriculum WU
    }, 0);
    const totalRegularHours = regular.reduce((s, r) => {
      return s + (parseFloat(r.curriculum_total_hours) || parseFloat(r.hours) || 0);
    }, 0);

    // Overload totals from overloads audit table
    let overloadQuery = `
      SELECT COALESCE(SUM(units), 0) AS total_overload_units,
             COALESCE(SUM(hours), 0) AS total_overload_hours
      FROM overloads WHERE faculty_id = $1
    `;
    const overloadParams: unknown[] = [facultyId];
    let oi = 2;
    if (academicYear) { overloadQuery += ` AND academic_year = $${oi++}`; overloadParams.push(academicYear); }
    if (semester)     { overloadQuery += ` AND semester      = $${oi++}`; overloadParams.push(semester); }

    const olTotals          = await query(overloadQuery, overloadParams);
    const totalOverloadUnits = parseFloat(olTotals.rows[0].total_overload_units) || 0;
    const totalOverloadHours = parseFloat(olTotals.rows[0].total_overload_hours) || 0;

    const praiseLoads = loadsResult.rows.filter(r => r.load_category === 'Praise');
    const totalPraiseUnits = praiseLoads.reduce((sum, r) => {
      const lh = parseFloat(r.lecture_hours) || 0;
      const labh = parseFloat(r.laboratory_hours) || 0;
      return sum + lh * 1.0 + labh * 0.75;
    }, 0);
    const totalPraiseHours = praiseLoads.reduce((sum, r) => {
      return sum + (parseFloat(r.curriculum_total_hours) || parseFloat(r.hours) || 0);
    }, 0);

    const currentLoad   = faculty.employment_status === 'Permanent' ? totalRegularUnits : totalRegularHours;
    const remainingLoad = regularLoadLimit - currentLoad;
    const totalInstructorUnits = faculty.employment_status === 'Permanent'
      ? totalRegularUnits + totalDeduction + totalOverloadUnits + totalPraiseUnits
      : totalRegularHours + totalOverloadHours + totalPraiseHours;

    const loadStatus = computeRegularLoadStatus(currentLoad, regularLoadLimit);

    // Praise (Permanent only)
    let praiseQuery = 'SELECT * FROM praise WHERE faculty_id = $1';
    const praiseParams: unknown[] = [facultyId];
    let pi = 2;
    if (academicYear) { praiseQuery += ` AND academic_year = $${pi++}`; praiseParams.push(academicYear); }
    if (semester)     { praiseQuery += ` AND semester      = $${pi++}`; praiseParams.push(semester); }

    const praiseResult = faculty.employment_status === 'Permanent'
      ? await query(praiseQuery, praiseParams)
      : { rows: [] };

    // Deduction breakdown
    const deductionsResult = await query(
      `SELECT id, deduction_type, description, deducted_units
       FROM instructor_load_deductions
       WHERE faculty_id = $1
         AND ($2 = '' OR semester    = $2)
         AND ($3 = '' OR school_year = $3)
       ORDER BY id`,
      [facultyId, semester, academicYear],
    );

    return NextResponse.json({
      period: { schoolYear: academicYear, semester },
      faculty,
      loads:      loadsResult.rows,
      praise:     praiseResult.rows,
      deductions: deductionsResult.rows,
      summary: {
        regular_load_limit:     regularLoadLimit,
        remaining_regular_load: remainingLoad,
        current_regular_load:   currentLoad,
        total_regular_units:    totalRegularUnits,
        total_regular_hours:    totalRegularHours,
        total_deduction_units:  totalDeduction,
        total_overload_units:   totalOverloadUnits,
        total_overload_hours:   totalOverloadHours,
        total_praise_units:     totalPraiseUnits,
        total_praise_hours:     totalPraiseHours,
        total_instructor_units: totalInstructorUnits,
        load_status:            loadStatus,
      },
    });
  } catch (error) {
    console.error('[GET /api/instructor/workload]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
