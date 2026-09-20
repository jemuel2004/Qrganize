import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { syncWorkloadMonitoringNotifications } from '@/server/workloadMonitoring';

/**
 * Reclassify Overload subject(s) as Praise Load.
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
      return NextResponse.json({ error: 'Faculty and at least one overload subject are required.' }, { status: 400 });
    }

    const facultyResult = await query(
      'SELECT id, employment_status FROM faculty WHERE id=$1 AND is_active=true',
      [faculty_id]
    );
    if (facultyResult.rows.length === 0) {
      return NextResponse.json({ error: 'Faculty not found' }, { status: 404 });
    }

    const loads = await query(
      `SELECT id, master_schedule_id, load_category, academic_year, semester
       FROM instructor_loads
       WHERE faculty_id = $1 AND master_schedule_id = ANY($2::int[])`,
      [faculty_id, master_schedule_ids]
    );

    if (loads.rows.length !== master_schedule_ids.length) {
      return NextResponse.json({ error: 'One or more subjects are not assigned to this instructor.' }, { status: 404 });
    }

    for (const row of loads.rows as { load_category: string }[]) {
      if (row.load_category === 'Praise') {
        return NextResponse.json({
          error: 'Subject is already in Praise Load and cannot be moved again.',
        }, { status: 409 });
      }
      if (row.load_category !== 'Overload') {
        return NextResponse.json({
          error: 'Subject must be in the Overload table before it can be moved to Praise Load.',
        }, { status: 400 });
      }
    }

    await transaction(async (client) => {
      await client.query(
        `UPDATE instructor_loads
         SET load_category = 'Praise', overload_component = 'full'
         WHERE faculty_id = $1 AND master_schedule_id = ANY($2::int[])`,
        [faculty_id, master_schedule_ids]
      );
      await client.query(
        `DELETE FROM overloads
         WHERE faculty_id = $1 AND master_schedule_id = ANY($2::int[])`,
        [faculty_id, master_schedule_ids]
      );
    });

    void syncWorkloadMonitoringNotifications(true);

    const n = master_schedule_ids.length;
    return NextResponse.json({
      success: true,
      moved: n,
      message: n === 1
        ? 'Subject moved from Overload to Praise Load.'
        : `${n} subjects moved from Overload to Praise Load.`,
    });
  } catch (error) {
    console.error('[POST /api/workload/move-to-praise]', error);
    return NextResponse.json({ error: 'Failed to move subject to Praise Load.' }, { status: 500 });
  }
}
