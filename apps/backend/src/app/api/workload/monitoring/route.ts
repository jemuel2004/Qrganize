import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { getChairAssignedProgramId, isScopedChair } from '@/services/programScope';
import {
  computeWorkloadMonitoring,
  filterSnapshotForProgram,
  syncWorkloadMonitoringNotifications,
} from '@/services/workloadMonitoring';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const full = await computeWorkloadMonitoring();
    await syncWorkloadMonitoringNotifications(true, full);

    if (isScopedChair(auth)) {
      const userId = Number(auth.id);
      const programId = userId ? await getChairAssignedProgramId(userId) : null;
      const scoped = filterSnapshotForProgram(full, programId);
      return NextResponse.json(scoped, { headers: { 'Cache-Control': 'no-store' } });
    }

    return NextResponse.json(full, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[GET /api/workload/monitoring]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
