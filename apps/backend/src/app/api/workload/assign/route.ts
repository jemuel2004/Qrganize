import { NextRequest, NextResponse } from 'next/server';
import { parseId } from '@/database/ids';
import { readJsonObject } from '@/services/requestInput';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import {
  regularLoadLimit as termRegularLoadLimit, canHaveOverloadOrPraise, contractualLimitError, OVERLOAD_PRAISE_PERMANENT_ONLY,
  regularOverflowSplit, shownUnitsLeft,
} from '@shared/regularLoad';
import { describeMoved, saveSplit } from '@/services/praiseSplit';
import { getWorkloadPolicy } from '@/services/workloadPolicy';
import { syncWorkloadMonitoringNotifications } from '@/services/workloadMonitoring';
import { canAccessMasterSchedule, canAccessProgram } from '@/services/programScope';
import { withAudit } from '@/services/audit';
import { overloadCapError } from '@/services/overloadCap';
import { isBlockAssignedToFaculty } from '@/services/facultyBlocks';
import { createNotification } from '@/services/notifications';
import { programBlockCode } from '@shared/blockCode';

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // assign_category: 'regular' | 'overload' | undefined
    // If undefined â†’ server checks load and returns requires_confirmation
    // If provided   â†’ admin already confirmed; proceed with that category
    const body = await readJsonObject(req);
    const faculty_id = parseId(body?.faculty_id);
    const master_schedule_id = parseId(body?.master_schedule_id);
    const assign_category = body?.assign_category;

    if (!faculty_id || !master_schedule_id) {
      return NextResponse.json({ error: 'Faculty and master schedule are required' }, { status: 400 });
    }

    if (!(await canAccessMasterSchedule(auth, master_schedule_id))) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    const facultyResult = await query('SELECT * FROM faculty WHERE id=$1 AND is_active=true', [faculty_id]);
    if (facultyResult.rows.length === 0) {
      return NextResponse.json({ error: 'Faculty not found' }, { status: 404 });
    }
    const faculty = facultyResult.rows[0];
    if (!(await canAccessProgram(auth, faculty.program_id))) {
      return NextResponse.json({ error: 'Faculty not found' }, { status: 404 });
    }
    const isPermanent = faculty.employment_status === 'Permanent';

    const schedResult = await query(`
      SELECT ms.*,
        c.units AS credit_units,
        c.total_hours, c.lecture_hours, c.laboratory_hours,
        c.subject_code, c.subject_name,
        b.semester, b.academic_year, b.id AS block_id, b.block_name, b.year_level,
        p.code AS program_code
      FROM master_schedule ms
      JOIN block_subjects bs ON ms.block_subject_id = bs.id
      JOIN curriculums c ON bs.curriculum_id = c.id
      JOIN blocks b ON bs.block_id = b.id
      LEFT JOIN programs p ON p.id = b.program_id
      WHERE ms.id = $1
    `, [master_schedule_id]);

    if (schedResult.rows.length === 0) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }
    const sched = schedResult.rows[0];

    // Only blocks assigned to this faculty (Faculty → Blocks to Handle)
    if (!(await isBlockAssignedToFaculty(Number(faculty_id), Number(sched.block_id)))) {
      return NextResponse.json({
        error: `Block ${sched.block_name} is not assigned to ${faculty.name}. Add it under Faculty → Blocks to Handle first.`,
      }, { status: 403 });
    }

    if (sched.faculty_id || ['Assigned', 'Scheduled', 'Completed'].includes(String(sched.status))) {
      return NextResponse.json(
        { error: 'This subject is already assigned to a faculty member and cannot be assigned again.' },
        { status: 409 },
      );
    }

    // Duplicate guard — any existing load row (this faculty or another) blocks re-assignment.
    // Re-classification of an already-assigned subject goes through move-to-overload.
    const existingAssign = await query(
      'SELECT id, faculty_id FROM instructor_loads WHERE master_schedule_id=$1',
      [master_schedule_id]
    );
    if (existingAssign.rows.length > 0) {
      const sameFaculty = existingAssign.rows.some((r: { faculty_id: number }) => r.faculty_id === faculty_id);
      return NextResponse.json({
        error: sameFaculty
          ? 'Subject is already assigned to this faculty'
          : 'This subject is already assigned to a faculty member and cannot be assigned again.',
      }, { status: 409 });
    }

    // Current regular load for this semester (excluding this subject row in case of retry)
    const currentRegularSql = `
      SELECT COALESCE(SUM(
        CASE WHEN il.load_category = 'Regular'
          THEN CASE WHEN $1 = 'Permanent' THEN il.units ELSE il.hours END
          ELSE 0 END
      ), 0) AS regular_load
      FROM instructor_loads il
      JOIN master_schedule ms2 ON il.master_schedule_id = ms2.id
      JOIN block_subjects bs2  ON ms2.block_subject_id  = bs2.id
      JOIN blocks b2           ON bs2.block_id          = b2.id
      WHERE il.faculty_id         = $2
        AND b2.academic_year      = $3
        AND b2.semester           = $4
        AND il.master_schedule_id != $5
    `;
    const currentRegularParams = [faculty.employment_status, faculty_id, sched.academic_year, sched.semester, master_schedule_id];
    const currentLoadResult = await query(currentRegularSql, currentRegularParams);

    const currentRegular = parseFloat(currentLoadResult.rows[0].regular_load) || 0;

    const lec = parseFloat(sched.lecture_hours) || 0;
    const lab = parseFloat(sched.laboratory_hours) || 0;
    const subjectValue = isPermanent ? lec + (lab * 0.75) : parseFloat(sched.total_hours);
    const unit = isPermanent ? 'units' : 'hours';

    // Same limit the Workload page shows for this term: the term's deloading
    // (Faculty Deloading), not the designation last saved on the faculty record.
    let termDeduction = 0;
    if (isPermanent) {
      const deduction = await query(
        `SELECT COALESCE(SUM(deducted_units), 0) AS total
           FROM instructor_load_deductions
          WHERE faculty_id = $1 AND semester = $2 AND school_year = $3`,
        [faculty_id, sched.semester, sched.academic_year],
      );
      termDeduction = parseFloat(deduction.rows[0]?.total) || 0;
    }
    const regularLoadLimit = termRegularLoadLimit(isPermanent, termDeduction, await getWorkloadPolicy());
    const remainingRegular = parseFloat((regularLoadLimit - currentRegular).toFixed(10));

    // Contractual faculty can't go past their Regular Load limit (no Overload) — nothing is saved
    const limitError = (current: number) => isPermanent ? null : contractualLimitError({
      name: faculty.name, subject: sched.subject_code, currentHours: current, addHours: subjectValue, limitHours: regularLoadLimit,
    });
    const overLimit = limitError(currentRegular);
    if (overLimit) return NextResponse.json({ error: overLimit, over_limit: true }, { status: 409 });

    // Permanent: the Regular Load never goes past its limit (Settings → Workload Limits). A subject
    // that doesn't fit fills Regular up to the published cap and the rest goes to Overload — the
    // Laboratory first — within the Overload limit; otherwise it isn't assigned.
    const overflowAt = (current: number) => (isPermanent
      ? regularOverflowSplit({ currentRegular: current, limit: regularLoadLimit, lecValue: lec, labValue: lab * 0.75 })
      : null);
    const capCheck = (addUnits: number, q?: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => overloadCapError({
      facultyId: Number(faculty_id), isPermanent,
      semester: sched.semester, academicYear: sched.academic_year,
      addUnits, replacingMsIds: [Number(master_schedule_id)], q,
    });
    const doesNotFit = (capError: string) =>
      `${sched.subject_code} doesn't fit the Regular Load (${shownUnitsLeft(remainingRegular).toFixed(2)} ${unit} left), and ${capError}`;
    const overflow = assign_category === 'overload' ? null : overflowAt(currentRegular);
    if (overflow) {
      const capError = await capCheck(overflow.moved);
      if (capError) return NextResponse.json({ error: doesNotFit(capError), overload_limit_reached: true }, { status: 409 });
    }

    // ── No category provided yet: determine which confirmation is needed ─────
    if (!assign_category) {
      if (overflow) {
        // Doesn't fit the Regular Load — the admin confirms the part that goes to Overload
        return NextResponse.json({
          requires_confirmation: true,
          confirmation_type: 'overload',
          subject_code:  sched.subject_code  ?? '',
          subject_name:  sched.subject_name  ?? '',
          subject_value: subjectValue,
          unit,
          load_limit:    regularLoadLimit,
          current_load:  parseFloat(currentRegular.toFixed(4)),
          remaining:     parseFloat(remainingRegular.toFixed(4)),
          regular_part:  overflow.regular,
          overload_part: overflow.moved,
          lec_moved:     overflow.lec,
          lab_moved:     overflow.lab,
        });
      }
      // Subject fits within remaining regular capacity
      return NextResponse.json({
        requires_confirmation: true,
        confirmation_type: 'remaining_balance',
        subject_code:  sched.subject_code  ?? '',
        subject_name:  sched.subject_name  ?? '',
        subject_value: subjectValue,
        unit,
        remaining:     parseFloat(remainingRegular.toFixed(4)),
        load_limit:    regularLoadLimit,
        current_load:  parseFloat(currentRegular.toFixed(4)),
      });
    }

    // ── Admin confirmed — assign with the chosen category ────────────────────
    if (assign_category === 'overload') {
      if (!canHaveOverloadOrPraise(faculty.employment_status)) {
        return NextResponse.json({ error: OVERLOAD_PRAISE_PERMANENT_ONLY }, { status: 400 });
      }
      const capError = await capCheck(subjectValue);
      if (capError) return NextResponse.json({ error: capError, overload_limit_reached: true }, { status: 409 });
    }
    // Claim the subject and record its load together: two admins assigning at
    // once can't both pass the checks above, and a failed insert never leaves
    // a class marked Assigned with no load behind it.
    // assign_category === 'regular' (or any other value) is Regular — for a Permanent
    // faculty, whatever doesn't fit goes to Overload (above); Contractual can't go past the hours limit.
    const category = assign_category === 'overload' ? 'Overload' : 'Regular';
    type Outcome = { claimed: false } | { claimed: true; split: ReturnType<typeof overflowAt> } | { error: string; overloadLimit: boolean };
    const outcome = await transaction(async (client): Promise<Outcome> => {
      // One save at a time per faculty, so two can't both squeeze past a limit
      await client.query('SELECT id FROM faculty WHERE id = $1 FOR UPDATE', [faculty_id]);
      const fresh = await client.query(currentRegularSql, currentRegularParams);
      const freshRegular = parseFloat(fresh.rows[0].regular_load) || 0;
      const late = limitError(freshRegular);
      if (late) return { error: late, overloadLimit: false };
      const split = category === 'Regular' ? overflowAt(freshRegular) : null;
      if (split) {
        const capError = await capCheck(split.moved, (text, params) => client.query(text, params));
        if (capError) return { error: doesNotFit(capError), overloadLimit: true };
      }
      const claim = await client.query(
        `UPDATE master_schedule SET faculty_id=$1, status=$2, updated_at=NOW()
         WHERE id=$3 AND faculty_id IS NULL
           AND COALESCE(status, 'Unassigned') NOT IN ('Assigned', 'Scheduled', 'Completed')
         RETURNING id`,
        [faculty_id, 'Assigned', master_schedule_id]
      );
      if (claim.rows.length === 0) return { claimed: false };

      // A full Regular Load: the whole subject is Overload
      const stored = category === 'Overload' || (split && split.regular <= 0.001) ? 'Overload' : 'Regular';
      await client.query(`
        INSERT INTO instructor_loads
          (faculty_id, master_schedule_id, load_category, units, hours, academic_year, semester)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        faculty_id, master_schedule_id, stored,
        isPermanent  ? subjectValue : 0,
        !isPermanent ? subjectValue : 0,
        sched.academic_year, sched.semester,
      ]);

      if (stored === 'Overload') {
        // Audit record in overloads table
        await client.query('DELETE FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2', [faculty_id, master_schedule_id]);
        await client.query(`
          INSERT INTO overloads
            (faculty_id, master_schedule_id, units, hours, reason, academic_year, semester)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          faculty_id, master_schedule_id,
          isPermanent  ? subjectValue : 0,
          !isPermanent ? subjectValue : 0,
          category === 'Overload' ? 'Teaching overload — admin approved at assignment' : 'Teaching overload — Regular Load full',
          sched.academic_year, sched.semester,
        ]);
      } else if (split) {
        await saveSplit(client, {
          facultyId: Number(faculty_id), msId: Number(master_schedule_id), isPermanent: true,
          total: subjectValue, lecMoved: split.lec, labMoved: split.lab, isPraise: false,
          reason: `Split load — ${split.regular.toFixed(2)} units Regular, ${split.moved.toFixed(2)} units Overload (Regular Load full)`,
          academicYear: sched.academic_year, semester: sched.semester,
        });
      }
      return { claimed: true, split };
    });
    if ('error' in outcome) {
      return NextResponse.json(
        outcome.overloadLimit ? { error: outcome.error, overload_limit_reached: true } : { error: outcome.error, over_limit: true },
        { status: 409 },
      );
    }
    if (!outcome.claimed) {
      return NextResponse.json(
        { error: 'This subject is already assigned to a faculty member and cannot be assigned again.' },
        { status: 409 },
      );
    }
    const split = outcome.split;
    const wholeOverload = category === 'Overload' || (split !== null && split.regular <= 0.001);

    // Tell the faculty member at once — their bell and open pages update live
    const classLabel = programBlockCode(sched.program_code, sched.year_level, sched.block_name);
    await createNotification({
      recipientId: Number(faculty_id),
      recipientRole: 'instructor',
      title: 'New subject assigned',
      message: `${sched.subject_code} ${sched.subject_name}${classLabel ? ` for ${classLabel}` : ''} was added to your ${wholeOverload ? 'overload'
        : split ? `regular load (${split.regular.toFixed(2)} units) and overload (${split.moved.toFixed(2)} units)` : 'regular load'}.`,
      type: 'workload_updated',
      relatedModule: 'workload',
      relatedId: Number(master_schedule_id),
    });

    void syncWorkloadMonitoringNotifications(true);
    if (wholeOverload) {
      return NextResponse.json({
        success: true,
        load_category: 'Overload',
        message: category === 'Overload'
          ? `Subject assigned as overload (${subjectValue.toFixed(2)} ${unit}).`
          : `The Regular Load is full, so the subject was assigned as overload (${subjectValue.toFixed(2)} ${unit}).`,
        // Overload doesn't count against the regular limit, so the regular balance is unchanged.
        remaining: parseFloat(remainingRegular.toFixed(2)),
        unit,
      });
    }
    if (split) {
      return NextResponse.json({
        success: true,
        load_category: 'Regular',
        split: { regular_part: split.regular, overload_part: split.moved, lec_moved: split.lec, lab_moved: split.lab },
        message: `${split.regular.toFixed(2)} ${unit} in Regular Load (now full); ${describeMoved(split.lec, split.lab)} ${unit} moved to Overload.`,
        remaining: parseFloat((remainingRegular - split.regular).toFixed(2)),
        unit,
      });
    }

    const remainingAfter = parseFloat((remainingRegular - subjectValue).toFixed(2));
    return NextResponse.json({
      success: true,
      load_category: 'Regular',
      message: 'Subject assigned successfully within regular load.',
      remaining: remainingAfter,
      unit,
    });
  } catch (error) {
    console.error('[POST /api/workload/assign]', error);
    return NextResponse.json({ error: 'Failed to assign workload.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
