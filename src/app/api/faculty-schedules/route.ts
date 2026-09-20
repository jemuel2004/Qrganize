import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const employment_status = searchParams.get('employment_status') || '';
    const semester          = searchParams.get('semester') || '';
    const academic_year     = searchParams.get('academic_year') || '';
    const faculty_id        = searchParams.get('faculty_id') || '';

    const conditions: string[] = ['f.is_active = true'];
    const values: (string | number)[] = [];
    let idx = 1;

    if (employment_status) { conditions.push(`f.employment_status = $${idx++}`); values.push(employment_status); }
    if (semester)          { conditions.push(`b.semester = $${idx++}`);          values.push(semester); }
    if (academic_year)     { conditions.push(`b.academic_year = $${idx++}`);     values.push(academic_year); }
    if (faculty_id)        { conditions.push(`f.id = $${idx++}`);                values.push(faculty_id); }

    const where = conditions.join(' AND ');

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
        il.load_category,
        il.units,
        il.hours,
        c.subject_code,
        c.subject_name,
        c.units        AS curriculum_units,
        c.total_hours,
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
        ) AS room_name
      FROM instructor_loads il
      JOIN faculty f        ON il.faculty_id          = f.id
      JOIN master_schedule ms ON il.master_schedule_id = ms.id
      JOIN block_subjects bs  ON ms.block_subject_id   = bs.id
      JOIN curriculums c      ON bs.curriculum_id      = c.id
      JOIN blocks b           ON bs.block_id           = b.id
      JOIN programs p         ON b.program_id          = p.id
      LEFT JOIN rooms r       ON ms.room_id            = r.id
      WHERE ${where}
      ORDER BY f.name, il.load_category, c.subject_code
    `, values);

    const rows = result.rows;

    const totalSchedules   = rows.length;
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

    return NextResponse.json({
      schedules:      rows,
      summary:        { totalSchedules, totalInstructors, totalRegular, totalOverload, totalPraise },
      academic_years: yearsResult.rows.map((r: Record<string, unknown>) => r.academic_year),
    });
  } catch (error) {
    console.error('[GET /api/faculty-schedules]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
