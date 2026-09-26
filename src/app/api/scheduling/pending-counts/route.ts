import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { getActiveAcademicPeriod } from '@/server/activeAcademicPeriod';
import { loadFacultyLoadSummaries } from '@/server/facultyLoadSummaries';
import { fetchBlocksWithAssignmentCounts } from '@/server/blockAssignmentCounts';
import { getChairAssignedProgramId } from '@/server/programScope';

/**
 * Nav badge counts for the Scheduling dropdown — how many items still need
 * attention on Faculty Workload, Master Schedule, and Faculty Schedules.
 * Reuses the exact same completion logic each of those pages already uses
 * (loadFacultyLoadSummaries / fetchBlocksWithAssignmentCounts), scoped to the
 * admin-configured active academic period so the numbers match what an admin
 * sees by default when opening each page.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { schoolYear, semester } = await getActiveAcademicPeriod();

    // Department Chairs only see counts for their own assigned program —
    // Admins see the global count across every program.
    const chairProgramId = auth.role === 'program_chair' && auth.id
      ? await getChairAssignedProgramId(Number(auth.id))
      : null;
    if (auth.role === 'program_chair' && !chairProgramId) {
      return NextResponse.json({ workload: 0, masterSchedule: 0, facultySchedule: 0 });
    }

    const [summaries, blocks, facultyScheduleRes] = await Promise.all([
      loadFacultyLoadSummaries({ semester: semester ?? '', academicYear: schoolYear ?? '', programId: chairProgramId ? String(chairProgramId) : '' }),
      fetchBlocksWithAssignmentCounts({ semester: semester ?? '', academicYear: schoolYear ?? '', programId: chairProgramId }),
      query(`
        SELECT COUNT(DISTINCT il.faculty_id)::int AS count
        FROM instructor_loads il
        JOIN master_schedule ms ON il.master_schedule_id = ms.id
        JOIN faculty f ON il.faculty_id = f.id
        WHERE f.is_active = true
          AND ms.status <> 'Scheduled'
          AND ($1 = '' OR il.semester = $1)
          AND ($2 = '' OR il.academic_year = $2)
          AND ($3::int IS NULL OR f.program_id = $3)
      `, [semester ?? '', schoolYear ?? '', chairProgramId]).catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    // Faculty Workload — instructors who haven't yet reached their required load.
    // A small epsilon avoids floating-point noise flagging an exact match as incomplete.
    const workload = Object.values(summaries).filter(s => s.remaining_load > 0.01).length;

    // Master Schedule — blocks with subjects loaded that aren't fully Scheduled yet.
    const masterSchedule = blocks.filter(b => b.subject_count > 0 && b.scheduled_count < b.subject_count).length;

    // Faculty Schedules — instructors with at least one assigned load that isn't time-scheduled yet.
    const facultySchedule = Number(facultyScheduleRes.rows[0]?.count ?? 0);

    return NextResponse.json({ workload, masterSchedule, facultySchedule });
  } catch (error) {
    console.error('[GET /api/scheduling/pending-counts]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
