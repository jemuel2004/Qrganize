import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { loadFacultyLoadSummaries } from '@/server/facultyLoadSummaries';
import { syncWorkloadMonitoringNotifications } from '@/server/workloadMonitoring';

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  try {
    await query(`ALTER TABLE instructor_loads ADD COLUMN IF NOT EXISTS overload_component VARCHAR(10) DEFAULT 'full'`);
    schemaReady = true;
  } catch (e) {
    console.error('[move-to-overload] ensureSchema DDL failed — will retry:', e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await ensureSchema();

    const { faculty_id, master_schedule_id, split_regular, component } = await req.json();
    const overloadComponent: string = component || 'full';

    if (!faculty_id || !master_schedule_id) {
      return NextResponse.json({ error: 'Faculty and master schedule are required' }, { status: 400 });
    }

    const facultyResult = await query('SELECT * FROM faculty WHERE id=$1 AND is_active=true', [faculty_id]);
    if (facultyResult.rows.length === 0) {
      return NextResponse.json({ error: 'Faculty not found' }, { status: 404 });
    }
    const faculty = facultyResult.rows[0];
    const isPermanent = faculty.employment_status === 'Permanent';

    const loadResult = await query(
      'SELECT * FROM instructor_loads WHERE faculty_id=$1 AND master_schedule_id=$2',
      [faculty_id, master_schedule_id]
    );
    if (loadResult.rows.length === 0) {
      return NextResponse.json({ error: 'Subject is not assigned to this instructor' }, { status: 404 });
    }
    const loadRow = loadResult.rows[0];

    // Use curriculum data as the authoritative total — instructor_loads.units/hours may be
    // reduced from a previous split, so using the curriculum ensures correct re-split math.
    const curriculumResult = await query(`
      SELECT c.units, c.total_hours, c.lecture_hours, c.laboratory_hours
      FROM master_schedule ms
      JOIN block_subjects bs ON ms.block_subject_id = bs.id
      JOIN curriculums c ON bs.curriculum_id = c.id
      WHERE ms.id = $1
    `, [master_schedule_id]);

    let subjectTotal: number;
    if (curriculumResult.rows.length > 0) {
      const cur = curriculumResult.rows[0];
      const lec = parseFloat(cur.lecture_hours) || 0;
      const lab = parseFloat(cur.laboratory_hours) || 0;
      const totalH = parseFloat(cur.total_hours) || 0;
      subjectTotal = isPermanent ? lec + lab * 0.75 : totalH;
    } else {
      // Fall back to stored value if curriculum join fails
      subjectTotal = isPermanent
        ? parseFloat(loadRow.units) || 0
        : parseFloat(loadRow.hours) || 0;
    }

    if (subjectTotal <= 0.001) {
      return NextResponse.json({ error: 'Subject has no workload value to move' }, { status: 400 });
    }

    const unit = isPermanent ? 'units' : 'hours';

    const summaries = await loadFacultyLoadSummaries({
      semester: String(loadRow.semester || ''),
      academicYear: String(loadRow.academic_year || ''),
    });
    const summary = summaries[faculty_id];
    const excess = Math.max(0, (summary?.current_load ?? 0) - (summary?.regular_load_limit ?? 0));

    // ── Split mode ─────────────────────────────────────────────────────────────
    if (split_regular !== undefined && split_regular !== null) {
      const regularPart = parseFloat(String(split_regular));
      if (isNaN(regularPart) || regularPart < 0) {
        return NextResponse.json({ error: 'Invalid split_regular value' }, { status: 400 });
      }
      const overloadPart = parseFloat((subjectTotal - regularPart).toFixed(10));
      if (overloadPart <= 0.001) {
        return NextResponse.json({ error: 'Overload portion must be greater than 0. Reduce the regular amount.' }, { status: 400 });
      }
      if (regularPart > subjectTotal + 0.001) {
        return NextResponse.json({ error: 'Regular portion cannot exceed subject total' }, { status: 400 });
      }
      if (overloadPart > excess + 0.001) {
        return NextResponse.json({
          error: `Selected overload (${overloadPart.toFixed(2)} ${unit}) exceeds excess workload (${excess.toFixed(2)} ${unit}).`,
        }, { status: 400 });
      }

      await query(
        `UPDATE instructor_loads
         SET load_category = 'Regular', units = $1, hours = $2, overload_component = $3
         WHERE faculty_id = $4 AND master_schedule_id = $5`,
        [
          isPermanent ? parseFloat(regularPart.toFixed(2)) : 0,
          !isPermanent ? parseFloat(regularPart.toFixed(2)) : 0,
          overloadComponent,
          faculty_id, master_schedule_id,
        ]
      );

      // Upsert: delete any existing overloads row then insert the new one
      await query('DELETE FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2', [faculty_id, master_schedule_id]);
      await query(`
        INSERT INTO overloads
          (faculty_id, master_schedule_id, units, hours, reason, academic_year, semester)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [
        faculty_id, master_schedule_id,
        isPermanent ? parseFloat(overloadPart.toFixed(2)) : 0,
        !isPermanent ? parseFloat(overloadPart.toFixed(2)) : 0,
        `Split load — ${regularPart.toFixed(2)} ${unit} Regular, ${overloadPart.toFixed(2)} ${unit} Overload`,
        loadRow.academic_year, loadRow.semester,
      ]);

    void syncWorkloadMonitoringNotifications(true);
    return NextResponse.json({
      success: true,
      split: true,
        regular_part: parseFloat(regularPart.toFixed(2)),
        overload_part: parseFloat(overloadPart.toFixed(2)),
        unit,
        message: `Subject split: ${regularPart.toFixed(2)} ${unit} Regular + ${overloadPart.toFixed(2)} ${unit} Overload.`,
      });
    }

    // ── Entire move mode ───────────────────────────────────────────────────────
    if (loadRow.load_category === 'Overload') {
      return NextResponse.json({ error: 'Subject is already classified as overload' }, { status: 409 });
    }
    if (loadRow.load_category === 'Praise') {
      return NextResponse.json({ error: 'Subject is in Praise Load. Return it to Overload first if needed.' }, { status: 409 });
    }
    if (subjectTotal > excess + 0.001) {
      return NextResponse.json({
        error: `Selected overload (${subjectTotal.toFixed(2)} ${unit}) exceeds excess workload (${excess.toFixed(2)} ${unit}).`,
      }, { status: 400 });
    }

    await query(
      "UPDATE instructor_loads SET load_category='Overload', overload_component='full' WHERE faculty_id=$1 AND master_schedule_id=$2",
      [faculty_id, master_schedule_id]
    );

    await query('DELETE FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2', [faculty_id, master_schedule_id]);
    await query(`
      INSERT INTO overloads
        (faculty_id, master_schedule_id, units, hours, reason, academic_year, semester)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      faculty_id, master_schedule_id,
      isPermanent  ? parseFloat(subjectTotal.toFixed(2)) : 0,
      !isPermanent ? parseFloat(subjectTotal.toFixed(2)) : 0,
      'Teaching overload — manually promoted by admin',
      loadRow.academic_year, loadRow.semester,
    ]);

    void syncWorkloadMonitoringNotifications(true);
    return NextResponse.json({
      success: true,
      split: false,
      overload_value: parseFloat(subjectTotal.toFixed(2)),
      unit,
      message: `Subject moved to overload (${subjectTotal.toFixed(2)} ${unit}).`,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
