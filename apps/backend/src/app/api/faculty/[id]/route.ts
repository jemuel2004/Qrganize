import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { releaseFacultyAssignments } from '@/services/releaseFacultyAssignments';
import bcrypt from 'bcryptjs';
import { deleteUploadedFile } from '@/services/uploadStorage';
import { revokeInstructorAccessByFacultyId } from '@/auth/trustedDevices';
import {
  INSTRUCTOR_EMAIL_GOOGLE_SQL,
  classifyFacultyPgError,
  parseFacultyId,
  parsePosition,
  resolveOptionalProgramId,
} from '@/services/facultyValidation';
import { ensureFacultyProfileColumns } from '@/database/schema-guard';
import { formatLoadCap, maxDeductionUnits, regularUnitsCap, shownUnitsCap } from '@shared/regularLoad';
import { getWorkloadPolicy, sqlNumber } from '@/services/workloadPolicy';
import {
  assertEmailAvailable,
  ensureEmailRegistry,
  assertUsernameAllowed,
} from '@/auth/emailIdentity';
import { PRIORITY_SUBJECTS_SUBQUERY, setPrioritySubjects, type PrioritySubject } from '@/services/facultyPrioritySubjects';
import { ASSIGNED_BLOCK_IDS_SUBQUERY, setFacultyBlocks } from '@/services/facultyBlocks';
import { canAccessProgram, isScopedChair } from '@/services/programScope';
import { withAudit } from '@/services/audit';


export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { role?: string; program_id?: number | null } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await ensureFacultyProfileColumns();
    const { id } = await params;

    if (isScopedChair(auth)) {
      const ownerCheck = await query('SELECT program_id FROM faculty WHERE id = $1', [id]);
      if (ownerCheck.rows.length === 0) return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
      if (!(await canAccessProgram(auth, ownerCheck.rows[0].program_id))) {
        return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
      }
    }

    const policy = await getWorkloadPolicy();
    const result = await query(`
      SELECT
        f.id, f.first_name, f.last_name, f.middle_name, f.name, f.employee_id,
        f.program_id, f.position, f.employment_status, f.designation_type,
        f.designation_units, f.load_type, f.contact_number, f.is_active,
        f.years_in_service, f.educational_qualification, f.major, f.eligibility, f.specialization,
        p.code AS program_code, p.name AS program_name,
        ia.username, ia.email,
        ia.google_verified, ia.google_verified_at,
        CASE WHEN f.employment_status = 'Permanent'
          THEN GREATEST(0, ${sqlNumber(regularUnitsCap(policy))} - COALESCE(f.designation_units, 0))
          ELSE ${sqlNumber(policy.contractualHours)}
        END AS regular_load_limit,
        COALESCE((
          SELECT SUM(CASE WHEN f.employment_status = 'Permanent' THEN c.units ELSE c.total_hours END)
          FROM instructor_loads il
          JOIN master_schedule ms ON il.master_schedule_id = ms.id
          JOIN block_subjects bs ON ms.block_subject_id = bs.id
          JOIN curriculums c ON bs.curriculum_id = c.id
          WHERE il.faculty_id = f.id AND il.load_category = 'Regular'
        ), 0) AS current_regular_load,
        COALESCE((
          SELECT SUM(CASE WHEN f.employment_status = 'Permanent' THEN c.units ELSE c.total_hours END)
          FROM instructor_loads il
          JOIN master_schedule ms ON il.master_schedule_id = ms.id
          JOIN block_subjects bs ON ms.block_subject_id = bs.id
          JOIN curriculums c ON bs.curriculum_id = c.id
          WHERE il.faculty_id = f.id AND il.load_category = 'Overload'
        ), 0) AS current_overload,
        ${PRIORITY_SUBJECTS_SUBQUERY} AS priority_subjects,
        ${ASSIGNED_BLOCK_IDS_SUBQUERY} AS assigned_block_ids
      FROM faculty f
      LEFT JOIN programs p ON f.program_id = p.id
      LEFT JOIN instructor_accounts ia ON ia.faculty_id = f.id
      WHERE f.id = $1
    `, [id]);

    if (result.rows.length === 0) return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
    return NextResponse.json({ faculty: result.rows[0] });
  } catch (error) {
    console.error('[GET /api/faculty/id]', error);
    const classified = classifyFacultyPgError(error);
    if (classified) return classified;
    return NextResponse.json({ error: 'Failed to load faculty details.' }, { status: 500 });
  }
}

