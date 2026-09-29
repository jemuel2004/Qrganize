'use client';

import { useEffect, useRef, useState } from 'react';

/** Global UI-only skeleton duration (ms). Does not delay network fetches. */
export const LOADING_DELAY = 1500;

/** @deprecated Prefer LOADING_DELAY — kept so existing imports keep working. */
export const PAGE_SKELETON_MIN_MS = LOADING_DELAY;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Keep a loading placeholder visible until `busy` is false AND `minMs` has
 * elapsed. Fetching continues independently — this never sleeps the network.
 * Reduced-motion users skip the minimum wait.
 */
export function useMinLoading(busy: boolean, minMs: number = LOADING_DELAY): boolean {
  const [visible, setVisible] = useState(busy);
  const startedAt = useRef<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const min = prefersReducedMotion() ? 0 : minMs;

    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }

    if (busy) {
      if (startedAt.current == null) startedAt.current = Date.now();
      setVisible(true);
      return;
    }

    const elapsed = startedAt.current == null ? min : Date.now() - startedAt.current;
    const wait = Math.max(0, min - elapsed);

    hideTimer.current = setTimeout(() => {
      setVisible(false);
      startedAt.current = null;
      hideTimer.current = null;
    }, wait);

    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [busy, minMs]);

  return visible;
}

/** Alias for the shared delayed-loading hook (same implementation). */
export const useDelayedLoading = useMinLoading;
