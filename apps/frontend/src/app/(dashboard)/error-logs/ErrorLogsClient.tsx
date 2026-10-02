'use client';

/**
 * System → Error Logs — server errors, warnings and page crashes, each filed
 * under the module where it happened (Scheduling, Workload, Rooms…) with the
 * exact place in the code, the route, who hit it, how often and when.
 * Repeats of one error are grouped; resolving an entry closes it until the
 * error happens again.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertOctagon, AlertTriangle, BookOpen, Briefcase, CalendarClock, CheckCircle2, ChevronDown, ChevronRight,
  Clock, Copy, Database, DoorOpen, FileText, GraduationCap, KeyRound, LayoutDashboard, Loader2, MapPin,
  Repeat, Search, Settings2, User, UserCog, Bell, X,
} from 'lucide-react';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import Modal from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/skeletons';
import { useRealtime } from '@/context/RealtimeContext';
import { useToast } from '@/context/ToastContext';
import { ERROR_MODULES, type ErrorModule } from '@shared/errorLog';

/* ─── Types & constants ─────────────────────────────────────────── */
interface ErrorEntry {
  id: string;
  level: 'error' | 'warning';
  module: string;
  source: string;
  message: string;
  method: string | null;
  path: string | null;
  actor_name: string | null;
  actor_role: string | null;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
  resolved_by: string | null;
}
interface Counts { open: number; resolved: number; modules: Record<string, { open: number; resolved: number }> }
type Status = 'open' | 'resolved' | 'all';

const EASE = [0.4, 0, 0.2, 1] as const;
const PAGE_SIZE = 40;
const WHITE = { color: '#FFFFFF' } as const;

const STATUSES: { id: Status; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

const MODULE_ICON: Record<ErrorModule, React.ElementType> = {
  'Sign-in': KeyRound, Accounts: UserCog, Setup: BookOpen, Scheduling: CalendarClock, Workload: Briefcase,
  Rooms: DoorOpen, Notifications: Bell, 'Faculty portal': GraduationCap, Dashboard: LayoutDashboard,
  Reports: FileText, Database, System: Settings2,
};

const LEVEL = {
  error:   { label: 'Error',   icon: AlertOctagon,  color: '#DC2626', tint: '#FEF2F2', border: '#FECACA' },
  warning: { label: 'Warning', icon: AlertTriangle, color: '#B45309', tint: '#FFFBEB', border: '#FDE68A' },
} as const;

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin', department_chair: 'Department Chair', program_chair: 'Program Chair', instructor: 'Faculty',
};

