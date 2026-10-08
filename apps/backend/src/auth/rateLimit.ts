/**
 * Simple in-memory rate limiter for login brute-force protection.
 *
 * Tracks failed attempts per IP (or username when IP is unavailable).
 * In a multi-instance deployment, replace this Map with a Redis-backed
 * counter so state is shared across pods.
 *
 * Limits:
 *   - 5 failed attempts within a 15-minute window → 15-minute lockout
 *   - Successful login clears the attempt counter for that key
 */

interface Attempt {
  count: number;
  firstAt: number;
  lockedUntil: number | null;
}

const store = new Map<string, Attempt>();

const MAX_ATTEMPTS  = 5;
const WINDOW_MS     = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS    = 15 * 60 * 1000; // 15-minute lockout

// Prune stale entries every 30 minutes to prevent unbounded memory growth.
const pruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store) {
    const expired = now - val.firstAt > WINDOW_MS * 2;
    const unlocked = val.lockedUntil !== null && now > val.lockedUntil;
    if (expired || unlocked) store.delete(key);
  }
}, 30 * 60 * 1000);
pruneTimer.unref?.();

export function checkRateLimit(key: string): {
  allowed: boolean;
  retryAfterSeconds?: number;
} {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry) return { allowed: true };

  // Actively locked out
  if (entry.lockedUntil !== null && now < entry.lockedUntil) {
    const retryAfterSeconds = Math.ceil((entry.lockedUntil - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  // Window expired — reset
  if (now - entry.firstAt > WINDOW_MS) {
    store.delete(key);
    return { allowed: true };
  }

  return { allowed: true };
}

/** `maxAttempts`: failures within the window before the key is locked (per-account keys allow more than per-IP) */
export function recordFailure(key: string, maxAttempts = MAX_ATTEMPTS): void {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now - entry.firstAt > WINDOW_MS) {
    store.set(key, { count: 1, firstAt: now, lockedUntil: maxAttempts <= 1 ? now + LOCKOUT_MS : null });
    return;
  }

  entry.count += 1;
  if (entry.count >= maxAttempts) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  store.set(key, entry);
}

export function clearFailures(key: string): void {
  store.delete(key);
}

interface ActionBucket {
  count: number;
  windowStart: number;
}

const actionStore = new Map<string, ActionBucket>();

/**
 * Count-based limiter for actions that are not "failures" (OTP start, resend, verify).
 * Increments on every call. Independent of the login-failure store.
 */
export function consumeRate(
  key: string,
  max: number,
  windowMs: number
): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const entry = actionStore.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    actionStore.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }

  if (entry.count >= max) {
    const retryAfterSeconds = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }

  entry.count += 1;
  return { allowed: true };
}