async function PUT_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Editing a faculty record is admin-only — Department Chair and Program
    // Chair can view the Faculty page but not add/edit/delete records there.
    const auth = await getAuthUser(req) as { role?: string; program_id?: number | null } | null;
    if (!auth || auth.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await ensureFacultyProfileColumns();
    await ensureEmailRegistry();
    const { id: idParam } = await params;
    const id = parseFacultyId(idParam);
    if (id === null)
      return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body — expected JSON.' }, { status: 400 });
    }

    const {
      first_name, last_name, middle_name,
      program_id, position, designation_type, designation_units, load_type,
      username, email, password,
      years_in_service, educational_qualification, major, eligibility, specialization,
      priority_subjects, block_ids,
    } = body;

    if (!String(first_name ?? '').trim())
      return NextResponse.json({ error: 'First Name is required.', field: 'first_name' }, { status: 400 });
    if (!String(last_name ?? '').trim())
      return NextResponse.json({ error: 'Last Name is required.', field: 'last_name' }, { status: 400 });
    const pos = parsePosition(position);
    if (!pos.ok)
      return NextResponse.json({ error: pos.error.error, field: pos.error.field }, { status: 400 });
    // Program is optional — blank clears it (a faculty member may belong to no single program)
    const program = await resolveOptionalProgramId(program_id);
    if (!program.ok)
      return NextResponse.json({ error: program.error.error, field: program.error.field }, { status: 400 });
    if (!String(username ?? '').trim())
      return NextResponse.json({ error: 'Username is required.', field: 'username' }, { status: 400 });
    if (!String(email ?? '').trim())
      return NextResponse.json({ error: 'Email is required.', field: 'email' }, { status: 400 });

    const accountIdRow = await query(
      'SELECT id, google_verified FROM instructor_accounts WHERE faculty_id = $1',
      [id]
    );
    const accountId = Number(accountIdRow.rows[0]?.id);
    if (!accountId) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    const googleVerified = accountIdRow.rows[0]?.google_verified === true;

    const emailCheck = await assertEmailAvailable(String(email), {
      accountKind: 'instructor',
      accountId,
    });
    if (!emailCheck.ok)
      return NextResponse.json({ error: emailCheck.error, field: 'email' }, { status: 409 });
    const emailStr = emailCheck.email;

    const usernameCheck = assertUsernameAllowed(username, {
      emailVerified: googleVerified,
      verifiedEmail: emailStr,
    });
    if (!usernameCheck.ok)
      return NextResponse.json({ error: usernameCheck.error, field: 'username' }, { status: 400 });

    const userStr = usernameCheck.username;
    const fnStr = String(first_name).trim();
    const lnStr = String(last_name).trim();
    const mid = String(middle_name ?? '').trim();
    const fullName = [fnStr, mid, lnStr].filter(Boolean).join(' ');

    const dupUser = await query(
      'SELECT id FROM instructor_accounts WHERE username = $1 AND faculty_id != $2 AND is_active = true',
      [userStr, id]
    );
    if (dupUser.rows.length > 0)
      return NextResponse.json({ error: 'Username already exists. Please choose another username.', field: 'username' }, { status: 409 });

    if (password && String(password).length < 8)
      return NextResponse.json({ error: 'Password must be at least 8 characters.', field: 'password' }, { status: 400 });

    // Only Contractual is hour-based; Temporary Permanent is unit-based like Permanent.
    const isHourBased = pos.position === 'Contractual';
    const desUnitsNum = Number(designation_units) || 0;
    if (isHourBased && desUnitsNum > 0)
      return NextResponse.json({ error: 'Contractual faculty cannot have designation units.' }, { status: 400 });

    const desUnits = isHourBased ? 0 : desUnitsNum;
    const desType  = isHourBased ? 'No Designation' : (String(designation_type || 'No Designation').trim());

    const yis = years_in_service != null && String(years_in_service).trim() !== ''
      ? Number(years_in_service) : null;
    if (yis !== null && (!Number.isInteger(yis) || yis < 0 || yis > 100))
      return NextResponse.json({ error: 'Years in Service must be a whole number between 0 and 100.', field: 'years_in_service' }, { status: 400 });
    const edQual   = educational_qualification ? String(educational_qualification).trim().slice(0, 255) || null : null;
    const majorVal = major ? String(major).trim().slice(0, 255) || null : null;
    const eligVal  = eligibility ? String(eligibility).trim().slice(0, 255) || null : null;
    const specVal  = specialization ? String(specialization).trim().slice(0, 255) || null : null;

    const prevAccount = await query(
      'SELECT email FROM instructor_accounts WHERE faculty_id = $1',
      [id]
    );
    const emailDidChange =
      String(prevAccount.rows[0]?.email ?? '').trim().toLowerCase() !== emailStr;

    const updated = await transaction(async (client) => {
      const fResult = await client.query(`
        UPDATE faculty
        SET first_name=$1, last_name=$2, middle_name=$3, name=$4,
            program_id=$5, position=$6, designation_type=$7, designation_units=$8,
            load_type=$9, years_in_service=$10, educational_qualification=$11,
            major=$12, eligibility=$13, specialization=$14, updated_at=NOW()
        WHERE id=$15 RETURNING id
      `, [
        fnStr, lnStr, mid, fullName,
        program.id, pos.position, desType, desUnits,
        String(load_type || 'Regular').trim(), yis, edQual, majorVal, eligVal, specVal, id,
      ]);

      if (fResult.rows.length === 0) throw new Error('NOT_FOUND');

      if (password) {
        const passwordHash = await bcrypt.hash(String(password), 12);
        await client.query(`
          UPDATE instructor_accounts
          SET username=$1,
              ${INSTRUCTOR_EMAIL_GOOGLE_SQL},
              password_hash=$3,
              updated_at=NOW()
          WHERE faculty_id=$4
        `, [userStr, emailStr, passwordHash, id]);
      } else {
        await client.query(`
          UPDATE instructor_accounts
          SET username=$1,
              ${INSTRUCTOR_EMAIL_GOOGLE_SQL},
              updated_at=NOW()
          WHERE faculty_id=$3
        `, [userStr, emailStr, id]);
      }

      await client.query(
        `DELETE FROM account_email_registry WHERE account_kind = 'instructor' AND account_id = $1`,
        [accountId]
      ).catch(() => {});
      await client.query(
        `INSERT INTO account_email_registry (email_normalized, account_kind, account_id)
         VALUES ($1, 'instructor', $2)`,
        [emailStr, accountId]
      );

      await setPrioritySubjects(client, id, priority_subjects as PrioritySubject[] | undefined);
      await setFacultyBlocks(client, id, block_ids);

      // 3. Return the updated combined record
      const full = await client.query(`
        SELECT
          f.id, f.first_name, f.last_name, f.middle_name, f.name, f.employee_id,
          f.program_id, f.position, f.employment_status, f.designation_type,
          f.designation_units, f.load_type,
          f.years_in_service, f.educational_qualification, f.major, f.eligibility, f.specialization,
          ia.username, ia.email, ia.google_verified, ia.google_verified_at,
          p.code AS program_code,
          ${PRIORITY_SUBJECTS_SUBQUERY} AS priority_subjects,
        ${ASSIGNED_BLOCK_IDS_SUBQUERY} AS assigned_block_ids
        FROM faculty f
        LEFT JOIN programs p ON f.program_id = p.id
        LEFT JOIN instructor_accounts ia ON ia.faculty_id = f.id
        WHERE f.id = $1
      `, [id]);

      return full.rows[0];
    });

    if (password || emailDidChange) await revokeInstructorAccessByFacultyId(Number(id));
    return NextResponse.json({ faculty: updated });

  } catch (error) {
    console.error('[PUT /api/faculty/id] Unhandled error:', error);
    if (String(error) === 'Error: NOT_FOUND' || (error as Error).message === 'NOT_FOUND')
      return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
    const classified = classifyFacultyPgError(error);
    if (classified) return classified;
    return NextResponse.json({ error: 'A server error occurred while updating. Please try again.' }, { status: 500 });
  }
}

