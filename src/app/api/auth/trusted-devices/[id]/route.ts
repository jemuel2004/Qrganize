import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import {
  accountKindFromRole,
  clearTrustedDeviceCookie,
  getTrustedDeviceForAccount,
  revokeTrustedDevice,
} from '@/server/trustedDevices';

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

export async function DELETE(
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
