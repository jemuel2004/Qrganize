import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getAuthUser } from '@/auth/auth';
import { ensureAuditTable } from '@/database/auditSchema';

/** Entries per page (Audit Logs shows numbered pages) */
const PAGE_SIZE = 20;

/**
 * GET /api/audit-logs — admin only.
 * ?category=Rooms&q=text&range=today|7d|30d|all&page=<1…>
 * Returns one page of the newest matching entries, the total for the filter
 * (for the page numbers) and per-category counts for the range + search.
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { role?: string } | null;
    if (!auth || (auth.role !== 'admin')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    await ensureAuditTable();

    const sp = req.nextUrl.searchParams;
    const category = sp.get('category') || '';
    const q = (sp.get('q') || '').trim().slice(0, 100);
    const range = sp.get('range') || '7d';
    const page = Math.min(100000, Math.max(1, Math.floor(Number(sp.get('page')) || 1)));
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
    listParams.push(PAGE_SIZE, (page - 1) * PAGE_SIZE);

    const [list, counts] = await Promise.all([
      query(`
        SELECT id, created_at, actor_id, actor_role, actor_name, category, action, summary,
               method, path, status, success, ip, details
        FROM audit_logs
        ${listWhere.length ? `WHERE ${listWhere.join(' AND ')}` : ''}
        ORDER BY id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `, listParams),
      query(`SELECT category, COUNT(*)::int AS n FROM audit_logs ${base} GROUP BY category`, params),
    ]);

    const byCategory = Object.fromEntries((counts.rows as { category: string; n: number }[]).map(r => [r.category, r.n]));
    // Total for the list's own filter (range + search + category) — drives the page numbers
    const total = category ? (byCategory[category] ?? 0) : Object.values(byCategory).reduce((a, b) => a + b, 0);
    return NextResponse.json({
      logs: list.rows,
      total,
      page,
      page_size: PAGE_SIZE,
      counts: byCategory,
    });
  } catch (error) {
    console.error('[GET /api/audit-logs]', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
