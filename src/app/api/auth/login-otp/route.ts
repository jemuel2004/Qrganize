import { NextRequest, NextResponse } from 'next/server';
import { clearOtpCookie, getOtpChallengeId } from '@/server/auth';
import { cancelOtp, getOtpStatus, verifyOtpCode } from '@/server/loginOtp';
import { checkRateLimit, clearFailures, consumeRate, recordFailure } from '@/server/rateLimit';

const OTP_VERIFY_WINDOW_MS = 15 * 60 * 1000;
const OTP_VERIFY_MAX = 20;

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

export async function GET(req: NextRequest) {
  const status = await getOtpStatus(getOtpChallengeId(req));
  const response = NextResponse.json(status ?? { pending: false });
  if (!status) clearOtpCookie(response);
  return response;
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const loginLimit = checkRateLimit(ip);
  if (!loginLimit.allowed) {
    return NextResponse.json(
      { error: `Too many failed login attempts. Please try again in ${loginLimit.retryAfterSeconds} seconds.` },
      { status: 429 }
    );
  }

  const verifyLimit = consumeRate(`otp-verify:${ip}`, OTP_VERIFY_MAX, OTP_VERIFY_WINDOW_MS);
  if (!verifyLimit.allowed) {
    return NextResponse.json(
      { error: `Too many verification attempts. Please try again in ${verifyLimit.retryAfterSeconds} seconds.` },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const response = await verifyOtpCode(req, getOtpChallengeId(req), (body as { code?: unknown }).code);

  if (response.status === 200) {
    clearFailures(ip);
  } else if (response.status === 401) {
    recordFailure(ip);
  }

  return response;
}

export async function DELETE(req: NextRequest) {
  return cancelOtp(getOtpChallengeId(req));
}
