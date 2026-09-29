'use client';

import { useEffect, useRef } from 'react';

/**
 * Drop-in replacement for setInterval that automatically pauses when the
 * browser tab is hidden (Page Visibility API) and resumes — firing the
 * callback immediately on resume — when the tab becomes visible again.
 *
 * Why this matters for performance:
 *   A laptop with QRganize open in a background tab was still executing
 *   ~8 concurrent polling intervals (notifications, dashboard, room
 *   utilization, workload, sidebar badges…) every 15–60 seconds.  With
 *   this hook all those intervals go completely silent the moment the
 *   user switches to another tab, eliminating the background CPU load
 *   and the associated heat / fan noise.
 *
 * Usage — replace:
 *   setInterval(() => doWork(), POLL_MS);
 * with:
 *   useVisibilityAwareInterval(() => doWork(), POLL_MS);
 */
export function useVisibilityAwareInterval(
  callback: () => void,
  delay: number,
): void {
  // Keep a stable ref so we can always call the latest callback without
  // re-creating the effect (and re-registering the visibilitychange listener)
  // on every render.
  const savedCb = useRef(callback);
  useEffect(() => { savedCb.current = callback; }, [callback]);

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (id !== null) return;
      id = setInterval(() => {
        try {
          const result = savedCb.current() as unknown;
          if (result != null && typeof (result as Promise<unknown>).then === 'function') {
            (result as Promise<unknown>).catch(err => {
              console.warn('[useVisibilityAwareInterval] poll failed:', err instanceof Error ? err.message : err);
            });
          }
        } catch (err) {
          console.warn('[useVisibilityAwareInterval] poll threw:', err instanceof Error ? err.message : err);
        }
      }, delay);
    }

    function stop() {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    }

    function onVisibility() {
      if (document.hidden) {
        stop();
      } else {
        // Tab just became visible — refresh once, then resume cadence.
        // Wrap so a network failure in the callback cannot surface as an
        // unhandled rejection / Next.js runtime overlay.
        try {
          const result = savedCb.current() as unknown;
          if (result != null && typeof (result as Promise<unknown>).then === 'function') {
            (result as Promise<unknown>).catch(err => {
              console.warn('[useVisibilityAwareInterval] refresh failed:', err instanceof Error ? err.message : err);
            });
          }
        } catch (err) {
          console.warn('[useVisibilityAwareInterval] refresh threw:', err instanceof Error ? err.message : err);
        }
        start();
      }
    }

    // Only start ticking if the tab is currently visible.
    if (!document.hidden) start();

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [delay]);
}
