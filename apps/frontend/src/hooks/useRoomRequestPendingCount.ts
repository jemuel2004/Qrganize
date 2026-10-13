'use client';

import { useCallback, useEffect, useState } from 'react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';

/** Fallback only — the count refreshes through live updates when requests change. */
const POLL_MS = 120_000;

/**
 * Admin menu badge for Room Requests: how many faculty requests wait for a
 * decision (the page's Pending list). Refreshed by live updates whenever a
 * request is made, decided or runs out, with a slow fallback poll (paused
 * while the tab is hidden).
 */
export function useRoomRequestPendingCount(): number {
  const [count, setCount] = useState(0);

  const load = useCallback(() => fetch('/api/admin/room-requests?count=1', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(d => { if (d) setCount(Number(d.pending) || 0); })
    .catch(() => {}), []);

  useEffect(() => { void load(); }, [load]);
  useRealtime(['room-requests'], load);
  useVisibilityAwareInterval(load, POLL_MS);

  return count;
}
