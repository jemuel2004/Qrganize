import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { canAccessMasterSchedule } from '@/server/programScope';
import { findScheduleConflicts, validateSessions, type ConflictSessionInput } from '@/server/scheduleConflicts';

/**
 * Preview conflicts for sessions before saving. Uses the same rules as the
 * save route (src/server/scheduleConflicts.ts), so "no conflicts" here means
 * the save won't be refused for a conflict.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { master_schedule_id, sessions, semester, academic_year, component } = await req.json() as {
      master_schedule_id: number;
      sessions: ConflictSessionInput[];
      semester?: string;
      academic_year?: string;
      /** Component being edited — exclude only these sessions of this schedule, not the sibling Lec/Lab. */
      component?: 'lec' | 'lab' | string;
    };

    if (!master_schedule_id || !sessions?.length) {
      return NextResponse.json({ conflicts: [] });
    }
    if (!(await canAccessMasterSchedule(auth, master_schedule_id))) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    const schedResult = await query(`
      SELECT ms.faculty_id, bs.block_id, b.semester, b.academic_year
      FROM master_schedule ms
      JOIN block_subjects bs ON ms.block_subject_id = bs.id
      JOIN blocks b ON bs.block_id = b.id
      WHERE ms.id = $1
    `, [master_schedule_id]);
    if (schedResult.rows.length === 0) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }
    const sched = schedResult.rows[0];

    // Rows without a day yet can't conflict — check only the complete ones,
    // keeping their original index so the UI can point at the right row.
    const complete = sessions
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => s.day && s.start_time && s.hours);
    const invalid = validateSessions(complete.map(x => x.s));
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

    const found = await findScheduleConflicts(query, {
      masterScheduleId: Number(master_schedule_id),
      facultyId: sched.faculty_id ? Number(sched.faculty_id) : null,
      blockId: Number(sched.block_id),
      // The schedule's own term — never trust a client-sent term over it
      semester: sched.semester || semester || '',
      academicYear: sched.academic_year || academic_year || '',
      editingType: component === 'lab' ? 'lab' : 'lec',
      sessions: complete.map(x => x.s),
    });

    const conflicts = found.map(c => ({ ...c, session_index: complete[c.session_index].index }));
    return NextResponse.json({ conflicts });
  } catch (error) {
    console.error('[POST /api/scheduling/check-conflicts]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
