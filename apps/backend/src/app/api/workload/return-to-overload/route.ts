import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { syncWorkloadMonitoringNotifications } from '@/services/workloadMonitoring';
import { canAccessMasterSchedule } from '@/services/programScope';
import { ensurePraiseSplitColumn } from '@/services/praiseSplit';
import { withAudit } from '@/services/audit';
import { overloadCapError } from '@/services/overloadCap';
import { canHaveOverloadOrPraise, OVERLOAD_PRAISE_PERMANENT_ONLY } from '@shared/regularLoad';

/**
 * Reclassify Praise Load subject(s) back to Overload.
 * Does not unassign the instructor or delete schedule/block/curriculum rows.
 */
async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const faculty_id = Number(body.faculty_id);
    const rawIds: unknown[] = Array.isArray(body.master_schedule_ids)
      ? body.master_schedule_ids
      : body.master_schedule_id != null
        ? [body.master_schedule_id]
        : [];
    let master_schedule_ids = [...new Set(
      rawIds.map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0)
    )];

    if (!faculty_id || master_schedule_ids.length === 0) {
      return NextResponse.json({ error: 'Faculty and at least one Praise Load subject are required.' }, { status: 400 });
    }

    for (const msId of master_schedule_ids) {
      if (!(await canAccessMasterSchedule(auth, msId))) {
        return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
      }
    }

    const facultyResult = await query(
      'SELECT id, employment_status FROM faculty WHERE id=$1 AND is_active=true',
      [faculty_id]
    );
    if (facultyResult.rows.length === 0) {
      return NextResponse.json({ error: 'Faculty not found' }, { status: 404 });
    }
    if (!canHaveOverloadOrPraise(facultyResult.rows[0].employment_status)) {
      return NextResponse.json({ error: OVERLOAD_PRAISE_PERMANENT_ONLY }, { status: 400 });
    }
    const isPermanent = facultyResult.rows[0].employment_status === 'Permanent';

    /* Overload cap — work out everything that would come back as Overload
       (split Praise portions + whole Praise subjects) before changing anything. */
    await ensurePraiseSplitColumn();
    if (isPermanent) {
      const pending = await query(
        `SELECT il.master_schedule_id, il.semester, il.academic_year, il.load_category,
                c.lecture_hours, c.laboratory_hours,
                (SELECT SUM(o.units) FROM overloads o
                  WHERE o.faculty_id = il.faculty_id AND o.master_schedule_id = il.master_schedule_id
                    AND o.is_praise = true) AS split_units
           FROM instructor_loads il
           JOIN master_schedule ms ON ms.id = il.master_schedule_id
           JOIN block_subjects bs ON bs.id = ms.block_subject_id
           JOIN curriculums c ON c.id = bs.curriculum_id
          WHERE il.faculty_id = $1 AND il.master_schedule_id = ANY($2::int[])`,
        [faculty_id, master_schedule_ids]
      );
      let addUnits = 0;
      let term: { semester: string; academic_year: string } | null = null;
      for (const r of pending.rows as Array<{ semester: string; academic_year: string; load_category: string; lecture_hours: unknown; laboratory_hours: unknown; split_units: unknown }>) {
        term = term ?? { semester: r.semester, academic_year: r.academic_year };
        const split = parseFloat(String(r.split_units)) || 0;
        if (split > 0) addUnits += split;
        else if (r.load_category === 'Praise') {
          addUnits += (parseFloat(String(r.lecture_hours)) || 0) + (parseFloat(String(r.laboratory_hours)) || 0) * 0.75;
        }
      }
      if (term) {
        const capError = await overloadCapError({
          facultyId: faculty_id, isPermanent,
          semester: term.semester, academicYear: term.academic_year,
          addUnits, replacingMsIds: master_schedule_ids,
        });
        if (capError) return NextResponse.json({ error: capError, overload_limit_reached: true }, { status: 409 });
      }
    }

    /* Split Praise portions (only the Lec or Lab in Praise, rest Regular) just
       flip back to an Overload split — the Regular part is untouched. */
    const splitPraise = await query(
      `UPDATE overloads SET is_praise = false, reason = 'Returned from Praise Load'
       WHERE faculty_id = $1 AND master_schedule_id = ANY($2::int[]) AND is_praise = true
       RETURNING master_schedule_id`,
      [faculty_id, master_schedule_ids]
    );
    const splitIds = new Set((splitPraise.rows as { master_schedule_id: number }[]).map(r => Number(r.master_schedule_id)));
    master_schedule_ids = master_schedule_ids.filter(id => !splitIds.has(id));
    if (master_schedule_ids.length === 0) {
      void syncWorkloadMonitoringNotifications(true);
      return NextResponse.json({
        success: true,
        moved: splitIds.size,
        message: 'Returned from Praise Load to Overload.',
      });
    }

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
      return NextResponse.json({ error: 'One or more subjects are not assigned to this faculty.' }, { status: 404 });
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

    const n = master_schedule_ids.length + splitIds.size;
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

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
