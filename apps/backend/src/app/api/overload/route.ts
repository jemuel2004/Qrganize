import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getChairAssignedProgramId, isScopedChair } from '@/services/programScope';
import { ensurePraiseSplitColumn } from '@/services/praiseSplit';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await ensurePraiseSplitColumn();

    const { searchParams } = new URL(req.url);
    const facultyId      = searchParams.get('faculty_id')      || '';
    const semester       = searchParams.get('semester')        || '';
    const academicYear   = searchParams.get('academic_year')   || '';
    let programId        = searchParams.get('program_id')      || '';

    if (isScopedChair(auth)) {
      const chairProgramId = auth.id ? await getChairAssignedProgramId(Number(auth.id)) : null;
      if (chairProgramId == null) {
        return NextResponse.json({
          overloads: [],
          summary: { total_records: 0, total_instructors: 0, total_overload_units: 0, total_overload_hours: 0 },
        });
      }
      programId = String(chairProgramId);
    }
    const employmentType = searchParams.get('employment_type') || '';
    const search         = searchParams.get('search')          || '';

    let sql = `
      SELECT
        f.id              AS faculty_id,
        f.name            AS faculty_name,
        f.employee_id,
        f.employment_status,
        f.position,
        c.subject_code,
        c.subject_name,
        c.lecture_hours,
        c.laboratory_hours,
        c.total_hours     AS curriculum_total_hours,
        c.units           AS curriculum_units,
        c.subject_category,
        b.block_name,
        b.year_level,
        b.semester        AS block_semester,
        b.academic_year   AS block_academic_year,
        p.code            AS program_code,
        p.name            AS program_name,
        p.id              AS program_id,
        ms.id             AS master_schedule_id,
        ms.status         AS schedule_status,
        ms.day_pattern,
        ms.start_time,
        ms.end_time,
        il.id             AS load_id,
        il.load_category,
        il.units          AS il_units,
        il.hours          AS il_hours,
        o.id              AS overload_id,
        o.units           AS overload_units,
        o.hours           AS overload_hours,
        o.reason,
        o.academic_year   AS overload_academic_year,
        o.semester        AS overload_semester,
        o.created_at      AS overload_created_at,
        CASE WHEN il.load_category = 'Regular' THEN true ELSE false END AS is_split
      FROM overloads o
      JOIN faculty f ON o.faculty_id = f.id
      LEFT JOIN master_schedule ms
        ON o.master_schedule_id = ms.id
      LEFT JOIN block_subjects bs
        ON ms.block_subject_id = bs.id
      LEFT JOIN curriculums c
        ON bs.curriculum_id = c.id
      LEFT JOIN blocks b
        ON bs.block_id = b.id
      LEFT JOIN programs p
        ON b.program_id = p.id
      LEFT JOIN instructor_loads il
        ON il.faculty_id = o.faculty_id
       AND il.master_schedule_id = o.master_schedule_id
      WHERE f.is_active = true
        AND o.is_praise = false
    `;

    const params: unknown[] = [];
    let idx = 1;

    if (facultyId)    { sql += ` AND f.id = $${idx++}`;              params.push(parseInt(facultyId)); }
    if (semester)     { sql += ` AND o.semester = $${idx++}`;       params.push(semester); }
    if (academicYear) { sql += ` AND o.academic_year = $${idx++}`;  params.push(academicYear); }
    if (programId)    { sql += ` AND p.id = $${idx++}`;             params.push(programId); }

    if (employmentType === 'Permanent') {
      sql += ` AND f.employment_status = $${idx++}`;
      params.push('Permanent');
    } else if (employmentType === 'Contractual') {
      sql += ` AND f.employment_status = $${idx++}`;
      params.push('Contractual');
    }

    if (search) {
      sql += ` AND (
        f.name          ILIKE $${idx}
        OR f.employee_id ILIKE $${idx}
        OR c.subject_code ILIKE $${idx}
        OR c.subject_name ILIKE $${idx}
      )`;
      params.push(`%${search}%`);
      idx++;
    }

    sql += ' ORDER BY f.name, b.academic_year DESC, b.semester, c.subject_code';

    const result = await query(sql, params);
    const overloads = result.rows;

    const uniqueFaculty     = new Set(overloads.map(r => r.faculty_id)).size;
    const totalOverloadUnits = overloads
      .filter(r => r.employment_status === 'Permanent')
      .reduce((s, r) => s + (parseFloat(r.overload_units) || 0), 0);
    const totalOverloadHours = overloads
      .filter(r => r.employment_status !== 'Permanent')
      .reduce((s, r) => s + (parseFloat(r.overload_hours) || 0), 0);

    return NextResponse.json({
      overloads,
      summary: {
        total_records:        overloads.length,
        total_instructors:    uniqueFaculty,
        total_overload_units: parseFloat(totalOverloadUnits.toFixed(2)),
        total_overload_hours: parseFloat(totalOverloadHours.toFixed(2)),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
