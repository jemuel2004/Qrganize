/**
 * Shared secret resolution for JWT / OTP HMAC.
 * Never fall back to a hardcoded default — missing secrets must fail closed.
 */

export function getRequiredJwtSecretBytes(): Uint8Array {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error(
      '[auth] JWT_SECRET must be set in the environment. Refusing to start with a missing or default secret.',
    );
  }
  return new TextEncoder().encode(secret);
}

/** Prefer OTP_SECRET when set; otherwise JWT_SECRET. */
export function getRequiredHmacSecret(): string {
  const secret = process.env.OTP_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error(
      '[auth] OTP_SECRET or JWT_SECRET must be set. Refusing to use a default HMAC secret.',
    );
  }
  return secret;
}
