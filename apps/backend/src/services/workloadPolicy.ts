import { query } from '@/database/db';
import { ensureSystemSettingsTable } from '@/database/schema-guard';
import { DEFAULT_WORKLOAD_POLICY, normalizeWorkloadPolicy, type WorkloadPolicy } from '@shared/regularLoad';

/**
 * The department's workload limits (Settings → Workload Limits), stored as
 * JSON in system_settings. Rules read them through getWorkloadPolicy(); no
 * saved value means the defaults (18 units / 6 units / 30 hours).
 */

const KEY = 'workload_policy';
/** Short cache — the limits are read by many routes; a save replaces it at once. */
const CACHE_MS = 2_000;

let cached: { at: number; policy: WorkloadPolicy } | null = null;
let inFlight: Promise<WorkloadPolicy> | null = null;
/** Bumped by every save, so a read that started before it never caches old limits. */
let generation = 0;

export async function getWorkloadPolicy(): Promise<WorkloadPolicy> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.policy;
  if (!inFlight) {
    const startedAt = generation;
    inFlight = (async () => {
      try {
        await ensureSystemSettingsTable();
        const res = await query('SELECT value FROM system_settings WHERE key = $1', [KEY]);
        const policy = normalizeWorkloadPolicy(res.rows[0]?.value ?? null);
        if (startedAt !== generation) return cached?.policy ?? policy; // a save landed meanwhile
        cached = { at: Date.now(), policy };
        return policy;
      } catch (err) {
        // Keep working with the last known limits rather than failing every load page
        console.error('[workloadPolicy] could not read the workload limits — using the last known values:', err);
        return cached?.policy ?? { ...DEFAULT_WORKLOAD_POLICY };
      } finally {
        inFlight = null;
      }
    })();
  }
  return inFlight;
}

/** Saves validated limits (see parseWorkloadPolicy) and uses them straight away. */
export async function saveWorkloadPolicy(policy: WorkloadPolicy): Promise<void> {
  await ensureSystemSettingsTable();
  await query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [KEY, JSON.stringify(policy)],
  );
  generation++;
  cached = { at: Date.now(), policy };
}

/** A limit as a SQL number literal — only finite numbers ever reach a query. */
export function sqlNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Invalid workload limit: ${n}`);
  return String(Math.round(n * 100) / 100);
}
