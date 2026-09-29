import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { ensureAuditTable } from '@/database/auditSchema';

const PAGE_SIZE = 50;

/**
 * GET /api/audit-logs — admin only.
 * ?category=Rooms&q=text&range=today|7d|30d|all&before=<id> (id cursor for "Load more")
 * Returns the newest matching entries plus per-category counts for the range.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || (auth.role !== 'admin' && auth.role !== 'program_chair')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await ensureAuditTable();

    const sp = req.nextUrl.searchParams;
    const category = sp.get('category') || '';
    const q = (sp.get('q') || '').trim().slice(0, 100);
    const range = sp.get('range') || '7d';
    const before = Number(sp.get('before')) || null;
    const since =
      range === 'today' ? `date_trunc('day', NOW() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila'`
      : range === '30d' ? `NOW() - INTERVAL '30 days'`
      : range === 'all' ? null
      : `NOW() - INTERVAL '7 days'`;

    // Shared filters (range + search); category applied to the list only.
    const where: string[] = [];
    const params: unknown[] = [];
    if (since) where.push(`created_at >= ${since}`);
    if (q) {
      params.push(`%${q}%`);
      where.push(`(summary ILIKE $${params.length} OR actor_name ILIKE $${params.length} OR ip ILIKE $${params.length})`);
    }
    const base = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const listParams = [...params];
    const listWhere = [...where];
    if (category) { listParams.push(category); listWhere.push(`category = $${listParams.length}`); }
    if (before) { listParams.push(before); listWhere.push(`id < $${listParams.length}`); }
    listParams.push(PAGE_SIZE + 1);

    const [list, counts] = await Promise.all([
      query(`
        SELECT id, created_at, actor_id, actor_role, actor_name, category, action, summary,
               method, path, status, success, ip, details
        FROM audit_logs
        ${listWhere.length ? `WHERE ${listWhere.join(' AND ')}` : ''}
        ORDER BY id DESC
        LIMIT $${listParams.length}
      `, listParams),
      before ? Promise.resolve(null) : query(`SELECT category, COUNT(*)::int AS n FROM audit_logs ${base} GROUP BY category`, params),
    ]);

    const rows = list.rows;
    return NextResponse.json({
      logs: rows.slice(0, PAGE_SIZE),
      has_more: rows.length > PAGE_SIZE,
      counts: counts ? Object.fromEntries((counts.rows as { category: string; n: number }[]).map(r => [r.category, r.n])) : undefined,
    });
  } catch (error) {
    console.error('[GET /api/audit-logs]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
