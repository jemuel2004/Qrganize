import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { syncWorkloadMonitoringNotifications } from '@/server/workloadMonitoring';

/**
 * Reclassify Praise Load subject(s) back to Overload.
 * Does not unassign the instructor or delete schedule/block/curriculum rows.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const faculty_id = Number(body.faculty_id);
    const rawIds: unknown[] = Array.isArray(body.master_schedule_ids)
      ? body.master_schedule_ids
      : body.master_schedule_id != null
        ? [body.master_schedule_id]
        : [];
    const master_schedule_ids = [...new Set(
      rawIds.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0)
    )];

    if (!faculty_id || master_schedule_ids.length === 0) {
      return NextResponse.json({ error: 'Faculty and at least one Praise Load subject are required.' }, { status: 400 });
    }

    const facultyResult = await query(
      'SELECT id, employment_status FROM faculty WHERE id=$1 AND is_active=true',
      [faculty_id]
    );
    if (facultyResult.rows.length === 0) {
      return NextResponse.json({ error: 'Faculty not found' }, { status: 404 });
    }
    const isPermanent = facultyResult.rows[0].employment_status === 'Permanent';

    const loads = await query(
      `SELECT
         il.id, il.master_schedule_id, il.load_category, il.academic_year, il.semester,
         c.lecture_hours, c.laboratory_hours, c.total_hours, c.units
       FROM instructor_loads il
       JOIN master_schedule ms ON ms.id = il.master_schedule_id
       JOIN block_subjects bs ON bs.id = ms.block_subject_id
       JOIN curriculums c ON c.id = bs.curriculum_id
       WHERE il.faculty_id = $1 AND il.master_schedule_id = ANY($2::int[])`,
      [faculty_id, master_schedule_ids]
    );

    if (loads.rows.length !== master_schedule_ids.length) {
      return NextResponse.json({ error: 'One or more subjects are not assigned to this instructor.' }, { status: 404 });
    }

    for (const row of loads.rows as { load_category: string }[]) {
      if (row.load_category === 'Overload') {
        return NextResponse.json({
          error: 'Subject is already in Overload.',
        }, { status: 409 });
      }
      if (row.load_category !== 'Praise') {
        return NextResponse.json({
          error: 'Only Praise Load subjects can be returned to Overload.',
        }, { status: 400 });
      }
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE instructor_loads
         SET load_category = 'Overload', overload_component = 'full'
         WHERE faculty_id = $1 AND master_schedule_id = ANY($2::int[])`,
        [faculty_id, master_schedule_ids]
      );
      await client.query(
        `DELETE FROM overloads
         WHERE faculty_id = $1 AND master_schedule_id = ANY($2::int[])`,
        [faculty_id, master_schedule_ids]
      );

      for (const row of loads.rows as {
        master_schedule_id: number;
        academic_year: string;
        semester: string;
        lecture_hours: unknown;
        laboratory_hours: unknown;
        total_hours: unknown;
      }[]) {
        const lec = parseFloat(String(row.lecture_hours)) || 0;
        const lab = parseFloat(String(row.laboratory_hours)) || 0;
        const totalH = parseFloat(String(row.total_hours)) || 0;
        const subjectTotal = isPermanent ? lec + lab * 0.75 : (totalH || lec + lab);

        await client.query(
          `INSERT INTO overloads
            (faculty_id, master_schedule_id, units, hours, reason, academic_year, semester)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            faculty_id,
            row.master_schedule_id,
            isPermanent ? parseFloat(subjectTotal.toFixed(2)) : 0,
            !isPermanent ? parseFloat(subjectTotal.toFixed(2)) : 0,
            'Returned from Praise Load',
            row.academic_year,
            row.semester,
          ]
        );
      }
    });

    void syncWorkloadMonitoringNotifications(true);

    const n = master_schedule_ids.length;
    return NextResponse.json({
      success: true,
      moved: n,
      message: n === 1
        ? 'Subject returned from Praise Load to Overload.'
        : `${n} subjects returned from Praise Load to Overload.`,
    });
  } catch (error) {
    console.error('[POST /api/workload/return-to-overload]', error);
    return NextResponse.json({ error: 'Failed to return subject to Overload.' }, { status: 500 });
  }
}
