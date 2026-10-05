'use client';

import { useCallback, useState } from 'react';
import { useNotifications } from '@/context/NotificationContext';

/**
 * The Refresh button's reload: everything on the page loads again behind the
 * page's skeleton (feed `refreshing` into its showSkeleton) and the bell in
 * the top bar reloads too. Live and timed updates keep using the page's quiet
 * loader, so they never flash the skeleton.
 *
 * `reload` may resolve to false when it failed — the button then skips its
 * "Updated" tick.
 */
export function useSkeletonRefresh(reload: () => unknown) {
  const { refresh: refreshBell } = useNotifications();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    refreshBell();
    try {
      return (await reload()) !== false;
    } catch {
      return false;
    } finally {
      setRefreshing(false);
    }
  }, [reload, refreshBell]);
  return { refreshing, refresh };
}
