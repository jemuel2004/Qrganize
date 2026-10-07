import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { withAudit } from '@/services/audit';
import { getWorkloadPolicy, saveWorkloadPolicy } from '@/services/workloadPolicy';
import { DEFAULT_WORKLOAD_POLICY, LOAD_GRACE_UNITS, WORKLOAD_POLICY_LIMITS, parseWorkloadPolicy } from '@shared/regularLoad';

/**
 * GET /api/settings/workload-policy — the current workload limits (any signed-in user;
 * every load page shows them). PUT — change them (Administrator only).
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json(
      { policy: await getWorkloadPolicy(), defaults: DEFAULT_WORKLOAD_POLICY, limits: WORKLOAD_POLICY_LIMITS, grace: LOAD_GRACE_UNITS },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[GET /api/settings/workload-policy]', error);
    return NextResponse.json({ error: 'Could not load the workload limits.' }, { status: 500 });
  }
}

async function PUT_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (auth.role !== 'admin') {
      return NextResponse.json({ error: 'Only an Administrator can change the workload limits.' }, { status: 403 });
    }

    const parsed = parseWorkloadPolicy(await req.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, field: parsed.field }, { status: 400 });

    await saveWorkloadPolicy(parsed.policy);
    return NextResponse.json({ success: true, policy: parsed.policy });
  } catch (error) {
    console.error('[PUT /api/settings/workload-policy]', error);
    return NextResponse.json({ error: 'Could not save the workload limits. Please try again.' }, { status: 500 });
  }
}

// Recorded in the audit trail; open tabs refresh their loads (live updates).
export const PUT = withAudit(PUT_handler);
