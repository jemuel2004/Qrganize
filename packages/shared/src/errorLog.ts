/**
 * Error log helpers shared by the API (which records errors) and the app (which
 * reports page crashes and shows the log). Pure — no database, no browser APIs.
 *
 * Every error is filed under a module (the feature area it happened in) and a
 * source (the exact place: a log tag such as "qr/scan", a route file or a page).
 * Repeats of the same error are grouped by a fingerprint that ignores the parts
 * that change between occurrences (ids, numbers, emails).
 */

export const ERROR_MODULES = [
  'Sign-in', 'Accounts', 'Setup', 'Scheduling', 'Workload', 'Rooms',
  'Notifications', 'Faculty portal', 'Dashboard', 'Reports', 'Database', 'System',
] as const;
export type ErrorModule = (typeof ERROR_MODULES)[number];
export type ErrorLevel = 'error' | 'warning';

export const ERROR_LIMITS = { message: 500, detail: 4000, source: 120, path: 300 } as const;

/** API route → module. First match wins. */
const API_MODULES: ReadonlyArray<[RegExp, ErrorModule]> = [
  [/^\/api\/(auth|account\/security)(\/|$)/, 'Sign-in'],
  [/^\/api\/(account|instructor-accounts|department-chair-accounts|dept-chair-accounts|instructor\/profile|instructor\/verify-google|dept-chair\/verify-google)(\/|$)/, 'Accounts'],
  [/^\/api\/(curriculum|faculty|blocks|programs)(\/|$)/, 'Setup'],
  [/^\/api\/(scheduling|master-schedule|class-program|faculty-schedules)(\/|$)/, 'Scheduling'],
  [/^\/api\/(workload|praise|praise-loads|overload)(\/|$)/, 'Workload'],
  [/^\/api\/(rooms|qr|admin\/room-requests|instructor\/room-requests|instructor\/available-rooms|instructor\/rooms)(\/|$)/, 'Rooms'],
  [/^\/api\/notifications(\/|$)/, 'Notifications'],
  [/^\/api\/instructor(\/|$)/, 'Faculty portal'],
  [/^\/api\/(dashboard|analytics)(\/|$)/, 'Dashboard'],
  [/^\/api\/setup(\/|$)/, 'Database'],
];

/** App page → module. */
const PAGE_MODULES: ReadonlyArray<[RegExp, ErrorModule]> = [
  [/^\/login(\/|$)/, 'Sign-in'],
  [/^\/(instructor-accounts|department-chair-accounts|dept-chair-accounts|dept-chair\/account|department-chair\/account)(\/|$)/, 'Accounts'],
  [/^\/program\/(curriculum|faculty|blocks)(\/|$)/, 'Setup'],
  [/^\/(scheduling|master-schedule|program\/class-program|faculty-schedules)(\/|$)/, 'Scheduling'],
  [/^\/(workload|overload)(\/|$)/, 'Workload'],
  [/^\/(room-monitoring|room-utilization|room-requests|rooms|qr-generator)(\/|$)/, 'Rooms'],
  [/^\/instructor(\/|$)/, 'Faculty portal'],
  [/^\/(dashboard|analytics)(\/|$)/, 'Dashboard'],
  [/^\/reports(\/|$)/, 'Reports'],
];

/** Log tag of a service (no route in it) → module. Order matters. */
const TAG_MODULES: ReadonlyArray<[RegExp, ErrorModule]> = [
  [/^v\d+\b/i, 'Database'],                                   // migrations: [v12], [v3 backfill]
  [/^(db|schema-guard|migrate|startup)\b/i, 'Database'],
  [/notification/i, 'Notifications'],                        // syncWorkloadMonitoringNotifications, createNotification
  [/workload|overload|praise|loadsummar|deduction/i, 'Workload'],
  [/room|occupancy|qr\b|qrscan/i, 'Rooms'],
  [/schedul|conflict|session/i, 'Scheduling'],
  [/curriculum|block|faculty|program/i, 'Setup'],
  [/auth|login|otp|token|google|geoip|trusted/i, 'Sign-in'],
  [/account|profile|picture/i, 'Accounts'],
];

const firstMatch = (value: string, rules: ReadonlyArray<[RegExp, ErrorModule]>) =>
  rules.find(([re]) => re.test(value))?.[1] ?? null;