const TZ = 'Asia/Manila';
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const fmtFull = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: TZ });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
function dayLabel(key: string) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const yest = new Date(Date.now() - 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
  if (key === today) return 'Today';
  if (key === yest) return 'Yesterday';
  return new Date(`${key}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
const where = (e: Pick<ErrorEntry, 'method' | 'path'>) =>
  e.path ? (e.method === 'PAGE' ? `Page ${e.path}` : `${e.method ? `${e.method} ` : ''}${e.path}`) : 'Background task';

/* ─── Page ───────────────────────────────────────────────────────── */
export default function ErrorLogsClient() {
  const reduceMotion = useReducedMotion();
  const toast = useToast();
  const [status, setStatus] = useState<Status>('open');
  const [moduleFilter, setModuleFilter] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [logs, setLogs] = useState<ErrorEntry[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<ErrorEntry | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [resolvingAll, setResolvingAll] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const filterQuery = useMemo(() => {
    const sp = new URLSearchParams({ status });
    if (moduleFilter) sp.set('module', moduleFilter);
    if (debouncedQ) sp.set('q', debouncedQ);
    return sp.toString();
  }, [status, moduleFilter, debouncedQ]);

  type Page = { logs: ErrorEntry[]; has_more: boolean; next_before: string | null; counts: Counts };
  const fetchPage = useCallback(async (extra: Record<string, string>, signal?: AbortSignal): Promise<Page> => {
    const sp = new URLSearchParams(filterQuery);
    for (const [k, v] of Object.entries(extra)) sp.set(k, v);
    const res = await fetch(`/api/error-logs?${sp}`, { signal, cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load the error log.');
    return data as Page;
  }, [filterQuery]);

  // First page for the current filters
  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError('');
    fetchPage({}, ctrl.signal)
      .then(d => { setLogs(d.logs); setHasMore(d.has_more); setNextBefore(d.next_before); setCounts(d.counts); })
      .catch(e => { if ((e as Error).name !== 'AbortError') setError((e as Error).message); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [fetchPage]);

  async function loadMore() {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const d = await fetchPage({ before: nextBefore });
      setLogs(prev => {
        const seen = new Set(prev.map(l => l.id));
        return [...prev, ...d.logs.filter(l => !seen.has(l.id))];
      });
      setHasMore(d.has_more);
      setNextBefore(d.next_before);
      setCounts(d.counts);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  /* Live updates: re-read every row already on screen (same filters, same
     amount), so new errors, repeats and other admins' fixes show up without
     a reload. The open entry follows its latest state. */
  const shownCount = useRef(PAGE_SIZE);
  useEffect(() => { shownCount.current = Math.max(PAGE_SIZE, logs.length); }, [logs.length]);
  const refresh = useCallback(async () => {
    try {
      const d = await fetchPage({ limit: String(Math.min(200, shownCount.current)) });
      setLogs(d.logs);
      setHasMore(d.has_more);
      setNextBefore(d.next_before);
      setCounts(d.counts);
      setPicked(prev => (prev ? d.logs.find(l => l.id === prev.id) ?? prev : prev));
    } catch { /* keep what is on screen */ }
  }, [fetchPage]);
  useRealtime(['errors'], refresh, { enabled: !loading && !loadingMore && !resolvingAll });

  async function resolveAll() {
    setResolvingAll(true);
    try {
      const res = await fetch('/api/error-logs', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve-all', module: moduleFilter || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || 'Could not update the error log.'); return; }
      toast.success(`${data.resolved} entr${data.resolved === 1 ? 'y' : 'ies'} marked as resolved.`);
      setConfirmAll(false);
      await refresh();
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setResolvingAll(false);
    }
  }

  const groups = useMemo(() => {
    const out: { key: string; items: ErrorEntry[] }[] = [];
    for (const l of logs) {
      const key = dayKey(l.last_seen);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(l);
      else out.push({ key, items: [l] });
    }
    return out;
  }, [logs]);

  const moduleCount = (m: string) => {
    const c = counts?.modules[m];
    if (!c) return 0;
    return status === 'open' ? c.open : status === 'resolved' ? c.resolved : c.open + c.resolved;
  };
  const statusCount = (s: Status) => (!counts ? null : s === 'open' ? counts.open : s === 'resolved' ? counts.resolved : counts.open + counts.resolved);
  const shownModules = ERROR_MODULES.filter(m => moduleCount(m) > 0 || m === moduleFilter);
  const openInView = moduleFilter ? (counts?.modules[moduleFilter]?.open ?? 0) : (counts?.open ?? 0);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto w-full min-w-0 space-y-5">
      <div>
        <BackButton />
        <div className="mt-4 sm:mt-7 mb-2"><WatermarkTitle>Error Logs</WatermarkTitle></div>
      </div>

      {/* ── Filters ── */}
      <section className="bg-white rounded-2xl border border-[#E3E9F3] p-4 sm:p-5 space-y-4 shadow-[0_8px_24px_-18px_rgba(11,42,91,0.35)]">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div role="tablist" aria-label="Status" className="flex gap-1 p-1 rounded-full bg-[#EAF0FA] border border-[#DCE5F3] self-stretch md:self-start">
            {STATUSES.map(s => {
              const on = s.id === status;
              const n = statusCount(s.id);
              return (
                <motion.button key={s.id} type="button" role="tab" aria-selected={on} onClick={() => setStatus(s.id)}
                  whileTap={reduceMotion ? undefined : { scale: 0.94 }}
                  className={`relative flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-3 sm:px-5 h-10 rounded-full text-[15px] font-semibold whitespace-nowrap transition-colors ${on ? '' : 'text-[#475569] hover:text-[#0B2A5B]'}`}
                  style={on ? WHITE : undefined}>
                  {on && <motion.span layoutId="error-status" className="absolute inset-0 rounded-full bg-[#0B2A5B] shadow-[0_4px_12px_-4px_rgba(11,42,91,0.5)]"
                    transition={{ duration: reduceMotion ? 0 : 0.35, ease: EASE }} />}
                  <span className="relative">{s.label}</span>
                  {n !== null && (
                    <span className="relative min-w-[24px] h-6 px-1.5 rounded-full text-xs font-bold inline-flex items-center justify-center"
                      style={on ? { backgroundColor: 'rgba(255,255,255,0.2)', color: '#FFFFFF' } : { backgroundColor: '#FFFFFF', color: '#1D5BD6' }}>
                      {n}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </div>
          <div className="relative flex-1 md:max-w-md md:ml-auto">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#94A3B8]" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search message, place, page or person…"
              className="w-full h-12 pl-12 pr-10 rounded-xl border border-[#D6E0EF] bg-white text-[15px] text-[#0B2A5B] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/25 focus:border-[#1D5BD6]" />
            {q && (
              <button type="button" onClick={() => setQ('')} aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-[#64748B] hover:bg-[#F1F5F9]">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Module chips — only modules that have entries */}
        {counts === null ? (
          <div className="flex flex-wrap gap-2" aria-hidden>
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-11 w-32 rounded-xl" />)}
          </div>
        ) : shownModules.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <ModuleChip on={!moduleFilter} onClick={() => setModuleFilter('')} label="All modules" icon={Settings2} />
            {shownModules.map(m => (
              <ModuleChip key={m} on={moduleFilter === m} onClick={() => setModuleFilter(moduleFilter === m ? '' : m)}
                label={m} icon={MODULE_ICON[m]} n={moduleCount(m)} />
            ))}
          </div>
        )}

        {status !== 'resolved' && openInView > 0 && (
          <div className="flex justify-end">
            <button type="button" onClick={() => setConfirmAll(true)}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-xl text-sm font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors">
              <CheckCircle2 className="w-4 h-4" /> Mark all {moduleFilter ? `${moduleFilter} ` : ''}as resolved
            </button>
          </div>
        )}
      </section>

      {/* ── List ── */}
      <section className="bg-white rounded-2xl border border-[#E3E9F3] overflow-hidden shadow-[0_8px_24px_-18px_rgba(11,42,91,0.35)]">
        {loading ? (
          <div role="status" aria-live="polite" aria-label="Loading the error log">
            <div className="px-5 py-2.5 bg-[#F6F9FE] border-b border-[#EEF2F7]">
              <Skeleton className="h-3.5 w-24 rounded" />
            </div>
            <div className="divide-y divide-[#EEF2F7]">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3.5">
                  <Skeleton className="w-11 h-11 rounded-xl flex-shrink-0" />
                  <div className="flex-1 min-w-0 space-y-2">
                    <Skeleton className={`h-4 rounded ${i % 2 ? 'w-[55%]' : 'w-[70%]'}`} />
                    <Skeleton className="h-3 w-[40%] rounded" />
                  </div>
                  <Skeleton className="hidden sm:block h-4 w-16 rounded flex-shrink-0" />
                </div>
              ))}
            </div>
          </div>
        ) : error ? (
          <p className="py-14 text-center text-[15px] font-semibold text-[#B91C1C]">{error}</p>
        ) : logs.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-3 text-center px-6">
            <CheckCircle2 className="w-12 h-12 text-[#16A34A]" />
            <p className="text-base font-bold text-[#0B2A5B]">
              {status === 'open' && !debouncedQ ? 'No open errors — the system is running normally.' : 'No entries found'}
            </p>
            {(status !== 'open' || debouncedQ || moduleFilter) && <p className="text-sm text-[#64748B]">Try another status, module or search.</p>}
          </div>
        ) : (
          <motion.div key={filterQuery} initial={reduceMotion ? false : { opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, ease: EASE }}>
            {groups.map(g => (
              <div key={g.key}>
                <div className="sticky top-0 z-[1] px-5 py-2.5 bg-[#F6F9FE] border-y border-[#EEF2F7] text-[13px] font-bold uppercase tracking-[0.08em] text-[#0B2A5B]">
                  {dayLabel(g.key)}
                </div>
                <ul className="divide-y divide-[#EEF2F7]">
                  {g.items.map(l => {
                    const lv = LEVEL[l.level] ?? LEVEL.error;
                    const Icon = l.resolved_at ? CheckCircle2 : lv.icon;
                    return (
                      <li key={l.id}>
                        <motion.button type="button" onClick={() => setPicked(l)} whileTap={reduceMotion ? undefined : { scale: 0.99 }}
                          className="group w-full flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3.5 text-left hover:bg-[#F8FAFE] active:bg-[#EFF6FF] transition-colors">
                          <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
                            style={l.resolved_at ? { backgroundColor: '#F0FDF4', color: '#16A34A' } : { backgroundColor: lv.tint, color: lv.color }}>
                            <Icon className="w-5 h-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-bold text-[15px] text-[#0B2A5B] break-words line-clamp-2">{l.message}</span>
                            <span className="mt-1 flex items-center flex-wrap gap-x-2 gap-y-1 text-[13px] text-[#64748B]">
                              <span className="sm:hidden font-semibold text-[#475569] whitespace-nowrap">{fmtTime(l.last_seen)} ·</span>
                              <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap bg-[#EFF6FF] text-[#1D5BD6]">{l.module}</span>
                              <span className="font-mono text-[12px] text-[#475569] min-w-0 break-all">{l.source}</span>
                              {l.occurrences > 1 && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap bg-[#F1F5F9] text-[#334155]">
                                  <Repeat className="w-3 h-3" /> {l.occurrences}×
                                </span>
                              )}
                              {l.resolved_at && <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#F0FDF4] text-[#15803D] border border-[#BBF7D0]">Resolved</span>}
                            </span>
                          </span>
                          <span className="hidden sm:inline text-sm font-semibold text-[#475569] whitespace-nowrap">{fmtTime(l.last_seen)}</span>
                          <ChevronRight className="flex-shrink-0 w-5 h-5 text-[#94A3B8] transition-transform group-hover:translate-x-0.5 group-hover:text-[#1D5BD6]" />
                        </motion.button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {hasMore && (
              <div className="p-4 flex justify-center border-t border-[#EEF2F7]">
                <motion.button type="button" onClick={loadMore} disabled={loadingMore}
                  whileHover={reduceMotion ? undefined : { y: -2 }} whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                  className="inline-flex items-center gap-2 h-11 px-6 rounded-xl text-[15px] font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-70 transition-colors"
                  style={WHITE}>
                  {loadingMore ? <><Loader2 className="w-4 h-4 animate-spin" /> Loading…</> : 'Load more'}
                </motion.button>
              </div>
            )}
          </motion.div>
        )}
      </section>

      <EntryDialog entry={picked} onClose={() => setPicked(null)} onChanged={refresh} />

      {/* ── Resolve all ── */}
      <Modal open={confirmAll} onClose={() => { if (!resolvingAll) setConfirmAll(false); }} size="sm"
        title="Mark as resolved?" icon={CheckCircle2}>
        <p className="text-[15px] text-[#334155]">
          All {openInView} open {moduleFilter ? `${moduleFilter} ` : ''}entr{openInView === 1 ? 'y' : 'ies'} will move to Resolved.
          If an error happens again, it opens a new entry.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={() => setConfirmAll(false)} disabled={resolvingAll}
            className="h-11 px-5 rounded-xl text-sm font-semibold border border-[#D6E0EF] text-[#0B2A5B] bg-white hover:bg-[#F8FAFC] disabled:opacity-40">
            Cancel
          </button>
          <motion.button type="button" onClick={resolveAll} disabled={resolvingAll}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            className="inline-flex items-center gap-2 h-11 px-6 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-60"
            style={WHITE}>
            {resolvingAll && <Loader2 className="w-4 h-4 animate-spin" />}
            {resolvingAll ? 'Saving…' : 'Mark as resolved'}
          </motion.button>
        </div>
      </Modal>
    </div>
  );
}

/* ─── Entry details ──────────────────────────────────────────────── */
function EntryDialog({ entry, onClose, onChanged }: {
  entry: ErrorEntry | null; onClose: () => void; onChanged: () => Promise<void>;
}) {
  const reduceMotion = useReducedMotion();
  const toast = useToast();
  const [detail, setDetail] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [showDetail, setShowDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const entryId = entry?.id ?? null;

  // Stack trace for the opened entry
  useEffect(() => {
    setDetail(null);
    setShowDetail(false);
    setCopied(false);
    if (!entryId) return;
    const ctrl = new AbortController();
    setDetailState('loading');
    fetch(`/api/error-logs/${entryId}`, { signal: ctrl.signal, cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { log?: { detail?: string | null } }) => { setDetail(d.log?.detail ?? null); setDetailState('idle'); })
      .catch(e => { if ((e as Error).name !== 'AbortError') setDetailState('failed'); });
    return () => ctrl.abort();
  }, [entryId]);

  async function setResolved(resolved: boolean) {
    if (!entry) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/error-logs/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || 'Could not update this entry.'); return; }
      setSuccess(resolved ? 'Marked as resolved' : 'Opened again');
      await onChanged();
      window.setTimeout(() => { setSuccess(null); onClose(); }, 1300);
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    if (!entry) return;
    const text = [
      `${LEVEL[entry.level]?.label ?? 'Error'} — ${entry.module} — ${entry.source}`,
      entry.message,
      where(entry),
      `Last seen ${fmtFull(entry.last_seen)} (${entry.occurrences}×)`,
      detail ?? '',
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy — select the text instead.');
    }
  }

  const lv = entry ? (LEVEL[entry.level] ?? LEVEL.error) : LEVEL.error;
  return (
    <Modal open={!!entry} onClose={() => { if (!saving && !success) onClose(); }} size="lg"
      title={entry ? `${lv.label} in ${entry.module}` : ''}
      subtitle={entry ? `Last seen ${fmtFull(entry.last_seen)}` : undefined}
      icon={entry ? (entry.resolved_at ? CheckCircle2 : lv.icon) : undefined}>
      <AnimatePresence mode="wait">
        {entry && (
          <motion.div key={entry.id} initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="relative space-y-4">
            {success && (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-white/80 backdrop-blur-sm save-success-overlay">
                <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-xl">
                  <svg width="72" height="72" viewBox="0 0 52 52" aria-hidden>
                    <circle className="save-success-circle" cx="26" cy="26" r="24" fill="none" stroke="#16A34A" strokeWidth="3" />
                    <path className="save-success-check" fill="none" stroke="#16A34A" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" d="M14.5 27 22 34.5 38 17" />
                  </svg>
                  <p className="text-base font-semibold text-[#0B2A5B]">{success}</p>
                </div>
              </div>
            )}

            <div className="rounded-xl border px-4 py-3" style={{ borderColor: lv.border, backgroundColor: lv.tint }}>
              <p className="text-[15px] font-semibold break-words" style={{ color: '#0B2A5B' }}>{entry.message}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Fact icon={MapPin} label="Where in the system" value={`${entry.source}\n${where(entry)}`} mono />
              <Fact icon={User} label="Who was using it" value={entry.actor_name ? `${entry.actor_name}${entry.actor_role ? ` · ${ROLE_LABEL[entry.actor_role] ?? entry.actor_role}` : ''}` : 'No signed-in user'} />
              <Fact icon={Repeat} label="How often" value={entry.occurrences === 1 ? 'Once' : `${entry.occurrences} times · first ${fmtFull(entry.first_seen)}`} />
              <Fact icon={entry.resolved_at ? CheckCircle2 : Clock} label="Status"
                value={entry.resolved_at ? `Resolved ${fmtFull(entry.resolved_at)}${entry.resolved_by ? ` by ${entry.resolved_by}` : ''}` : 'Open'}
                tone={entry.resolved_at ? '#15803D' : lv.color} />
            </div>

            <div className="rounded-xl border border-[#E3E9F3] overflow-hidden">
              <button type="button" onClick={() => setShowDetail(v => !v)} aria-expanded={showDetail}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-[#F6F9FE] text-left hover:bg-[#EEF4FD] transition-colors">
                <span className="text-[13px] font-bold uppercase tracking-[0.08em] text-[#0B2A5B]">Technical details</span>
                <ChevronDown className={`w-5 h-5 text-[#475569] transition-transform ${showDetail ? 'rotate-180' : ''}`} />
              </button>
              <AnimatePresence initial={false}>
                {showDetail && (
                  <motion.div initial={reduceMotion ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: EASE }} className="overflow-hidden">
                    {detailState === 'loading' ? (
                      <div className="p-4 space-y-2" aria-hidden>
                        <Skeleton className="h-3 w-[90%] rounded" /><Skeleton className="h-3 w-[75%] rounded" /><Skeleton className="h-3 w-[82%] rounded" />
                      </div>
                    ) : (
                      <pre className="max-h-72 overflow-auto p-4 text-xs leading-relaxed text-[#1E293B] whitespace-pre-wrap break-words font-mono">
                        {detailState === 'failed' ? 'Could not load the technical details.' : detail || 'No stack trace was recorded for this entry.'}
                      </pre>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <button type="button" onClick={copy}
                className="inline-flex items-center gap-2 h-11 px-4 rounded-xl text-sm font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors">
                {copied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {copied ? 'Copied' : 'Copy for a report'}
              </button>
              {entry.resolved_at ? (
                <button type="button" onClick={() => setResolved(false)} disabled={saving}
                  className="inline-flex items-center gap-2 h-11 px-5 rounded-xl text-sm font-semibold border border-[#D6E0EF] text-[#0B2A5B] bg-white hover:bg-[#F8FAFC] disabled:opacity-50">
                  {saving && <Loader2 className="w-4 h-4 animate-spin" />} Open again
                </button>
              ) : (
                <motion.button type="button" onClick={() => setResolved(true)} disabled={saving}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                  className="inline-flex items-center gap-2 h-11 px-6 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-60"
                  style={WHITE}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Mark as resolved
                </motion.button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}

/* ─── Bits ───────────────────────────────────────────────────────── */
function ModuleChip({ on, onClick, icon: Icon, label, n }: {
  on: boolean; onClick: () => void; icon: React.ElementType; label: string; n?: number;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button type="button" onClick={onClick} aria-pressed={on}
      whileHover={reduceMotion || on ? undefined : { y: -2 }}
      whileTap={reduceMotion ? undefined : { scale: 0.95 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={`relative inline-flex items-center gap-2 h-11 pl-3.5 ${n === undefined ? 'pr-3.5' : 'pr-2'} rounded-xl border text-[15px] font-semibold whitespace-nowrap transition-colors duration-300 ${
        on ? 'border-[#0B2A5B]' : 'bg-white border-[#D6E0EF] text-[#0B2A5B] hover:border-[#9DB8E8] hover:bg-[#F8FAFE]'
      }`}
      style={on ? WHITE : undefined}>
      {on && (
        <motion.span layoutId="error-module" aria-hidden
          className="absolute inset-[-1px] rounded-xl bg-[#0B2A5B] shadow-[0_6px_14px_-6px_rgba(11,42,91,0.55)]"
          transition={{ duration: reduceMotion ? 0 : 0.35, ease: EASE }} />
      )}
      <Icon className="relative w-4.5 h-4.5" style={{ color: on ? '#FFFFFF' : '#1D5BD6' }} />
      <span className="relative">{label}</span>
      {n !== undefined && (
        <span className="relative min-w-[26px] h-6 px-1.5 rounded-full text-xs font-bold flex items-center justify-center"
          style={on ? { backgroundColor: 'rgba(255,255,255,0.2)', color: '#FFFFFF' } : { backgroundColor: '#EFF6FF', color: '#1D5BD6' }}>{n}</span>
      )}
    </motion.button>
  );
}

function Fact({ icon: Icon, label, value, tone, mono }: { icon: React.ElementType; label: string; value: string; tone?: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[#E3E9F3] px-4 py-3">
      <Icon className="w-5 h-5 mt-0.5 text-[#1D5BD6] flex-shrink-0" />
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#94A3B8]">{label}</p>
        <p className={`text-sm font-semibold break-words whitespace-pre-line ${mono ? 'font-mono text-[13px]' : ''}`} style={{ color: tone ?? '#0B2A5B' }}>{value}</p>
      </div>
    </div>
  );
}
