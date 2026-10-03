import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { ensureFacultyActivitiesTable } from '@/database/facultyActivitiesSchema';
import { canAccessProgram } from '@/services/programScope';
import { withAudit } from '@/services/audit';

/*
 * A faculty member's non-teaching time (Consultation, Flag Ceremony, …) for
 * one term. It is not teaching load; it only blocks the faculty's
 * availability when classes are scheduled (services/scheduleConflicts.ts).
 */

const STAFF = ['admin', 'department_chair', 'program_chair'];

type Scope = { ok: true; id: number } | { ok: false; response: NextResponse };

async function facultyInScope(req: NextRequest, idRaw: string): Promise<Scope> {
  const auth = await getAuthUser(req) as { role?: string } | null;
  if (!auth || !STAFF.includes(auth.role ?? '')) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, response: NextResponse.json({ error: 'Faculty not found.' }, { status: 404 }) };
  const owner = await query('SELECT program_id FROM faculty WHERE id = $1', [id]);
  if (!owner.rows[0] || !(await canAccessProgram(auth, owner.rows[0].program_id))) {
    return { ok: false, response: NextResponse.json({ error: 'Faculty not found.' }, { status: 404 }) };
  }
  return { ok: true, id };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = await facultyInScope(req, (await params).id);
    if (!scope.ok) return scope.response;
    await ensureFacultyActivitiesTable();
    const { searchParams } = new URL(req.url);
    const result = await query(
      `SELECT id, day_of_week, start_time::text AS start_time, end_time::text AS end_time, activity, source
         FROM faculty_activities
        WHERE faculty_id = $1
          AND ($2 = '' OR academic_year = $2) AND ($3 = '' OR semester = $3)
        ORDER BY CASE day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
                   WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END, start_time`,
      [scope.id, searchParams.get('academic_year') ?? '', searchParams.get('semester') ?? ''],
    );
    return NextResponse.json({ activities: result.rows });
  } catch (error) {
    console.error('[GET /api/faculty/[id]/activities]', error);
    return NextResponse.json({ error: 'Failed to load non-teaching time.' }, { status: 500 });
  }
}

/** Remove one entry (?activity_id=…) */
async function DELETE_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = await facultyInScope(req, (await params).id);
    if (!scope.ok) return scope.response;
    await ensureFacultyActivitiesTable();
    const activityId = Number(new URL(req.url).searchParams.get('activity_id'));
    if (!Number.isInteger(activityId) || activityId <= 0) {
      return NextResponse.json({ error: 'Choose the entry to remove.' }, { status: 400 });
    }
    const removed = await query('DELETE FROM faculty_activities WHERE id = $1 AND faculty_id = $2 RETURNING id', [activityId, scope.id]);
    if (!removed.rows[0]) return NextResponse.json({ error: 'That entry no longer exists.' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/faculty/[id]/activities]', error);
    return NextResponse.json({ error: 'Failed to remove the entry.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const DELETE = withAudit(DELETE_handler);
