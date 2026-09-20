import { NextRequest, NextResponse } from 'next/server';
import { clearAuthCookie, clearOtpCookie } from '@/server/auth';
import { clearEmailVerifyCookie } from '@/server/emailVerifyChallenge';
import { clearTrustedDeviceCookie, revokeTrustedDeviceByCookie } from '@/server/trustedDevices';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const forgetDevice = Boolean((body as { forgetDevice?: unknown }).forgetDevice);
  const response = NextResponse.json({ success: true });
  clearAuthCookie(response);
  clearOtpCookie(response);
  clearEmailVerifyCookie(response);
  if (forgetDevice) {
    await revokeTrustedDeviceByCookie(req);
    clearTrustedDeviceCookie(response);
  }
  return response;
}
