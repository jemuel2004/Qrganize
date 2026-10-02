import { createHash } from 'node:crypto';
import { headers } from 'next/headers';
import { query } from '@/database/db';
import { ensureErrorLogTable } from '@/database/errorLogSchema';
import { bumpTopics } from '@/services/realtime';
import { ACTOR_HEADER, ROUTE_HEADER, decodeActor, decodeRoute, type RequestActor } from '@/auth/requestHeaders';
import {
  ERROR_LIMITS, errorFingerprintKey, formatLogArgs, moduleForError, parseLogTag, redactSecrets, truncate,
  type ErrorLevel, type ErrorModule,
} from '@shared/errorLog';

/**
 * Error log — every server error and warning the code logs with a [module]
 * tag (console.error / console.warn), every uncaught route error
 * (instrumentation onRequestError) and every page crash reported by the app
 * lands in `error_logs`, filed under the module where it happened, with the
 * route and signed-in user when there was one. Admins see it in System →
 * Error Logs. Recording never delays or breaks the request that failed.
 */

export interface ErrorInput {
  level: ErrorLevel;
  /** Exact place: log tag, route file or page */
  source: string;
  message: string;
  detail?: string | null;
  method?: string | null;
  path?: string | null;
  actor?: RequestActor | null;
  module?: ErrorModule;
  /** A page crash in the app (path is the page) */
  page?: boolean;
}

interface QueuedError {
  fingerprint: string;
  level: ErrorLevel;
  module: ErrorModule;
  source: string;
  message: string;
  detail: string | null;
  method: string | null;
  path: string | null;
  actor: RequestActor | null;
  occurrences: number;
  firstSeen: Date;
  lastSeen: Date;
}

/** Errors are written in small batches; repeats inside one batch become a count. */
const FLUSH_DELAY_MS = 1_500;
/** At most this many different errors wait for one write (a flood is counted, not stored). */
const MAX_PENDING = 200;
/** Entries from these sources don't wake open Error Logs pages — no live-update feedback loop. */
const QUIET_SOURCE = /^(realtime|errorLog)\b|error-logs/i;
/** Debug-only messages and the log's own notes are never stored. */
const IGNORED_TAG = /^(verifyToken|errorLog)$/;

const pending = new Map<string, QueuedError>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let dropped = 0;

type CaptureGlobal = typeof globalThis & {
  __qrganizeErrorCapture?: { error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
};

/** The log's own problems go to the original console only, so they can't loop back in. */
function rawError(...args: unknown[]) {
  ((globalThis as CaptureGlobal).__qrganizeErrorCapture?.error ?? console.error)(...args);
}

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_DELAY_MS);
}

/** Queue one error. Returns at once and never throws. */
export function recordError(input: ErrorInput): void {
  try {
    const source = truncate(String(input.source ?? '').trim() || 'unknown', ERROR_LIMITS.source);
    const message = truncate(redactSecrets(String(input.message ?? '').trim()) || '(no message)', ERROR_LIMITS.message);
    const detail = input.detail ? truncate(redactSecrets(String(input.detail)), ERROR_LIMITS.detail) : null;
    // Query strings can carry anything — keep the route only
    const path = input.path ? truncate(String(input.path).split('?')[0], ERROR_LIMITS.path) : null;
    const fingerprint = createHash('sha1').update(errorFingerprintKey(input.level, source, message)).digest('hex');
    const now = new Date();

    const queued = pending.get(fingerprint);
    if (queued) {
      queued.occurrences++;
      queued.lastSeen = now;
      return;
    }
    if (pending.size >= MAX_PENDING) {
      dropped++;
      return;
    }
    pending.set(fingerprint, {
      fingerprint, level: input.level, source, message, detail, path,
      module: input.module ?? moduleForError({ source, path, page: input.page }),
      method: input.method ? truncate(String(input.method).toUpperCase(), 10) : null,
      actor: input.actor ?? null,
      occurrences: 1, firstSeen: now, lastSeen: now,
    });
    scheduleFlush();
  } catch {
    /* recording must never break the app */
  }
}

