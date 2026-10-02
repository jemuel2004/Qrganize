import { NextRequest, NextResponse } from 'next/server';
import { transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { syncWorkloadMonitoringNotifications } from '@/services/workloadMonitoring';
import { canAccessMasterSchedule } from '@/services/programScope';
import { withAudit } from '@/services/audit';

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { faculty_id, master_schedule_id } = await req.json();

    if (!(await canAccessMasterSchedule(auth, master_schedule_id))) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    // All on one pooled connection (BEGIN/COMMIT through pool.query could each land
    // on a different connection — no atomicity, and a connection left mid-transaction).
    const outcome = await transaction(async (client) => {
      // Lock the class; if another faculty holds it now (stale screen), leave it alone
      const owner = await client.query('SELECT faculty_id FROM master_schedule WHERE id=$1 FOR UPDATE', [master_schedule_id]);
      if (owner.rows.length === 0) return 'missing' as const;
      const holder = owner.rows[0].faculty_id;
      if (holder != null && Number(holder) !== Number(faculty_id)) return 'other' as const;

      await client.query('DELETE FROM instructor_loads WHERE faculty_id=$1 AND master_schedule_id=$2', [faculty_id, master_schedule_id]);
      await client.query('DELETE FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2', [faculty_id, master_schedule_id]);
      await client.query(
        'UPDATE block_subjects SET status=$1 WHERE id=(SELECT block_subject_id FROM master_schedule WHERE id=$2)',
        ['Unscheduled', master_schedule_id]
      );
      await client.query(
        'UPDATE master_schedule SET faculty_id=NULL, status=$1, day_pattern=NULL, start_time=NULL, end_time=NULL, room_id=NULL, updated_at=NOW() WHERE id=$2',
        ['Unassigned', master_schedule_id]
      );
      await client.query('DELETE FROM schedule_sessions WHERE master_schedule_id=$1', [master_schedule_id]);
      return 'done' as const;
    });

    if (outcome === 'missing') return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    if (outcome === 'other') {
      return NextResponse.json({ error: 'This subject is now assigned to another faculty member. Refresh and try again.' }, { status: 409 });
    }

    void syncWorkloadMonitoringNotifications(true);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[POST /api/workload/unassign]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
