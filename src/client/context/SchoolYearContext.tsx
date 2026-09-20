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

    fetch('/api/settings/school-year', { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        if (data.schoolYear) setSchoolYear(data.schoolYear);
        if (data.semester)   setSemester(data.semester);
      })
      .catch(e => { if (e?.name !== 'AbortError') console.error('[SchoolYear]', e); })
      .finally(() => setLoading(false));

    function onChanged(e: Event) {
      const { schoolYear: sy, semester: sem } = (e as CustomEvent).detail ?? {};
      if (sy  !== undefined) setSchoolYear(sy);
      if (sem !== undefined) setSemester(sem);
    }

    window.addEventListener('school-year-changed', onChanged);
    return () => {
      controller.abort();
      window.removeEventListener('school-year-changed', onChanged);
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