async function flush(): Promise<void> {
  if (flushing) { scheduleFlush(); return; }
  const batch = [...pending.values()];
  pending.clear();
  if (batch.length === 0) return;
  flushing = true;
  try {
    await ensureErrorLogTable();
    const col = <T,>(pick: (e: QueuedError) => T) => batch.map(pick);
    // A repeat of an open error adds to its count; a resolved one starts a new row
    await query(
      `INSERT INTO error_logs (fingerprint, level, module, source, message, detail, method, path,
                               actor_id, actor_role, actor_name, occurrences, first_seen, last_seen)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                            $9::int[], $10::text[], $11::text[], $12::int[], $13::timestamptz[], $14::timestamptz[])
       ON CONFLICT (fingerprint) WHERE resolved_at IS NULL
       DO UPDATE SET occurrences = error_logs.occurrences + EXCLUDED.occurrences,
                     last_seen   = GREATEST(error_logs.last_seen, EXCLUDED.last_seen)`,
      [
        col(e => e.fingerprint), col(e => e.level), col(e => e.module), col(e => e.source),
        col(e => e.message), col(e => e.detail), col(e => e.method), col(e => e.path),
        col(e => e.actor?.id ?? null), col(e => e.actor?.role ?? null), col(e => e.actor?.name ?? null),
        col(e => e.occurrences), col(e => e.firstSeen), col(e => e.lastSeen),
      ],
    );
    if (batch.some(e => !QUIET_SOURCE.test(e.source))) bumpTopics(['errors']);
  } catch (err) {
    rawError('[errorLog] could not store', batch.length, 'error(s):', (err as Error).message);
  } finally {
    flushing = false;
    if (dropped > 0) {
      rawError(`[errorLog] ${dropped} more error(s) arrived at once and were not stored.`);
      dropped = 0;
    }
  }
}

/* ── Where the error happened ──────────────────────────────────────────────── */

type HeaderSource = { get(name: string): string | null | undefined };

function contextFromHeaders(h: HeaderSource): Pick<ErrorInput, 'method' | 'path' | 'actor'> {
  const route = decodeRoute(h.get(ROUTE_HEADER));
  return { method: route?.method ?? null, path: route?.path ?? null, actor: decodeActor(h.get(ACTOR_HEADER)) };
}

/** The request being handled when the error was logged, or null outside a request. */
function currentRequest(): Promise<Pick<ErrorInput, 'method' | 'path' | 'actor'>> | null {
  let requestHeaders: unknown;
  try {
    requestHeaders = headers(); // throws outside a request scope
  } catch {
    return null;
  }
  return Promise.resolve(requestHeaders as Promise<HeaderSource>).then(contextFromHeaders);
}

/* ── Capture ───────────────────────────────────────────────────────────────── */

let inCapture = false;

function captureConsole(level: ErrorLevel, args: unknown[]): void {
  if (inCapture) return;
  inCapture = true;
  try {
    const tagged = parseLogTag(args[0]);
    if (!tagged || IGNORED_TAG.test(tagged.tag)) return;
    const { message, detail } = formatLogArgs([tagged.rest, ...args.slice(1)]);
    const base: ErrorInput = { level, source: tagged.tag, message, detail };
    const request = currentRequest();
    if (!request) recordError(base);
    else request.then(ctx => recordError({ ...base, ...ctx }), () => recordError(base));
  } catch {
    /* the console must keep working whatever happens here */
  } finally {
    inCapture = false;
  }
}

/**
 * Copies tagged console.error / console.warn output into the error log
 * (console output itself is unchanged). Installed once per server process
 * from instrumentation.ts.
 */
export function installConsoleCapture(): void {
  const g = globalThis as CaptureGlobal;
  if (g.__qrganizeErrorCapture) return;
  const original = { error: console.error.bind(console), warn: console.warn.bind(console) };
  g.__qrganizeErrorCapture = original;
  console.error = (...args: unknown[]) => { original.error(...args); captureConsole('error', args); };
  console.warn = (...args: unknown[]) => { original.warn(...args); captureConsole('warning', args); };
}

/** An error no route caught (Next.js onRequestError). */
export function recordRequestError(
  err: unknown,
  request: { path: string; method: string; headers: Record<string, string | string[] | undefined> },
  context: { routePath?: string; routeType?: string },
): void {
  const header = (name: string) => {
    const v = request.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const { message, detail } = formatLogArgs([err]);
  recordError({
    level: 'error',
    source: context.routePath || request.path,
    message: `Unhandled: ${message}`,
    detail,
    method: request.method,
    path: request.path,
    actor: decodeActor(header(ACTOR_HEADER)),
  });
}
