/**
 * Parse remaining OTP cooldown seconds from API JSON and optional response headers.
 * Prefer explicit server fields; fall back to Retry-After / message text.
 */
export function parseOtpCooldownSeconds(
  data: Record<string, unknown> | null | undefined,
  headers?: Headers | null
): number {
  const body = data ?? {};
  const candidates = [
    body.resend_after,
    body.resendAfter,
    body.retry_after,
    body.retryAfter,
    body.retry_after_seconds,
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.ceil(n);
  }

  const retryHeader = headers?.get('Retry-After')?.trim();
  if (retryHeader) {
    const asNum = Number(retryHeader);
    if (Number.isFinite(asNum) && asNum > 0) return Math.ceil(asNum);
    const asDate = Date.parse(retryHeader);
    if (Number.isFinite(asDate)) {
      const rem = Math.ceil((asDate - Date.now()) / 1000);
      if (rem > 0) return rem;
    }
  }

  const msg = String(body.error ?? body.message ?? '');
  const match = /(?:wait|available in|in)\s+(\d+)\s+seconds?/i.exec(msg);
  if (match) {
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

export function formatOtpCooldownMessage(seconds: number): string {
  if (seconds <= 0) return '';
  if (seconds === 1) return 'Please wait 1 second before requesting another code.';
  return `Please wait ${seconds} seconds before requesting another code.`;
}
