import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query, transaction } from '@/server/db';
import { isGoogleIdentity, verifyGoogleIdToken } from '@/server/verifyGoogleIdToken';
import { ensureInstructorGooglePicture } from '@/server/schema-guard';
import {
  customProfilePicturePath,
  resolveInstructorProfilePicture,
} from '@/lib/instructorAvatar';
import { revokeAllTrustedDevices } from '@/server/trustedDevices';

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as { role?: string; faculty_id?: number } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureInstructorGooglePicture();

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

    const facultyId = authUser.faculty_id;

    const result = await transaction(async (client) => {
      const account = await client.query<{
        id: number;
        email: string;
        google_sub: string | null;
        google_verified: boolean;
      }>(
        `SELECT id, email, google_sub, google_verified
         FROM instructor_accounts
         WHERE faculty_id = $1
         FOR UPDATE`,
        [facultyId]
      );

      if (account.rows.length === 0) {
        return { kind: 'not_found' as const };
      }

      const row = account.rows[0];
      const registered = normalizeEmail(row.email);
      if (identity.email !== registered) {
        return { kind: 'mismatch' as const };
      }

      const taken = await client.query(
        `SELECT faculty_id FROM instructor_accounts
         WHERE google_sub = $1 AND faculty_id <> $2`,
        [identity.sub, facultyId]
      );
      if (taken.rows.length > 0) {
        return { kind: 'duplicate' as const };
      }

      await client.query(
        `UPDATE instructor_accounts
         SET google_sub = $1,
             google_verified = TRUE,
             google_verified_at = NOW(),
             google_picture = $2,
             updated_at = NOW()
         WHERE faculty_id = $3`,
        [identity.sub, identity.picture, facultyId]
      );

      const updated = await client.query<{
        email: string;
        google_verified: boolean;
        google_verified_at: string | null;
        google_picture: string | null;
        profile_picture: string | null;
      }>(
        `SELECT ia.email, ia.google_verified, ia.google_verified_at, ia.google_picture,
                f.profile_picture
         FROM instructor_accounts ia
         JOIN faculty f ON f.id = ia.faculty_id
         WHERE ia.faculty_id = $1`,
        [facultyId]
      );

      return { kind: 'ok' as const, row: updated.rows[0] };
    });

    if (result.kind === 'not_found') {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }
    if (result.kind === 'mismatch') {
      return NextResponse.json(
        {
          error: 'The Google account you selected does not match the email registered for this Faculty account.',
        },
        { status: 403 }
      );
    }
    if (result.kind === 'duplicate') {
      return NextResponse.json(
        { error: 'This Google account is already connected to another Faculty member.' },
        { status: 409 }
      );
    }
    if (!result.row) {
      return NextResponse.json({ error: 'Failed to verify Google account.' }, { status: 500 });
    }

    const pictureUrl = resolveInstructorProfilePicture({
      customPicture: result.row.profile_picture,
      googleVerified: true,
      googlePicture: result.row.google_picture,
    });

    return NextResponse.json({
      success: true,
      google_verified: true,
      google_verified_at: result.row.google_verified_at,
      email: result.row.email,
      picture_url: pictureUrl,
      has_custom_profile_picture: Boolean(customProfilePicturePath(result.row.profile_picture)),
    });
  } catch (error) {
    const pg = error as { code?: string };
    if (pg.code === '42703') {
      return NextResponse.json(
        { error: 'Database schema is out of date. Please restart the server and try again.' },
        { status: 503 }
      );
    }
    console.error('[POST /api/instructor/verify-google]', error);
    return NextResponse.json({ error: 'Failed to verify Google account.' }, { status: 500 });
  }
}

/**
 * Unlinks Google identity. Keeps custom profile picture and Faculty account.
 * Clears google_* fields and revokes trusted devices (OTP security depended on verified Gmail).
 */
export async function DELETE(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as {
      role?: string;
      faculty_id?: number;
      id?: number;
    } | null;
    if (!authUser || authUser.role !== 'instructor' || !authUser.faculty_id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureInstructorGooglePicture();
    const facultyId = authUser.faculty_id;

    const result = await transaction(async (client) => {
      const account = await client.query<{
        id: number;
        google_verified: boolean;
      }>(
        `SELECT id, google_verified
         FROM instructor_accounts
         WHERE faculty_id = $1
         FOR UPDATE`,
        [facultyId]
      );
      if (account.rows.length === 0) return { kind: 'not_found' as const };

      await client.query(
        `UPDATE instructor_accounts
         SET google_sub = NULL,
             google_verified = FALSE,
             google_verified_at = NULL,
             google_picture = NULL,
             otp_enabled = FALSE,
             updated_at = NOW()
         WHERE faculty_id = $1`,
        [facultyId]
      );

      const updated = await client.query<{
        profile_picture: string | null;
      }>(
        `SELECT f.profile_picture
         FROM faculty f
         WHERE f.id = $1`,
        [facultyId]
      );

      return {
        kind: 'ok' as const,
        accountId: Number(account.rows[0].id),
        profile_picture: updated.rows[0]?.profile_picture ?? null,
      };
    });

    if (result.kind === 'not_found') {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    await revokeAllTrustedDevices('instructor', result.accountId);
    await query(
      `UPDATE login_otp_challenges
       SET used_at = NOW()
       WHERE account_kind = 'instructor' AND account_id = $1 AND used_at IS NULL AND purpose = 'login'`,
      [result.accountId]
    ).catch(() => {});

    const pictureUrl = resolveInstructorProfilePicture({
      customPicture: result.profile_picture,
      googleVerified: false,
      googlePicture: null,
    });

    return NextResponse.json({
      success: true,
      google_verified: false,
      otp_enabled: false,
      picture_url: pictureUrl,
      has_custom_profile_picture: Boolean(customProfilePicturePath(result.profile_picture)),
    });
  } catch (error) {
    console.error('[DELETE /api/instructor/verify-google]', error);
    return NextResponse.json({ error: 'Failed to remove Google account.' }, { status: 500 });
  }
}
