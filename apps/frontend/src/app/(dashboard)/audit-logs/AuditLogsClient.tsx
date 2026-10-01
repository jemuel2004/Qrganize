'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  KeyRound, UserCog, BookOpen, CalendarClock, Briefcase, DoorOpen, Settings2,
  Search, ChevronRight, Loader2, ScrollText, ShieldAlert, Clock, User, Globe, X,
} from 'lucide-react';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import Modal from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/skeletons';
import { useRealtime } from '@/context/RealtimeContext';

/* ─── Types & constants ─────────────────────────────────────────── */
interface AuditLog {
  id: number; created_at: string; actor_id: number | null; actor_role: string | null; actor_name: string | null;
  category: string; action: string; summary: string; method: string; path: string; status: number;
  success: boolean; ip: string | null; details: Record<string, unknown> | null;
}

const EASE = [0.4, 0, 0.2, 1] as const;

const CATEGORIES: { id: string; icon: React.ElementType; color: string; tint: string }[] = [
  // One palette for every category — the icon tells them apart, not the colour
  { id: 'Sign-in',    icon: KeyRound,      color: '#1D5BD6', tint: '#EFF6FF' },
  { id: 'Accounts',   icon: UserCog,       color: '#1D5BD6', tint: '#EFF6FF' },
  { id: 'Setup',      icon: BookOpen,      color: '#1D5BD6', tint: '#EFF6FF' },
  { id: 'Scheduling', icon: CalendarClock, color: '#1D5BD6', tint: '#EFF6FF' },
  { id: 'Workload',   icon: Briefcase,     color: '#1D5BD6', tint: '#EFF6FF' },
  { id: 'Rooms',      icon: DoorOpen,      color: '#1D5BD6', tint: '#EFF6FF' },
  { id: 'System',     icon: Settings2,     color: '#1D5BD6', tint: '#EFF6FF' },
];
const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: '7d',    label: '7 days' },
  { id: '30d',   label: '30 days' },
  { id: 'all',   label: 'All' },
] as const;
type Range = typeof RANGES[number]['id'];

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin', department_chair: 'Department Chair', program_chair: 'Program Chair', instructor: 'Faculty',
  admin_chair: 'Admin / Chair',
};

