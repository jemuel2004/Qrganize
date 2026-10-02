import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { ensureErrorLogTable } from '@/database/errorLogSchema';
import { withAudit } from '@/services/audit';
import { errorLogViewer } from '@/services/errorLogAccess';

type Ctx = { params: Promise<{ id: string }> };

const parseId = (raw: string) => (/^\d{1,18}$/.test(raw) ? raw : null);

/** GET /api/error-logs/[id] — one entry with its stack trace. */
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    if (!(await errorLogViewer(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    await ensureErrorLogTable();
    const res = await query(
      `SELECT id, level, module, source, message, detail, method, path, actor_id, actor_name, actor_role,
              occurrences, first_seen, last_seen, resolved_at, resolved_by
         FROM error_logs WHERE id = $1`,
      [id],
    );
    if (res.rows.length === 0) return NextResponse.json({ error: 'This entry no longer exists.' }, { status: 404 });
    return NextResponse.json({ log: res.rows[0] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[GET /api/error-logs/[id]]', error);
    return NextResponse.json({ error: 'Could not load this entry.' }, { status: 500 });
  }
}

/** PATCH { resolved: true | false } — mark as resolved, or open it again. */
async function PATCH_handler(req: NextRequest, { params }: Ctx) {
  try {
    const viewer = await errorLogViewer(req);
    if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = parseId((await params).id);
    if (!id) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = await req.json().catch(() => ({})) as { resolved?: unknown };
    if (typeof body.resolved !== 'boolean') return NextResponse.json({ error: 'Say whether it is resolved.' }, { status: 400 });

    await ensureErrorLogTable();
    try {
      const res = body.resolved
        ? await query(
          `UPDATE error_logs SET resolved_at = NOW(), resolved_by = $2
            WHERE id = $1 AND resolved_at IS NULL
            RETURNING id, resolved_at, resolved_by`,
          [id, viewer.name],
        )
        : await query(
          `UPDATE error_logs SET resolved_at = NULL, resolved_by = NULL
            WHERE id = $1 AND resolved_at IS NOT NULL
            RETURNING id, resolved_at, resolved_by`,
          [id],
        );
      if (res.rows.length === 0) {
        const exists = await query('SELECT 1 FROM error_logs WHERE id = $1', [id]);
        if (exists.rows.length === 0) return NextResponse.json({ error: 'This entry no longer exists.' }, { status: 404 });
      }
      return NextResponse.json({ success: true, log: res.rows[0] ?? null });
    } catch (err) {
      // Reopening while a newer open entry of the same error exists (one open entry per error)
      if ((err as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'This error happened again after it was resolved — see the newer open entry.' }, { status: 409 });
      }
      throw err;
    }
  } catch (error) {
    console.error('[PATCH /api/error-logs/[id]]', error);
    return NextResponse.json({ error: 'Could not update this entry.' }, { status: 500 });
  }
}

export const PATCH = withAudit(PATCH_handler);
