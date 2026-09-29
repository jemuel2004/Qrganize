import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import {
  accountKindFromRole,
  clearTrustedDeviceCookie,
  getTrustedDeviceForAccount,
  revokeTrustedDevice,
} from '@/auth/trustedDevices';
import { withAudit } from '@/services/audit';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
  if (!auth?.id || !auth.role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const device = await getTrustedDeviceForAccount(
    req,
    accountKindFromRole(auth.role),
    Number(auth.id),
    id
  );
  if (!device) {
    return NextResponse.json({ error: 'Device not found.' }, { status: 404 });
  }
  return NextResponse.json({ device });
}

async function DELETE_handler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
  if (!auth?.id || !auth.role) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  const result = await revokeTrustedDevice(
    req,
    accountKindFromRole(auth.role),
    Number(auth.id),
    id
  );
  if (!result.revoked) {
    return NextResponse.json({ error: 'Device not found.' }, { status: 404 });
  }
  const response = NextResponse.json({ success: true });
  if (result.wasCurrent) clearTrustedDeviceCookie(response);
  return response;
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const DELETE = withAudit(DELETE_handler);
