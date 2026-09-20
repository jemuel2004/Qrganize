import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query } from '@/server/db';
import { DEPT_CHAIR_ACCOUNT_SELECT, ensureUsersSchema } from '@/server/ensure-users-schema';
import bcrypt from 'bcryptjs';
import { resolveRequiredProgramId } from '@/server/facultyValidation';
import {
  EMAIL_ALREADY_REGISTERED,
  assertEmailAvailable,
  claimAccountEmail,
  assertUsernameAllowed,
} from '@/server/emailIdentity';

function adminOnly(auth: { role?: string } | null) {
  return !auth || auth.role !== 'admin';
}

export async function GET(req: NextRequest) {
  try {
    await ensureUsersSchema();
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (adminOnly(auth)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const search = searchParams.get('search')?.trim() ?? '';

    const result = await query(
      `${DEPT_CHAIR_ACCOUNT_SELECT}
         AND ($1 = '' OR u.username ILIKE $2 OR u.email ILIKE $2 OR p.code ILIKE $2 OR p.name ILIKE $2)
       ORDER BY u.created_at DESC`,
      [search, `%${search}%`]
    );

    return NextResponse.json({ accounts: result.rows });
  } catch (error) {
    console.error('[GET /api/dept-chair-accounts]', error);
    return NextResponse.json({ error: 'Failed to load accounts.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureUsersSchema();
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (adminOnly(auth)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { username, email, password, confirm_password, program_id } = body;

    if (!username?.trim()) return NextResponse.json({ error: 'Username is required.', field: 'username' }, { status: 400 });
    const usernameCheck = assertUsernameAllowed(username, { emailVerified: false });
    if (!usernameCheck.ok) {
      return NextResponse.json({ error: usernameCheck.error, field: 'username' }, { status: 400 });
    }
    if (!email?.trim()) return NextResponse.json({ error: 'Email is required.', field: 'email' }, { status: 400 });
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(email.trim())) {
      return NextResponse.json({ error: 'Please enter a valid email address.', field: 'email' }, { status: 400 });
    }
    if (!password) return NextResponse.json({ error: 'Password is required.', field: 'password' }, { status: 400 });
    if (password !== confirm_password) {
      return NextResponse.json({ error: 'Passwords do not match.', field: 'confirm_password' }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.', field: 'password' }, { status: 400 });
    }

    const program = await resolveRequiredProgramId(program_id);
    if (!program.ok) {
      return NextResponse.json(
        { error: program.error.error === 'Program is required.' ? 'Please select a program.' : program.error.error, field: 'program_id' },
        { status: 400 }
      );
    }

    const normalUsername = usernameCheck.username;
    const emailCheck = await assertEmailAvailable(email);
    if (!emailCheck.ok) {
      return NextResponse.json({ error: emailCheck.error, field: 'email' }, { status: 409 });
    }
    const normalEmail = emailCheck.email;

    const dupUser = await query(
      `SELECT id FROM users WHERE LOWER(username) = LOWER($1)`,
      [normalUsername]
    );
    if (dupUser.rows.length > 0) {
      return NextResponse.json({ error: 'Username is already in use.', field: 'username' }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await query(
      `INSERT INTO users (
         username, email, password_hash, role, is_active,
         program_id, google_sub, google_verified, google_verified_at, google_picture
       )
       VALUES ($1, $2, $3, 'department_chair', true, $4, NULL, false, NULL, NULL)
       RETURNING id`,
      [normalUsername, normalEmail, passwordHash, program.id]
    );

    const newId = Number(result.rows[0].id);
    const claimed = await claimAccountEmail({
      email: normalEmail,
      accountKind: 'user',
      accountId: newId,
    });
    if (!claimed.ok) {
      await query(`DELETE FROM users WHERE id = $1`, [newId]).catch(() => {});
      return NextResponse.json({ error: EMAIL_ALREADY_REGISTERED, field: 'email' }, { status: 409 });
    }

    const created = await query(
      `${DEPT_CHAIR_ACCOUNT_SELECT} AND u.id = $1`,
      [newId]
    );

    return NextResponse.json({ account: created.rows[0] }, { status: 201 });
  } catch (error) {
    const pg = error as { code?: string };
    if (pg?.code === '23505') {
      return NextResponse.json({ error: EMAIL_ALREADY_REGISTERED, field: 'email' }, { status: 409 });
    }
    console.error('[POST /api/dept-chair-accounts]', error);
    return NextResponse.json({ error: 'Failed to create account.' }, { status: 500 });
  }
}
