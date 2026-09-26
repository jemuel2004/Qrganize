import { NextRequest, NextResponse } from 'next/server';
import { transaction } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { syncWorkloadMonitoringNotifications } from '@/server/workloadMonitoring';
import { canAccessMasterSchedule } from '@/server/programScope';

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { faculty_id, master_schedule_id, return_units } = await req.json();

    if (!faculty_id || !master_schedule_id) {
      return NextResponse.json(
        { error: 'faculty_id and master_schedule_id are required' },
        { status: 400 }
      );
    }

    if (!(await canAccessMasterSchedule(auth, master_schedule_id))) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

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
      const curriculumUnits = parseFloat(curriculum.units) || 0;
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
      const returnValue = isPartial
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

      // Maximum Regular Load is a monitoring threshold, not a hard block.

      // Partial return only for split overloads (full overloads have nothing in regular yet)
      if (isPartial && isFullOverload && Math.abs(returnValue - currentOverloadValue) > 0.001) {
        throw new Error('Partial return is only available for split overload subjects');
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
            isPermanent ? curriculumUnits : 0,
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
            isPermanent ? curriculumUnits : 0,
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

      await client.query(
        `UPDATE instructor_loads
         SET units = $1, hours = $2
         WHERE faculty_id = $3 AND master_schedule_id = $4`,
        [
          isPermanent ? newRegularValue : 0,
          !isPermanent ? newRegularValue : 0,
          faculty_id, master_schedule_id,
        ]
      );
      await client.query(
        `UPDATE overloads
         SET units = $1, hours = $2
         WHERE faculty_id = $3 AND master_schedule_id = $4`,
        [
          isPermanent ? remainingOverload : 0,
          !isPermanent ? remainingOverload : 0,
          faculty_id, master_schedule_id,
        ]
      );
      return {
        message: `${returnValue.toFixed(2)} ${isPermanent ? 'units' : 'hrs'} returned to Regular Load.`,
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
