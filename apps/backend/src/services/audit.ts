import type { NextRequest } from 'next/server';
import { query } from '@/database/db';
import { ensureAuditTable } from '@/database/auditSchema';
import { getAuthUser } from '@/auth/auth';
import { getClientIp } from '@/auth/clientIp';
import { bumpTopics } from '@/services/realtime';
import { scheduleWorkloadMonitoringSync } from '@/services/workloadMonitoring';
import { topicsForWrite, type RealtimeTopic } from '@shared/realtime';

/**
 * Audit trail — every successful write (POST / PUT / PATCH / DELETE) made
 * through the API, plus sign-in attempts, is recorded in `audit_logs`.
 *
 * Route handlers are wrapped with `withAudit()`; logging happens after the
 * handler has answered and never delays or breaks the request.
 */

export type AuditCategory = 'Sign-in' | 'Accounts' | 'Setup' | 'Scheduling' | 'Workload' | 'Rooms' | 'System';

interface Rule {
  re: RegExp;
  category: AuditCategory;
  noun: string;
  /** Per-method wording, overriding "Created / Updated / Deleted <noun>". */
  verbs?: Partial<Record<string, string>>;
}

/** Routes that change nothing worth auditing (checks, reads over POST, UI prefs). */
const SKIP: RegExp[] = [
  /^\/api\/scheduling\/check-conflicts/,
  /^\/api\/settings\/verify-password/,
  /^\/api\/curriculum\/export/,
  /^\/api\/notifications\//,
  /^\/api\/auth\/login-otp\/resend/,
  /^\/api\/instructor\/profile\/theme/,
  /^\/api\/rooms\/occupancy/,
  /^\/api\/error-logs\/report/,
];

