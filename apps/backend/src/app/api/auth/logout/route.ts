import { NextRequest, NextResponse } from 'next/server';
import { clearAuthCookie, clearOtpCookie } from '@/auth/auth';
import { clearEmailVerifyCookie } from '@/auth/emailVerifyChallenge';
import { clearTrustedDeviceCookie, revokeTrustedDeviceByCookie } from '@/auth/trustedDevices';
import { withAudit } from '@/services/audit';

async function POST_handler(req: NextRequest) {
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

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
