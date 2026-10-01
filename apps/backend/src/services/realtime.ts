import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { query } from '@/database/db';
import { ensureRealtimeTable } from '@/database/realtimeSchema';
import { getAuthUser } from '@/auth/auth';
import { notificationTopicKey, topicsForRole, type RealtimeVersions } from '@shared/realtime';

/**
 * Real-time sync — server side (contract in packages/shared/src/realtime.ts).
 *
 * `realtime_versions` keeps one row per topic. A successful write bumps the
 * topics it touched; open tabs read the versions they may see through
 * GET /api/realtime/versions and re-fetch their data when one moves on.
 * Nothing here ever delays or fails the request that made the change.
 */

/* ── Recording changes ─────────────────────────────────────────────────────── */

const pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumps a request makes (route + services) are written together. */
const FLUSH_DELAY_MS = 40;
/** Bumped on every successful write, so a read that started earlier is never cached. */
let writeGeneration = 0;

/**
 * Marks topics as changed. Returns at once and never throws; a failed write
 * is retried twice before it is given up (tabs still fall back to their timers).
 */
export function bumpTopics(topics: Iterable<string | null | undefined>): void {
  for (const t of topics) if (t) pending.add(t);
  if (pending.size > 0) scheduleFlush(FLUSH_DELAY_MS, 1);
}

/** A recipient's inbox changed (new, updated, read or removed notifications). */
export function bumpNotifications(role: string, recipientId?: number | null): void {
  bumpTopics([notificationTopicKey(role, recipientId)]);
}

function scheduleFlush(delay: number, attempt: number) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush(attempt);
  }, delay);
}

async function flush(attempt: number): Promise<void> {
  const topics = [...pending];
  pending.clear();
  if (topics.length === 0) return;
  try {
    await ensureRealtimeTable();
    // Version = server time in µs, and always above the previous one, so it
    // keeps moving forward even if the table was emptied or the clock stepped back.
    await query(
      `INSERT INTO realtime_versions AS rv (topic, version, changed_at)
       SELECT t, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint, NOW()
       FROM unnest($1::text[]) AS t
       ON CONFLICT (topic) DO UPDATE
         SET version = GREATEST(rv.version + 1, EXCLUDED.version), changed_at = NOW()`,
      [topics],
    );
    writeGeneration++;
    versionsCache = null; // the next check sees this change straight away
  } catch (err) {
    if (attempt >= 3) {
      console.warn('[realtime] could not record change:', topics.join(', '), (err as Error).message);
      return;
    }
    for (const t of topics) pending.add(t);
    scheduleFlush(2_000 * attempt, attempt + 1);
  }
}

/* ── Reading versions ──────────────────────────────────────────────────────── */

/** All tabs share one read per second, however many are open. */
const VERSIONS_CACHE_MS = 1_000;

interface VersionsSnapshot {
  map: Map<string, number>;
  /** Database time of the read, in µs — the same clock as the versions. */
  now: number;
}

let versionsCache: { at: number; snap: VersionsSnapshot } | null = null;
let versionsInFlight: Promise<VersionsSnapshot> | null = null;

async function allVersions(): Promise<VersionsSnapshot> {
  if (versionsCache && Date.now() - versionsCache.at < VERSIONS_CACHE_MS) return versionsCache.snap;
  if (!versionsInFlight) {
    const generation = writeGeneration;
    versionsInFlight = (async () => {
      await ensureRealtimeTable();
      // One row even when the table is empty
      const res = await query(`
        SELECT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint AS now,
               COALESCE(json_object_agg(topic, version), '{}'::json) AS versions
        FROM realtime_versions
      `);
      const row = res.rows[0] as { now: string | number; versions: Record<string, string | number> | null };
      const snap: VersionsSnapshot = {
        now: Number(row.now),
        map: new Map(Object.entries(row.versions ?? {}).map(([t, v]) => [t, Number(v)])),
      };
      // A write that landed while this read ran must not be hidden behind the cache.
      if (generation === writeGeneration) versionsCache = { at: Date.now(), snap };
      return snap;
    })().finally(() => {
      versionsInFlight = null;
    });
  }
  return versionsInFlight;
}

type SessionUser = Record<string, unknown>;

/** The topics this user may see, with their current versions and the server time. */
export async function versionsFor(user: SessionUser): Promise<{ v: RealtimeVersions; now: number }> {
  const role = String(user.role ?? '');
  const { map, now } = await allVersions();
  const v: RealtimeVersions = {};
  for (const topic of topicsForRole(role)) {
    if (topic === 'notifications') {
      const recipientId = role === 'instructor' ? Number(user.faculty_id) : Number(user.id);
      const key = notificationTopicKey(role, recipientId);
      v.notifications = key ? (map.get(key) ?? 0) : 0;
    } else {
      v[topic] = map.get(topic) ?? 0;
    }
  }
  return { v, now };
}

/* ── Session check for the version endpoint ────────────────────────────────── */

/**
 * Tabs check versions every few seconds. The session's liveness (signed out,
 * deactivated) is re-confirmed against the database at most every 15 s per
 * session; the data routes themselves still check on every request.
 */
const SESSION_CACHE_MS = 15_000;
const SESSION_CACHE_MAX = 5_000;
const sessionCache = new Map<string, { user: SessionUser; until: number }>();

export async function realtimeSessionUser(req: NextRequest): Promise<SessionUser | null> {
  const token = req.cookies.get('auth_token')?.value;
  if (!token) return null;
  const key = createHash('sha256').update(token).digest('base64url');
  const now = Date.now();
  const hit = sessionCache.get(key);
  if (hit && hit.until > now) return hit.user;

  const user = (await getAuthUser(req)) as SessionUser | null;
  if (!user?.role) {
    sessionCache.delete(key);
    return null;
  }
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    for (const [k, v] of sessionCache) if (v.until <= now) sessionCache.delete(k);
    if (sessionCache.size >= SESSION_CACHE_MAX) sessionCache.clear();
  }
  sessionCache.set(key, { user, until: now + SESSION_CACHE_MS });
  return user;
}
