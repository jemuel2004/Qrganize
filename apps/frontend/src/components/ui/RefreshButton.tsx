'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, RefreshCw } from 'lucide-react';

const EASE = [0.45, 0, 0.55, 1] as const;
const WHITE = { color: '#FFFFFF' } as const;
const MIN_SPIN_MS = 700; // keep the spinner visible long enough to register

/**
 * Refresh button: spinner while loading → brief "Updated ✓".
 * `loading` is the page's own flag — the button finishes once it turns false.
 */
export function RefreshButton({ onRefresh, loading, className = '', overlay = true }: {
  /** A promise that resolves to false (the refresh failed) skips the "Updated" tick */
  onRefresh: () => unknown;
  loading: boolean;
  className?: string;
  /** Centred "Refreshing…" card over the page — off for pages that show skeletons instead */
  overlay?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState<'idle' | 'spinning' | 'done'>('idle');
  const startedAt = useRef(0);
  const failed = useRef(false);
  const [mounted, setMounted] = useState(false); // portal only after hydration
  useEffect(() => { setMounted(true); }, []);

  // Finish once the load is over AND the minimum spin time has passed
  useEffect(() => {
    if (phase !== 'spinning' || loading) return;
    const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - startedAt.current));
    const t1 = window.setTimeout(() => setPhase(failed.current ? 'idle' : 'done'), wait);
    return () => window.clearTimeout(t1);
  }, [phase, loading]);
  useEffect(() => {
    if (phase !== 'done') return;
    const t = window.setTimeout(() => setPhase('idle'), 1200);
    return () => window.clearTimeout(t);
  }, [phase]);

  const busy = phase === 'spinning';

  function start() {
    if (busy) return;
    startedAt.current = Date.now();
    failed.current = false;
    setPhase('spinning');
    Promise.resolve(onRefresh()).then(
      result => { if (result === false) failed.current = true; },
      () => { failed.current = true; },
    );
  }

  return (
    <>
    {/* Centred loading card while refreshing (same look as Scheduling's "Going back…") */}
    {overlay && mounted && createPortal(
      <AnimatePresence>
        {busy && (
          <motion.div
            key="refresh-overlay"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.25, ease: EASE } }}
            exit={{ opacity: 0, transition: { duration: 0.25, ease: EASE } }}
            className="fixed inset-x-0 bottom-0 top-[72px] z-30 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(11, 42, 91, 0.08)' }}
            role="status"
            aria-live="polite"
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, scale: 0.94, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.3, ease: EASE } }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
              className="flex items-center gap-3 px-5 py-3.5 rounded-2xl bg-white border border-[#E2E8F0] shadow-[0_12px_32px_-12px_rgba(11,42,91,0.35)]"
            >
              <div className="w-6 h-6 border-[3px] border-[#DBE5F4] border-t-[#1D5BD6] rounded-full animate-spin" aria-hidden="true" />
              <p className="text-sm font-semibold text-[#0B2A5B]">Refreshing…</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>,
      document.body,
    )}
    <motion.button
      type="button"
      onClick={start}
      disabled={busy}
      aria-busy={busy}
      whileHover={reduceMotion || busy ? undefined : { y: -1 }}
      whileTap={reduceMotion || busy ? undefined : { scale: 0.96 }}
      className={`group h-[42px] inline-flex items-center justify-center gap-2 px-5 rounded-xl text-sm font-semibold transition-colors duration-300 disabled:cursor-wait ${
        phase === 'done' ? 'bg-emerald-600' : 'bg-[#1D5BD6] hover:bg-[#164BB5]'
      } shadow-[0_10px_22px_-12px_rgba(29,91,214,0.9)] ${className}`}
      style={WHITE}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={phase}
          initial={reduceMotion ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE } }}
          exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
          className="inline-flex items-center gap-2"
        >
          {phase === 'done'
            ? <><Check className="w-4 h-4" style={WHITE} /> Updated</>
            : <>
                <RefreshCw
                  className={`w-4 h-4 ${busy ? 'animate-spin' : 'transition-transform duration-500 group-hover:rotate-180'}`}
                  style={WHITE}
                />
                {busy ? 'Refreshing…' : 'Refresh'}
              </>}
        </motion.span>
      </AnimatePresence>
    </motion.button>
    </>
  );
}