const TZ = 'Asia/Manila';
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const fmtFull = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: TZ });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
function dayLabel(key: string) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const yest = new Date(Date.now() - 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
  if (key === today) return 'Today';
  if (key === yest) return 'Yesterday';
  return new Date(`${key}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
const prettyKey = (k: string) => k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^\w/, c => c.toUpperCase());
function prettyValue(v: unknown): string {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.map(prettyValue).join(', ');
  if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${prettyKey(k)}: ${prettyValue(x)}`).join(' · ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

/* ─── Page ───────────────────────────────────────────────────────── */
export default function AuditLogsClient() {
  const reduceMotion = useReducedMotion();
  const [range, setRange] = useState<Range>('7d');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  /** Category counts arrive with the first page — until then the chips show a placeholder, not 0 */
  const [countsReady, setCountsReady] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<AuditLog | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const fetchPage = useCallback(async (before?: number) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const sp = new URLSearchParams({ range });
    if (category) sp.set('category', category);
    if (debouncedQ) sp.set('q', debouncedQ);
    if (before) sp.set('before', String(before));
    const res = await fetch(`/api/audit-logs?${sp}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error('Could not load audit logs.');
    return res.json() as Promise<{ logs: AuditLog[]; has_more: boolean; counts?: Record<string, number> }>;
  }, [range, category, debouncedQ]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    fetchPage()
      .then(d => { if (!alive) return; setLogs(d.logs); setHasMore(d.has_more); if (d.counts) setCounts(d.counts); setCountsReady(true); })
      .catch(e => { if (alive && (e as Error).name !== 'AbortError') { setError((e as Error).message); setCountsReady(true); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; abortRef.current?.abort(); };
  }, [fetchPage]);

  /* Live updates: new activity appears at the top while the pages already
     loaded below stay (filters, search and an open entry are untouched). If
     more than a page of activity arrived at once, the list restarts from the
     newest page so it never has a gap. */
  const filterQuery = useMemo(() => {
    const sp = new URLSearchParams({ range });
    if (category) sp.set('category', category);
    if (debouncedQ) sp.set('q', debouncedQ);
    return sp.toString();
  }, [range, category, debouncedQ]);
  const shownQuery = useRef(filterQuery);
  useEffect(() => { shownQuery.current = filterQuery; }, [filterQuery]);
  const shownLogs = useRef(logs);
  useEffect(() => { shownLogs.current = logs; }, [logs]);
  useRealtime(['audit'], () => {
    const query = filterQuery;
    return fetch(`/api/audit-logs?${query}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { logs: AuditLog[]; has_more: boolean; counts?: Record<string, number> } | null) => {
        if (!d || shownQuery.current !== query) return;
        if (d.counts) setCounts(d.counts);
        const prev = shownLogs.current;
        const seen = new Set(prev.map(l => l.id));
        const fresh = d.logs.filter(l => !seen.has(l.id));
        if (fresh.length === 0) return;
        if (prev.length > 0 && fresh.length === d.logs.length && d.has_more) {
          setLogs(d.logs); // more than a page arrived — restart from the newest
          setHasMore(d.has_more);
        } else {
          setLogs([...fresh, ...prev]);
        }
      })
      .catch(() => {});
  }, { enabled: !loading && !loadingMore });

  const loadMore = async () => {
    if (!logs.length) return;
    setLoadingMore(true);
    try {
      const d = await fetchPage(logs[logs.length - 1].id);
      setLogs(prev => [...prev, ...d.logs]); setHasMore(d.has_more);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally { setLoadingMore(false); }
  };

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const groups = useMemo(() => {
    const out: { key: string; items: AuditLog[] }[] = [];
    for (const l of logs) {
      const k = dayKey(l.created_at);
      if (out[out.length - 1]?.key !== k) out.push({ key: k, items: [] });
      out[out.length - 1].items.push(l);
    }
    return out;
  }, [logs]);

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6 space-y-5">
      <div>
        <BackButton />
        <div className="mt-4 sm:mt-7 mb-2"><WatermarkTitle>Audit Logs</WatermarkTitle></div>
      </div>

      {/* ── Filters ── */}
      <section className="bg-white rounded-2xl border border-[#E3E9F3] p-4 sm:p-5 space-y-4 shadow-[0_8px_24px_-18px_rgba(11,42,91,0.35)]">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div role="tablist" aria-label="Time range" className="flex gap-1 p-1 rounded-full bg-[#EAF0FA] border border-[#DCE5F3] self-stretch md:self-start">
            {RANGES.map(r => {
              const on = r.id === range;
              return (
                <motion.button key={r.id} type="button" role="tab" aria-selected={on} onClick={() => setRange(r.id)}
                  whileTap={reduceMotion ? undefined : { scale: 0.94 }}
                  className={`relative flex-1 sm:flex-none px-3 sm:px-5 h-10 rounded-full text-[15px] font-semibold whitespace-nowrap transition-colors ${on ? '' : 'text-[#475569] hover:text-[#0B2A5B]'}`}
                  style={on ? { color: '#FFFFFF' } : undefined}>
                  {on && <motion.span layoutId="audit-range" className="absolute inset-0 rounded-full bg-[#0B2A5B] shadow-[0_4px_12px_-4px_rgba(11,42,91,0.5)]"
                    transition={{ duration: reduceMotion ? 0 : 0.35, ease: EASE }} />}
                  <span className="relative">{r.label}</span>
                </motion.button>
              );
            })}
          </div>
          <div className="relative flex-1 md:max-w-md md:ml-auto">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[#94A3B8]" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search action, person, or IP…"
              className="w-full h-12 pl-12 pr-10 rounded-xl border border-[#D6E0EF] bg-white text-[15px] text-[#0B2A5B] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/25 focus:border-[#1D5BD6]" />
            {q && (
              <button type="button" onClick={() => setQ('')} aria-label="Clear search"
                className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-[#64748B] hover:bg-[#F1F5F9]">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Category chips */}
        <div className="flex flex-wrap gap-2">
          <Chip on={!category} onClick={() => setCategory('')} icon={ScrollText} label="All" n={countsReady ? total : null} />
          {CATEGORIES.map(c => (
            <Chip key={c.id} on={category === c.id} onClick={() => setCategory(category === c.id ? '' : c.id)}
              icon={c.icon} label={c.id} n={countsReady ? (counts[c.id] ?? 0) : null} />
          ))}
        </div>
      </section>

      {/* ── List ── */}
      <section className="bg-white rounded-2xl border border-[#E3E9F3] overflow-hidden shadow-[0_8px_24px_-18px_rgba(11,42,91,0.35)]">
        {loading ? (
          <div role="status" aria-live="polite" aria-label="Loading activity">
            {/* Same shape as the list: a day header, then rows */}
            <div className="px-5 py-2.5 bg-[#F6F9FE] border-b border-[#EEF2F7]">
              <Skeleton className="h-3.5 w-24 rounded" />
            </div>
            <div className="divide-y divide-[#EEF2F7]">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3.5">
                  <Skeleton className="w-11 h-11 rounded-xl flex-shrink-0" />
                  <div className="flex-1 min-w-0 space-y-2">
                    <Skeleton className={`h-4 rounded ${i % 2 ? 'w-[45%]' : 'w-[60%]'}`} />
                    <Skeleton className="h-3 w-[35%] rounded" />
                  </div>
                  <Skeleton className="hidden sm:block h-4 w-16 rounded flex-shrink-0" />
                  <Skeleton className="w-5 h-5 rounded flex-shrink-0" />
                </div>
              ))}
            </div>
          </div>
        ) : error ? (
          <p className="py-14 text-center text-[15px] font-semibold text-[#B91C1C]">{error}</p>
        ) : logs.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-3 text-center">
            <ScrollText className="w-12 h-12 text-[#CBD5E1]" />
            <p className="text-base font-bold text-[#0B2A5B]">No activity found</p>
            <p className="text-sm text-[#64748B]">Try a longer time range or a different filter.</p>
          </div>
        ) : (
          <motion.div
            key={`${range}|${category}`}
            initial={reduceMotion ? false : { opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            {groups.map(g => (
              <div key={g.key}>
                <div className="sticky top-0 z-[1] px-5 py-2.5 bg-[#F6F9FE] border-y border-[#EEF2F7] text-[13px] font-bold uppercase tracking-[0.08em] text-[#0B2A5B]">
                  {dayLabel(g.key)}
                </div>
                <ul className="divide-y divide-[#EEF2F7]">
                  {g.items.map((l, i) => {
                    const c = CAT[l.category] ?? CAT.System;
                    const Icon = l.success ? c.icon : ShieldAlert;
                    return (
                      <motion.li key={l.id}
                        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 10) * 0.025 } }}>
                        <motion.button type="button" onClick={() => setPicked(l)}
                          whileTap={reduceMotion ? undefined : { scale: 0.99 }}
                          className="group w-full flex items-center gap-3 sm:gap-4 px-4 sm:px-5 py-3.5 text-left hover:bg-[#F8FAFE] active:bg-[#EFF6FF] transition-colors">
                          <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 transition-transform group-hover:scale-105"
                            style={l.success ? { backgroundColor: c.tint, color: c.color } : { backgroundColor: '#FEF2F2', color: '#DC2626' }}>
                            <Icon className="w-5 h-5" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-[15px] text-[#0B2A5B] min-w-0 break-words sm:truncate">{l.summary}</span>
                              {!l.success && <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#FEF2F2] text-[#B91C1C] border border-[#FECACA]">Failed</span>}
                            </span>
                            <span className="mt-1 sm:mt-0.5 flex items-center flex-wrap sm:flex-nowrap gap-x-2 gap-y-1 text-[13px] text-[#64748B]">
                              <span className="sm:hidden font-semibold text-[#475569] whitespace-nowrap">{fmtTime(l.created_at)} ·</span>
                              <span className="font-semibold text-[#334155] min-w-0 break-all sm:break-normal sm:truncate">{l.actor_name ?? 'Unknown'}</span>
                              {l.actor_role && <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap bg-[#F1F5F9] text-[#475569]">{ROLE_LABEL[l.actor_role] ?? l.actor_role}</span>}
                              <span className="px-2 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap" style={{ backgroundColor: c.tint, color: c.color }}>{l.category}</span>
                            </span>
                          </span>
                          <span className="hidden sm:inline text-sm font-semibold text-[#475569] whitespace-nowrap">{fmtTime(l.created_at)}</span>
                          <ChevronRight className="flex-shrink-0 w-5 h-5 text-[#94A3B8] transition-transform group-hover:translate-x-0.5 group-hover:text-[#1D5BD6]" />
                        </motion.button>
                      </motion.li>
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
                  style={{ color: '#FFFFFF' }}>
                  {loadingMore ? <><Loader2 className="w-4 h-4 animate-spin" /> Loading…</> : 'Load more'}
                </motion.button>
              </div>
            )}
          </motion.div>
        )}
      </section>

      {/* ── Entry details ── */}
      <Modal open={!!picked} onClose={() => setPicked(null)} size="md"
        title={picked?.action ?? ''} subtitle={picked ? `${picked.category} · ${fmtTime(picked.created_at)}` : undefined}
        icon={picked ? (picked.success ? (CAT[picked.category] ?? CAT.System).icon : ShieldAlert) : undefined}>
        <AnimatePresence mode="wait">
          {picked && (
            <motion.div key={picked.id} initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Fact icon={User} label="Who" value={`${picked.actor_name ?? 'Unknown'}${picked.actor_role ? ` · ${ROLE_LABEL[picked.actor_role] ?? picked.actor_role}` : ''}`} />
                <Fact icon={Clock} label="When" value={fmtFull(picked.created_at)} />
                <Fact icon={Globe} label="IP address" value={picked.ip ?? '—'} />
                <Fact icon={picked.success ? ScrollText : ShieldAlert} label="Result" value={picked.success ? 'Completed' : 'Failed'} tone={picked.success ? '#047857' : '#B91C1C'} />
              </div>
              <div className="rounded-xl border border-[#E3E9F3] overflow-hidden">
                <p className="px-4 py-2.5 bg-[#F6F9FE] text-[13px] font-bold uppercase tracking-[0.08em] text-[#0B2A5B]">What changed</p>
                {picked.details && Object.keys(picked.details).length ? (
                  <dl className="divide-y divide-[#EEF2F7]">
                    {Object.entries(picked.details).map(([k, v]) => (
                      <div key={k} className="grid grid-cols-[140px_1fr] gap-3 px-4 py-2.5 text-sm">
                        <dt className="font-semibold text-[#64748B]">{prettyKey(k)}</dt>
                        <dd className="text-[#0B2A5B] break-words">{k === 'role' && typeof v === 'string' ? (ROLE_LABEL[v] ?? v) : prettyValue(v)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="px-4 py-3 text-sm text-[#64748B]">{picked.summary}</p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Modal>
    </div>
  );
}

/* ─── Bits ───────────────────────────────────────────────────────── */
/** Category filter chip — white with navy text; the navy highlight slides to the selected chip */
function Chip({ on, onClick, icon: Icon, label, n }: {
  /** null while the counts are still loading */
  on: boolean; onClick: () => void; icon: React.ElementType; label: string; n: number | null;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button type="button" onClick={onClick} aria-pressed={on}
      whileHover={reduceMotion || on ? undefined : { y: -2 }}
      whileTap={reduceMotion ? undefined : { scale: 0.95 }}
      transition={{ duration: 0.2, ease: EASE }}
      className={`relative inline-flex items-center gap-2 h-11 pl-3.5 pr-2 rounded-xl border text-[15px] font-semibold whitespace-nowrap transition-colors duration-300 ${
        on ? 'border-[#0B2A5B]' : 'bg-white border-[#D6E0EF] text-[#0B2A5B] hover:border-[#9DB8E8] hover:bg-[#F8FAFE]'
      }`}
      style={on ? { color: '#FFFFFF' } : undefined}>
      {on && (
        <motion.span layoutId="audit-category" aria-hidden
          className="absolute inset-[-1px] rounded-xl bg-[#0B2A5B] shadow-[0_6px_14px_-6px_rgba(11,42,91,0.55)]"
          transition={{ duration: reduceMotion ? 0 : 0.35, ease: EASE }} />
      )}
      <motion.span key={on ? 'on' : 'off'} className="relative inline-flex"
        initial={reduceMotion || !on ? false : { scale: 0.6, rotate: -15 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 500, damping: 18 }}>
        <Icon className="w-4.5 h-4.5" style={{ color: on ? '#FFFFFF' : '#1D5BD6' }} />
      </motion.span>
      <span className="relative">{label}</span>
      {n === null ? (
        <Skeleton className="relative w-[26px] h-6 rounded-full" />
      ) : (
        <motion.span key={`${on}-${n}`} className="relative min-w-[26px] h-6 px-1.5 rounded-full text-xs font-bold flex items-center justify-center"
          initial={reduceMotion ? false : { scale: 0.7, opacity: 0.4 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 20 }}
          style={on ? { backgroundColor: 'rgba(255,255,255,0.2)', color: '#FFFFFF' } : { backgroundColor: '#EFF6FF', color: '#1D5BD6' }}>{n}</motion.span>
      )}
    </motion.button>
  );
}

function Fact({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[#E3E9F3] px-4 py-3">
      <Icon className="w-5 h-5 mt-0.5 text-[#1D5BD6] flex-shrink-0" />
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#94A3B8]">{label}</p>
        <p className="text-sm font-semibold break-words" style={{ color: tone ?? '#0B2A5B' }}>{value}</p>
      </div>
    </div>
  );
}
