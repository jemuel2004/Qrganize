import { NextRequest, NextResponse } from 'next/server';
import { query, transaction } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import bcrypt from 'bcryptjs';
import { classifyFacultyPgError, parsePosition, resolveRequiredProgramId } from '@/services/facultyValidation';
import { ensureFacultyProfileColumns, resetFacultyProfileColumns } from '@/database/schema-guard';
import { regularUnitsCap } from '@shared/regularLoad';
import { getWorkloadPolicy, sqlNumber } from '@/services/workloadPolicy';
import {
  assertEmailAvailable,
  ensureEmailRegistry,
  assertUsernameAllowed,
} from '@/auth/emailIdentity';
import { PRIORITY_SUBJECTS_SUBQUERY, setPrioritySubjects, type PrioritySubject } from '@/services/facultyPrioritySubjects';
import { ASSIGNED_BLOCK_IDS_SUBQUERY, setFacultyBlocks } from '@/services/facultyBlocks';
import { resolveProgramScope, canAccessProgram } from '@/services/programScope';
import { withAudit } from '@/services/audit';


// ─────────────────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const authGet = await getAuthUser(req) as { role?: string; program_id?: number | null } | null;
    if (!authGet || !['admin', 'department_chair', 'program_chair'].includes(authGet.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await ensureFacultyProfileColumns();

    const { searchParams } = new URL(req.url);
    const scope = await resolveProgramScope(authGet, { requestedProgramId: searchParams.get('program_id') });
    if (!scope.ok) return scope.response;
    const programId         = scope.programId != null ? String(scope.programId) : null;
    const employmentStatus = searchParams.get('employment_status');
    const policy = await getWorkloadPolicy();

    let sql = `
      SELECT
        f.id, f.first_name, f.last_name, f.middle_name, f.name, f.employee_id,
        f.program_id, f.position, f.employment_status, f.designation_type,
        f.designation_units, f.load_type, f.contact_number,
        f.is_active, f.created_at,
        f.years_in_service, f.educational_qualification, f.major, f.eligibility,
        f.specialization,
        p.code AS program_code,
        p.name AS program_name,
        CASE WHEN f.employment_status = 'Permanent'
          THEN GREATEST(0, ${sqlNumber(regularUnitsCap(policy))} - COALESCE(f.designation_units, 0))
          ELSE ${sqlNumber(policy.contractualHours)}
        END AS remaining_regular_load,
        ${PRIORITY_SUBJECTS_SUBQUERY} AS priority_subjects,
        ${ASSIGNED_BLOCK_IDS_SUBQUERY} AS assigned_block_ids
      FROM faculty f
      LEFT JOIN programs p ON p.id = f.program_id
      WHERE f.is_active IS NOT FALSE
    `;
    const params: unknown[] = [];
    let idx = 1;

    if (programId)        { sql += ` AND f.program_id = $${idx++}`;        params.push(programId); }
    if (employmentStatus) { sql += ` AND f.employment_status = $${idx++}`; params.push(employmentStatus); }
    sql += ' ORDER BY f.name';

    const result = await query(sql, params);
    const incomplete = result.rows.filter((r: { program_id: number | null }) => r.program_id == null);
    if (process.env.NODE_ENV !== 'production' && incomplete.length > 0) {
      console.warn(
        `[GET /api/faculty] ${incomplete.length} faculty record(s) missing program_id (ids: ${incomplete.map((r: { id: number }) => r.id).join(', ')}). Assign a Program when editing these records.`
      );
    }
    return NextResponse.json({ faculty: result.rows });
  } catch (error) {
    console.error('[GET /api/faculty]', error);
    const classified = classifyFacultyPgError(error);
    if (classified) return classified;
    return NextResponse.json({ error: 'Failed to load faculty list.' }, { status: 500 });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function POST_handler(req: NextRequest) {
  try {
    // ── Auth ─────────────────────────────────────────────────────────────────
    // Faculty creation is admin-only — Department Chair and Program Chair can
    // view the Faculty page but not add/edit/delete records there.
    const auth = await getAuthUser(req) as { role?: string; program_id?: number | null } | null;
    if (!auth || auth.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ── Self-heal schema before any DB write ──────────────────────────────────
    await ensureFacultyProfileColumns();
    await ensureEmailRegistry();

    // ── Parse body ────────────────────────────────────────────────────────────
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
    } = body as Record<string, unknown>;

    // ── Required field validation ─────────────────────────────────────────────
    if (!String(first_name ?? '').trim())
      return NextResponse.json({ error: 'First Name is required.', field: 'first_name' }, { status: 400 });
    if (!String(last_name ?? '').trim())
      return NextResponse.json({ error: 'Last Name is required.', field: 'last_name' }, { status: 400 });
    const pos = parsePosition(position);
    if (!pos.ok)
      return NextResponse.json({ error: pos.error.error, field: pos.error.field }, { status: 400 });
    const program = await resolveRequiredProgramId(program_id);
    if (!program.ok)
      return NextResponse.json({ error: program.error.error, field: program.error.field }, { status: 400 });
    if (!(await canAccessProgram(auth, program.id))) {
      return NextResponse.json(
        { error: 'You can only add faculty to your assigned program.', field: 'program_id' },
        { status: 403 }
      );
    }
    if (!String(username ?? '').trim())
      return NextResponse.json({ error: 'Username is required.', field: 'username' }, { status: 400 });
    if (!String(email ?? '').trim())
      return NextResponse.json({ error: 'Email is required.', field: 'email' }, { status: 400 });

    const usernameCheck = assertUsernameAllowed(username, { emailVerified: false });
    if (!usernameCheck.ok)
      return NextResponse.json({ error: usernameCheck.error, field: 'username' }, { status: 400 });

    // Basic email format check
    const emailCheck = await assertEmailAvailable(String(email ?? ''));
    if (!emailCheck.ok)
      return NextResponse.json({ error: emailCheck.error, field: 'email' }, { status: 409 });
    const emailStr = emailCheck.email;

    if (!password)
      return NextResponse.json({ error: 'Password is required.', field: 'password' }, { status: 400 });
    if (String(password).length < 8)
      return NextResponse.json({ error: 'Password must be at least 8 characters.', field: 'password' }, { status: 400 });

    // ── Sanitise and derive computed values ───────────────────────────────────
    const fnStr  = String(first_name).trim().slice(0, 100);
    const lnStr  = String(last_name).trim().slice(0, 100);
    const midStr = String(middle_name ?? '').trim().slice(0, 100);
    const uStr   = usernameCheck.username.slice(0, 100);
    const posStr = pos.position;
    const fullName = [fnStr, midStr, lnStr].filter(Boolean).join(' ');

    // Only Contractual is hour-based; Temporary Permanent is unit-based like Permanent.
    const isContractual = posStr === 'Contractual';
    const desUnits = isContractual ? 0 : (Number(designation_units) || 0);
    const desType  = isContractual ? 'No Designation' : (String(designation_type || 'No Designation').trim());

    if (!isContractual && desUnits < 0)
      return NextResponse.json({ error: 'Designation units cannot be negative.', field: 'designation_units' }, { status: 400 });

    // ── Professional profile (all optional) ───────────────────────────────────
    const yisRaw = years_in_service != null && String(years_in_service).trim() !== ''
      ? Number(years_in_service) : null;
    if (yisRaw !== null && (!Number.isInteger(yisRaw) || yisRaw < 0 || yisRaw > 100))
      return NextResponse.json(
        { error: 'Years in Service must be a whole number between 0 and 100.', field: 'years_in_service' },
        { status: 400 }
      );
    const edQual   = educational_qualification ? String(educational_qualification).trim().slice(0, 255) || null : null;
    const majorVal = major       ? String(major).trim().slice(0, 255)       || null : null;
    const eligVal  = eligibility ? String(eligibility).trim().slice(0, 255) || null : null;
    const specVal  = specialization ? String(specialization).trim().slice(0, 255) || null : null;

    // ── Duplicate checks (before hashing password) ────────────────────────────
    const dupUser = await query(
      'SELECT id FROM instructor_accounts WHERE username = $1 AND is_active = true',
      [uStr]
    );
    if (dupUser.rows.length > 0)
      return NextResponse.json(
        { error: 'Username already exists. Please choose another username.', field: 'username' },
        { status: 409 }
      );

    // ── Hash password ─────────────────────────────────────────────────────────
    const passwordHash = await bcrypt.hash(String(password), 12);

    // ── Atomic transaction: faculty row + employee_id + instructor account ─────
    const newFaculty = await transaction(async (client) => {
      const fRow = await client.query<{ id: number }>(`
        INSERT INTO faculty
          (first_name, last_name, middle_name, name,
           program_id, position, designation_type, designation_units, load_type,
           years_in_service, educational_qualification, major, eligibility, specialization)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING id
      `, [
        fnStr, lnStr, midStr, fullName,
        program.id, posStr, desType, desUnits,
        String(load_type || 'Regular').trim(),
        yisRaw, edQual, majorVal, eligVal, specVal,
      ]);

      const facultyId = fRow.rows[0].id;

      // Stamp auto-generated employee_id: FAC-0001, FAC-0002, …
      await client.query(
        `UPDATE faculty SET employee_id = 'FAC-' || LPAD($1::text, 4, '0') WHERE id = $1`,
        [facultyId]
      );

      // Create linked instructor account
      const iaRow = await client.query<{ id: number }>(`
        INSERT INTO instructor_accounts
          (faculty_id, username, email, password_hash, role)
        VALUES ($1, $2, $3, $4, 'instructor')
        RETURNING id
      `, [facultyId, uStr, emailStr, passwordHash]);

      const accountId = Number(iaRow.rows[0].id);
      await client.query(
        `DELETE FROM account_email_registry WHERE account_kind = 'instructor' AND account_id = $1`,
        [accountId]
      ).catch(() => {});
      await client.query(
        `INSERT INTO account_email_registry (email_normalized, account_kind, account_id)
         VALUES ($1, 'instructor', $2)`,
        [emailStr, accountId]
      );

      await setPrioritySubjects(client, facultyId, priority_subjects as PrioritySubject[] | undefined);
      await setFacultyBlocks(client, facultyId, block_ids);

      // Return combined record
      const combined = await client.query(`
        SELECT
          f.id, f.first_name, f.last_name, f.middle_name, f.name, f.employee_id,
          f.program_id, f.position, f.employment_status,
          f.designation_type, f.designation_units, f.load_type,
          f.years_in_service, f.educational_qualification, f.major, f.eligibility, f.specialization,
          ia.username, ia.email,
          ${PRIORITY_SUBJECTS_SUBQUERY} AS priority_subjects,
        ${ASSIGNED_BLOCK_IDS_SUBQUERY} AS assigned_block_ids
        FROM faculty f
        JOIN instructor_accounts ia ON ia.faculty_id = f.id
        WHERE f.id = $1
      `, [facultyId]);

      return combined.rows[0];
    });

    return NextResponse.json({ faculty: newFaculty }, { status: 201 });

  } catch (error) {
    // Always log the full error server-side for diagnostics
    console.error('[POST /api/faculty] Unhandled error:', error);

    // Attempt structured classification first
    const classified = classifyFacultyPgError(error);
    if (classified) return classified;

    // Fallback string-based checks for legacy pg versions without code
    const msg = String(error).toLowerCase();
    if (msg.includes('instructor_accounts') && msg.includes('does not exist'))
      return NextResponse.json(
        { error: 'Database table not ready. Please restart the server so migrations can run, then try again.' },
        { status: 503 }
      );
    if (msg.includes('employee_id') && msg.includes('null value'))
      return NextResponse.json(
        { error: 'Database schema out of date. Please restart the server so migrations can run, then try again.' },
        { status: 503 }
      );
    if (msg.includes('does not exist') && (msg.includes('column') || msg.includes('years_in') || msg.includes('educational') || msg.includes('eligibility'))) {
      resetFacultyProfileColumns();
      return NextResponse.json(
        { error: 'Database schema is out of date. Please try again — the server is applying the fix automatically.' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: 'An unexpected server error occurred. Please try again.' },
      { status: 500 }
    );
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const POST = withAudit(POST_handler);