const RULES: Rule[] = [
  { re: /^\/api\/auth\/(login|google-login|login-otp)$/, category: 'Sign-in', noun: 'sign-in', verbs: { POST: 'Signed in' } },
  { re: /^\/api\/auth\/logout$/, category: 'Sign-in', noun: 'sign-out', verbs: { POST: 'Signed out' } },
  { re: /^\/api\/auth\/trusted-devices/, category: 'Sign-in', noun: 'trusted device', verbs: { DELETE: 'Removed trusted device' } },
  { re: /^\/api\/auth\/verify-email-google/, category: 'Sign-in', noun: 'Google email link', verbs: { POST: 'Linked Google email', DELETE: 'Unlinked Google email' } },
  { re: /^\/api\/(instructor|dept-chair)\/verify-google/, category: 'Sign-in', noun: 'Google email link', verbs: { POST: 'Linked Google email', DELETE: 'Unlinked Google email' } },

  { re: /^\/api\/(account\/change-password|instructor\/profile\/password(-otp)?)$/, category: 'Accounts', noun: 'password', verbs: { POST: 'Changed password', PUT: 'Changed password', PATCH: 'Changed password' } },
  { re: /^\/api\/account\/security\/otp\/disable/, category: 'Accounts', noun: 'sign-in code', verbs: { POST: 'Turned off sign-in codes' } },
  { re: /^\/api\/account\/security\/otp/, category: 'Accounts', noun: 'sign-in code setting', verbs: { POST: 'Changed sign-in code setting', PUT: 'Changed sign-in code setting', PATCH: 'Changed sign-in code setting' } },
  { re: /^\/api\/(account\/me|instructor\/profile)\/picture/, category: 'Accounts', noun: 'profile picture', verbs: { POST: 'Changed profile picture', PUT: 'Changed profile picture', DELETE: 'Removed profile picture' } },
  { re: /^\/api\/account\/me$/, category: 'Accounts', noun: 'own profile', verbs: { PUT: 'Updated own profile', PATCH: 'Updated own profile' } },
  { re: /^\/api\/instructor-accounts\/[^/]+\/picture/, category: 'Accounts', noun: 'faculty account picture' },
  { re: /^\/api\/instructor-accounts/, category: 'Accounts', noun: 'faculty account' },
  { re: /^\/api\/department-chair-accounts/, category: 'Accounts', noun: 'department chair account' },
  { re: /^\/api\/dept-chair-accounts/, category: 'Accounts', noun: 'program chair account' },

  { re: /^\/api\/curriculum\/import/, category: 'Setup', noun: 'curriculum', verbs: { POST: 'Imported curriculum' } },
  { re: /^\/api\/curriculum/, category: 'Setup', noun: 'curriculum subject' },
  { re: /^\/api\/faculty\/[^/]+\/deductions/, category: 'Setup', noun: 'load deduction' },
  { re: /^\/api\/faculty/, category: 'Setup', noun: 'faculty' },
  { re: /^\/api\/blocks\/[^/]+\/reload/, category: 'Setup', noun: 'block subjects', verbs: { POST: 'Reloaded block subjects' } },
  { re: /^\/api\/blocks\/[^/]+\/subjects/, category: 'Setup', noun: 'block subject', verbs: { POST: 'Added subject to block', DELETE: 'Removed subject from block' } },
  { re: /^\/api\/blocks/, category: 'Setup', noun: 'block' },
  { re: /^\/api\/programs/, category: 'Setup', noun: 'program' },

  { re: /^\/api\/scheduling/, category: 'Scheduling', noun: 'class schedule', verbs: { POST: 'Saved class schedule', PUT: 'Updated class schedule', DELETE: 'Deleted class schedule' } },

  { re: /^\/api\/workload\/assign/, category: 'Workload', noun: 'subject', verbs: { POST: 'Assigned subject to faculty' } },
  { re: /^\/api\/workload\/unassign/, category: 'Workload', noun: 'subject', verbs: { POST: 'Unassigned subject from faculty' } },
  { re: /^\/api\/workload\/move-to-overload/, category: 'Workload', noun: 'subject', verbs: { POST: 'Moved subject to overload' } },
  { re: /^\/api\/workload\/move-to-praise/, category: 'Workload', noun: 'subject', verbs: { POST: 'Moved subject to PRAISE' } },
  { re: /^\/api\/workload\/return-to-overload/, category: 'Workload', noun: 'subject', verbs: { POST: 'Returned subject to overload' } },
  { re: /^\/api\/workload\/return-to-regular/, category: 'Workload', noun: 'subject', verbs: { POST: 'Returned subject to regular load' } },
  { re: /^\/api\/praise/, category: 'Workload', noun: 'PRAISE load' },

  { re: /^\/api\/qr\/scan/, category: 'Rooms', noun: 'room QR', verbs: { POST: 'Scanned room QR' } },
  { re: /^\/api\/rooms\/qr-codes/, category: 'Rooms', noun: 'room QR codes', verbs: { POST: 'Generated room QR codes' } },
  { re: /^\/api\/rooms/, category: 'Rooms', noun: 'room' },
  { re: /^\/api\/admin\/room-requests/, category: 'Rooms', noun: 'room request', verbs: { PATCH: 'Reviewed room request', PUT: 'Reviewed room request' } },
  { re: /^\/api\/instructor\/room-requests/, category: 'Rooms', noun: 'room request', verbs: { POST: 'Submitted room request', DELETE: 'Cancelled room request' } },

  { re: /^\/api\/settings\/school-year/, category: 'System', noun: 'active term', verbs: { POST: 'Changed active term', PUT: 'Changed active term', PATCH: 'Changed active term' } },
  { re: /^\/api\/settings\/workload-policy/, category: 'System', noun: 'workload limits', verbs: { PUT: 'Changed workload limits' } },
  { re: /^\/api\/error-logs/, category: 'System', noun: 'error log', verbs: { PATCH: 'Updated error log' } },
  { re: /^\/api\/school-years/, category: 'System', noun: 'school year' },
  { re: /^\/api\/settings\/logo/, category: 'System', noun: 'system logo', verbs: { POST: 'Changed system logo', PUT: 'Changed system logo', DELETE: 'Removed system logo' } },
  { re: /^\/api\/settings\/reset/, category: 'System', noun: 'system data', verbs: { POST: 'Reset system data' } },
  { re: /^\/api\/setup/, category: 'System', noun: 'database setup', verbs: { POST: 'Ran database setup' } },
];

const DEFAULT_VERB: Record<string, string> = { POST: 'Created', PUT: 'Updated', PATCH: 'Updated', DELETE: 'Deleted' };

/** Writes to these areas can raise or clear workload / schedule / room-request alerts. */
const ALERT_TOPICS = new Set<RealtimeTopic>(['term', 'faculty', 'blocks', 'schedule', 'workload', 'room-requests']);

/** Keys never stored (secrets, big blobs). */
const SECRET_KEY = /pass|otp|code_hash|^code$|token|secret|credential|picture|image|logo|photo|file|data_url|base64/i;
/** Body fields that best name the thing that changed, in priority order. */
const LABEL_KEYS = ['room_name', 'subject_code', 'name', 'block_name', 'username', 'email', 'code', 'title', 'status', 'action'];

function sanitize(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '…' : value;
  if (depth > 2) return '…';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map(v => sanitize(v, depth + 1));
    return value.length > 20 ? [...items, `…and ${value.length - 20} more`] : items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (!SECRET_KEY.test(k)) out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return undefined;
}

function labelFrom(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  for (const k of LABEL_KEYS) {
    const v = body[k];
    if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v).trim().slice(0, 80);
  }
  return null;
}

