'use client';

import { useEffect, useState } from 'react';
import { useVisibilityAwareInterval } from '@/client/hooks/useVisibilityAwareInterval';

export interface SchedulingPendingCounts {
  workload: number;
  masterSchedule: number;
  facultySchedule: number;
}

const EMPTY: SchedulingPendingCounts = { workload: 0, masterSchedule: 0, facultySchedule: 0 };
const POLL_MS = 30_000;

/**
 * Nav badge counts for the Scheduling dropdown (Faculty Workload / Master
 * Schedule / Faculty Schedules) — same polling pattern as NotificationContext,
 * pausing while the tab is hidden.
 */
export function useSchedulingPendingCounts(): SchedulingPendingCounts {
  const [counts, setCounts] = useState<SchedulingPendingCounts>(EMPTY);

  function load() {
    return fetch('/api/scheduling/pending-counts')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return;
        setCounts({
          workload: Number(d.workload) || 0,
          masterSchedule: Number(d.masterSchedule) || 0,
          facultySchedule: Number(d.facultySchedule) || 0,
        });
      })
      .catch(() => {});
  }

  useEffect(() => { load(); }, []);
  useVisibilityAwareInterval(load, POLL_MS);

  return counts;
}
