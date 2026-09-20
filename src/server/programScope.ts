import { NextResponse } from 'next/server';
import { query } from '@/server/db';

export type AuthLike = {
  id?: number | string;
  role?: string;
} | null;

export const CHAIR_NO_PROGRAM_MSG =
  'No program is assigned to your Department Chair account. Please contact the administrator.';

export const CHAIR_PROGRAM_FORBIDDEN_MSG =
  'You can only manage resources for your assigned program.';

type ScopeOk =
  | { ok: true; role: 'admin'; programId: number | null }
  | { ok: true; role: 'department_chair'; programId: number };

type ScopeErr = { ok: false; response: NextResponse };

export type ProgramScopeResult = ScopeOk | ScopeErr;

/** Trusted source: DB assignment, not JWT claim alone. */
export async function getChairAssignedProgramId(userId: number): Promise<number | null> {
  const result = await query(
    `SELECT program_id FROM users
     WHERE id = $1 AND role = 'department_chair' AND COALESCE(is_active, true) = true`,
    [userId]
  );
  const pid = (result.rows[0] as { program_id?: number | null } | undefined)?.program_id;
  return pid == null ? null : Number(pid);
}

  /**
   * Resolve which program_id the caller may use for Block Creation / Class Program / Master Schedule.
   * - Admin: optional/required requested id (unchanged multi-program access)
   * - Department Chair: always their DB-assigned program; mismatch → 403
   * Do NOT use this helper for Curriculum, Workload, Scheduling, Rooms, etc.
   */
export async function resolveProgramScope(
  auth: AuthLike,
  options?: { requestedProgramId?: unknown; requireProgram?: boolean }
): Promise<ProgramScopeResult> {
  if (!auth?.role) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  if (auth.role === 'admin') {
    const raw = options?.requestedProgramId;
    if (options?.requireProgram) {
      const id = Number(raw);
      if (raw == null || raw === '' || Number.isNaN(id) || id <= 0) {
        return {
          ok: false,
          response: NextResponse.json({ error: 'Program is required.' }, { status: 400 }),
        };
      }
      return { ok: true, role: 'admin', programId: id };
    }
    if (raw != null && raw !== '') {
      const id = Number(raw);
      if (Number.isNaN(id) || id <= 0) {
        return {
          ok: false,
          response: NextResponse.json({ error: 'Invalid program.' }, { status: 400 }),
        };
      }
      return { ok: true, role: 'admin', programId: id };
    }
    return { ok: true, role: 'admin', programId: null };
  }

  if (auth.role === 'department_chair') {
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
    return { ok: true, role: 'department_chair', programId: assigned };
  }

  return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
}

/** Ensure a block belongs to the chair's assigned program (admins pass). */
export async function assertBlockProgramAccess(
  auth: AuthLike,
  blockId: string | number
): Promise<
  | { ok: true; block: Record<string, unknown> }
  | { ok: false; response: NextResponse }
> {
  if (!auth?.role || !['admin', 'department_chair'].includes(auth.role)) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const result = await query(`SELECT * FROM blocks WHERE id = $1`, [blockId]);
  if (result.rows.length === 0) {
    return { ok: false, response: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  }
  const block = result.rows[0] as Record<string, unknown>;

  if (auth.role === 'admin') {
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
