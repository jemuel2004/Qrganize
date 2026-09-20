'use client';

import { useEffect } from 'react';
import { useSystemLogo } from '@/client/hooks/useSystemLogo';

/**
 * Mounts in the root layout and keeps the browser favicon in sync with the
 * system logo stored in the database. Falls back to the default favicon when
 * no custom logo is set. Renders nothing visible.
 */
export default function FaviconUpdater() {
  const logoUrl = useSystemLogo();

  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = logoUrl ?? '/favicon.ico';
  }, [logoUrl]);

  return null;
}
