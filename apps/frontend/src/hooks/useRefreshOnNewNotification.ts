'use client';

import { useEffect, useRef } from 'react';
import { useNotifications } from '@/context/NotificationContext';

/**
 * Re-load a page's data as soon as a new notification arrives — e.g. a subject
 * newly assigned to the faculty — instead of waiting for the page's own polling.
 * The first load is ignored; only notifications that appear afterwards trigger it.
 */
export function useRefreshOnNewNotification(refresh: () => void): void {
  const { notifications, isInitialLoad } = useNotifications();
  const newestId = notifications.reduce((max, n) => Math.max(max, n.id), 0);
  const seen = useRef<number | null>(null);
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);

  useEffect(() => {
    if (isInitialLoad) return;
    if (seen.current === null) { seen.current = newestId; return; }
    if (newestId > seen.current) {
      seen.current = newestId;
      refreshRef.current();
    }
  }, [newestId, isInitialLoad]);
}
