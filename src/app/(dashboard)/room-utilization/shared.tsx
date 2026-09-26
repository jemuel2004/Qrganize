'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BookOpen, CalendarDays, Check, ChevronDown, Monitor, RefreshCw } from 'lucide-react';
import { useVisibilityAwareInterval } from '@/client/hooks/useVisibilityAwareInterval';

/* ─── Types (mirror /api/rooms/utilization) ─────────────────────────────── */

export type View = 'daily' | 'weekly' | 'monthly';
export type RowStatus = 'Occupied' | 'Completed' | 'Pending' | 'Not Checked' | 'Upcoming' | 'Walk-in';
/** A room's status for the selected day / period */
export type RoomStatus = 'Occupied' | 'Available' | 'Pending' | 'No Scan';

export interface UtilRoom {
  id: number; room_name: string; room_type: string; building: string | null; capacity: number | null;
  live_status: 'Available' | 'Pending' | 'Occupied'; live_faculty: string | null;
}
export interface UtilRow {
  key: string; date: string; day: string; room_id: number; room_name: string; room_type: string;
  subject_code: string | null; subject_name: string | null; component: string | null; block: string | null;
  faculty_id: number | null; faculty_name: string | null; start: string | null; end: string | null;
  scan_time: string | null; late: boolean; status: RowStatus; hours_scheduled: number; hours_used: number;
}
export interface ScanLog {
  id: number; scan_date: string; scan_hm: string; status: string; notes: string | null;
  scheduled_start: string | null; scheduled_end: string | null; faculty_name: string | null;
}
export interface UtilData {
  today: string; now: string; date: string; view: View; range: { start: string; end: string };
  /** Next day after the range that has scheduled classes */
  next_class_date: string | null;
  term: { semester: string | null; school_year: string | null };
  rooms: UtilRoom[]; activity: UtilRow[]; logs: ScanLog[];
}

export const EASE = [0.45, 0, 0.55, 1] as const;
export const WHITE = { color: '#FFFFFF' } as const;

/* ─── Data ──────────────────────────────────────────────────────────────── */

export function useUtilization(date: string, view: View, roomId?: number) {
  const [data, setData] = useState<UtilData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ctrl = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    const qs = new URLSearchParams({ view, ...(date ? { date } : {}), ...(roomId ? { room_id: String(roomId) } : {}) });
    fetch(`/api/rooms/utilization?${qs}`, { signal: c.signal })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Failed to load room utilization.');
        setData(d);
        setError('');
      })
      .catch(e => { if (!c.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to load.'); })
      .finally(() => { if (!c.signal.aborted) setLoading(false); });
  }, [date, view, roomId]);

  useEffect(() => { load(); return () => ctrl.current?.abort(); }, [load]);
  // Live data only changes for ranges that include today
  useVisibilityAwareInterval(() => {
    if (data && data.range.start <= data.today && data.range.end >= data.today) load();
  }, 60_000);

  return { data, loading, error, reload: load };
}

/** Room status for the period: live status on "today, daily"; otherwise what happened. */
export function roomStatusFor(room: UtilRoom, rows: UtilRow[], liveDay: boolean): RoomStatus {
  const mine = rows.filter(r => r.room_id === room.id);
  if (liveDay) {
    if (room.live_status === 'Occupied' || mine.some(r => r.status === 'Occupied')) return 'Occupied';
    if (room.live_status === 'Pending' || mine.some(r => r.status === 'Pending')) return 'Pending';
    if (mine.some(r => r.status === 'Not Checked')) return 'No Scan';
    return 'Available';
  }
  if (mine.some(r => r.status === 'Completed' || r.status === 'Occupied' || r.status === 'Walk-in')) return 'Occupied';
  if (mine.some(r => r.status === 'Not Checked')) return 'No Scan';
  return 'Available';
}

/* ─── Formatting ────────────────────────────────────────────────────────── */

