import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { getActiveAcademicPeriod } from '@/services/activeAcademicPeriod';
import { getChairAssignedProgramId, isScopedChair } from '@/services/programScope';
import { applyMovesIntoDay, planMovesIntoDay } from '@/services/moveIntoDay';
import { withAudit } from '@/services/audit';

/**
 * "Move into the school day" — classes of the active term with a meeting
 * outside 7:00 AM–6:00 PM (or over lunch), each with the free room and time
 * inside the day it would get (services/moveIntoDay.ts).
 *
 * GET  — the plan: each class, its faculty, where it is now and where it would go
 *        (or why it can't be moved automatically). Nothing is changed.
 * POST — moves them, through the same save as the Scheduling page; returns
 *        each class with where it went, or why it was not moved.
 */

async function scope(req: NextRequest) {
  const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
  if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) return { error: true as const };
  const programId = isScopedChair(auth) ? (auth.id ? await getChairAssignedProgramId(Number(auth.id)) : null) : undefined;
  const { semester, schoolYear } = await getActiveAcademicPeriod();
  return { error: false as const, programId, term: { semester: semester ?? '', schoolYear: schoolYear ?? '' } };
}

export async function GET(req: NextRequest) {
  try {
    const s = await scope(req);
    if (s.error) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (s.programId === null) return NextResponse.json({ term: s.term, classes: [] });
    const classes = await planMovesIntoDay(query, s.term, { programId: s.programId });
    return NextResponse.json({ term: s.term, classes });
  } catch (error) {
    console.error('[GET /api/scheduling/into-day]', error);
    return NextResponse.json({ error: 'Failed to load the classes outside the school day.' }, { status: 500 });
  }
}

async function POST_handler(req: NextRequest) {
  try {
    const s = await scope(req);
    if (s.error) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (s.programId === null) return NextResponse.json({ moved: 0, results: [] });
    const results = await applyMovesIntoDay(query, s.term, { programId: s.programId, scopedProgramId: s.programId });
    return NextResponse.json({ moved: results.filter(r => r.moved).length, results });
  } catch (error) {
    console.error('[POST /api/scheduling/into-day]', error);
    return NextResponse.json({ error: 'Failed to move the classes.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
