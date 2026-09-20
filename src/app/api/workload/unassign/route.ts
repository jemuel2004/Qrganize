import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import { syncWorkloadMonitoringNotifications } from '@/server/workloadMonitoring';

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { faculty_id, master_schedule_id } = await req.json();

    await query('BEGIN');
    try {
      await query('DELETE FROM instructor_loads WHERE faculty_id=$1 AND master_schedule_id=$2', [faculty_id, master_schedule_id]);
      await query('DELETE FROM overloads WHERE faculty_id=$1 AND master_schedule_id=$2', [faculty_id, master_schedule_id]);
      await query(
        'UPDATE block_subjects SET status=$1 WHERE id=(SELECT block_subject_id FROM master_schedule WHERE id=$2)',
        ['Unscheduled', master_schedule_id]
      );
      await query(
        'UPDATE master_schedule SET faculty_id=NULL, status=$1, day_pattern=NULL, start_time=NULL, end_time=NULL, room_id=NULL, updated_at=NOW() WHERE id=$2',
        ['Unassigned', master_schedule_id]
      );
      await query('DELETE FROM schedule_sessions WHERE master_schedule_id=$1', [master_schedule_id]);
      await query('COMMIT');
    } catch (txErr) {
      await query('ROLLBACK');
      throw txErr;
    }

    void syncWorkloadMonitoringNotifications(true);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
