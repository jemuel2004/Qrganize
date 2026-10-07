import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { parseId } from '@/database/ids';
import { getAuthUser } from '@/auth/auth';
import { releaseFacultyAssignments } from '@/services/releaseFacultyAssignments';
import bcrypt from 'bcryptjs';
import { revokeAccountAccess, revokeInstructorAccessByFacultyId } from '@/auth/trustedDevices';
import { INSTRUCTOR_EMAIL_GOOGLE_SQL, parsePosition, resolveOptionalProgramId } from '@/services/facultyValidation';
import { ensureFacultyProfileColumns, ensureInstructorGooglePicture } from '@/database/schema-guard';
import { assertEmailAvailable, EMAIL_ALREADY_REGISTERED, assertUsernameAllowed } from '@/auth/emailIdentity';
import { PRIORITY_SUBJECTS_SUBQUERY, setPrioritySubjects, type PrioritySubject } from '@/services/facultyPrioritySubjects';
import { withAudit } from '@/services/audit';

type Params = { params: Promise<{ id: string }> };

// GET /api/instructor-accounts/[id]
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || auth.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureFacultyProfileColumns();
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    const result = await query(`
      SELECT
        ia.id AS account_id, ia.faculty_id, ia.username, ia.email, ia.role,
        ia.is_active, ia.google_verified, ia.google_verified_at,
        ia.created_at AS account_created_at, ia.updated_at AS account_updated_at,
        f.name, f.first_name, f.last_name, f.middle_name, f.employee_id,
        f.position, f.employment_status, f.program_id, f.profile_picture, f.specialization,
        p.code AS program_code, p.name AS program_name,
        ${PRIORITY_SUBJECTS_SUBQUERY} AS priority_subjects
      FROM instructor_accounts ia
      JOIN faculty f ON ia.faculty_id = f.id
      LEFT JOIN programs p ON f.program_id = p.id
      WHERE ia.faculty_id = $1
    `, [id]);

    if (result.rows.length === 0)
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

    return NextResponse.json({ account: result.rows[0] });
  } catch (error) {
    console.error('[GET /api/instructor-accounts/[id]]', error);
    return NextResponse.json({ error: 'Failed to load account.' }, { status: 500 });
  }
}

// PUT /api/instructor-accounts/[id] — update profile + credentials
async function PUT_handler(req: NextRequest, { params }: Params) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const role = auth.role as string;
    if (role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await ensureInstructorGooglePicture();

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    const { first_name, last_name, middle_name, program_id, position, username, email, password, priority_subjects } = await req.json();

    // Required field validation
    if (!first_name?.trim())
      return NextResponse.json({ error: 'First Name is required.', field: 'first_name' }, { status: 400 });
    if (!last_name?.trim())
      return NextResponse.json({ error: 'Last Name is required.', field: 'last_name' }, { status: 400 });
    const pos = parsePosition(position);
    if (!pos.ok)
      return NextResponse.json({ error: pos.error.error, field: pos.error.field }, { status: 400 });
    // Program is optional — a faculty member may belong to no single program
    const program = await resolveOptionalProgramId(program_id);
    if (!program.ok)
      return NextResponse.json({ error: program.error.error, field: program.error.field }, { status: 400 });
    if (!username?.trim())
      return NextResponse.json({ error: 'Username is required.', field: 'username' }, { status: 400 });
    if (!email?.trim())
      return NextResponse.json({ error: 'Email is required.', field: 'email' }, { status: 400 });

    if (password && password.length < 8)
      return NextResponse.json({ error: 'Password must be at least 8 characters.', field: 'password' }, { status: 400 });

    const accountIdRow = await query(
      'SELECT id, google_verified FROM instructor_accounts WHERE faculty_id = $1',
      [id]
    );
    const accountId = Number(accountIdRow.rows[0]?.id);
    if (!accountId) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    const googleVerified = accountIdRow.rows[0]?.google_verified === true;

    const emailCheck = await assertEmailAvailable(email, {
      accountKind: 'instructor',
      accountId,
    });
    if (!emailCheck.ok) {
      return NextResponse.json({ error: emailCheck.error, field: 'email' }, { status: 409 });
    }

    const usernameCheck = assertUsernameAllowed(username, {
      emailVerified: googleVerified,
      verifiedEmail: emailCheck.email,
    });
    if (!usernameCheck.ok) {
      return NextResponse.json({ error: usernameCheck.error, field: 'username' }, { status: 400 });
    }

    // Uniqueness checks excluding self
    const dupUser = await query(
      'SELECT id FROM instructor_accounts WHERE username = $1 AND faculty_id != $2',
      [usernameCheck.username, id]
    );
    if (dupUser.rows.length > 0)
      return NextResponse.json({ error: 'Username already exists. Please choose another.', field: 'username' }, { status: 409 });

    const prevEmail = await query(
      'SELECT email FROM instructor_accounts WHERE faculty_id = $1',
      [id]
    );
    const emailDidChange =
      String(prevEmail.rows[0]?.email ?? '').trim().toLowerCase() !== emailCheck.email;

    const mid  = (middle_name || '').trim();
    const name = [first_name.trim(), mid, last_name.trim()].filter(Boolean).join(' ');

    const updated = await transaction(async (client) => {
      // Update faculty profile
      await client.query(`
        UPDATE faculty
        SET first_name = $1, last_name = $2, middle_name = $3, name = $4,
            program_id = $5, position = $6, updated_at = NOW()
        WHERE id = $7
      `, [
        first_name.trim(), last_name.trim(), mid, name,
        program.id, pos.position, id,
      ]);

      // Update credentials (password optional)
      if (password) {
        const passwordHash = await bcrypt.hash(password, 12);
        await client.query(`
          UPDATE instructor_accounts
          SET username = $1,
              ${INSTRUCTOR_EMAIL_GOOGLE_SQL},
              password_hash = $3,
              updated_at = NOW()
          WHERE faculty_id = $4
        `, [usernameCheck.username, emailCheck.email, passwordHash, id]);
      } else {
        await client.query(`
          UPDATE instructor_accounts
          SET username = $1,
              ${INSTRUCTOR_EMAIL_GOOGLE_SQL},
              updated_at = NOW()
          WHERE faculty_id = $3
        `, [usernameCheck.username, emailCheck.email, id]);
      }

      await client.query(
        `DELETE FROM account_email_registry WHERE account_kind = 'instructor' AND account_id = $1`,
        [accountId]
      ).catch(() => {});
      await client.query(
        `INSERT INTO account_email_registry (email_normalized, account_kind, account_id)
         VALUES ($1, 'instructor', $2)`,
        [emailCheck.email, accountId]
      );

      await setPrioritySubjects(client, Number(id), priority_subjects as PrioritySubject[] | undefined);

      const row = await client.query(`
        SELECT
          ia.id AS account_id, ia.faculty_id, ia.username, ia.email, ia.role,
          ia.is_active, ia.google_verified, ia.google_verified_at,
          ia.created_at AS account_created_at, ia.updated_at AS account_updated_at,
          f.name, f.first_name, f.last_name, f.middle_name, f.employee_id,
          f.position, f.employment_status, f.program_id, f.profile_picture, f.specialization,
          p.code AS program_code, p.name AS program_name,
          ${PRIORITY_SUBJECTS_SUBQUERY} AS priority_subjects
        FROM instructor_accounts ia
        JOIN faculty f ON ia.faculty_id = f.id
        LEFT JOIN programs p ON f.program_id = p.id
        WHERE ia.faculty_id = $1
      `, [id]);

      return row.rows[0];
    });

    if (password || emailDidChange) await revokeInstructorAccessByFacultyId(Number(id));
    return NextResponse.json({ account: updated });
  } catch (error) {
    const msg = String(error);
    console.error('[PUT /api/instructor-accounts/[id]]', error);
    if ((error as { code?: string }).code === '23505' || msg.toLowerCase().includes('unique')) {
      if (msg.toLowerCase().includes('username'))
        return NextResponse.json({ error: 'Username already exists.', field: 'username' }, { status: 409 });
      return NextResponse.json({ error: EMAIL_ALREADY_REGISTERED, field: 'email' }, { status: 409 });
    }
    return NextResponse.json({ error: 'A server error occurred. Please try again.' }, { status: 500 });
  }
}

