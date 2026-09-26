import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { loadFacultyLoadSummaries } from '@/server/facultyLoadSummaries';
import { resolveProgramScope } from '@/server/programScope';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    let programId = searchParams.get('program_id') || '';
    if (auth.role === 'program_chair') {
      const scope = await resolveProgramScope(auth, { requestedProgramId: programId || undefined });
      if (!scope.ok) return scope.response;
      programId = scope.programId != null ? String(scope.programId) : '';
    }
    const summaries = await loadFacultyLoadSummaries({
      semester: searchParams.get('semester') || '',
      academicYear: searchParams.get('academic_year') || '',
      programId,
    });

    return NextResponse.json({ summaries });
  } catch (error) {
    console.error('[GET /api/workload/summaries]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
