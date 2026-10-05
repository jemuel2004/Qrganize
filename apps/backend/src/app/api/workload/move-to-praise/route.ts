import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { parseId } from '@/database/ids';
import { getAuthUser } from '@/auth/auth';
import { syncWorkloadMonitoringNotifications } from '@/services/workloadMonitoring';
import { canAccessMasterSchedule } from '@/services/programScope';
import { ensurePraiseSplitColumn } from '@/services/praiseSplit';
import { withAudit } from '@/services/audit';
import { canHaveOverloadOrPraise, OVERLOAD_PRAISE_PERMANENT_ONLY } from '@shared/regularLoad';

/**
 * Reclassify Overload subject(s) as Praise Load.
 * Does not unassign the instructor or delete schedule/block/curriculum rows.
 */
async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    await ensurePraiseSplitColumn();

    // Single component (Lec or Lab) of a Regular subject → Praise; the other stays Regular
    if (body.component === 'lec' || body.component === 'lab') {
      return movePraiseComponent(auth, Number(body.faculty_id), Number(body.master_schedule_id), body.component);
    }
    // The whole of a Regular (or Overload) subject → Praise in one step
    if (body.whole_subject === true) {
      return moveWholeSubjectToPraise(auth, parseId(body.faculty_id), parseId(body.master_schedule_id));
    }

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

    const loads = await query(
      `SELECT id, master_schedule_id, load_category, academic_year, semester
       FROM instructor_loads
       WHERE faculty_id = $1 AND master_schedule_id = ANY($2::int[])`,
      [faculty_id, master_schedule_ids]
    );

    if (loads.rows.length !== master_schedule_ids.length) {
      return NextResponse.json({ error: 'One or more subjects are not assigned to this faculty.' }, { status: 404 });
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

/**
 * Move only the Lec or Lab of a Lec+Lab subject to Praise Load — the same
 * split model as a component Overload: the load row stays 'Regular' holding
 * the other component, and the moved component is an `overloads` row flagged
 * is_praise. If that component is already split into Overload, it's simply
 * reclassified as Praise.
 */
async function movePraiseComponent(
  auth: { role?: string },
  faculty_id: number,
  master_schedule_id: number,
  component: 'lec' | 'lab',
) {
  if (!faculty_id || !master_schedule_id) {
    return NextResponse.json({ error: 'Faculty and subject are required.' }, { status: 400 });
  }
  if (!(await canAccessMasterSchedule(auth, master_schedule_id))) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
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

  const loadResult = await query(
    `SELECT il.load_category, COALESCE(il.overload_component, 'full') AS overload_component,
            il.academic_year, il.semester,
            c.lecture_hours, c.laboratory_hours
     FROM instructor_loads il
     JOIN master_schedule ms ON ms.id = il.master_schedule_id
     JOIN block_subjects bs  ON bs.id = ms.block_subject_id
     JOIN curriculums c      ON c.id  = bs.curriculum_id
     WHERE il.faculty_id = $1 AND il.master_schedule_id = $2`,
    [faculty_id, master_schedule_id]
  );
  if (loadResult.rows.length === 0) {
    return NextResponse.json({ error: 'Subject is not assigned to this faculty.' }, { status: 404 });
  }
  const load = loadResult.rows[0];
  if (load.load_category !== 'Regular') {
    return NextResponse.json({ error: 'Only a Regular Load subject can have its Lec or Lab moved to Praise Load.' }, { status: 400 });
  }

  const lec = parseFloat(String(load.lecture_hours)) || 0;
  const lab = parseFloat(String(load.laboratory_hours)) || 0;
  if (lec <= 0 || lab <= 0) {
    return NextResponse.json({ error: 'This subject has no separate Lec and Lab to split.' }, { status: 400 });
  }
  // Permanent: work units (lab × 0.75). Contractual: contact hours.
  const lecVal = lec;
  const labVal = isPermanent ? lab * 0.75 : lab;
  const movedVal = component === 'lec' ? lecVal : labVal;
  const keptVal  = component === 'lec' ? labVal : lecVal;
  const label = component === 'lec' ? 'Lecture' : 'Laboratory';

  const existing = await query(
    'SELECT id, is_praise FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2',
    [faculty_id, master_schedule_id]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    // Already-split Overload portion of this same component → just reclassify it
    if (!row.is_praise && load.overload_component === component) {
      await query('UPDATE overloads SET is_praise = true, reason = $2 WHERE id = $1',
        [row.id, `Praise Load — ${label} portion`]);
      void syncWorkloadMonitoringNotifications(true);
      return NextResponse.json({ success: true, message: `${label} moved from Overload to Praise Load.` });
    }
    return NextResponse.json({
      error: row.is_praise
        ? 'Part of this subject is already in Praise Load.'
        : 'Part of this subject is already in Overload. Return it to Regular Load first.',
    }, { status: 409 });
  }

  await transaction(async (client) => {
    await client.query(
      `UPDATE instructor_loads
       SET units = $1, hours = $2, overload_component = $3
       WHERE faculty_id = $4 AND master_schedule_id = $5`,
      [
        isPermanent ? parseFloat(keptVal.toFixed(2)) : 0,
        !isPermanent ? parseFloat(keptVal.toFixed(2)) : 0,
        component, faculty_id, master_schedule_id,
      ]
    );
    await client.query(
      `INSERT INTO overloads
         (faculty_id, master_schedule_id, units, hours, reason, academic_year, semester, is_praise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        faculty_id, master_schedule_id,
        isPermanent ? parseFloat(movedVal.toFixed(2)) : 0,
        !isPermanent ? parseFloat(movedVal.toFixed(2)) : 0,
        `Praise Load — ${label} portion`,
        load.academic_year, load.semester,
      ]
    );
  });

  void syncWorkloadMonitoringNotifications(true);
  return NextResponse.json({
    success: true,
    message: `${label} moved to Praise Load. The ${component === 'lec' ? 'Laboratory' : 'Lecture'} stays in Regular Load.`,
  });
}

/**
 * Move a whole subject straight to Praise Load. Praise has no limit, so this
 * never passes through Overload: going Regular → Overload → Praise used to be
 * refused by the Overload limit even though the subject ends up in Praise.
 * Same end state as Overload → Praise. Its schedule (days, times, rooms) is
 * not touched.
 */
async function moveWholeSubjectToPraise(
  auth: { role?: string },
  faculty_id: number | null,
  master_schedule_id: number | null,
) {
  if (faculty_id === null || master_schedule_id === null) {
    return NextResponse.json({ error: 'Faculty and subject are required.' }, { status: 400 });
  }
  if (!(await canAccessMasterSchedule(auth, master_schedule_id))) {
    return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
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

  const loadResult = await query(
    `SELECT il.load_category, c.lecture_hours, c.laboratory_hours
     FROM instructor_loads il
     JOIN master_schedule ms ON ms.id = il.master_schedule_id
     JOIN block_subjects bs  ON bs.id = ms.block_subject_id
     JOIN curriculums c      ON c.id  = bs.curriculum_id
     WHERE il.faculty_id = $1 AND il.master_schedule_id = $2`,
    [faculty_id, master_schedule_id]
  );
  if (loadResult.rows.length === 0) {
    return NextResponse.json({ error: 'Subject is not assigned to this faculty.' }, { status: 404 });
  }
  const load = loadResult.rows[0];
  if (load.load_category === 'Praise') {
    return NextResponse.json({ error: 'Subject is already in Praise Load and cannot be moved again.' }, { status: 409 });
  }
  if ((parseFloat(String(load.lecture_hours)) || 0) + (parseFloat(String(load.laboratory_hours)) || 0) <= 0) {
    return NextResponse.json({ error: 'Subject has no workload value to move' }, { status: 400 });
  }
  const praiseSplit = await query(
    'SELECT 1 FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2 AND is_praise = true',
    [faculty_id, master_schedule_id]
  );
  if (praiseSplit.rows.length > 0) {
    return NextResponse.json({ error: 'Part of this subject is in Praise Load. Return it to Regular Load first.' }, { status: 409 });
  }

  await transaction(async (client) => {
    await client.query(
      `UPDATE instructor_loads
       SET load_category = 'Praise', overload_component = 'full'
       WHERE faculty_id = $1 AND master_schedule_id = $2`,
      [faculty_id, master_schedule_id]
    );
    // Any Overload part of it goes too — the whole subject is Praise now
    await client.query('DELETE FROM overloads WHERE faculty_id = $1 AND master_schedule_id = $2', [faculty_id, master_schedule_id]);
  });

  void syncWorkloadMonitoringNotifications(true);
  return NextResponse.json({
    success: true,
    message: 'Subject moved to Praise Load. Its days, times and rooms stay the same.',
  });
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
