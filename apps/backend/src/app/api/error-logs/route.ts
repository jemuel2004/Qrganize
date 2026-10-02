import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { ensureErrorLogTable } from '@/database/errorLogSchema';
import { withAudit } from '@/services/audit';
import { errorLogViewer } from '@/services/errorLogAccess';
import { ERROR_MODULES } from '@shared/errorLog';

const PAGE_SIZE = 40;
/** Live updates re-read every row already on screen (up to this many). */
const MAX_LIMIT = 200;
const RETENTION_DAYS = 90;
let lastPurge = 0;

/** Entries untouched for 90 days are removed (checked at most hourly). */
function purgeOldEntries() {
  if (Date.now() - lastPurge < 60 * 60 * 1000) return;
  lastPurge = Date.now();
  void query(`DELETE FROM error_logs WHERE last_seen < NOW() - INTERVAL '${RETENTION_DAYS} days'`)
    .catch(err => console.error('[error-logs] purge failed:', err));
}

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;

/**
 * GET /api/error-logs?status=open|resolved|all&module=&level=error|warning&q=&before=<next_before>&limit=
 * Newest activity first (a repeat moves an entry up). The stack trace is left
 * out of the list — GET /api/error-logs/[id] has it. `next_before` is the
 * server's exact position, so "load more" never skips or repeats an entry.
 */
export async function GET(req: NextRequest) {
  try {
    if (!(await errorLogViewer(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    await ensureErrorLogTable();
    purgeOldEntries();

    const sp = req.nextUrl.searchParams;
    const status = ['open', 'resolved', 'all'].includes(sp.get('status') ?? '') ? sp.get('status')! : 'open';
    const moduleFilter = (ERROR_MODULES as readonly string[]).includes(sp.get('module') ?? '') ? sp.get('module')! : '';
    const level = ['error', 'warning'].includes(sp.get('level') ?? '') ? sp.get('level')! : '';
    const q = (sp.get('q') ?? '').trim().slice(0, 100);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(sp.get('limit') ?? '', 10) || PAGE_SIZE));
    const before = sp.get('before') ?? '';
    const cut = before.lastIndexOf('|');
    const beforeSeen = cut > 0 ? before.slice(0, cut) : '';
    const beforeId = cut > 0 ? before.slice(cut + 1) : '';

    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, ...values: unknown[]) => {
      let text = sql;
      for (const v of values) { params.push(v); text = text.replace('?', `$${params.length}`); }
      where.push(text);
    };
    if (status === 'open') where.push('resolved_at IS NULL');
    if (status === 'resolved') where.push('resolved_at IS NOT NULL');
    if (moduleFilter) add('module = ?', moduleFilter);
    if (level) add('level = ?', level);
    if (q) {
      const pattern = likePattern(q);
      add("(message ILIKE ? ESCAPE '\\' OR source ILIKE ? ESCAPE '\\' OR COALESCE(path, '') ILIKE ? ESCAPE '\\' OR COALESCE(actor_name, '') ILIKE ? ESCAPE '\\')",
        pattern, pattern, pattern, pattern);
    }
    if (beforeSeen && /^\d{1,18}$/.test(beforeId) && /^[\d\-:. +TZ]{10,40}$/.test(beforeSeen)) {
      add('(last_seen, id) < (?::timestamptz, ?::bigint)', beforeSeen, beforeId);
    }

    params.push(limit + 1);
    const rows = await query(
      `SELECT id, level, module, source, message, method, path, actor_name, actor_role,
              occurrences, first_seen, last_seen, resolved_at, resolved_by,
              last_seen::text AS seen_key
         FROM error_logs
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY last_seen DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    const counts = await query(
      `SELECT module,
              COUNT(*) FILTER (WHERE resolved_at IS NULL)::int     AS open,
              COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved
         FROM error_logs GROUP BY module`,
    );

    const modules: Record<string, { open: number; resolved: number }> = {};
    let open = 0, resolved = 0;
    for (const r of counts.rows as { module: string; open: number; resolved: number }[]) {
      modules[r.module] = { open: r.open, resolved: r.resolved };
      open += r.open;
      resolved += r.resolved;
    }

    const page = (rows.rows as Array<Record<string, unknown> & { id: string; seen_key: string }>).slice(0, limit);
    const last = page[page.length - 1];
    return NextResponse.json(
      {
        logs: page,
        has_more: rows.rows.length > limit,
        next_before: last ? `${last.seen_key}|${last.id}` : null,
        counts: { open, resolved, modules },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[GET /api/error-logs]', error);
    return NextResponse.json({ error: 'Could not load the error log.' }, { status: 500 });
  }
}

/** PATCH { action: 'resolve-all', module? } — mark every open entry (of one module) as resolved. */
async function PATCH_handler(req: NextRequest) {
  try {
    const viewer = await errorLogViewer(req);
    if (!viewer) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => ({})) as { action?: unknown; module?: unknown };
    if (body.action !== 'resolve-all') return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
    const moduleFilter = typeof body.module === 'string' && (ERROR_MODULES as readonly string[]).includes(body.module) ? body.module : '';

    await ensureErrorLogTable();
    const res = await query(
      `UPDATE error_logs SET resolved_at = NOW(), resolved_by = $1
        WHERE resolved_at IS NULL AND ($2 = '' OR module = $2)`,
      [viewer.name, moduleFilter],
    );
    return NextResponse.json({ success: true, resolved: res.rowCount ?? 0 });
  } catch (error) {
    console.error('[PATCH /api/error-logs]', error);
    return NextResponse.json({ error: 'Could not update the error log.' }, { status: 500 });
  }
}

export const PATCH = withAudit(PATCH_handler);
