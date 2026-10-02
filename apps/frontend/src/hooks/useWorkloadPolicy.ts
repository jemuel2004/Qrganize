'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_WORKLOAD_POLICY, normalizeWorkloadPolicy, type WorkloadPolicy } from '@shared/regularLoad';
import { useRealtime } from '@/context/RealtimeContext';

/*
 * The department's workload limits (Settings → Workload Limits), shared by
 * every page that shows a cap. One request per tab; live updates refresh it
 * when an admin changes the limits.
 */
let cached: WorkloadPolicy | null = null;
let request: Promise<WorkloadPolicy | null> | null = null;
const listeners = new Set<(p: WorkloadPolicy) => void>();

function loadPolicy(force = false): Promise<WorkloadPolicy | null> {
  if (request && !force) return request;
  const current = fetch('/api/settings/workload-policy', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then((d: { policy?: unknown } | null) => {
      if (!d?.policy) return null; // keep what is on screen
      const policy = normalizeWorkloadPolicy(d.policy);
      cached = policy;
      for (const l of listeners) l(policy);
      return policy;
    })
    .catch(() => null)
    .finally(() => { if (request === current) request = null; });
  request = current;
  return current;
}

/** Use right after saving new limits, so this tab shows them at once. */
export function setWorkloadPolicyCache(policy: WorkloadPolicy) {
  cached = policy;
  for (const l of listeners) l(policy);
}

export function useWorkloadPolicy(): WorkloadPolicy {
  // Defaults on the first render (same as the server render), then the saved limits
  const [policy, setPolicy] = useState<WorkloadPolicy>(DEFAULT_WORKLOAD_POLICY);

  useEffect(() => {
    listeners.add(setPolicy);
    if (cached) setPolicy(cached);
    else void loadPolicy();
    return () => { listeners.delete(setPolicy); };
  }, []);

  // An admin changed the limits elsewhere
  useRealtime(['settings'], () => loadPolicy(true));

  return policy;
}
