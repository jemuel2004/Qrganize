import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { resolveProgramScope, isScopedChair } from '@/services/programScope';
import { ensurePraiseSplitColumn } from '@/services/praiseSplit';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const employment_status = searchParams.get('employment_status') || '';
    const semester          = searchParams.get('semester') || '';
    const academic_year     = searchParams.get('academic_year') || '';
    const faculty_id        = searchParams.get('faculty_id') || '';

    let programId = '';
    if (isScopedChair(auth)) {
      const scope = await resolveProgramScope(auth);
      if (!scope.ok) return scope.response;
      programId = String(scope.programId);
    }

    const conditions: string[] = ['f.is_active = true'];
    const values: (string | number)[] = [];
    let idx = 1;

    if (employment_status) { conditions.push(`f.employment_status = $${idx++}`); values.push(employment_status); }
    if (semester)          { conditions.push(`b.semester = $${idx++}`);          values.push(semester); }
    if (academic_year)     { conditions.push(`b.academic_year = $${idx++}`);     values.push(academic_year); }
    if (faculty_id)        { conditions.push(`f.id = $${idx++}`);                values.push(faculty_id); }
    if (programId)         { conditions.push(`p.id = $${idx++}`);               values.push(programId); }

    const where = conditions.join(' AND ');
    await ensurePraiseSplitColumn();

    const result = await query(`
      SELECT
        f.id           AS faculty_id,
        f.name         AS faculty_name,
        f.employee_id,
        f.position,
        f.employment_status,
        p.id           AS program_id,
        p.code         AS program_code,
        p.name         AS program_name,
        il.id          AS load_id,
        ms.id          AS master_schedule_id,
        il.load_category,
        il.units,
        il.hours,
        c.subject_code,
        c.subject_name,
        c.units        AS curriculum_units,
        c.total_hours,
        -- What the official forms value the subject by (@shared/loadSplit formLoadValue)
        c.lecture_hours,
        c.laboratory_hours,
        EXISTS(SELECT 1 FROM schedule_sessions ss_l WHERE ss_l.master_schedule_id = ms.id AND ss_l.type = 'lec') AS lec_scheduled,
        EXISTS(SELECT 1 FROM schedule_sessions ss_b WHERE ss_b.master_schedule_id = ms.id AND ss_b.type = 'lab') AS lab_scheduled,
        b.block_name,
        b.year_level,
        b.semester,
        b.academic_year,
        ms.day_pattern,
        ms.start_time,
        ms.end_time,
        ms.status,
        COALESCE(
          (SELECT r2.room_name
           FROM schedule_sessions ss
           JOIN rooms r2 ON ss.room_id = r2.id
           WHERE ss.master_schedule_id = ms.id
           ORDER BY ss.id LIMIT 1),
          r.room_name
        ) AS room_name,
        COALESCE(il.overload_component, 'full') AS overload_component,
        ol.split_units,
        ol.split_hours,
        ol.split_is_praise,
        -- Short names (Mon/Thu) to match master_schedule.day_pattern
        (SELECT string_agg(LEFT(d.day_of_week, 3), '/' ORDER BY
            CASE d.day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2
              WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4
              WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 WHEN 'Sunday' THEN 7 ELSE 8 END)
         FROM (SELECT DISTINCT day_of_week FROM schedule_sessions
               WHERE master_schedule_id = ms.id AND type = il.overload_component) d) AS split_day_pattern,
        (SELECT ss_c.start_time FROM schedule_sessions ss_c
         WHERE ss_c.master_schedule_id = ms.id AND ss_c.type = il.overload_component
         ORDER BY ss_c.id LIMIT 1) AS split_start_time,
        (SELECT ss_c.end_time FROM schedule_sessions ss_c
         WHERE ss_c.master_schedule_id = ms.id AND ss_c.type = il.overload_component
         ORDER BY ss_c.id LIMIT 1) AS split_end_time
      FROM instructor_loads il
      JOIN faculty f        ON il.faculty_id          = f.id
      JOIN master_schedule ms ON il.master_schedule_id = ms.id
      JOIN block_subjects bs  ON ms.block_subject_id   = bs.id
      JOIN curriculums c      ON bs.curriculum_id      = c.id
      JOIN blocks b           ON bs.block_id           = b.id
      JOIN programs p         ON b.program_id          = p.id
      LEFT JOIN rooms r       ON ms.room_id            = r.id
      -- Split portion (only the Lec or Lab) moved to Overload / Praise: the
      -- instructor_loads row stays 'Regular' and the moved part lives in overloads.
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(o.units), 0) AS split_units,
               COALESCE(SUM(o.hours), 0) AS split_hours,
               SUM(o.lec_part)           AS split_lec_part,
               BOOL_OR(o.is_praise)      AS split_is_praise
        FROM overloads o
        WHERE o.faculty_id = il.faculty_id AND o.master_schedule_id = il.master_schedule_id
      ) ol ON il.load_category = 'Regular'
      WHERE ${where}
      ORDER BY f.name, il.load_category, c.subject_code
    `, values);

    // Emit each split portion as its own Overload / Praise row so it is counted
    // and listed like the Faculty Workload page does.
    const rows: Record<string, unknown>[] = [];
    for (const r of result.rows as Record<string, unknown>[]) {
      const { overload_component, split_units, split_hours, split_lec_part, split_is_praise,
              split_day_pattern, split_start_time, split_end_time, ...rest } = r;
      // The split as the Workload API gives it to the official forms, so the page
      // values each row the same way the forms do (see @shared/loadSplit)
      const base: Record<string, unknown> = {
        ...rest,
        overload_component,
        split_overload_units: split_units ?? 0,
        split_overload_hours: split_hours ?? 0,
        split_lec_part: split_lec_part ?? null,
      };
      rows.push(base);
      const isPerm = base.employment_status === 'Permanent';
      const portion = parseFloat(String((isPerm ? split_units : split_hours) ?? 0)) || 0;
      if (base.load_category !== 'Regular' || portion <= 0.001) continue;
      const component = overload_component === 'lec' || overload_component === 'lab' ? overload_component : null;
      rows.push({
        ...base,
        load_category: split_is_praise ? 'Praise' : 'Overload',
        units: isPerm ? portion : 0,
        hours: isPerm ? 0 : portion,
        // Same subject as the row above — only its moved part
        split_portion: true,
        split_component: component,
        ...(component && split_start_time
          ? { day_pattern: split_day_pattern, start_time: split_start_time, end_time: split_end_time }
          : {}),
      });
    }

    const totalSchedules   = new Set(rows.map(r => r.load_id)).size;
    const totalInstructors = new Set(rows.map((r: Record<string, unknown>) => r.faculty_id)).size;
    const totalRegular     = rows.filter((r: Record<string, unknown>) => r.load_category === 'Regular').length;
    const totalOverload    = rows.filter((r: Record<string, unknown>) => r.load_category === 'Overload').length;
    const totalPraise      = rows.filter((r: Record<string, unknown>) => r.load_category === 'Praise').length;

    const yearsResult = await query(
      `SELECT DISTINCT academic_year FROM blocks
       WHERE academic_year IS NOT NULL
       ORDER BY academic_year DESC`,
      []
    );

    /* The official forms' other lines, for the faculty listed (Permanent only, as
       the forms count them): Deloading is added to the classes on the Actual Load
       and Regular Load forms, Praise Load records on the Praise Load form — so the
       page's totals match the print. */
    const listed = [...new Set(rows.map(r => Number(r.faculty_id)))];
    const [deloadingResult, praiseResult] = listed.length === 0
      ? [{ rows: [] }, { rows: [] }]
      : await Promise.all([
          query(
            `SELECT d.id, d.faculty_id, d.deduction_type, d.description, COALESCE(d.deducted_units, 0)::float AS units
             FROM instructor_load_deductions d
             JOIN faculty f ON f.id = d.faculty_id AND f.employment_status = 'Permanent'
             WHERE d.faculty_id = ANY($1::int[])
               AND ($2::text = '' OR d.semester = $2::text)
               AND ($3::text = '' OR d.school_year = $3::text)
             ORDER BY d.id`,
            [listed, semester, academic_year],
          ),
          query(
            `SELECT p.id, p.faculty_id, p.praise_type, COALESCE(NULLIF(p.description, ''), NULLIF(p.remarks, ''), '') AS description,
                    COALESCE(p.equivalent_units, 0)::float AS units
             FROM praise p
             JOIN faculty f ON f.id = p.faculty_id AND f.employment_status = 'Permanent'
             WHERE p.faculty_id = ANY($1::int[])
               AND ($2::text = '' OR p.semester = $2::text)
               AND ($3::text = '' OR p.academic_year = $3::text)
             ORDER BY p.id`,
            [listed, semester, academic_year],
          ),
        ]);

    return NextResponse.json({
      schedules:      rows,
      deloading:      deloadingResult.rows,
      praise_records: praiseResult.rows,
      summary:        { totalSchedules, totalInstructors, totalRegular, totalOverload, totalPraise },
      academic_years: yearsResult.rows.map((r: Record<string, unknown>) => r.academic_year),
    });
  } catch (error) {
    console.error('[GET /api/faculty-schedules]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
