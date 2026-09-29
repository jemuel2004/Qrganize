'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { resetScrollLocks } from '@/hooks/useScrollLock';

/**
 * Resets any body styles that a modal or overlay may have set (overflow, pointer-events)
 * whenever the user navigates to a new route. Acts as a catch-all safety net so that
 * navigating away from a page with an open modal never leaves the body locked.
 */
export default function BodyResetEffect() {
  const pathname = usePathname();

  useEffect(() => {
    resetScrollLocks();
    document.body.style.pointerEvents = '';
  }, [pathname]);

  return null;
}
