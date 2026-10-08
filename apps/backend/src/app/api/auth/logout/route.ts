import { NextRequest, NextResponse } from 'next/server';
import { clearAuthCookie, clearOtpCookie, verifyToken } from '@/auth/auth';
import { revokeSession } from '@/auth/sessionRevocation';
import { clearEmailVerifyCookie } from '@/auth/emailVerifyChallenge';
import { clearTrustedDeviceCookie, revokeTrustedDeviceByCookie } from '@/auth/trustedDevices';
import { withAudit } from '@/services/audit';

async function POST_handler(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const forgetDevice = Boolean((body as { forgetDevice?: unknown }).forgetDevice);
  // End this session on the server too, so a copied cookie stops working now
  const token = req.cookies.get('auth_token')?.value;
  const payload = token ? await verifyToken(token) : null;
  if (payload) {
    await revokeSession(payload).catch(err => console.warn('[auth/logout] could not revoke the session:', (err as Error).message));
  }
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
