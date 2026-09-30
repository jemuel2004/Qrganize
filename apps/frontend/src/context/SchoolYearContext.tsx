'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

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

  useEffect(() => {
    const controller = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // A network blip ("Failed to fetch" — e.g. the dev server recompiling or a
    // reload mid-request) shouldn't leave the app without an active term, so
    // retry a couple of times before giving up quietly.
    const MAX_ATTEMPTS = 3;
    function load(attempt: number) {
      fetch('/api/settings/school-year', { signal: controller.signal })
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

    function onChanged(e: Event) {
      const { schoolYear: sy, semester: sem } = (e as CustomEvent).detail ?? {};
      if (sy  !== undefined) setSchoolYear(sy);
      if (sem !== undefined) setSemester(sem);
    }

    // The term can change in another tab, window or by another admin — re-check
    // whenever this tab comes back into view (at most every 10 s).
    let lastCheck = Date.now();
    function onVisible() {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 10_000) return;
      lastCheck = Date.now();
      load(MAX_ATTEMPTS); // one quiet attempt, no retries
    }

    window.addEventListener('school-year-changed', onChanged);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('school-year-changed', onChanged);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

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
