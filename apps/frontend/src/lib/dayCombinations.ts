'use client';

/**
 * Semester day combinations (Settings → Day Combinations) for the frontend —
 * one cached loader used by Settings, Scheduling, Class Program and the
 * workload form (on screen, Print, Excel), so they all read the same list.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WeekDay } from '@shared/dayCombination';
import { useRealtime } from '@/context/RealtimeContext';

export interface TermDayCombination {
  id: number;
  days: WeekDay[];
  is_active: boolean;
  sort_order: number;
}

export interface TermDayCombinations {
  academic_year: string;
  semester: string;
  combinations: TermDayCombination[];
  /** true when scheduling is limited to the active combinations */
  restricted: boolean;
}

const EMPTY: TermDayCombinations = { academic_year: '', semester: '', combinations: [], restricted: false };
const cache = new Map<string, { at: number; p: Promise<TermDayCombinations> }>();
/** A cached list is reused this long; printouts and Excel files always read it fresh */
const CACHE_MS = 30_000;

/**
 * The term's combinations (active term when omitted). Never throws — no data =
 * no restriction. `fresh` skips the cache (documents must match the database
 * now, even when another user changed Settings a moment ago).
 */
export function fetchDayCombinations(
  semester?: string | null,
  academicYear?: string | null,
  opts: { fresh?: boolean } = {},
): Promise<TermDayCombinations> {
  const key = `${academicYear ?? ''}|${semester ?? ''}`;
  const hit = cache.get(key);
  let p = !opts.fresh && hit && Date.now() - hit.at < CACHE_MS ? hit.p : undefined;
  if (!p) {
    const qs = new URLSearchParams();
    if (academicYear) qs.set('academic_year', academicYear);
    if (semester) qs.set('semester', semester);
    p = fetch(`/api/settings/day-combinations?${qs}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() as Promise<TermDayCombinations> : EMPTY))
      .catch(() => EMPTY);
    const entry = { at: Date.now(), p };
    cache.set(key, entry);
    // A failed load shouldn't stick — let the next call retry
    p.then(d => { if (d === EMPTY && cache.get(key) === entry) cache.delete(key); });
  }
  return p;
}

/** Drop cached lists (after Settings saves a change) */
export function invalidateDayCombinations() {
  cache.clear();
}

/** Only the combinations switched on */
export const activeCombinations = (d: TermDayCombinations | null | undefined) =>
  (d?.combinations ?? []).filter(c => c.is_active);

export function useDayCombinations(semester: string | null | undefined, academicYear: string | null | undefined) {
  const [data, setData] = useState<TermDayCombinations | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchDayCombinations(semester, academicYear).then(d => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [semester, academicYear, version]);
  const reload = useCallback(() => { invalidateDayCombinations(); setVersion(v => v + 1); }, []);
  // Settings → Day Combinations changed elsewhere — the current list stays until the new one is in
  useRealtime(['settings'], reload);
  const active = useMemo(() => activeCombinations(data), [data]);
  return { data, active, loading: data === null, reload };
}
