'use client';

/**
 * Semester day combinations (Settings → Day Combinations) for the frontend —
 * one cached loader used by Settings, Scheduling, Class Program and the
 * workload form (on screen, Print, Excel), so they all read the same list.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WeekDay } from '@shared/dayCombination';

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
const cache = new Map<string, Promise<TermDayCombinations>>();

/** The term's combinations (active term when omitted). Never throws — no data = no restriction. */
export function fetchDayCombinations(semester?: string | null, academicYear?: string | null): Promise<TermDayCombinations> {
  const key = `${academicYear ?? ''}|${semester ?? ''}`;
  let p = cache.get(key);
  if (!p) {
    const qs = new URLSearchParams();
    if (academicYear) qs.set('academic_year', academicYear);
    if (semester) qs.set('semester', semester);
    p = fetch(`/api/settings/day-combinations?${qs}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() as Promise<TermDayCombinations> : EMPTY))
      .catch(() => EMPTY);
    cache.set(key, p);
    // A failed load shouldn't stick — let the next call retry
    p.then(d => { if (d === EMPTY) cache.delete(key); });
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
  const active = useMemo(() => activeCombinations(data), [data]);
  return { data, active, loading: data === null, reload };
}
