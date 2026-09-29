'use client';

import { useEffect, useState } from 'react';

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
      const withBust = next ? `${next.split('?')[0]}?t=${Date.now()}` : null;
      cachedUrl    = withBust;
      fetchPromise = Promise.resolve(withBust);
      setLogoUrl(withBust);
    }

    window.addEventListener('system-logo-changed', onLogoChange);
    return () => window.removeEventListener('system-logo-changed', onLogoChange);
  }, []);

  return logoUrl;
}
