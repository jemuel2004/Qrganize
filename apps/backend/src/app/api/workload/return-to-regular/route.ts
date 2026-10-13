import { NextRequest, NextResponse } from 'next/server';
import { parseId } from '@/database/ids';
import { readJsonObject } from '@/services/requestInput';
import { transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { syncWorkloadMonitoringNotifications } from '@/services/workloadMonitoring';
import { canAccessMasterSchedule } from '@/services/programScope';
import { withAudit } from '@/services/audit';
import { describeMoved, ensurePraiseSplitColumn, saveSplit } from '@/services/praiseSplit';
import { getWorkloadPolicy } from '@/services/workloadPolicy';
import { movedComponent } from '@shared/loadSplit';
import { formatLoadCap, regularLoadLimit, regularOverflowSplit, shownUnitsCap } from '@shared/regularLoad';

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await readJsonObject(req);
    const faculty_id = parseId(body?.faculty_id);
    const master_schedule_id = parseId(body?.master_schedule_id);
    const return_units = body?.return_units;

    if (!faculty_id || !master_schedule_id) {
      return NextResponse.json(
        { error: 'faculty_id and master_schedule_id are required' },
        { status: 400 }
      );
    }

    if (!(await canAccessMasterSchedule(auth, master_schedule_id))) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    await ensurePraiseSplitColumn();
    const result = await transaction(async (client) => {
      // 1. Faculty
      const facultyResult = await client.query(
        'SELECT * FROM faculty WHERE id=$1 AND is_active=true',
        [faculty_id]
      );
      if (facultyResult.rows.length === 0) throw new Error('Faculty not found');
      const faculty = facultyResult.rows[0];
      const isPermanent = faculty.employment_status === 'Permanent';

      // 2. Load row
      const loadResult = await client.query(
        'SELECT * FROM instructor_loads WHERE faculty_id=$1 AND master_schedule_id=$2',
        [faculty_id, master_schedule_id]
      );
      if (loadResult.rows.length === 0) throw new Error('Assignment not found');
      const loadRow = loadResult.rows[0];

      // 3. Overload row — must exist
      const overloadResult = await client.query(
        'SELECT * FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2',
        [faculty_id, master_schedule_id]
      );
      if (overloadResult.rows.length === 0) {
        throw new Error('No overload record found for this assignment');
      }
      const overloadRow = overloadResult.rows[0];

      const isFullOverload = loadRow.load_category === 'Overload';
      const isSplitOverload = loadRow.load_category === 'Regular';

      if (!isFullOverload && !isSplitOverload) {
        throw new Error('This subject has no overload to return to regular load');
      }

      // 4. Curriculum — authoritative source for restoring full unit values
      const curriculumResult = await client.query(
        `SELECT c.units, c.total_hours, c.lecture_hours, c.laboratory_hours
         FROM master_schedule ms
         JOIN block_subjects bs ON ms.block_subject_id = bs.id
         JOIN curriculums c      ON bs.curriculum_id   = c.id
         WHERE ms.id = $1`,
        [master_schedule_id]
      );
      if (curriculumResult.rows.length === 0) throw new Error('Curriculum data not found');
      const curriculum = curriculumResult.rows[0];
      // The whole subject's value, as the assign route stores it: work units for Permanent
      // faculty (Lecture hours + 0.75 × Laboratory hours) — not the curriculum's credit
      // units, which differ for any subject with a Laboratory — and contact hours otherwise.
      const subjectUnits = parseFloat((
        (parseFloat(curriculum.lecture_hours) || 0) + (parseFloat(curriculum.laboratory_hours) || 0) * 0.75
      ).toFixed(2));
      const curriculumHours = parseFloat(curriculum.total_hours) || 0;

      // 5. Current overload values from the overloads row
      const currentOverloadValue = isPermanent
        ? parseFloat(String(overloadRow.units)) || 0
        : parseFloat(String(overloadRow.hours)) || 0;

      if (currentOverloadValue <= 0) {
        throw new Error('Overload record has zero value — nothing to return');
      }

      // 6. Determine how much to return
      const isPartial = return_units !== undefined && return_units !== null;
      let returnValue = isPartial
        ? parseFloat(String(return_units))
        : currentOverloadValue;

      if (isNaN(returnValue) || returnValue <= 0) {
        throw new Error('Return amount must be greater than 0');
      }
      if (returnValue > currentOverloadValue + 0.001) {
        throw new Error(
          `Cannot return ${returnValue.toFixed(2)} — only ${currentOverloadValue.toFixed(2)} ${isPermanent ? 'units' : 'hrs'} are in overload`
        );
      }

      // Partial return only for split overloads (full overloads have nothing in regular yet)
      if (isPartial && isFullOverload && Math.abs(returnValue - currentOverloadValue) > 0.001) {
        throw new Error('Partial return is only available for split overload subjects');
      }

      // The Regular Load never goes past its limit (Settings → Workload Limits). Only what fits
      // comes back — up to the published cap — and the rest stays in Overload, the Laboratory
      // first. Nothing fits → refused. Contractual hours have no grace and no partial return.
      const unit = isPermanent ? 'units' : 'hours';
      const deduction = isPermanent ? parseFloat(String((await client.query(
        `SELECT COALESCE(SUM(deducted_units), 0) AS total FROM instructor_load_deductions
          WHERE faculty_id = $1 AND semester = $2 AND school_year = $3`,
        [faculty_id, loadRow.semester, loadRow.academic_year],
      )).rows[0]?.total ?? 0)) || 0 : 0;
      const limit = regularLoadLimit(isPermanent, deduction, await getWorkloadPolicy());
      const currentRegular = parseFloat(String((await client.query(
        `SELECT COALESCE(SUM(CASE WHEN $2::boolean THEN units ELSE hours END), 0) AS total FROM instructor_loads
          WHERE faculty_id = $1 AND load_category = 'Regular' AND academic_year = $3 AND semester = $4`,
        [faculty_id, isPermanent, loadRow.academic_year, loadRow.semester],
      )).rows[0]?.total ?? 0)) || 0;
      let capped = false;
      if (returnValue > limit - currentRegular + 0.001) {
        const shownCap = isPermanent ? shownUnitsCap(limit) : limit;
        const fits = Math.max(0, parseFloat((shownCap - currentRegular).toFixed(2)));
        if (!isPermanent || fits <= 0.001) {
          throw new Error(`Cannot return it — the Regular Load is ${currentRegular.toFixed(2)} of ${formatLoadCap(shownCap)} ${unit}`
            + (fits <= 0.001 ? ', already full.' : `, and Contractual faculty can't go past ${formatLoadCap(shownCap)} ${unit}.`));
        }
        if (isFullOverload) {
          // Part of the subject comes back: it becomes a split, the rest stays in Overload
          const lecValue = parseFloat(curriculum.lecture_hours) || 0;
          const labValue = (parseFloat(curriculum.laboratory_hours) || 0) * 0.75;
          const split = regularOverflowSplit({ currentRegular, limit, lecValue, labValue });
          if (!split || split.regular <= 0.001) throw new Error('Cannot return it — the Regular Load is already full.');
          await saveSplit(client, {
            facultyId: Number(faculty_id), msId: Number(master_schedule_id), isPermanent: true,
            total: subjectUnits, lecMoved: split.lec, labMoved: split.lab, isPraise: false,
            reason: `Split load — ${split.regular.toFixed(2)} units Regular, ${split.moved.toFixed(2)} units Overload (Regular Load full)`,
            academicYear: loadRow.academic_year, semester: loadRow.semester,
          });
          return {
            message: `${split.regular.toFixed(2)} units returned to Regular Load (now full); ${describeMoved(split.lec, split.lab)} units stay in Overload.`,
          };
        }
        returnValue = fits;
        capped = true;
      }

      const remainingOverload = parseFloat((currentOverloadValue - returnValue).toFixed(4));
      const isEntireReturn = remainingOverload < 0.001;

      if (isFullOverload) {
        // Move entire subject from Overload category back to Regular
        await client.query(
          `UPDATE instructor_loads
           SET load_category    = 'Regular',
               units            = $1,
               hours            = $2,
               overload_component = 'full'
           WHERE faculty_id = $3 AND master_schedule_id = $4`,
          [
            isPermanent ? subjectUnits : 0,
            !isPermanent ? curriculumHours : 0,
            faculty_id, master_schedule_id,
          ]
        );
        await client.query(
          'DELETE FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2',
          [faculty_id, master_schedule_id]
        );
        return { message: 'Subject moved from Overload back to Regular Load.' };
      }

      if (isSplitOverload && isEntireReturn) {
        // Return the entire overload portion → restore to full curriculum values
        await client.query(
          `UPDATE instructor_loads
           SET units              = $1,
               hours              = $2,
               overload_component = 'full'
           WHERE faculty_id = $3 AND master_schedule_id = $4`,
          [
            isPermanent ? subjectUnits : 0,
            !isPermanent ? curriculumHours : 0,
            faculty_id, master_schedule_id,
          ]
        );
        await client.query(
          'DELETE FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2',
          [faculty_id, master_schedule_id]
        );
        return {
          message: overloadRow.is_praise
            ? 'Praise Load portion returned to Regular Load.'
            : 'Overload portion fully returned to Regular Load.',
        };
      }

      // Partial return: add returnValue to regular, subtract from overload
      const currentRegularValue = isPermanent
        ? parseFloat(String(loadRow.units)) || 0
        : parseFloat(String(loadRow.hours)) || 0;
      const newRegularValue = parseFloat((currentRegularValue + returnValue).toFixed(4));
      // A Lecture + Laboratory split: the Laboratory comes back first, the Lecture's share stays as far as it fits
      const oldLecPart = overloadRow.lec_part === null || overloadRow.lec_part === undefined
        ? null : parseFloat(String(overloadRow.lec_part)) || 0;
      const newLecPart = oldLecPart === null ? null : Math.min(oldLecPart, remainingOverload);

      await client.query(
        `UPDATE instructor_loads
         SET units = $1, hours = $2,
             overload_component = COALESCE($5, overload_component)
         WHERE faculty_id = $3 AND master_schedule_id = $4`,
        [
          isPermanent ? newRegularValue : 0,
          !isPermanent ? newRegularValue : 0,
          faculty_id, master_schedule_id,
          newLecPart === null ? null : movedComponent(newLecPart, remainingOverload - newLecPart),
        ]
      );
      await client.query(
        `UPDATE overloads
         SET units = $1, hours = $2, lec_part = $5
         WHERE faculty_id = $3 AND master_schedule_id = $4`,
        [
          isPermanent ? remainingOverload : 0,
          !isPermanent ? remainingOverload : 0,
          faculty_id, master_schedule_id,
          newLecPart,
        ]
      );
      return {
        message: `${returnValue.toFixed(2)} ${isPermanent ? 'units' : 'hrs'} returned to Regular Load.`
          + (capped ? ' The Regular Load is now full; the rest stays in Overload.' : ''),
      };
    });

    void syncWorkloadMonitoringNotifications(true);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isClientError = [
      'not found', 'no overload', 'cannot return', 'partial return', 'must be greater', 'zero value',
    ].some(s => msg.toLowerCase().includes(s));
    return NextResponse.json({ error: msg }, { status: isClientError ? 400 : 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
