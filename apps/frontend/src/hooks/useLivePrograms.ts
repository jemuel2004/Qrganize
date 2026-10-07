'use client';

import { useRealtime } from '@/context/RealtimeContext';

/**
 * Keeps a page's program list current: when a program is added, renamed or
 * removed anywhere, the list is read again quietly (filters stay as they are).
 */
export function useLivePrograms<T>(setPrograms: (list: T[]) => void): void {
  useRealtime(['programs'], async () => {
    const res = await fetch('/api/programs', { cache: 'no-store' });
    if (!res.ok) return; // keep what is on screen
    const d = (await res.json().catch(() => null)) as { programs?: T[] } | null;
    if (Array.isArray(d?.programs)) setPrograms(d.programs);
  });
}
