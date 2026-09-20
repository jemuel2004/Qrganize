import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/server/db';
import { getAuthUser } from '@/server/auth';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || !['admin', 'department_chair'].includes(auth.role ?? '')) {
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
      'SELECT employment_status FROM faculty WHERE id = $1 AND is_active IS NOT FALSE',
      [facultyId],
    );
    if (facResult.rows.length === 0) {
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
        { error: 'Praise load not found or does not belong to this instructor.' },
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
