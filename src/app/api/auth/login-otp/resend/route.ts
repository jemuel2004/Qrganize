import { NextRequest, NextResponse } from 'next/server';
import { getOtpChallengeId } from '@/server/auth';
import { resendOtp } from '@/server/loginOtp';
import { consumeRate } from '@/server/rateLimit';

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

export async function POST(req: NextRequest) {
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