export function describe(method: string, path: string, body: Record<string, unknown> | null, ok: boolean) {
  const rule = RULES.find(r => r.re.test(path));
  const category: AuditCategory = rule?.category ?? 'System';
  const noun = rule?.noun ?? path.replace(/^\/api\//, '').split('/')[0].replace(/-/g, ' ');
  let action = rule?.verbs?.[method] ?? `${DEFAULT_VERB[method] ?? method} ${noun}`;
  if (category === 'Sign-in' && method === 'POST' && !ok && /login/.test(path)) action = 'Failed sign-in';
  // Room request review: show the decision when the body carries it
  if (/room-requests/.test(path) && body && typeof body.status === 'string' && method !== 'POST') {
    action = `${body.status.charAt(0).toUpperCase()}${body.status.slice(1).toLowerCase()} room request`;
  }
  const label = category === 'Sign-in' ? null : labelFrom(body);
  return { category, action, summary: label ? `${action} — ${label}` : action };
}

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response> | Response;

/**
 * Wraps a route handler so successful writes land in the audit trail and tell
 * open tabs which data changed (real-time sync, services/realtime.ts).
 */
export function withAudit<C = unknown>(handler: Handler<C>): (req: NextRequest, ctx: C) => Promise<Response> {
  return async (req: NextRequest, ctx: C) => {
    const path = req.nextUrl?.pathname ?? new URL(req.url).pathname;
    const method = req.method.toUpperCase();
    if (method === 'GET') return handler(req, ctx);
    if (SKIP.some(re => re.test(path))) {
      const res = await handler(req, ctx);
      if (res.status < 400) bumpTopics(topicsForWrite(method, path));
      return res;
    }

    // Read the JSON body from a copy — the handler still gets the original.
    let body: Record<string, unknown> | null = null;
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      body = await req.clone().json().catch(() => null);
      if (body && (typeof body !== 'object' || Array.isArray(body))) body = { items: body };
    }
    // Session of whoever is acting (before sign-out clears it)
    const actor = await getAuthUser(req).catch(() => null);

    const res = await handler(req, ctx);

    const isLogin = /^\/api\/auth\/(login|google-login|login-otp)$/.test(path);
    const ok = res.status < 400;
    if (ok) {
      const topics = topicsForWrite(method, path);
      bumpTopics(topics);
      // Workload routes re-check alerts themselves
      if (!path.startsWith('/api/workload/') && topics.some(t => ALERT_TOPICS.has(t))) scheduleWorkloadMonitoringSync();
    }
    // Keep failed sign-in attempts too (security); other failures are noise.
    if (ok || (isLogin && [401, 403, 429].includes(res.status))) {
      // Copy the sign-in response now — Next streams the original to the client.
      const out = isLogin && !actor ? res.clone() : null;
      void record({ req, ctx, path, method, body, actor, status: res.status, out, ok, isLogin }).catch(err =>
        console.warn('[audit] could not record', path, (err as Error).message));
    }
    return res;
  };
}

async function record(a: {
  req: NextRequest; ctx: unknown; path: string; method: string; body: Record<string, unknown> | null;
  actor: Record<string, unknown> | null; status: number; out: Response | null; ok: boolean; isLogin: boolean;
}) {
  await ensureAuditTable();
  let actorId = a.actor?.id != null ? Number(a.actor.id) : null;
  let actorRole = (a.actor?.role as string | undefined) ?? null;
  let actorName = (a.actor?.name as string | undefined) ?? (a.actor?.username as string | undefined) ?? null;

  // Sign-in: nobody is logged in yet — take the identity from the response / form.
  if (a.isLogin && !a.actor) {
    const out = await a.out?.json().catch(() => null) as { role?: string; user?: { id?: number; name?: string; username?: string; role?: string } } | null;
    actorRole = out?.user?.role ?? out?.role ?? null;
    actorId = a.ok && out?.user?.id != null ? Number(out.user.id) : null;
    actorName = out?.user?.name ?? out?.user?.username ?? (a.body?.username as string | undefined) ?? (a.body?.email as string | undefined) ?? null;
  }

  const params = await Promise.resolve((a.ctx as { params?: unknown } | undefined)?.params).catch(() => undefined);
  const { category, action, summary } = describe(a.method, a.path, a.body, a.ok);
  const details = sanitize({ ...(params && typeof params === 'object' ? { target: params } : {}), ...(a.body ?? {}) }) as Record<string, unknown>;

  await query(
    `INSERT INTO audit_logs (actor_id, actor_role, actor_name, category, action, summary, method, path, status, success, ip, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [actorId, actorRole, actorName ? String(actorName).slice(0, 120) : null, category, action, summary.slice(0, 300),
      a.method, a.path, a.status, a.ok, getClientIp(a.req), Object.keys(details).length ? JSON.stringify(details) : null],
  );
  bumpTopics(['audit']);
}
