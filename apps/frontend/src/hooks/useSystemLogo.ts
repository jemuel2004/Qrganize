'use client';

import { useEffect, useState } from 'react';
import { useRealtime } from '@/context/RealtimeContext';

/*
 * Module-level singleton — shared across every useSystemLogo() instance
 * (login page, FaviconUpdater, Sidebar, InstructorSidebar).
 *
 * Previously each hook instance fetched /api/settings/logo independently,
 * causing 2–3 concurrent requests on every page load. Now the fetch runs
 * once; subsequent subscribers receive the resolved value immediately.
 */
let cachedUrl: string | null = null;
let fetchPromise: Promise<string | null> | null = null;

function getLogoUrl(): Promise<string | null> {
  if (fetchPromise) return fetchPromise;
  fetchPromise = fetch('/api/settings/logo')
    .then(r => (r.ok ? r.json() : null))
    .then((d: { logoUrl?: string | null } | null) => {
      cachedUrl = d?.logoUrl ?? null;
      return cachedUrl;
    })
    .catch(() => null);
  return fetchPromise;
}

/** Invalidate the singleton so the next hook mount re-fetches (used after logo upload). */
export function invalidateSystemLogoCache() {
  cachedUrl     = null;
  fetchPromise  = null;
}

/**
 * One re-fetch shared by every mounted logo when an admin changes it (live
 * updates). Resolves undefined when the check failed, so the logo stays.
 */
let refreshPromise: Promise<string | null | undefined> | null = null;
function refreshLogoUrl(): Promise<string | null | undefined> {
  if (!refreshPromise) {
    refreshPromise = fetch('/api/settings/logo', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { logoUrl?: string | null } | null) => {
        cachedUrl = d?.logoUrl ?? null;
        fetchPromise = Promise.resolve(cachedUrl);
        return cachedUrl;
      })
      .catch(() => undefined)
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

export function useSystemLogo(): string | null {
  // Always start null so SSR HTML and the first client render match.
  // Reading module-level cachedUrl here caused hydration mismatches after
  // client navigations / HMR left the singleton warm while the server stayed cold.
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (cachedUrl !== null) {
      setLogoUrl(cachedUrl);
    } else {
      // Subscribe to the shared promise — only one network request fires
      getLogoUrl().then(url => setLogoUrl(url));
    }

    function onLogoChange(e: Event) {
      const next = (e as CustomEvent<{ logoUrl: string | null }>).detail.logoUrl;
      // Saved logo URLs already carry their upload time (?t=…) — keep it, so
      // the live-update re-fetch sees the same URL and doesn't reload the image
      const withBust = next ? (/[?&]t=/.test(next) ? next : `${next.split('?')[0]}?t=${Date.now()}`) : null;
      cachedUrl    = withBust;
      fetchPromise = Promise.resolve(withBust);
      setLogoUrl(withBust);
    }

    window.addEventListener('system-logo-changed', onLogoChange);
    return () => window.removeEventListener('system-logo-changed', onLogoChange);
  }, []);

  // Another admin changed the logo. The saved URL changes with every upload,
  // so an unchanged URL leaves the image as it is.
  useRealtime(['settings'], () => refreshLogoUrl().then(url => { if (url !== undefined) setLogoUrl(url); }));

  return logoUrl;
}
