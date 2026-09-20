'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Live countdown derived from an absolute deadline so re-renders / accordion
 * toggles do not duplicate or accelerate the timer.
 */
export function useLiveCountdown() {
  const [deadlineMs, setDeadlineMs] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);

  const start = useCallback((secs: number) => {
    const n = Math.ceil(Number(secs));
    if (!Number.isFinite(n) || n <= 0) {
      setDeadlineMs(null);
      setSeconds(0);
      return;
    }
    setDeadlineMs(Date.now() + n * 1000);
    setSeconds(n);
  }, []);

  const clear = useCallback(() => {
    setDeadlineMs(null);
    setSeconds(0);
  }, []);

  useEffect(() => {
    if (deadlineMs == null) return;

    const tick = () => {
      const rem = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setSeconds(rem);
      if (rem <= 0) setDeadlineMs(null);
    };

    tick();
    const id = window.setInterval(tick, 1_000);
    return () => window.clearInterval(id);
  }, [deadlineMs]);

  return { seconds, active: seconds > 0, start, clear };
}
