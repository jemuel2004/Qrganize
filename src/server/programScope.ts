import { NextResponse } from 'next/server';
import { query } from '@/server/db';

export type AuthLike = {
  id?: number | string;
  role?: string;
  program_id?: number | string | null;
} | null;

export const CHAIR_NO_PROGRAM_MSG =
  'No program is assigned to your Program Chair account. Please contact the administrator.';

export const CHAIR_PROGRAM_FORBIDDEN_MSG =
  'You can only manage resources for your assigned program.';

type ScopeOk =
  | { ok: true; role: 'admin' | 'department_chair'; programId: number | null }
  | { ok: true; role: 'program_chair'; programId: number };

type ScopeErr = { ok: false; response: NextResponse };

export type ProgramScopeResult = ScopeOk | ScopeErr;

/**
 * Trusted source: DB assignment, not JWT claim alone. Program Chair is the
 * program-scoped role (unlike Department Chair, which is department-wide
 * and has no program assignment).
 */
export async function getChairAssignedProgramId(userId: number): Promise<number | null> {
  const result = await query(
    `SELECT program_id FROM users
     WHERE id = $1 AND role = 'program_chair' AND COALESCE(is_active, true) = true`,
    [userId]
  );
  const pid = (result.rows[0] as { program_id?: number | null } | undefined)?.program_id;
  return pid == null ? null : Number(pid);
}

/**
 * Resolve which program_id the caller may use for a program-scoped operation
 * (Block Creation, Class Program, Master Schedule, Curriculum, Workload, etc.)
 * - Admin: optional/required requested id — unrestricted, sees any program.
 * - Department Chair: department-wide, no fixed program assignment — behaves
 *   like Admin here (optional/required requested id, never forced to one).
 * - Program Chair: always their DB-assigned program; a requested id that
 *   doesn't match their own is rejected with 403.
 */
export async function resolveProgramScope(
  auth: AuthLike,
  options?: { requestedProgramId?: unknown; requireProgram?: boolean }
): Promise<ProgramScopeResult> {
  if (!auth?.role) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  if (auth.role === 'admin' || auth.role === 'department_chair') {
    const raw = options?.requestedProgramId;
    if (options?.requireProgram) {
      const id = Number(raw);
      if (raw == null || raw === '' || Number.isNaN(id) || id <= 0) {
        return {
          ok: false,
          response: NextResponse.json({ error: 'Program is required.' }, { status: 400 }),
        };
      }
      return { ok: true, role: auth.role, programId: id };
    }
    if (raw != null && raw !== '') {
      const id = Number(raw);
      if (Number.isNaN(id) || id <= 0) {
        return {
          ok: false,
          response: NextResponse.json({ error: 'Invalid program.' }, { status: 400 }),
        };
      }
      return { ok: true, role: auth.role, programId: id };
    }
    return { ok: true, role: auth.role, programId: null };
  }

  if (auth.role === 'program_chair') {
    const userId = Number(auth.id);
    if (!userId) {
      return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    const assigned = await getChairAssignedProgramId(userId);
    if (assigned == null) {
      return {
        ok: false,
        response: NextResponse.json({ error: CHAIR_NO_PROGRAM_MSG }, { status: 403 }),
      };
    }
    const raw = options?.requestedProgramId;
    if (raw != null && raw !== '') {
      const requested = Number(raw);
      if (!Number.isNaN(requested) && requested > 0 && requested !== assigned) {
        return {
          ok: false,
          response: NextResponse.json({ error: CHAIR_PROGRAM_FORBIDDEN_MSG }, { status: 403 }),
        };
      }
    }
    return { ok: true, role: 'program_chair', programId: assigned };
  }

  return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
}

/** Ensure a block belongs to the chair's assigned program (admin/department_chair pass). */
export async function assertBlockProgramAccess(
  auth: AuthLike,
  blockId: string | number
): Promise<
  | { ok: true; block: Record<string, unknown> }
  | { ok: false; response: NextResponse }
> {
  if (!auth?.role || !['admin', 'department_chair', 'program_chair'].includes(auth.role)) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const result = await query(`SELECT * FROM blocks WHERE id = $1`, [blockId]);
  if (result.rows.length === 0) {
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }
  const block = result.rows[0] as Record<string, unknown>;

  if (auth.role === 'admin' || auth.role === 'department_chair') {
    return { ok: true, block };
  }

  const scope = await resolveProgramScope(auth);
  if (!scope.ok) return scope;
  if (Number(block.program_id) !== scope.programId) {
    return {
      ok: false,
      response: NextResponse.json({ error: CHAIR_PROGRAM_FORBIDDEN_MSG }, { status: 403 }),
    };
  }
  return { ok: true, block };
}

/**
 * Per-resource-row guard: can this authenticated user touch a resource that
 * belongs to `resourceProgramId`? Admin and Department Chair are unrestricted
 * (department-wide); Program Chair is checked against their DB-assigned
 * program (trusted source, not the JWT claim alone).
 */
export async function canAccessProgram(
  auth: AuthLike,
  resourceProgramId: number | string | null | undefined
): Promise<boolean> {
  if (auth?.role !== 'program_chair') return true;
  if (resourceProgramId == null) return false;
  const userId = Number(auth.id);
  if (!userId) return false;
  const assigned = await getChairAssignedProgramId(userId);
  return assigned != null && assigned === Number(resourceProgramId);
}

/**
 * Guards any write keyed by a `master_schedule_id` (workload assign/unassign,
 * move-to-overload/praise, return-to-overload/regular, etc.) — resolves the
 * schedule's program through block_subjects → blocks and checks it against
 * the Program Chair's DB-assigned program. Admin/Department Chair always pass.
 */
export async function canAccessMasterSchedule(
  auth: AuthLike,
  masterScheduleId: number | string | null | undefined
): Promise<boolean> {
  if (auth?.role !== 'program_chair') return true;
  if (masterScheduleId == null) return false;
  const userId = Number(auth.id);
  if (!userId) return false;
  const assigned = await getChairAssignedProgramId(userId);
  if (assigned == null) return false;
  const result = await query(
    `SELECT b.program_id
     FROM master_schedule ms
     JOIN block_subjects bs ON ms.block_subject_id = bs.id
     JOIN blocks b ON bs.block_id = b.id
     WHERE ms.id = $1`,
    [masterScheduleId]
  );
  const programId = result.rows[0]?.program_id;
  return programId != null && Number(programId) === assigned;
}
