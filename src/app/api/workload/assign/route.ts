import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import {
  CONTRACTUAL_REGULAR_HOURS_LIMIT,
  permanentRegularLoadLimit,
} from '@/lib/regularLoad';
import { syncWorkloadMonitoringNotifications } from '@/server/workloadMonitoring';
import { canAccessMasterSchedule, canAccessProgram } from '@/server/programScope';

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // assign_category: 'regular' | 'overload' | undefined
    // If undefined â†’ server checks load and returns requires_confirmation
    // If provided   â†’ admin already confirmed; proceed with that category
    const { faculty_id, master_schedule_id, assign_category } = await req.json();

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
        b.semester, b.academic_year
      FROM master_schedule ms
      JOIN block_subjects bs ON ms.block_subject_id = bs.id
      JOIN curriculums c ON bs.curriculum_id = c.id
      JOIN blocks b ON bs.block_id = b.id
      WHERE ms.id = $1
    `, [master_schedule_id]);

    if (schedResult.rows.length === 0) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }
    const sched = schedResult.rows[0];

    if (sched.faculty_id || ['Assigned', 'Scheduled', 'Completed'].includes(String(sched.status))) {
      return NextResponse.json(
        { error: 'This subject is already assigned to an instructor and cannot be assigned again.' },
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
          ? 'Subject is already assigned to this instructor'
          : 'This subject is already assigned to an instructor and cannot be assigned again.',
      }, { status: 409 });
    }

    // Current regular load for this semester (excluding this subject row in case of retry)
    const currentLoadResult = await query(`
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
    `, [faculty.employment_status, faculty_id, sched.academic_year, sched.semester, master_schedule_id]);

    const currentRegular = parseFloat(currentLoadResult.rows[0].regular_load) || 0;

    const lec = parseFloat(sched.lecture_hours) || 0;
    const lab = parseFloat(sched.laboratory_hours) || 0;
    const subjectValue = isPermanent ? lec + (lab * 0.75) : parseFloat(sched.total_hours);
    const unit = isPermanent ? 'units' : 'hours';

    const regularLoadLimit = isPermanent
      ? permanentRegularLoadLimit(parseFloat(faculty.designation_units))
      : CONTRACTUAL_REGULAR_HOURS_LIMIT;
    const remainingRegular = parseFloat((regularLoadLimit - currentRegular).toFixed(10));

    // ── No category provided yet: determine which confirmation is needed ─────
    if (!assign_category) {
      // Overload warning if: load already full OR this subject would exceed the limit
      const willExceed = subjectValue > remainingRegular + 0.001;
      if (willExceed || remainingRegular <= 0.001) {
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
        });
      } else {
        // Subject fits within remaining regular capacity — still ask admin to confirm
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
    }

    // ── Admin confirmed — assign with the chosen category ────────────────────
    await query(
      'UPDATE master_schedule SET faculty_id=$1, status=$2, updated_at=NOW() WHERE id=$3',
      [faculty_id, 'Assigned', master_schedule_id]
    );

    if (assign_category === 'overload') {
      // Full subject goes into instructor_loads as Overload
      await query(`
        INSERT INTO instructor_loads
          (faculty_id, master_schedule_id, load_category, units, hours, academic_year, semester)
        VALUES ($1, $2, 'Overload', $3, $4, $5, $6)
      `, [
        faculty_id, master_schedule_id,
        isPermanent  ? subjectValue : 0,
        !isPermanent ? subjectValue : 0,
        sched.academic_year, sched.semester,
      ]);

      // Audit record in overloads table
      await query('DELETE FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2', [faculty_id, master_schedule_id]);
      await query(`
        INSERT INTO overloads
          (faculty_id, master_schedule_id, units, hours, reason, academic_year, semester)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        faculty_id, master_schedule_id,
        isPermanent  ? subjectValue : 0,
        !isPermanent ? subjectValue : 0,
        'Teaching overload — admin approved at assignment',
        sched.academic_year, sched.semester,
      ]);

      void syncWorkloadMonitoringNotifications(true);
      return NextResponse.json({
        success: true,
        load_category: 'Overload',
        message: `Subject assigned as overload (${subjectValue.toFixed(2)} ${unit}).`,
        // Overload doesn't count against the regular limit, so the regular balance is unchanged.
        remaining: parseFloat(remainingRegular.toFixed(2)),
        unit,
      });
    }

    // assign_category === 'regular' (or any other value defaults to Regular)
    // Admin chose to add within regular — store full value as Regular even if it
    // temporarily exceeds the limit. Admin can promote to Overload manually later.
    await query(`
      INSERT INTO instructor_loads
        (faculty_id, master_schedule_id, load_category, units, hours, academic_year, semester)
      VALUES ($1, $2, 'Regular', $3, $4, $5, $6)
    `, [
      faculty_id, master_schedule_id,
      isPermanent  ? subjectValue : 0,
      !isPermanent ? subjectValue : 0,
      sched.academic_year, sched.semester,
    ]);

    void syncWorkloadMonitoringNotifications(true);
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
