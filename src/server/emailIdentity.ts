import { query, transaction } from '@/server/db';

export type EmailAccountKind = 'user' | 'instructor';

export const EMAIL_ALREADY_REGISTERED = 'This email address is already registered.';

/** Reject email-shaped usernames until Google email ownership is verified. */
export const EMAIL_AS_USERNAME_REQUIRES_VERIFICATION =
  'Please verify your email address before using an email address as your username.';

/** @deprecated Prefer EMAIL_AS_USERNAME_REQUIRES_VERIFICATION — login no longer blocks on unverified email. */
export const EMAIL_VERIFICATION_REQUIRED = EMAIL_AS_USERNAME_REQUIRES_VERIFICATION;

/** Safe identity normalization: trim + lowercase. No Gmail-dot / +tag rewriting. */
export function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function isValidEmailFormat(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** True when the string is email-shaped (used for username / login-identifier rules). */
export function looksLikeEmail(value: unknown): boolean {
  return isValidEmailFormat(normalizeEmail(value));
}

/**
 * Email ownership verification status (Google-linked).
 * Instructor / Department Chair: `google_verified`.
 * Administrator: no Google verify product — treated as N/A (not required for login).
 */
export function isEmailOwnershipVerified(params: {
  role: string;
  google_verified?: boolean | null;
}): boolean {
  if (params.role === 'admin') return true;
  if (params.role === 'department_chair' || params.role === 'instructor') {
    return params.google_verified === true;
  }
  return false;
}

/** @deprecated Use isEmailOwnershipVerified — email verification is optional for login. */
export function isLoginEmailVerified(params: {
  role: string;
  google_verified?: boolean | null;
}): boolean {
  return isEmailOwnershipVerified(params);
}

/**
 * Username rules:
 * - Normal usernames: letters, numbers, underscores
 * - Email-shaped usernames: only when email ownership is verified (and matches verified email when provided)
 */
export function assertUsernameAllowed(
  username: unknown,
  opts?: { emailVerified?: boolean; verifiedEmail?: string | null }
): { ok: true; username: string } | { ok: false; error: string; field: 'username' } {
  const raw = String(username ?? '').trim();
  if (!raw) {
    return { ok: false, error: 'Username is required.', field: 'username' };
  }

  if (looksLikeEmail(raw)) {
    if (!opts?.emailVerified) {
      return { ok: false, error: EMAIL_AS_USERNAME_REQUIRES_VERIFICATION, field: 'username' };
    }
    const verified = normalizeEmail(opts.verifiedEmail ?? '');
    const candidate = normalizeEmail(raw);
    if (verified && candidate !== verified) {
      return {
        ok: false,
        error: 'You may only use your verified email address as your username.',
        field: 'username',
      };
    }
    return { ok: true, username: candidate };
  }

  if (!/^[a-zA-Z0-9_]+$/.test(raw)) {
    return {
      ok: false,
      error: 'Username may only contain letters, numbers, and underscores.',
      field: 'username',
    };
  }
  if (raw.length > 100) {
    return { ok: false, error: 'Username is too long.', field: 'username' };
  }
  return { ok: true, username: raw };
}

let registryReady: Promise<void> | null = null;

export function ensureEmailRegistry(): Promise<void> {
  if (!registryReady) {
    registryReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS account_email_registry (
          email_normalized VARCHAR(255) PRIMARY KEY,
          account_kind VARCHAR(20) NOT NULL,
          account_id INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT account_email_registry_kind_check
            CHECK (account_kind IN ('user', 'instructor')),
          CONSTRAINT account_email_registry_owner_unique
            UNIQUE (account_kind, account_id)
        )
      `);
    })().catch(err => {
      registryReady = null;
      throw err;
    });
  }
  return registryReady;
}

async function findOwnerLive(
  normalized: string,
  exclude?: { accountKind: EmailAccountKind; accountId: number }
): Promise<{ account_kind: EmailAccountKind; account_id: number } | null> {
  const users = await query(
    `SELECT id FROM users WHERE lower(trim(email)) = $1 LIMIT 1`,
    [normalized]
  );
  if (users.rows[0]) {
    const id = Number(users.rows[0].id);
    if (!(exclude?.accountKind === 'user' && Number(exclude.accountId) === id)) {
      return { account_kind: 'user', account_id: id };
    }
  }
  const instructors = await query(
    `SELECT id FROM instructor_accounts WHERE lower(trim(email)) = $1 LIMIT 1`,
    [normalized]
  );
  if (instructors.rows[0]) {
    const id = Number(instructors.rows[0].id);
    if (!(exclude?.accountKind === 'instructor' && Number(exclude.accountId) === id)) {
      return { account_kind: 'instructor', account_id: id };
    }
  }
  return null;
}

/** Returns conflicting owner if the normalized email is already claimed by another account. */
export async function findEmailOwner(
  email: string,
  exclude?: { accountKind: EmailAccountKind; accountId: number }
): Promise<{ account_kind: EmailAccountKind; account_id: number } | null> {
  await ensureEmailRegistry();
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const result = await query(
    `SELECT account_kind, account_id FROM account_email_registry WHERE email_normalized = $1`,
    [normalized]
  );
  const row = result.rows[0] as
    | { account_kind: EmailAccountKind; account_id: number }
    | undefined;

  if (row) {
    if (
      exclude &&
      row.account_kind === exclude.accountKind &&
      Number(row.account_id) === Number(exclude.accountId)
    ) {
      return null;
    }
    return { account_kind: row.account_kind, account_id: Number(row.account_id) };
  }

  return findOwnerLive(normalized, exclude);
}

export async function assertEmailAvailable(
  email: string,
  exclude?: { accountKind: EmailAccountKind; accountId: number }
): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  const normalized = normalizeEmail(email);
  if (!normalized || !isValidEmailFormat(normalized)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }
  const owner = await findEmailOwner(normalized, exclude);
  if (owner) return { ok: false, error: EMAIL_ALREADY_REGISTERED };
  return { ok: true, email: normalized };
}

/** Claim or reassign registry entry for an account email (race-safe via PK). */
export async function claimAccountEmail(params: {
  email: string;
  accountKind: EmailAccountKind;
  accountId: number;
  client?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
}): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  await ensureEmailRegistry();
  const normalized = normalizeEmail(params.email);
  if (!normalized || !isValidEmailFormat(normalized)) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }

  const run = async (q: typeof query) => {
    await q(
      `DELETE FROM account_email_registry
       WHERE account_kind = $1 AND account_id = $2`,
      [params.accountKind, params.accountId]
    );
    await q(
      `INSERT INTO account_email_registry (email_normalized, account_kind, account_id)
       VALUES ($1, $2, $3)`,
      [normalized, params.accountKind, params.accountId]
    );
  };

  try {
    if (params.client) {
      await run(params.client.query.bind(params.client) as typeof query);
    } else {
      await transaction(async client => {
        await run(client.query.bind(client) as typeof query);
      });
    }
    return { ok: true, email: normalized };
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return { ok: false, error: EMAIL_ALREADY_REGISTERED };
    }
    throw err;
  }
}

export async function releaseAccountEmail(
  accountKind: EmailAccountKind,
  accountId: number
): Promise<void> {
  await ensureEmailRegistry();
  await query(
    `DELETE FROM account_email_registry WHERE account_kind = $1 AND account_id = $2`,
    [accountKind, accountId]
  ).catch(() => {});
}
