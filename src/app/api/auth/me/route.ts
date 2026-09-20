import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { ensureInstructorGooglePicture, ensureUserProfilePicture } from '@/server/schema-guard';
import { ensureOtpEnabledColumn } from '@/server/otpPreference';
import { customProfilePicturePath, resolveInstructorProfilePicture } from '@/lib/instructorAvatar';

export async function GET(req: NextRequest) {
  try {
    const authUser = await getAuthUser(req) as {
      id: number; role?: string; faculty_id?: number;
      name?: string; username?: string;
    } | null;

    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (authUser.role === 'instructor' && authUser.faculty_id) {
      await ensureInstructorGooglePicture();
      await ensureOtpEnabledColumn();
      const facRow = await query(
        `SELECT
           f.profile_picture,
           ia.email,
           ia.google_verified,
           ia.google_verified_at,
           ia.google_picture,
           ia.otp_enabled
         FROM faculty f
         LEFT JOIN instructor_accounts ia ON ia.faculty_id = f.id
         WHERE f.id = $1`,
        [authUser.faculty_id]
      );
      const row = facRow.rows[0] ?? {};
      const googleVerified = row.google_verified === true;
      const customPath = customProfilePicturePath(row.profile_picture);
      const displayPicture = resolveInstructorProfilePicture({
        customPicture: row.profile_picture,
        googleVerified,
        googlePicture: row.google_picture,
      });
      return NextResponse.json({
        user: {
          id: authUser.faculty_id,
          username: authUser.username,
          name: authUser.name,
          role: 'instructor',
          faculty_id: authUser.faculty_id,
          profile_picture: displayPicture,
          has_custom_profile_picture: Boolean(customPath),
          email: row.email ?? null,
          google_verified: googleVerified,
          google_verified_at: row.google_verified_at ?? null,
          otp_enabled: row.otp_enabled === true,
          google_picture: googleVerified
            ? resolveInstructorProfilePicture({ googleVerified: true, googlePicture: row.google_picture })
            : null,
        },
      });
    }

    // Admin / Department Chair — ensure the profile_picture column exists
    // before querying it. The guard is idempotent and resolves instantly after
    // the first request (module-level cache).
    await ensureUserProfilePicture();

    try {
      const result = await query(
        'SELECT id, username, email, role, profile_picture FROM users WHERE id = $1',
        [authUser.id]
      );
      if (result.rows.length === 0) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }
      return NextResponse.json({ user: result.rows[0] });
    } catch (queryErr) {
      // 42703 = PostgreSQL "undefined_column" — guard ran but DDL is still
      // propagating (extremely rare race). Fall back gracefully so the UI
      // still receives a valid user object with profile_picture: null.
      if ((queryErr as { code?: string }).code === '42703') {
        const fallback = await query(
          'SELECT id, username, email, role FROM users WHERE id = $1',
          [authUser.id]
        );
        if (fallback.rows.length === 0) {
          return NextResponse.json({ error: 'User not found' }, { status: 404 });
        }
        return NextResponse.json({ user: { ...fallback.rows[0], profile_picture: null } });
      }
      throw queryErr;
    }
  } catch (err) {
    const pgCode = (err as { code?: string }).code;
    // 42703 = undefined_column — already handled gracefully inside the inner try
    if (pgCode) {
      // PostgreSQL error — this is a DB failure, not an auth failure
      console.error('[GET /api/auth/me] DB error:', err);
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
