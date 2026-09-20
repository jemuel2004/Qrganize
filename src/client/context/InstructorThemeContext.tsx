'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type InstructorTheme = 'dark' | 'light' | 'system';

interface ThemeContextValue {
  theme: InstructorTheme;
  resolvedTheme: 'dark' | 'light';
  setTheme: (t: InstructorTheme) => Promise<void>;
  saving: boolean;
}

const InstructorThemeContext = createContext<ThemeContextValue>({
  theme: 'light',
  resolvedTheme: 'light',
  setTheme: async () => {},
  saving: false,
});

export function useInstructorTheme() {
  return useContext(InstructorThemeContext);
}

/**
 * Instructor uses the SAME shared authenticated theme as Admin/Dept Chair:
 * `html.light` for Light Mode, no class for Dark Mode.
 *
 * Preference is stored separately (`instructor-theme`) so each role keeps
 * its own choice — but the COLOR TOKENS are shared (no role-specific palette).
 */
export function InstructorThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<InstructorTheme>('light');
  const [saving, setSaving] = useState(false);
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mq.matches);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem('instructor-theme') as InstructorTheme | null;
    if (stored && ['dark', 'light', 'system'].includes(stored)) {
      setThemeState(stored);
    } else {
      setThemeState('light');
      localStorage.setItem('instructor-theme', 'light');
    }

    fetch('/api/instructor/profile/theme')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.theme && ['dark', 'light', 'system'].includes(d.theme)) {
          setThemeState(d.theme as InstructorTheme);
          localStorage.setItem('instructor-theme', d.theme);
        }
      })
      .catch(() => {});
  }, []);

  const resolvedTheme: 'dark' | 'light' =
    theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    const html = document.documentElement;
    // Shared app theme class — same as Admin/Dept Chair.
    html.classList.toggle('light', resolvedTheme === 'light');
    // Legacy attr: remove so the old separate Instructor palette cannot apply.
    html.removeAttribute('data-instructor-theme');
  }, [resolvedTheme]);

  const setTheme = useCallback(async (t: InstructorTheme) => {
    setThemeState(t);
    localStorage.setItem('instructor-theme', t);
    setSaving(true);
    try {
      await fetch('/api/instructor/profile/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: t }),
      });
    } catch {
      /* silent — preference is already saved in localStorage */
    } finally {
      setSaving(false);
    }
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, saving }),
    [theme, resolvedTheme, setTheme, saving]
  );

  return (
    <InstructorThemeContext.Provider value={value}>
      {children}
    </InstructorThemeContext.Provider>
  );
}