/** "/api/x/[id]/route" or "GET /api/x" or "qr/scan" inside a tag → "/api/…", else null. */
export function routeFromSource(source: string): string | null {
  const api = /\/api\/[\w\-/[\].]*/.exec(source);
  if (api) return api[0].replace(/\/route$/, '');
  const bare = /^(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?([a-z][\w-]*\/[\w\-/[\]]*)/i.exec(source.trim());
  return bare ? `/api/${bare[1]}` : null;
}

/**
 * The module an error belongs to. The source says where in the code it
 * happened, so it wins over the request that happened to trigger it.
 */
export function moduleForError(opts: { source?: string | null; path?: string | null; page?: boolean }): ErrorModule {
  const source = (opts.source ?? '').trim();
  const path = (opts.path ?? '').split('?')[0];
  if (opts.page) return (path && firstMatch(path, PAGE_MODULES)) || 'System';
  if (source) {
    const route = routeFromSource(source);
    if (route) {
      const byRoute = firstMatch(route, API_MODULES);
      if (byRoute) return byRoute;
    }
    const byTag = firstMatch(source, TAG_MODULES);
    if (byTag) return byTag;
  }
  if (path.startsWith('/api/')) return firstMatch(path, API_MODULES) ?? 'System';
  return 'System';
}

/**
 * "[qr/scan] error: …" → { tag: 'qr/scan', rest: 'error: …' }; untagged text → null.
 * Route tags can hold brackets themselves — "[GET /api/workload/[facultyId]]".
 */
export function parseLogTag(first: unknown): { tag: string; rest: string } | null {
  if (typeof first !== 'string' || first[0] !== '[') return null;
  let depth = 0;
  for (let i = 0; i < Math.min(first.length, 122); i++) {
    const ch = first[i];
    if (ch === '\n') return null;
    if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) {
      const tag = first.slice(1, i).trim();
      return tag ? { tag, rest: first.slice(i + 1).replace(/^\s+/, '') } : null;
    }
  }
  return null;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Hides tokens, passwords and database credentials that may appear in error text. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<token>')
    .replace(/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer <token>')
    .replace(/(\b[a-z][\w+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1***@')
    .replace(
      /(\b(?:password|passwd|pass|secret|token|api[_-]?key)\b["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      (_m, key: string, value: string) => `${key}${value[0] === '"' ? '"***"' : value[0] === "'" ? "'***'" : '***'}`,
    );
}

function describeValue(value: unknown): string {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    // pg reports its errors with the name "error" — only real class names are worth showing
    const name = value.name && !/^error$/i.test(value.name) ? `${value.name}: ` : '';
    return `${name}${value.message}${typeof code === 'string' && code ? ` (${code})` : ''}`;
  }
  if (typeof value === 'string') return value;
  if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return truncate(JSON.stringify(value) ?? String(value), 300);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Console arguments → a readable message plus the first error's stack trace. */
export function formatLogArgs(args: readonly unknown[]): { message: string; detail: string | null } {
  const message = args.map(describeValue).filter(s => s.trim() !== '').join(' ').replace(/\s+/g, ' ').trim();
  const err = args.find((a): a is Error => a instanceof Error);
  const pgDetail = err ? (err as { detail?: unknown }).detail : undefined;
  const detail = [err?.stack, typeof pgDetail === 'string' ? `Detail: ${pgDetail}` : null].filter(Boolean).join('\n') || null;
  return {
    message: truncate(redactSecrets(message || '(no message)'), ERROR_LIMITS.message),
    detail: detail ? truncate(redactSecrets(detail), ERROR_LIMITS.detail) : null,
  };
}

/**
 * What stays the same between repeats of one error — ids, numbers, emails and
 * the offending values a database error quotes (`integer: "abc"`,
 * `Key (email)=(x)`) removed. Names such as `constraint "users_email_key"`
 * are kept, so different problems stay apart.
 */
export function errorFingerprintKey(level: ErrorLevel, source: string, message: string): string {
  const normalized = message.toLowerCase()
    .replace(/:\s*"[^"]*"/g, ': "<v>"')
    .replace(/=\([^)]*\)/g, '=(<v>)')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\b0x[0-9a-f]+\b/g, '<n>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return `${level}|${source.trim().toLowerCase()}|${normalized}`;
}
