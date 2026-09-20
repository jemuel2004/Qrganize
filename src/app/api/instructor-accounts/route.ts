import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/server/db';
import { getAuthUser } from '@/server/auth';
import bcrypt from 'bcryptjs';
import { parsePosition, resolveRequiredProgramId } from '@/server/facultyValidation';
import {
  EMAIL_ALREADY_REGISTERED,
  assertEmailAvailable,
  assertUsernameAllowed,
} from '@/server/emailIdentity';

export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const search   = searchParams.get('search')   || '';
    const status   = searchParams.get('status')   || '';
    const position = searchParams.get('position') || '';

    let sql = `
      SELECT
        ia.id          AS account_id,
        ia.faculty_id,
        ia.username,
        ia.email,
        ia.role,
        ia.is_active,
        ia.created_at  AS account_created_at,
        ia.updated_at  AS account_updated_at,
        f.name,
        f.first_name,
        f.last_name,
        f.middle_name,
        f.employee_id,
        f.position,
        f.employment_status,
        f.program_id,
        f.profile_picture,
        f.is_active    AS faculty_active,
        p.code         AS program_code,
        p.name         AS program_name
      FROM instructor_accounts ia
      JOIN faculty f ON ia.faculty_id = f.id
      LEFT JOIN programs p ON f.program_id = p.id
      WHERE f.is_active = true
    `;
    const params: unknown[] = [];
    let idx = 1;

    if (search) {
      sql += ` AND (
        f.name ILIKE $${idx} OR
        ia.username ILIKE $${idx} OR
        ia.email ILIKE $${idx} OR
        f.employee_id ILIKE $${idx} OR
        f.position ILIKE $${idx}
      )`;
      params.push(`%${search}%`);
      idx++;
    }
    if (status === 'active')   { sql += ` AND ia.is_active = true`;  }
    if (status === 'inactive') { sql += ` AND ia.is_active = false`; }
    if (position) {
      sql += ` AND f.position = $${idx++}`;
      params.push(position);
    }

    sql += ' ORDER BY f.name ASC';

    const result = await query(sql, params);
    return NextResponse.json({ accounts: result.rows });
  } catch (error) {
    console.error('[GET /api/instructor-accounts]', error);
    return NextResponse.json({ error: 'Failed to load instructor accounts.' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const role = auth.role as string;
    if (role !== 'admin' && role !== 'department_chair') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const { first_name, last_name, middle_name, program_id, position, username, email, password } = body;

    // Required field validation
    if (!first_name?.trim())
      return NextResponse.json({ error: 'First Name is required.', field: 'first_name' }, { status: 400 });
    if (!last_name?.trim())
      return NextResponse.json({ error: 'Last Name is required.', field: 'last_name' }, { status: 400 });
    const pos = parsePosition(position);
    if (!pos.ok)
      return NextResponse.json({ error: pos.error.error, field: pos.error.field }, { status: 400 });
    const program = await resolveRequiredProgramId(program_id);
    if (!program.ok)
      return NextResponse.json({ error: program.error.error, field: program.error.field }, { status: 400 });
    if (!username?.trim())
      return NextResponse.json({ error: 'Username is required.', field: 'username' }, { status: 400 });
    if (!email?.trim())
      return NextResponse.json({ error: 'Email is required.', field: 'email' }, { status: 400 });

    // Email format validation
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(email.trim()))
      return NextResponse.json({ error: 'Please enter a valid email address.', field: 'email' }, { status: 400 });

    if (!password)
      return NextResponse.json({ error: 'Password is required.', field: 'password' }, { status: 400 });
    if (password.length < 8)
      return NextResponse.json({ error: 'Password must be at least 8 characters.', field: 'password' }, { status: 400 });

    // Username: normal usernames only on create (new accounts are unverified)
    const usernameCheck = assertUsernameAllowed(username, { emailVerified: false });
    if (!usernameCheck.ok)
      return NextResponse.json({ error: usernameCheck.error, field: 'username' }, { status: 400 });

    // Duplicate checks
    const dupUser = await query(
      'SELECT id FROM instructor_accounts WHERE username = $1',
      [usernameCheck.username]
    );
    if (dupUser.rows.length > 0)
      return NextResponse.json({ error: 'Username already exists. Please choose another.', field: 'username' }, { status: 409 });

    const emailCheck = await assertEmailAvailable(email);
    if (!emailCheck.ok) {
      return NextResponse.json({ error: emailCheck.error, field: 'email' }, { status: 409 });
    }

    const mid  = (middle_name || '').trim();
    const name = [first_name.trim(), mid, last_name.trim()].filter(Boolean).join(' ');
    const passwordHash = await bcrypt.hash(password, 12);

    const newAccount = await transaction(async (client) => {
      const fRow = await client.query<{ id: number }>(`
        INSERT INTO faculty
          (first_name, last_name, middle_name, name, program_id, position,
           designation_type, designation_units, load_type)
        VALUES ($1, $2, $3, $4, $5, $6, 'No Designation', 0, 'Regular')
        RETURNING id
      `, [
        first_name.trim(), last_name.trim(), mid, name,
        program.id, pos.position,
      ]);

      const facultyId = fRow.rows[0].id;

      await client.query(
        `UPDATE faculty SET employee_id = 'FAC-' || LPAD($1::text, 4, '0') WHERE id = $1`,
        [facultyId]
      );

      const iaRow = await client.query<{ id: number }>(`
        INSERT INTO instructor_accounts (faculty_id, username, email, password_hash, role)
        VALUES ($1, $2, $3, $4, 'instructor')
        RETURNING id
      `, [facultyId, usernameCheck.username, emailCheck.email, passwordHash]);

      const accountId = Number(iaRow.rows[0].id);
      await client.query(
        `DELETE FROM account_email_registry WHERE account_kind = 'instructor' AND account_id = $1`,
        [accountId]
      ).catch(() => {});
      await client.query(
        `INSERT INTO account_email_registry (email_normalized, account_kind, account_id)
         VALUES ($1, 'instructor', $2)`,
        [emailCheck.email, accountId]
      );

      const combined = await client.query(`
        SELECT
          ia.id AS account_id, ia.faculty_id, ia.username, ia.email, ia.role,
          ia.is_active, ia.created_at AS account_created_at, ia.updated_at AS account_updated_at,
          f.name, f.first_name, f.last_name, f.middle_name, f.employee_id,
          f.position, f.employment_status, f.program_id, f.profile_picture,
          p.code AS program_code, p.name AS program_name
        FROM instructor_accounts ia
        JOIN faculty f ON ia.faculty_id = f.id
        LEFT JOIN programs p ON f.program_id = p.id
        WHERE ia.faculty_id = $1
      `, [facultyId]);

      return combined.rows[0];
    });

    return NextResponse.json({ account: newAccount }, { status: 201 });

  } catch (error) {
    const msg = String(error);
    console.error('[POST /api/instructor-accounts]', error);

    if ((error as { code?: string }).code === '23505' || msg.toLowerCase().includes('unique')) {
      if (msg.toLowerCase().includes('username'))
        return NextResponse.json({ error: 'Username already exists.', field: 'username' }, { status: 409 });
      if (msg.toLowerCase().includes('faculty_id'))
        return NextResponse.json({ error: 'This faculty member already has an account.' }, { status: 409 });
      return NextResponse.json({ error: EMAIL_ALREADY_REGISTERED, field: 'email' }, { status: 409 });
    }
    if (msg.includes('violates check constraint'))
      return NextResponse.json({ error: 'Invalid position value.' }, { status: 400 });

    return NextResponse.json({ error: 'A server error occurred. Please try again.' }, { status: 500 });
  }
}
