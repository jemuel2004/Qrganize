import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { instructorLoginResponse } from '@/server/auth';
import { isGoogleIdentity, verifyGoogleIdToken } from '@/server/verifyGoogleIdToken';
import { checkRateLimit, recordFailure, clearFailures } from '@/server/rateLimit';
import { ensureInstructorGooglePicture } from '@/server/schema-guard';

const NOT_LINKED =
  'This Google account is not yet verified or linked to a system account. Please use your username and password first or contact the administrator.';

const NEEDS_VERIFICATION =
  'This Google account is registered but not yet verified. Please sign in with your username and password, then connect Google from Profile Settings.';

const ROLE_MISMATCH =
  'Google sign-in is only available for Instructor accounts. Please use your username and password.';

type LinkedAccount = {
  account_id: number;
  username: string;
  email: string;
  google_sub: string | null;
  google_verified: boolean;
  account_active: boolean;
  faculty_id: number;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  faculty_active: boolean;
};

async function findByGoogleSub(sub: string): Promise<LinkedAccount | null> {
  const result = await query(
    `SELECT
       ia.id AS account_id, ia.username, ia.email,
       ia.google_sub, ia.google_verified,
       ia.is_active AS account_active,
       f.id AS faculty_id, f.first_name, f.last_name, f.name,
       f.is_active AS faculty_active
     FROM instructor_accounts ia
     JOIN faculty f ON ia.faculty_id = f.id
     WHERE ia.google_sub = $1`,
    [sub]
  );
  return (result.rows[0] as LinkedAccount | undefined) ?? null;
}

async function findByEmail(email: string): Promise<LinkedAccount | null> {
  const result = await query(
    `SELECT
       ia.id AS account_id, ia.username, ia.email,
       ia.google_sub, ia.google_verified,
       ia.is_active AS account_active,
       f.id AS faculty_id, f.first_name, f.last_name, f.name,
       f.is_active AS faculty_active
     FROM instructor_accounts ia
     JOIN faculty f ON ia.faculty_id = f.id
     WHERE lower(trim(ia.email)) = $1`,
    [email]
  );
  return (result.rows[0] as LinkedAccount | undefined) ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const ip =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      req.headers.get('x-real-ip') ??
      'unknown';
    const limitResult = checkRateLimit(ip);
    if (!limitResult.allowed) {
      return NextResponse.json(
        { error: `Too many failed login attempts. Please try again in ${limitResult.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const role = String((body as { role?: unknown }).role ?? '');
    const credential = (body as { credential?: unknown }).credential;

    if (!['admin', 'department_chair', 'instructor'].includes(role)) {
      return NextResponse.json({ error: 'Please select a valid role.' }, { status: 400 });
    }

    if (role !== 'instructor') {
      recordFailure(ip);
      return NextResponse.json({ error: ROLE_MISMATCH }, { status: 403 });
    }

    const identity = await verifyGoogleIdToken(credential);
    if (!isGoogleIdentity(identity)) {
      recordFailure(ip);
      return NextResponse.json({ error: identity.error }, { status: identity.status });
    }

    const bySub = await findByGoogleSub(identity.sub);
    const byEmail = bySub ? null : await findByEmail(identity.email);

    if (!bySub && byEmail?.google_verified && byEmail.google_sub && byEmail.google_sub !== identity.sub) {
      recordFailure(ip);
      console.error('[auth/google-login] Google identity conflict', {
        faculty_id: byEmail.faculty_id,
      });
      return NextResponse.json(
        { error: 'This Google account cannot be used to sign in. Please contact the administrator.' },
        { status: 409 }
      );
    }

    const account = bySub ?? byEmail;

    if (!account) {
      recordFailure(ip);
      return NextResponse.json({ error: NOT_LINKED }, { status: 403 });
    }

    if (!account.google_verified || !account.google_sub || account.google_sub !== identity.sub) {
      recordFailure(ip);
      return NextResponse.json({ error: NEEDS_VERIFICATION }, { status: 403 });
    }

    if (!account.account_active || !account.faculty_active) {
      return NextResponse.json(
        { error: 'This instructor account has been deactivated. Please contact the administrator.' },
        { status: 403 }
      );
    }

    clearFailures(ip);
    await ensureInstructorGooglePicture();
    await query(
      `UPDATE instructor_accounts SET google_picture = $1, updated_at = NOW() WHERE id = $2`,
      [identity.picture, account.account_id]
    ).catch(() => {});

    return instructorLoginResponse({
      account_id: account.account_id,
      username: account.username,
      faculty_id: account.faculty_id,
      first_name: account.first_name,
      last_name: account.last_name,
      name: account.name,
    }, { req, registerDevice: true });
  } catch (error) {
    const pg = error as { code?: string };
    if (pg.code === '42703') {
      return NextResponse.json(
        { error: 'Google sign-in is not available yet. Please use your username and password.' },
        { status: 503 }
      );
    }
    console.error('[auth/google-login]', error);
    return NextResponse.json({ error: 'A server error occurred. Please try again.' }, { status: 500 });
  }
}
