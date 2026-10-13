'use client';

/**
 * "Generating Excel… 1% → 100%" — one progress card for every download / print
 * that takes a moment. Wrap the work in runExport(); <ExportProgressHost /> (in
 * the Admin and Faculty shells) shows a card over a soft dim that counts up while
 * it runs and reaches 100% when the file is ready, then steps aside.
 *
 * The count moves on its own (fast at first, slower near the end) and never
 * runs ahead of the real work: it waits below 100 until the work is done. A
 * task that knows how far it is (e.g. the Summary, faculty by faculty) passes
 * that through `report(fraction)` and the count follows it.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

export type ExportKind = 'excel' | 'print';

interface Job {
  id: number;
  kind: ExportKind;
  title: string;
  detail?: string;
  /** Real progress reported by the task (0–1) */
  real: number;
  status: 'running' | 'done' | 'failed';
}

/* ── A tiny store the host listens to ── */
let job: Job | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const finishers = new Map<number, () => void>();
const emit = () => listeners.forEach(l => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getJob = () => job;
const getServerJob = () => null;
let hostMounted = 0;

function update(id: number, patch: Partial<Job>) {
  if (!job || job.id !== id) return;
  job = { ...job, ...patch };
  emit();
}

/**
 * Runs `task` with the progress card showing. Resolves with the task's result
 * once the count has reached 100% (or rejects at once if the task fails).
 */
export async function runExport<T>(
  opts: { kind?: ExportKind; title?: string; detail?: string },
  task: (report: (fraction: number) => void) => Promise<T>,
): Promise<T> {
  const kind = opts.kind ?? 'excel';
  const id = nextId++;
  job = {
    id, kind, detail: opts.detail, real: 0, status: 'running',
    title: opts.title ?? (kind === 'excel' ? 'Generating Excel' : 'Preparing to print'),
  };
  emit();
  const report = (f: number) => {
    if (job?.id === id) update(id, { real: Math.max(job.real, Math.min(1, Math.max(0, f))) });
  };
  try {
    const result = await task(report);
    // The card counts the rest of the way to 100%, then lets the page carry on
    await new Promise<void>(resolve => {
      if (!hostMounted) { resolve(); return; }
      finishers.set(id, resolve);
      update(id, { status: 'done' });
      window.setTimeout(() => { finishers.delete(id); resolve(); }, 1500); // never hang
    });
    return result;
  } catch (e) {
    update(id, { status: 'failed' });
    throw e;
  } finally {
    if (job?.id === id) { job = null; emit(); }
  }
}

/** Mounted once per shell: shows the progress card for runExport() calls */
export function ExportProgressHost() {
  const current = useSyncExternalStore(subscribe, getJob, getServerJob);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    hostMounted++;
    return () => { hostMounted--; };
  }, []);
  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {current && current.status !== 'failed' && <ProgressCard key={current.id} job={current} />}
    </AnimatePresence>,
    document.body,
  );
}

const TONE: Record<ExportKind, { ring: string; track: string; darkTrack: string }> = {
  excel: { ring: '#107C41', track: '#DDEFE4', darkTrack: '[html:not(.light)_&]:stroke-[#1B3A2B]' },
  print: { ring: '#1D5BD6', track: '#DCE7FB', darkTrack: '[html:not(.light)_&]:stroke-[#1E335C]' },
};

function ProgressCard({ job: j }: { job: Job }) {
  const reduceMotion = useReducedMotion();
  const [shown, setShown] = useState(1);
  const pct = useRef(1);
  const doneRef = useRef(false);

  useEffect(() => {
    // Counts on its own toward 95 while the work runs; follows real progress when given
    const t = window.setInterval(() => {
      const cur = getJob();
      if (!cur || cur.id !== j.id) return;
      let p = pct.current;
      if (cur.status === 'done') {
        p = Math.min(100, p + Math.max(3, (100 - p) * 0.25)); // a quick finish, still counting
      } else {
        p = Math.max(p + Math.max(0.35, (95 - p) * 0.05), cur.real * 95);
        p = Math.min(p, 95);
      }
      pct.current = p;
      setShown(Math.max(1, Math.floor(p)));
      if (p >= 100 && !doneRef.current) {
        doneRef.current = true;
        window.setTimeout(() => { finishers.get(j.id)?.(); finishers.delete(j.id); }, 380);
      }
    }, 40);
    return () => window.clearInterval(t);
  }, [j.id]);

  const tone = TONE[j.kind];
  const R = 34;
  const C = 2 * Math.PI * R;
  const finished = shown >= 100;
  return (
    <motion.div
      className="fixed inset-0 z-[85] flex items-center justify-center save-success-overlay qr-overlay-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
      role="status"
      aria-live="polite"
    >
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, scale: 0.92, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
        className="flex flex-col items-center gap-3 w-[min(300px,calc(100vw-2rem))] px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-xl"
      >
        <div
          className="relative w-[88px] h-[88px]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shown}
          aria-label={`${j.title}: ${shown}%`}
        >
          <svg width="88" height="88" viewBox="0 0 88 88" aria-hidden className="-rotate-90">
            <circle cx="44" cy="44" r={R} fill="none" stroke={tone.track} strokeWidth="7" className={tone.darkTrack} />
            <circle
              cx="44" cy="44" r={R} fill="none" stroke={tone.ring} strokeWidth="7" strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={C * (1 - shown / 100)}
              style={{ transition: 'stroke-dashoffset 120ms linear' }}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[22px] font-bold tabular-nums text-[#0B2A5B]">
            {shown}%
          </span>
        </div>
        <div className="text-center">
          <p className="text-base font-semibold text-[#0B2A5B]">
            {finished ? (j.kind === 'excel' ? 'Excel ready' : 'Ready to print') : `${j.title}…`}
          </p>
          {j.detail && <p className="mt-0.5 text-sm text-[#475569]">{j.detail}</p>}
        </div>
      </motion.div>
    </motion.div>
  );
}
