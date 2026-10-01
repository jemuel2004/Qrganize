'use client';

import { useEffect, useState } from 'react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';

export interface SchedulingPendingCounts {
  workload: number;
  scheduleClasses: number;
  masterSchedule: number;
  facultySchedule: number;
}

const EMPTY: SchedulingPendingCounts = { workload: 0, scheduleClasses: 0, masterSchedule: 0, facultySchedule: 0 };
/** Fallback only — the counts refresh through live updates when classes change. */
const POLL_MS = 120_000;

/**
 * Nav badge counts for the Scheduling dropdown (Faculty Workload / Master
 * Schedule / Faculty Schedules) — refreshed by live updates whenever blocks,
 * schedules or loads change, with a slow fallback poll (paused while hidden).
 */
export function useSchedulingPendingCounts(): SchedulingPendingCounts {
  const [counts, setCounts] = useState<SchedulingPendingCounts>(EMPTY);

  function load() {
    return fetch('/api/scheduling/pending-counts')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d) return;
        const next: SchedulingPendingCounts = {
          workload: Number(d.workload) || 0,
          scheduleClasses: Number(d.scheduleClasses) || 0,
          masterSchedule: Number(d.masterSchedule) || 0,
          facultySchedule: Number(d.facultySchedule) || 0,
        };
        // Same numbers → keep the same object (no menu re-render)
        setCounts(prev => (
          prev.workload === next.workload && prev.scheduleClasses === next.scheduleClasses
          && prev.masterSchedule === next.masterSchedule && prev.facultySchedule === next.facultySchedule
            ? prev : next
        ));
      })
      .catch(() => {});
  }

  useEffect(() => { load(); }, []);
  useRealtime(['blocks', 'schedule', 'workload', 'term'], load);
  useVisibilityAwareInterval(load, POLL_MS);

  return counts;
}
