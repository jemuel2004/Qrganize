import { NextRequest, NextResponse } from 'next/server';
import { getOtpChallengeId } from '@/auth/auth';
import { resendOtp } from '@/auth/loginOtp';
import { consumeRate } from '@/auth/rateLimit';
import { withAudit } from '@/services/audit';

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

async function POST_handler(req: NextRequest) {
  const ip = clientIp(req);
  const limit = consumeRate(`otp-resend:${ip}`, 8, 15 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Too many resend requests. Please try again in ${limit.retryAfterSeconds} seconds.` },
      { status: 429 }
    );
  }

  return resendOtp(getOtpChallengeId(req));
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