async function PATCH_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || auth.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    const { designation_type, designation_units } = await req.json();

    const desUnits = Math.max(0, parseFloat(String(designation_units)) || 0);
    const desType  = (designation_type === 'None' || !designation_type) ? 'No Designation' : String(designation_type).trim();

    if (desType !== 'No Designation' && isNaN(desUnits)) {
      return NextResponse.json({ error: 'Designation units must be a number.' }, { status: 400 });
    }
    const maxDeduction = maxDeductionUnits(await getWorkloadPolicy());
    if (desUnits > maxDeduction) {
      return NextResponse.json({ error: `Total deduction cannot exceed ${formatLoadCap(shownUnitsCap(maxDeduction))} units.` }, { status: 400 });
    }

    const result = await query(`
      UPDATE faculty
      SET designation_type=$1, designation_units=$2, updated_at=NOW()
      WHERE id=$3 AND employment_status='Permanent'
      RETURNING id, designation_type, designation_units
    `, [desType, desUnits, id]);

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Faculty not found or not Permanent.' }, { status: 404 });
    }

    return NextResponse.json({ faculty: result.rows[0] });
  } catch (error) {
    console.error('[PATCH /api/faculty/id]', error);
    return NextResponse.json({ error: 'Failed to update designation.' }, { status: 500 });
  }
}

async function DELETE_handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    // Deleting a faculty record is admin-only — Department Chair and Program
    // Chair can view the Faculty page but not add/edit/delete records there.
    if (!auth || auth.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    // Fetch profile picture path before deletion so we can clean up the file
    const picRow = await query(
      'SELECT profile_picture FROM faculty WHERE id = $1',
      [id]
    );
    if (picRow.rows.length === 0)
      return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });

    const profilePicture: string | null = picRow.rows[0].profile_picture ?? null;

    // Release workload slots first (keep master_schedule rows; clear instructor + status),
    // then delete the faculty row. instructor_loads/overloads are removed in the helper;
    // remaining child tables still CASCADE. Blocks/subjects/programs are never deleted.
    await transaction(async (client) => {
      await releaseFacultyAssignments(client, Number(id));
      const deleted = await client.query('DELETE FROM faculty WHERE id = $1 RETURNING id', [id]);
      if (deleted.rows.length === 0) throw new Error('NOT_FOUND');
    });

    // Delete the stored profile picture (best-effort, non-fatal)
    await deleteUploadedFile(profilePicture);

    return NextResponse.json({ success: true });
  } catch (error) {
    if ((error as Error).message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
    }
    console.error('[DELETE /api/faculty/id]', error);
    return NextResponse.json({ error: 'Failed to delete faculty.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const PUT = withAudit(PUT_handler);
export const PATCH = withAudit(PATCH_handler);
export const DELETE = withAudit(DELETE_handler);
