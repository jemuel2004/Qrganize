import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { loadFacultyLoadSummaries } from '@/services/facultyLoadSummaries';
import { resolveProgramScope, isScopedChair } from '@/services/programScope';
import { loadUnscheduledByFaculty } from '@/services/unscheduledClasses';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    let programId = searchParams.get('program_id') || '';
    if (isScopedChair(auth)) {
      const scope = await resolveProgramScope(auth, { requestedProgramId: programId || undefined });
      if (!scope.ok) return scope.response;
      programId = scope.programId != null ? String(scope.programId) : '';
    }
    const term = { semester: searchParams.get('semester') || '', academicYear: searchParams.get('academic_year') || '' };
    const [summaries, unscheduled] = await Promise.all([
      loadFacultyLoadSummaries({ ...term, programId }),
      loadUnscheduledByFaculty({ ...term, programId: programId || null }),
    ]);

    return NextResponse.json({ summaries, unscheduled });
  } catch (error) {
    console.error('[GET /api/workload/summaries]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
