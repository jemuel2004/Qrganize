import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { loadFacultyLoadSummaries } from '@/server/facultyLoadSummaries';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const summaries = await loadFacultyLoadSummaries({
      semester: searchParams.get('semester') || '',
      academicYear: searchParams.get('academic_year') || '',
      programId: searchParams.get('program_id') || '',
    });

    return NextResponse.json({ summaries });
  } catch (error) {
    console.error('[GET /api/workload/summaries]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
