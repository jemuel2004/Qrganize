'use client';

import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Loader2, WifiOff } from 'lucide-react';
import { REALTIME_TOPICS, changedTopics, type RealtimeTopic, type RealtimeVersions } from '@shared/realtime';

/**
 * Real-time sync — one light check per tab (contract: packages/shared/src/realtime.ts).
 *
 * The tab asks the API which areas of data changed (version numbers only) and
 * tells the pages listening to those areas to re-fetch quietly through their
 * usual API calls. Checks pause while the tab is hidden, slow down while
 * nobody is using it, and back off while the server can't be reached.
 * Versions are cumulative, so the first check after any gap catches up.
 */

const ACTIVE_MS = 4_000;            // visible and in use
const IDLE_MS = 15_000;             // visible but untouched for IDLE_AFTER_MS
const IDLE_AFTER_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** On the first check, areas changed this recently may be newer than what the page just loaded. */
const CATCH_UP_US = 5_000_000;

type Listener = (changed: ReadonlySet<RealtimeTopic>) => void;

/** Read fresh each time — the browser flips it as the connection comes and goes. */
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
export type RealtimeStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'off';

interface RealtimeCtx {
  subscribe: (listener: Listener) => () => void;
  status: RealtimeStatus;
}

const RealtimeContext = createContext<RealtimeCtx>({ subscribe: () => () => {}, status: 'off' });

// Starts the first check before pages send their first requests (layout
// effects run before effects), so a page is never older than the first versions.
const useStartEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  useStartEffect(() => {
    let known: RealtimeVersions | null = null;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;
    let stopped = false;
    let lastCheck = 0;
    let lastActivity = Date.now();
    const startedAt = Date.now();

    const emit = (topics: readonly RealtimeTopic[]) => {
      if (topics.length === 0) return;
      const changed = new Set(topics);
      for (const listener of [...listeners.current]) {
        try { listener(changed); } catch (err) { console.warn('[realtime] refresh failed to start:', err); }
      }
    };

    const nextDelay = () => {
      if (failures > 0) return Math.min(MAX_BACKOFF_MS, ACTIVE_MS * 2 ** failures);
      return Date.now() - lastActivity < IDLE_AFTER_MS ? ACTIVE_MS : IDLE_MS;
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (stopped || document.hidden) return; // visibility brings it back
      timer = setTimeout(() => { void check(); }, nextDelay());
    };

    async function check() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (stopped || document.hidden || inFlight) return;
      if (isOffline()) {
        setStatus('offline');
        return; // the 'online' event resumes checks
      }
      lastCheck = Date.now();
      const ctrl = new AbortController();
      inFlight = ctrl;
      const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch('/api/realtime/versions', { cache: 'no-store', signal: ctrl.signal });
        if (res.status === 401) {
          stopped = true; // signed out — pages handle that on their own requests
          setStatus('off');
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { v?: RealtimeVersions; now?: number };
        const v = data.v ?? {};
        if (known) {
          emit(changedTopics(known, v));
        } else if (failures > 0 || Date.now() - startedAt > ACTIVE_MS) {
          // First answer came late (hidden tab, slow start, server unreachable):
          // what the pages loaded may be older — refresh everything once.
          emit(REALTIME_TOPICS.filter(t => t in v));
        } else if (typeof data.now === 'number') {
          const now = data.now;
          emit(REALTIME_TOPICS.filter(t => (v[t] ?? 0) > 0 && now - (v[t] ?? 0) < CATCH_UP_US));
        }
        known = v;
        failures = 0;
        setStatus('live');
      } catch {
        if (stopped) return;
        failures++;
        if (failures >= 2) setStatus(isOffline() ? 'offline' : 'reconnecting');
      } finally {
        clearTimeout(timeout);
        if (inFlight === ctrl) inFlight = null;
        schedule();
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        timer = null;
      } else if (Date.now() - lastCheck > 1_000) {
        void check();
      } else {
        schedule();
      }
    };
    const onFocus = () => { if (Date.now() - lastCheck > 2_000) void check(); };
    const onOnline = () => { failures = 0; void check(); };
    const onOffline = () => setStatus('offline');
    const onActivity = () => {
      const wasIdle = Date.now() - lastActivity >= IDLE_AFTER_MS;
      lastActivity = Date.now();
      if (wasIdle && Date.now() - lastCheck > ACTIVE_MS) void check();
    };

    const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    for (const e of ACTIVITY) window.addEventListener(e, onActivity, { passive: true });

    void check();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      inFlight?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      for (const e of ACTIVITY) window.removeEventListener(e, onActivity);
    };
  }, []);

  const value = useMemo(() => ({ subscribe, status }), [subscribe, status]);

  return (
    <RealtimeContext.Provider value={value}>
      {children}
      <RealtimeStatusPill status={status} />
    </RealtimeContext.Provider>
  );
}

/** Connection state of the live updates ('off' when signed out or outside a shell). */
export function useRealtimeStatus(): RealtimeStatus {
  return useContext(RealtimeContext).status;
}

/**
 * Re-runs `refresh` whenever one of `topics` changes anywhere in the system.
 *
 * `refresh` must reload quietly — no skeletons, no reset filters, scroll,
 * selection or open dialogs. Runs never overlap: a change that arrives during
 * a refresh runs it once more afterwards. While `enabled` is false (e.g. the
 * first load is still running) changes are held and run once it turns true.
 */
export function useRealtime(
  topics: readonly RealtimeTopic[],
  refresh: () => unknown,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  const { subscribe } = useContext(RealtimeContext);
  const refreshRef = useRef(refresh);
  const enabledRef = useRef(enabled);
  const state = useRef({ running: false, pending: false, alive: true });

  useEffect(() => { refreshRef.current = refresh; });

  const run = useCallback(async () => {
    const s = state.current;
    if (s.running) { s.pending = true; return; }
    s.running = true;
    try {
      do {
        s.pending = false;
        try { await refreshRef.current(); } catch { /* keep what is on screen */ }
      } while (s.pending && s.alive && enabledRef.current);
    } finally {
      s.running = false;
    }
  }, []);

  const key = [...topics].sort().join(' ');
  useEffect(() => {
    const wanted = new Set(key.split(' '));
    return subscribe(changed => {
      for (const t of changed) {
        if (!wanted.has(t)) continue;
        if (enabledRef.current) void run();
        else state.current.pending = true;
        return;
      }
    });
  }, [key, subscribe, run]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled && state.current.pending && !state.current.running) void run();
  }, [enabled, run]);

  useEffect(() => {
    const s = state.current;
    s.alive = true;
    return () => { s.alive = false; };
  }, []);
}

/** Shown only while live updates are interrupted; hides itself once they resume. */
function RealtimeStatusPill({ status }: { status: RealtimeStatus }) {
  const reduce = useReducedMotion();
  const show = status === 'reconnecting' || status === 'offline';
  return (
    <div className="fixed inset-x-0 bottom-4 z-[9990] flex justify-center px-4 pointer-events-none no-print">
      <AnimatePresence>
        {show && (
          <motion.div
            key="realtime-status"
            role="status"
            aria-live="polite"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="inline-flex items-center gap-2 rounded-full border border-[#D6E0F0] bg-white px-4 py-2 text-sm font-semibold text-[#0B2A5B] shadow-md"
          >
            {status === 'offline'
              ? <><WifiOff className="w-4 h-4 text-[#475569]" aria-hidden />You&apos;re offline</>
              : <><Loader2 className="w-4 h-4 text-[#1E4FB8] animate-spin" aria-hidden />Reconnecting…</>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
