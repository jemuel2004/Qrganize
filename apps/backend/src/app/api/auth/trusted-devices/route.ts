import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import {
  accountKindFromRole,
  listTrustedDevicesForAccount,
  revokeOtherTrustedDevices,
} from '@/auth/trustedDevices';
import { withAudit } from '@/services/audit';

export async function GET(req: NextRequest) {
  const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
  if (!auth?.id || !auth.role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const devices = await listTrustedDevicesForAccount(
    req,
    accountKindFromRole(auth.role),
    Number(auth.id)
  );
  return NextResponse.json({ devices });
}

async function POST_handler(req: NextRequest) {
  const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
  if (!auth?.id || !auth.role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  if (!(body as { others?: unknown }).others) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }
  await revokeOtherTrustedDevices(req, accountKindFromRole(auth.role), Number(auth.id));
  return NextResponse.json({ success: true });
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
