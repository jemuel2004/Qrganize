import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';

/**
 * All distinct active curriculum subjects across every program — used by the
 * "Subjects to Handle" picker, which is deliberately not scoped to a single
 * program (an instructor's priority subjects can come from any program).
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const result = await query(`
      SELECT DISTINCT ON (subject_code) subject_code, subject_name
      FROM curriculums
      WHERE is_active = true
      ORDER BY subject_code, subject_name
    `);

    return NextResponse.json({ subjects: result.rows });
  } catch (error) {
    console.error('[GET /api/curriculum/subjects]', error);
    return NextResponse.json({ error: 'Failed to load subjects.' }, { status: 500 });
  }
}
