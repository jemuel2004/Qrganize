import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { loadPlanningTerms, loadRoomPlanning } from '@/services/roomPlanning';

/**
 * GET /api/rooms/demand[?semester=…&academic_year=…]
 *
 * Room Planning — whether the rooms of each kind (lecture rooms, laboratories,
 * PATHFIT venues) are enough for the term's class schedule: simultaneous
 * demand per time slot vs. usable rooms, classes without a suitable room, and
 * the rooms to add now and once the classes not scheduled yet are (an
 * estimate). Schedule-based only, never QR scans; see @shared/roomPlanning.
 * Defaults to the active term. `terms` lists the terms with classes.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const active = await getActiveAcademicPeriod();
    const semester = searchParams.get('semester')?.trim().slice(0, 30) || active.semester || '';
    const academicYear = searchParams.get('academic_year')?.trim().slice(0, 20) || active.schoolYear || '';

    const [planning, terms] = await Promise.all([
      loadRoomPlanning({ semester, academicYear }),
      loadPlanningTerms(),
    ]);

    return NextResponse.json({
      term: { semester: semester || null, school_year: academicYear || null },
      active: { semester: active.semester, school_year: active.schoolYear },
      terms,
      planning,
    });
  } catch (error) {
    console.error('[GET /api/rooms/demand]', error);
    return NextResponse.json({ error: 'Failed to load room planning.' }, { status: 500 });
  }
}