export function fmt12(hm: string | null) {
  if (!hm) return '—';
  const [h, m] = hm.split(':').map(Number);
  if (Number.isNaN(h)) return '—';
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
export function fmtDate(s: string, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}
export function rangeLabel(view: View, date: string, range: { start: string; end: string }) {
  if (view === 'weekly') return `${fmtDate(range.start, { month: 'short', day: 'numeric' })} – ${fmtDate(range.end)}`;
  if (view === 'monthly') return fmtDate(date, { month: 'long', year: 'numeric' });
  return fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
export const hrs = (n: number) => `${Math.round(n * 10) / 10} hr${Math.round(n * 10) / 10 === 1 ? '' : 's'}`;

/* ─── Pills / icons (system colours: Lecture blue book, Laboratory amber monitor) ── */

export function RoomIcon({ type, className }: { type: string; className?: string }) {
  return type === 'Laboratory' || type === 'Computer Lab' ? <Monitor className={className} /> : <BookOpen className={className} />;
}

export function TypePill({ type }: { type: string }) {
  const lab = type === 'Laboratory' || type === 'Computer Lab';
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${
      lab ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]'
    }`}>
      <RoomIcon type={type} className="w-3 h-3" /> {type}
    </span>
  );
}

const ROW_TONE: Record<RowStatus, string> = {
  Occupied: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Completed: 'bg-[#EFF6FF] text-[#164BB5] border-[#BFD3F5]',
  Pending: 'bg-amber-50 text-amber-700 border-amber-200',
  'Not Checked': 'bg-red-50 text-red-600 border-red-200',
  Upcoming: 'bg-[#F1F5F9] text-[#64748B] border-[#E2E8F0]',
  'Walk-in': 'bg-[#EEF0FE] text-[#4338CA] border-[#C7CBFA]',
};
export function RowStatusPill({ status }: { status: RowStatus }) {
  return (
    <span className={`inline-flex items-center text-[11px] font-semibold px-2.5 py-0.5 rounded-full border whitespace-nowrap ${ROW_TONE[status]}`}>
      {status === 'Completed' ? 'Used' : status}
    </span>
  );
}

export const ROOM_TONE: Record<RoomStatus, { bar: string; soft: string; text: string }> = {
  Occupied: { bar: '#10B981', soft: '#ECFDF5', text: '#047857' },
  Available: { bar: '#1D5BD6', soft: '#EFF6FF', text: '#1D5BD6' },
  Pending: { bar: '#F59E0B', soft: '#FFFBEB', text: '#B45309' },
  'No Scan': { bar: '#94A3B8', soft: '#F1F5F9', text: '#64748B' },
};

/* ─── Date button (opens the centred calendar) ──────────────────────────── */

export function DateButton({ label, onClick }: { label: string; onClick: () => void }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
      className="w-full h-[42px] inline-flex items-center gap-2.5 px-3.5 rounded-xl border border-[#D6E0EF] bg-white text-sm font-semibold text-[#0B2A5B] hover:border-[#9DB8E8] transition-colors"
    >
      <CalendarDays className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
      <span className="flex-1 text-left truncate">{label}</span>
      <ChevronDown className="w-4 h-4 text-[#64748B] flex-shrink-0" />
    </motion.button>
  );
}

/** Height that glides to fit content */
export function AutoHeight({ children }: { children: React.ReactNode }) {
  const reduceMotion = useReducedMotion();
  const inner = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | 'auto'>('auto');
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div initial={false} animate={{ height: h }} transition={reduceMotion ? { duration: 0 } : { duration: 0.45, ease: EASE }} className="overflow-hidden">
      <div ref={inner}>{children}</div>
    </motion.div>
  );
}

/** Calendar Apply: spinner until the new date has loaded (min ~0.7s), then the
 *  success ✓ plays (~1.3s, same as Curriculum / Faculty), then `onDone`. */
export function useApplyingDate(loading: boolean, onDone: () => void) {
  const [applying, setApplying] = useState(false);
  const [success, setSuccess] = useState(false);
  const startedAt = useRef(0);
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; }, [onDone]);
  useEffect(() => {
    if (!applying || loading) return;
    const wait = Math.max(0, 700 - (Date.now() - startedAt.current));
    const t = window.setTimeout(() => { setApplying(false); setSuccess(true); }, wait);
    return () => window.clearTimeout(t);
  }, [applying, loading]);
  useEffect(() => {
    if (!success) return;
    const t = window.setTimeout(() => { setSuccess(false); done.current(); }, 1300);
    return () => window.clearTimeout(t);
  }, [success]);
  const start = () => { startedAt.current = Date.now(); setApplying(true); };
  return [applying, start, success] as const;
}

/* ─── Refresh button: spinner while loading → brief "Updated ✓" ─────────── */

const MIN_SPIN_MS = 700; // keep the spinner visible long enough to register

export function RefreshButton({ onRefresh, loading, className = '' }: {
  onRefresh: () => void; loading: boolean; className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState<'idle' | 'spinning' | 'done'>('idle');
  const startedAt = useRef(0);
  const [mounted, setMounted] = useState(false); // portal only after hydration
  useEffect(() => { setMounted(true); }, []);

  // Finish once the load is over AND the minimum spin time has passed
  useEffect(() => {
    if (phase !== 'spinning' || loading) return;
    const wait = Math.max(0, MIN_SPIN_MS - (Date.now() - startedAt.current));
    const t1 = window.setTimeout(() => setPhase('done'), wait);
    return () => window.clearTimeout(t1);
  }, [phase, loading]);
  useEffect(() => {
    if (phase !== 'done') return;
    const t = window.setTimeout(() => setPhase('idle'), 1200);
    return () => window.clearTimeout(t);
  }, [phase]);

  const busy = phase === 'spinning';
  return (
    <>
    {/* Centred loading card while refreshing (same look as Scheduling's "Going back…") */}
    {mounted && createPortal(
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
      onClick={() => { if (busy) return; startedAt.current = Date.now(); setPhase('spinning'); onRefresh(); }}
      disabled={busy}
      aria-busy={busy}
      whileTap={reduceMotion || busy ? undefined : { scale: 0.97 }}
      className={`h-[42px] inline-flex items-center justify-center gap-2 px-5 rounded-xl text-sm font-semibold transition-colors duration-300 disabled:cursor-wait ${
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
            : <><RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} style={WHITE} /> {busy ? 'Refreshing…' : 'Refresh'}</>}
        </motion.span>
      </AnimatePresence>
    </motion.button>
    </>
  );
}

export { AnimatePresence, motion };
