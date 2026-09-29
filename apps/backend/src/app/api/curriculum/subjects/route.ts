import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { mergeSameSubjects } from '@shared/subjectCode';

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

    // Spelling used by the most programs first (then the fuller one, since typos
    // usually drop a letter), so it becomes the one shown.
    const result = await query(`
      SELECT subject_code, subject_name
      FROM curriculums
      WHERE is_active = true
      GROUP BY subject_code, subject_name
      ORDER BY COUNT(DISTINCT program_id) DESC, LENGTH(subject_name) DESC, subject_code, subject_name
    `);

    // Same code + same (or nearly the same) title across programs is one subject.
    const subjects = mergeSameSubjects(result.rows as Array<{ subject_code: string; subject_name: string }>)
      .sort((a, b) =>
        a.subject_code.localeCompare(b.subject_code, undefined, { numeric: true })
        || a.subject_name.localeCompare(b.subject_name));

    return NextResponse.json({ subjects });
  } catch (error) {
    console.error('[GET /api/curriculum/subjects]', error);
    return NextResponse.json({ error: 'Failed to load subjects.' }, { status: 500 });
  }
}
