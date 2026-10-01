'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRealtime } from '@/context/RealtimeContext';

interface SchoolYearCtx {
  schoolYear: string;
  semester: string;
  loading: boolean;
}

const SchoolYearContext = createContext<SchoolYearCtx>({
  schoolYear: '',
  semester:   '',
  loading:    true,
});

export function SchoolYearProvider({ children }: { children: React.ReactNode }) {
  const [schoolYear, setSchoolYear] = useState('');
  const [semester,   setSemester]   = useState('');
  const [loading,    setLoading]    = useState(true);
  /** Quiet re-check of the active term (no retries) — used by live updates. */
  const recheck = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // A network blip ("Failed to fetch" — e.g. the dev server recompiling or a
    // reload mid-request) shouldn't leave the app without an active term, so
    // retry a couple of times before giving up quietly.
    const MAX_ATTEMPTS = 3;
    function load(attempt: number): Promise<void> {
      return fetch('/api/settings/school-year', { signal: controller.signal })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) {
            // null = archived / none active — clear it so stale terms never linger
            setSchoolYear(data.schoolYear ?? '');
            setSemester(data.semester ?? '');
          }
          setLoading(false);
        })
        .catch(e => {
          if (e?.name === 'AbortError') return;
          if (attempt < MAX_ATTEMPTS) {
            retryTimer = setTimeout(() => load(attempt + 1), 1000 * attempt);
            return;
          }
          console.warn('[SchoolYear] could not load active term:', e instanceof Error ? e.message : e);
          setLoading(false);
        });
    }
    load(1);
    recheck.current = () => load(MAX_ATTEMPTS);

    function onChanged(e: Event) {
      const { schoolYear: sy, semester: sem } = (e as CustomEvent).detail ?? {};
      if (sy  !== undefined) setSchoolYear(sy);
      if (sem !== undefined) setSemester(sem);
    }

    window.addEventListener('school-year-changed', onChanged);
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('school-year-changed', onChanged);
    };
  }, []);

  // Another admin (or another tab) changed the active term — follow it
  useRealtime(['term'], () => recheck.current());

  const value = useMemo(() => ({ schoolYear, semester, loading }), [schoolYear, semester, loading]);

  return (
    <SchoolYearContext.Provider value={value}>
      {children}
    </SchoolYearContext.Provider>
  );
}

export function useSchoolYear(): SchoolYearCtx {
  return useContext(SchoolYearContext);
}
