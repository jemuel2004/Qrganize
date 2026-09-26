import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { DEPARTMENT_CHAIR_ACCOUNT_SELECT, ensureUsersSchema } from '@/server/ensure-users-schema';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { revokeAccountAccess } from '@/server/trustedDevices';
import {
  EMAIL_ALREADY_REGISTERED,
  assertEmailAvailable,
  claimAccountEmail,
  releaseAccountEmail,
  assertUsernameAllowed,
} from '@/server/emailIdentity';

function adminOnly(auth: { role?: string } | null) {
  return !auth || auth.role !== 'admin';
}

type Ctx = { params: Promise<{ id: string }> };

async function fetchChair(uid: number) {
  const result = await query(`${DEPARTMENT_CHAIR_ACCOUNT_SELECT} AND u.id = $1`, [uid]);
  return result.rows[0] ?? null;
}

export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    await ensureUsersSchema();
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (adminOnly(auth)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const uid = parseInt(id, 10);
    if (isNaN(uid)) return NextResponse.json({ error: 'Invalid ID.' }, { status: 400 });

    const account = await fetchChair(uid);
    if (!account) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

    return NextResponse.json({ account });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    await ensureUsersSchema();
    const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
    if (adminOnly(auth)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const uid = parseInt(id, 10);
    if (isNaN(uid)) return NextResponse.json({ error: 'Invalid ID.' }, { status: 400 });

    const body = await req.json();
    const { username, email, password } = body as {
      username?: string;
      email?: string;
      password?: string;
    };

    if (!username?.trim()) return NextResponse.json({ error: 'Username is required.', field: 'username' }, { status: 400 });
    if (!email?.trim()) return NextResponse.json({ error: 'Email is required.', field: 'email' }, { status: 400 });
    if (password && password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.', field: 'password' }, { status: 400 });
    }

    const existing = await query(
      `SELECT id, email, google_verified FROM users WHERE id = $1 AND role = 'department_chair'`,
      [uid]
    );
    if (existing.rows.length === 0) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

    const existingRow = existing.rows[0] as { id: number; email: string; google_verified: boolean };
    const emailCheck = await assertEmailAvailable(email, {
      accountKind: 'user',
      accountId: uid,
    });
    if (!emailCheck.ok) {
      return NextResponse.json({ error: emailCheck.error, field: 'email' }, { status: 409 });
    }

    const usernameCheck = assertUsernameAllowed(username, {
      emailVerified: existingRow.google_verified === true,
      verifiedEmail: emailCheck.email,
    });
    if (!usernameCheck.ok) {
      return NextResponse.json({ error: usernameCheck.error, field: 'username' }, { status: 400 });
    }

    const currentEmail = String(existingRow.email).trim().toLowerCase();
    const nextEmail = emailCheck.email;
    const emailChanged = currentEmail !== nextEmail;

    const dupUser = await query(
      `SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2`,
      [usernameCheck.username, uid]
    );
    if (dupUser.rows.length > 0) {
      return NextResponse.json({ error: 'Username is already in use.', field: 'username' }, { status: 409 });
    }

    const claimed = await claimAccountEmail({
      email: nextEmail,
      accountKind: 'user',
      accountId: uid,
    });
    if (!claimed.ok) {
      return NextResponse.json({ error: claimed.error, field: 'email' }, { status: 409 });
    }

    const hash = password ? await bcrypt.hash(password, 12) : null;

    /* Email change clears Google verification (same rule as Instructor accounts). */
    await query(
      `UPDATE users SET
         username = $1,
         email = $2::varchar,
         google_sub = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN NULL ELSE google_sub END,
         google_verified = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN FALSE ELSE google_verified END,
         google_verified_at = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN NULL ELSE google_verified_at END,
         google_picture = CASE WHEN lower(trim(email)) IS DISTINCT FROM lower(trim($2::varchar)) THEN NULL ELSE google_picture END,
         password_hash = COALESCE($3, password_hash),
         updated_at = NOW()
       WHERE id = $4 AND role = 'department_chair'`,
      [usernameCheck.username, nextEmail, hash, uid]
    );

    if (password || emailChanged) await revokeAccountAccess('user', uid);

    const account = await fetchChair(uid);
    return NextResponse.json({ account });
  } catch (error) {
    const pg = error as { code?: string };
    if (pg?.code === '23505') {
      return NextResponse.json({ error: EMAIL_ALREADY_REGISTERED, field: 'email' }, { status: 409 });
    }
    console.error('[PUT /api/department-chair-accounts/:id]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    await ensureUsersSchema();
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (adminOnly(auth)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const uid = parseInt(id, 10);
    if (isNaN(uid)) return NextResponse.json({ error: 'Invalid ID.' }, { status: 400 });

    const body = await req.json();

    if ('is_active' in body) {
      const result = await query(
        `UPDATE users SET is_active = $1, updated_at = NOW()
         WHERE id = $2 AND role = 'department_chair'
         RETURNING id`,
        [Boolean(body.is_active), uid]
      );
      if (result.rows.length === 0) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
      if (Boolean(body.is_active) === false) await revokeAccountAccess('user', uid);
      const account = await fetchChair(uid);
      return NextResponse.json({ account });
    }

    if ('new_password' in body) {
      const { new_password } = body;
      if (!new_password || new_password.length < 8) {
        return NextResponse.json({ error: 'New password must be at least 8 characters.' }, { status: 400 });
      }
      const hash = await bcrypt.hash(new_password, 12);
      const result = await query(
        `UPDATE users SET password_hash = $1, updated_at = NOW()
         WHERE id = $2 AND role = 'department_chair'
         RETURNING id`,
        [hash, uid]
      );
      if (result.rows.length === 0) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
      await revokeAccountAccess('user', uid);
      const account = await fetchChair(uid);
      return NextResponse.json({ account });
    }

    return NextResponse.json({ error: 'Invalid patch body.' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    await ensureUsersSchema();
    const auth = await getAuthUser(req) as { role?: string; id?: number } | null;
    if (adminOnly(auth)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const uid = parseInt(id, 10);
    if (isNaN(uid)) return NextResponse.json({ error: 'Invalid ID.' }, { status: 400 });

    if (auth?.id === uid) {
      return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 403 });
    }

    const existing = await query(
      `SELECT id, profile_picture FROM users WHERE id = $1 AND role = 'department_chair'`,
      [uid]
    );
    if (existing.rows.length === 0) {
      return NextResponse.json({ error: 'Account not found or cannot be deleted.' }, { status: 404 });
    }
    const { profile_picture } = existing.rows[0] as { profile_picture: string | null };

    const result = await query(
      `DELETE FROM users WHERE id = $1 AND role = 'department_chair' RETURNING id`,
      [uid]
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Account not found or cannot be deleted.' }, { status: 404 });
    }

    await releaseAccountEmail('user', uid);

    if (profile_picture) {
      try {
        const filePath = path.join(process.cwd(), 'public', profile_picture.split('?')[0]);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (fileErr) {
        console.warn('[DELETE department-chair-account] Could not remove profile picture:', fileErr);
      }
    }

    // Department Chair notifications are broadcast (recipient_id = 0, shared
    // across every Department Chair account), not per-user — nothing to clean
    // up here without affecting other Department Chair accounts.

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/department-chair-accounts/:id]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
