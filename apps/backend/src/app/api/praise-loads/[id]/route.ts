import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { withAudit } from '@/services/audit';
import { canAccessProgram } from '@/services/programScope';

async function DELETE_handler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ── Validate path param ─────────────────────────────────────────────────
    const { id: idStr } = await params;
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid praise load ID.' }, { status: 400 });
    }

    // ── Ownership check via query param ─────────────────────────────────────
    const facultyIdRaw = req.nextUrl.searchParams.get('faculty_id');
    const facultyId = facultyIdRaw ? parseInt(facultyIdRaw, 10) : NaN;
    if (!Number.isInteger(facultyId) || facultyId <= 0) {
      return NextResponse.json({ error: 'faculty_id is required.' }, { status: 400 });
    }

    // ── Verify faculty exists and is permanent ──────────────────────────────
    const facResult = await query(
      'SELECT employment_status, program_id FROM faculty WHERE id = $1 AND is_active IS NOT FALSE',
      [facultyId],
    );
    if (facResult.rows.length === 0) {
      return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
    }
    // Program Chairs only manage faculty in their own program (same rule as Deloading)
    if (!(await canAccessProgram(auth, facResult.rows[0].program_id))) {
      return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
    }
    if (facResult.rows[0].employment_status !== 'Permanent') {
      return NextResponse.json(
        { error: 'Praise loads only exist for Permanent faculty.' },
        { status: 400 },
      );
    }

    // ── Verify record exists and belongs to this faculty ────────────────────
    const praiseResult = await query(
      'SELECT id, praise_type FROM praise WHERE id = $1 AND faculty_id = $2',
      [id, facultyId],
    );
    if (praiseResult.rows.length === 0) {
      return NextResponse.json(
        { error: 'Praise load not found or does not belong to this faculty.' },
        { status: 404 },
      );
    }

    // ── Delete ───────────────────────────────────────────────────────────────
    await query('DELETE FROM praise WHERE id = $1 AND faculty_id = $2', [id, facultyId]);

    return NextResponse.json({
      success: true,
      message: 'Praise load removed successfully.',
    });
  } catch (error) {
    console.error('[DELETE /api/praise-loads/[id]]', error);
    return NextResponse.json(
      { error: 'A server error occurred. Please try again.' },
      { status: 500 },
    );
  }
}

/** Edit a praise record in place (description, equivalent units) — Praise Load modal. */
async function PUT_handler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getAuthUser(req) as { id?: number; role?: string } | null;
    if (!auth || !['admin', 'department_chair', 'program_chair'].includes(auth.role ?? '')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: idStr } = await params;
    const id = parseInt(idStr, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid praise load ID.' }, { status: 400 });
    }

    const body = await req.json().catch(() => ({})) as {
      faculty_id?: unknown; description?: unknown; equivalent_units?: unknown;
    };
    const facultyId = Number(body.faculty_id);
    if (!Number.isInteger(facultyId) || facultyId <= 0) {
      return NextResponse.json({ error: 'faculty_id is required.' }, { status: 400 });
    }

    // Same number rules as POST /api/praise
    const raw = body.equivalent_units;
    const units = raw === '' || raw === null || raw === undefined ? 0 : Number(raw);
    if (!Number.isFinite(units) || units < 0) {
      return NextResponse.json({ error: 'Equivalent Units must be a non-negative number.' }, { status: 400 });
    }
    if ((String(raw ?? '').match(/\d/g) ?? []).length > 3 || (String(units).match(/\d/g) ?? []).length > 3) {
      return NextResponse.json({ error: 'Maximum of 3 digits only (e.g., 1.23).' }, { status: 400 });
    }
    const description = typeof body.description === 'string' ? body.description.trim() : '';

    const facResult = await query(
      'SELECT employment_status, program_id FROM faculty WHERE id = $1 AND is_active IS NOT FALSE',
      [facultyId],
    );
    if (facResult.rows.length === 0) {
      return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
    }
    // Program Chairs only manage faculty in their own program (same rule as Deloading)
    if (!(await canAccessProgram(auth, facResult.rows[0].program_id))) {
      return NextResponse.json({ error: 'Faculty not found.' }, { status: 404 });
    }
    if (facResult.rows[0].employment_status !== 'Permanent') {
      return NextResponse.json({ error: 'Praise loads only exist for Permanent faculty.' }, { status: 400 });
    }

    // Only a record that belongs to this faculty is updated
    const result = await query(
      `UPDATE praise SET description = $1, equivalent_units = $2, updated_at = NOW()
        WHERE id = $3 AND faculty_id = $4
        RETURNING *`,
      [description, units, id, facultyId],
    );
    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Praise load not found or does not belong to this faculty.' },
        { status: 404 },
      );
    }
    return NextResponse.json({ praise: result.rows[0] });
  } catch (error) {
    console.error('[PUT /api/praise-loads/[id]]', error);
    return NextResponse.json({ error: 'A server error occurred. Please try again.' }, { status: 500 });
  }
}

// Successful writes are recorded in the audit trail (System → Audit Logs).
export const DELETE = withAudit(DELETE_handler);
export const PUT = withAudit(PUT_handler);
