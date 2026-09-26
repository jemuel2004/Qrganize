import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query, transaction } from '@/server/db';
import { isGoogleIdentity, verifyGoogleIdToken } from '@/server/verifyGoogleIdToken';
import { ensureUsersSchema } from '@/server/ensure-users-schema';
import { revokeAllTrustedDevices } from '@/server/trustedDevices';

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Department Chair self-service Google verification (mirrors Instructor flow).
 * Admin create never verifies — the chair must complete OAuth themselves.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureUsersSchema();
    const authUser = await getAuthUser(req) as { role?: string; id?: number } | null;
    if (!authUser || authUser.role !== 'program_chair' || !authUser.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: { credential?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }

    const identity = await verifyGoogleIdToken(body.credential);
    if (!isGoogleIdentity(identity)) {
      return NextResponse.json({ error: identity.error }, { status: identity.status });
    }

    const userId = authUser.id;

    const result = await transaction(async (client) => {
      const account = await client.query(
        `SELECT id, email, google_sub, google_verified
         FROM users
         WHERE id = $1 AND role = 'program_chair'
         FOR UPDATE`,
        [userId]
      );

      if (account.rows.length === 0) {
        return { kind: 'not_found' as const };
      }

      const row = account.rows[0] as {
        id: number;
        email: string;
        google_sub: string | null;
        google_verified: boolean;
      };
      if (identity.email !== normalizeEmail(row.email)) {
        return { kind: 'mismatch' as const };
      }

      const taken = await client.query(
        `SELECT id FROM users WHERE google_sub = $1 AND id <> $2`,
        [identity.sub, userId]
      );
      if (taken.rows.length > 0) {
        return { kind: 'duplicate' as const };
      }

      await client.query(
        `UPDATE users
         SET google_sub = $1,
             google_verified = TRUE,
             google_verified_at = NOW(),
             google_picture = $2,
             updated_at = NOW()
         WHERE id = $3 AND role = 'program_chair'`,
        [identity.sub, identity.picture, userId]
      );

      const updated = await client.query(
        `SELECT email, google_verified, google_verified_at, google_picture
         FROM users WHERE id = $1`,
        [userId]
      );

      return { kind: 'ok' as const, row: updated.rows[0] };
    });

    if (result.kind === 'not_found') {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }
    if (result.kind === 'mismatch') {
      return NextResponse.json(
        {
          error: 'The Google account you selected does not match the email registered for this Department Chair account.',
        },
        { status: 403 }
      );
    }
    if (result.kind === 'duplicate') {
      return NextResponse.json(
        { error: 'This Google account is already connected to another user.' },
        { status: 409 }
      );
    }

    const row = result.row as {
      email: string;
      google_verified: boolean;
      google_verified_at: string | null;
      google_picture: string | null;
    };

    return NextResponse.json({
      success: true,
      google_verified: true,
      google_verified_at: row.google_verified_at,
      email: row.email,
      google_picture: row.google_picture,
    });
  } catch (error) {
    console.error('[POST /api/dept-chair/verify-google]', error);
    return NextResponse.json({ error: 'Failed to verify Google account.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await ensureUsersSchema();
    const authUser = await getAuthUser(req) as { role?: string; id?: number } | null;
    if (!authUser || authUser.role !== 'program_chair' || !authUser.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = authUser.id;

    const result = await transaction(async (client) => {
      const account = await client.query(
        `SELECT id FROM users WHERE id = $1 AND role = 'program_chair' FOR UPDATE`,
        [userId]
      );
      if (account.rows.length === 0) return { kind: 'not_found' as const };

      await client.query(
        `UPDATE users
         SET google_sub = NULL,
             google_verified = FALSE,
             google_verified_at = NULL,
             google_picture = NULL,
             otp_enabled = FALSE,
             updated_at = NOW()
         WHERE id = $1 AND role = 'program_chair'`,
        [userId]
      );

      return { kind: 'ok' as const, accountId: userId };
    });

    if (result.kind === 'not_found') {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    await revokeAllTrustedDevices('user', result.accountId);
    await query(
      `UPDATE login_otp_challenges
       SET used_at = NOW()
       WHERE account_kind = 'user' AND account_id = $1 AND used_at IS NULL AND purpose = 'login'`,
      [result.accountId]
    ).catch(() => {});

    return NextResponse.json({
      success: true,
      google_verified: false,
      otp_enabled: false,
    });
  } catch (error) {
    console.error('[DELETE /api/dept-chair/verify-google]', error);
    return NextResponse.json({ error: 'Failed to remove Google account.' }, { status: 500 });
  }
}