// PATCH /api/instructor-accounts/[id] — toggle active status OR reset password
async function PATCH_handler(req: NextRequest, { params }: Params) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const role = auth.role as string;
    if (role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    const body = await req.json();

    // --- Toggle active ---
    if ('is_active' in body) {
      const result = await query(`
        UPDATE instructor_accounts
        SET is_active = $1, updated_at = NOW()
        WHERE faculty_id = $2
        RETURNING id, is_active, updated_at
      `, [Boolean(body.is_active), id]);

      if (result.rows.length === 0)
        return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

      if (Boolean(body.is_active) === false) {
        await revokeAccountAccess('instructor', Number(result.rows[0].id));
      }

      return NextResponse.json({ account: result.rows[0] });
    }

    // --- Reset password ---
    if ('new_password' in body) {
      const { new_password } = body;
      if (!new_password || new_password.length < 8)
        return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });

      const passwordHash = await bcrypt.hash(new_password, 12);
      const result = await query(`
        UPDATE instructor_accounts
        SET password_hash = $1, updated_at = NOW()
        WHERE faculty_id = $2
        RETURNING id, updated_at
      `, [passwordHash, id]);

      if (result.rows.length === 0)
        return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

      await revokeAccountAccess('instructor', Number(result.rows[0].id));
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'No valid action specified.' }, { status: 400 });
  } catch (error) {
    console.error('[PATCH /api/instructor-accounts/[id]]', error);
    return NextResponse.json({ error: 'Failed to update account.' }, { status: 500 });
  }
}

// DELETE /api/instructor-accounts/[id] — soft-delete both account and faculty
async function DELETE_handler(req: NextRequest, { params }: Params) {
  try {
    const auth = await getAuthUser(req);
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const role = auth.role as string;
    if (role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });

    await transaction(async (client) => {
      await releaseFacultyAssignments(client, Number(id));
      await client.query('UPDATE instructor_accounts SET is_active = false WHERE faculty_id = $1', [id]);
      await client.query('UPDATE faculty SET is_active = false WHERE id = $1', [id]);
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/instructor-accounts/[id]]', error);
    return NextResponse.json({ error: 'Failed to deactivate account.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const PUT = withAudit(PUT_handler);
export const PATCH = withAudit(PATCH_handler);
export const DELETE = withAudit(DELETE_handler);
