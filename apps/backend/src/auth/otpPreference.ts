import { query } from '@/database/db';

export type OtpAccountKind = 'user' | 'instructor';

const PLACEHOLDER_EMAIL_DOMAINS = new Set(['placeholder.local']);

function usableEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  const domain = email.split('@')[1] ?? '';
  if (PLACEHOLDER_EMAIL_DOMAINS.has(domain)) return '';
  return email;
}

let otpColumnReady: Promise<void> | null = null;

/** Idempotent DDL so login/settings work even before migrate catches up. */
export function ensureOtpEnabledColumn(): Promise<void> {
  if (!otpColumnReady) {
    otpColumnReady = (async () => {
      await query(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_enabled BOOLEAN NOT NULL DEFAULT FALSE`
      );
      await query(
        `ALTER TABLE instructor_accounts ADD COLUMN IF NOT EXISTS otp_enabled BOOLEAN NOT NULL DEFAULT FALSE`
      );
      await query(`UPDATE users SET otp_enabled = FALSE WHERE otp_enabled IS NULL`).catch(() => {});
      await query(
        `UPDATE instructor_accounts SET otp_enabled = FALSE WHERE otp_enabled IS NULL`
      ).catch(() => {});
    })().catch(err => {
      otpColumnReady = null;
      throw err;
    });
  }
  return otpColumnReady;
}

export async function getAccountOtpEnabled(
  accountKind: OtpAccountKind,
  accountId: number
): Promise<boolean> {
  await ensureOtpEnabledColumn();
  if (accountKind === 'instructor') {
    const result = await query(
      `SELECT otp_enabled FROM instructor_accounts WHERE id = $1`,
      [accountId]
    );
    return result.rows[0]?.otp_enabled === true;
  }
  const result = await query(`SELECT otp_enabled FROM users WHERE id = $1`, [accountId]);
  return result.rows[0]?.otp_enabled === true;
}

export async function disableAccountOtp(
  accountKind: OtpAccountKind,
  accountId: number
): Promise<void> {
  await ensureOtpEnabledColumn();
  if (accountKind === 'instructor') {
    await query(
      `UPDATE instructor_accounts SET otp_enabled = FALSE, updated_at = NOW() WHERE id = $1`,
      [accountId]
    );
  } else {
    await query(
      `UPDATE users SET otp_enabled = FALSE, updated_at = NOW() WHERE id = $1`,
      [accountId]
    );
  }
  await query(
    `UPDATE login_otp_challenges
     SET used_at = NOW()
     WHERE account_kind = $1 AND account_id = $2 AND used_at IS NULL AND purpose = 'login'`,
    [accountKind, accountId]
  ).catch(() => {});
}

export type OtpPreferenceSnapshot = {
  otp_enabled: boolean;
  google_verified: boolean;
  email: string | null;
  can_enable: boolean;
  requires_google_verification: boolean;
};

export async function getOtpPreferenceSnapshot(
  accountKind: OtpAccountKind,
  accountId: number,
  role: string
): Promise<OtpPreferenceSnapshot | null> {
  await ensureOtpEnabledColumn();

  if (accountKind === 'instructor') {
    const result = await query(
      `SELECT ia.otp_enabled, ia.google_verified, ia.email, f.email AS faculty_email
       FROM instructor_accounts ia
       JOIN faculty f ON f.id = ia.faculty_id
       WHERE ia.id = $1`,
      [accountId]
    );
    const row = result.rows[0];
    if (!row) return null;
    const email = usableEmail(row.email) || usableEmail(row.faculty_email);
    const googleVerified = row.google_verified === true;
    return {
      otp_enabled: row.otp_enabled === true,
      google_verified: googleVerified,
      email: email || null,
      can_enable: googleVerified && Boolean(email),
      requires_google_verification: true,
    };
  }

  const result = await query(
    `SELECT otp_enabled, google_verified, email, role FROM users WHERE id = $1`,
    [accountId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const email = usableEmail(row.email);
  const googleVerified = row.google_verified === true;
  const isChair = role === 'program_chair' || row.role === 'program_chair';
  return {
    otp_enabled: row.otp_enabled === true,
    google_verified: googleVerified,
    email: email || null,
    can_enable: isChair ? googleVerified && Boolean(email) : Boolean(email),
    requires_google_verification: isChair,
  };
}
