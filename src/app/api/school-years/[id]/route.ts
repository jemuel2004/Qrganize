import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/server/auth';
import { query, transaction } from '@/server/db';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || (auth.role !== 'admin' && auth.role !== 'program_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const yearId  = parseInt(id, 10);
    if (isNaN(yearId)) {
      return NextResponse.json({ error: 'Invalid ID.' }, { status: 400 });
    }

    const { action } = await req.json();
    if (action !== 'activate' && action !== 'archive') {
      return NextResponse.json(
        { error: 'action must be "activate" or "archive".' },
        { status: 400 }
      );
    }

    // Verify the year exists
    const check = await query('SELECT id, label FROM school_years WHERE id = $1', [yearId]);
    if (!check.rows[0]) {
      return NextResponse.json({ error: 'School year not found.' }, { status: 404 });
    }
    const yearLabel = check.rows[0].label as string;

    if (action === 'activate') {
      await transaction(async (client) => {
        // Set all to Archived first
        await client.query(
          "UPDATE school_years SET status = 'Archived', updated_at = NOW()"
        );
        // Set this one to Active
        await client.query(
          "UPDATE school_years SET status = 'Active', updated_at = NOW() WHERE id = $1",
          [yearId]
        );
        // Sync system_settings so the context API picks it up
        await client.query(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES ('current_school_year', $1, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [yearLabel]
        );
      });
    } else {
      // Archive: just set to Archived
      await query(
        "UPDATE school_years SET status = 'Archived', updated_at = NOW() WHERE id = $1",
        [yearId]
      );
      // Remove from system_settings if this was the current one
      await query(
        `UPDATE system_settings SET value = NULL, updated_at = NOW()
         WHERE key = 'current_school_year' AND value = $1`,
        [yearLabel]
      );
    }

    // Return updated list
    const result = await query(
      'SELECT id, label, status, created_at FROM school_years ORDER BY label DESC'
    );
    return NextResponse.json({ years: result.rows });
  } catch (err) {
    console.error('[PATCH /api/school-years/[id]]', err);
    return NextResponse.json({ error: 'Action failed.' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || (auth.role !== 'admin' && auth.role !== 'program_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const yearId = parseInt(id, 10);
    if (isNaN(yearId)) {
      return NextResponse.json({ error: 'Invalid ID.' }, { status: 400 });
    }

    // Fetch the year
    const yearRes = await query('SELECT id, label, status FROM school_years WHERE id = $1', [yearId]);
    if (!yearRes.rows[0]) {
      return NextResponse.json({ error: 'School year not found.' }, { status: 404 });
    }
    const { label, status } = yearRes.rows[0] as { label: string; status: string };

    if (status === 'Active') {
      return NextResponse.json(
        { error: 'The active school year cannot be deleted. Archive it first.' },
        { status: 400 }
      );
    }

    // Check for any records that reference this school year label
    const checks = await Promise.all([
      query('SELECT 1 FROM blocks          WHERE academic_year = $1 LIMIT 1', [label]),
      query('SELECT 1 FROM master_schedule WHERE academic_year = $1 LIMIT 1', [label]),
      query('SELECT 1 FROM overloads       WHERE academic_year = $1 LIMIT 1', [label]),
      query('SELECT 1 FROM praise          WHERE academic_year = $1 LIMIT 1', [label]),
    ]);

    const [blocksRef, schedRef, overloadRef, praiseRef] = checks;

    const usedBy: string[] = [];
    if (blocksRef.rows.length)   usedBy.push('Blocks');
    if (schedRef.rows.length)    usedBy.push('Master Schedule');
    if (overloadRef.rows.length) usedBy.push('Overloads');
    if (praiseRef.rows.length)   usedBy.push('Praise Records');

    if (usedBy.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete ${label} — it is referenced by existing data: ${usedBy.join(', ')}. Remove those records first.`,
        },
        { status: 409 }
      );
    }

    await query('DELETE FROM school_years WHERE id = $1', [yearId]);

    const result = await query(
      'SELECT id, label, status, created_at FROM school_years ORDER BY label DESC'
    );
    return NextResponse.json({ years: result.rows });
  } catch (err) {
    console.error('[DELETE /api/school-years/[id]]', err);
    return NextResponse.json({ error: 'Failed to delete school year.' }, { status: 500 });
  }
}
