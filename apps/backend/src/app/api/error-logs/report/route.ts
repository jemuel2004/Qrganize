import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { withAudit } from '@/services/audit';
import { recordError } from '@/services/errorLog';

/**
 * POST /api/error-logs/report — the app reports a page that crashed (its error
 * screen appeared). Any signed-in user; limited so a looping page can't flood
 * the log. Body: { message, stack?, componentStack?, page }.
 */

const WINDOW_MS = 10 * 60 * 1000;
const PER_USER = 10;
const PER_SERVER = 200;
const recent = new Map<string, number[]>();

function allow(key: string): boolean {
  const now = Date.now();
  const keep = (list: number[] | undefined) => (list ?? []).filter(t => now - t < WINDOW_MS);
  const all = keep(recent.get('*'));
  const mine = keep(recent.get(key));
  if (mine.length >= PER_USER || all.length >= PER_SERVER) return false;
  recent.set(key, [...mine, now]);
  recent.set('*', [...all, now]);
  if (recent.size > 2_000) recent.clear();
  return true;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

async function POST_handler(req: NextRequest) {
  try {
    const auth = await getAuthUser(req) as { id?: unknown; role?: string; name?: string; username?: string } | null;
    if (!auth?.role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const page = text(body.page, 300).split('?')[0];
    const message = text(body.message, 1000).trim();
    if (!page.startsWith('/') || !message) return NextResponse.json({ error: 'Page and message are required.' }, { status: 400 });

    if (!allow(`${auth.role}:${String(auth.id ?? '')}`)) return NextResponse.json({ success: true, stored: false });

    const stack = text(body.stack, 3000);
    const componentStack = text(body.componentStack, 1500);
    recordError({
      level: 'error',
      // Ids in the address are the same page (blocks/12 and blocks/30 are one place)
      source: `page ${page.replace(/\/\d+(?=\/|$)/g, '/[id]')}`,
      page: true,
      path: page,
      method: 'PAGE',
      message: `Page crashed: ${message}`,
      detail: [stack, componentStack ? `Component stack:${componentStack}` : ''].filter(Boolean).join('\n') || null,
      actor: {
        id: Number.isFinite(Number(auth.id)) ? Number(auth.id) : null,
        role: auth.role,
        name: auth.name ?? auth.username ?? null,
      },
    });
    return NextResponse.json({ success: true, stored: true });
  } catch (error) {
    console.error('[POST /api/error-logs/report]', error);
    return NextResponse.json({ error: 'Could not report the error.' }, { status: 500 });
  }
}

// Not part of the audit trail (see audit SKIP) — the error log is the record.
export const POST = withAudit(POST_handler);
