'use client';

/**
 * Admin dashboard — what is happening today, at a glance.
 *   Greeting + live clock · today strip (classes today, rooms, faculty,
 *   subjects offered) · room status (live) · today's schedule ·
 *   workload overview · scheduling alerts.
 * Deeper charts live in Analytics.
 * Data: /api/dashboard (today + live rooms), /api/analytics (term figures).
 */

import { memo, useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle, ArrowRight, BookOpen, CalendarCheck, CalendarDays, CheckCircle2, ChevronRight,
  ClipboardList, DoorOpen, Monitor, Users,
} from 'lucide-react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { DashboardSkeleton } from '@/components/ui/skeletons';
import { PageLoadTransition, revealProps } from '@/components/ui/PageLoadTransition';
import { useSkeletonRefresh } from '@/hooks/useSkeletonRefresh';
import LoadBreakdownDonut from '@/components/charts/LoadBreakdownDonut';
import { RefreshButton } from '@/app/(dashboard)/room-utilization/shared';

/* ─── Types ──────────────────────────────────────────────────── */
interface TodayClass {
  id: number; start_time: string; end_time: string; subject_code: string;
  program_code: string | null; year_level: string | null; block_name: string | null;
  faculty_name: string; room_name: string;
}
interface LiveRoom {
  id: number; room_name: string; room_type: string;
  occupancy_status: 'Available' | 'Occupied' | 'Pending';
  subject_code: string | null; start_time: string | null; end_time: string | null;
  faculty_name: string | null; is_now: boolean | null;
}
interface DashboardData {
  user: { username: string; role: string } | null;
  stats: { today_schedules: number; occupied_rooms: number; available_rooms: number; pending_occupancy: number; total_rooms: number; pending_requests: number };
  today_schedule: TodayClass[];
  live_rooms: LiveRoom[];
}
interface Analytics {
  term: { semester: string | null; school_year: string | null };
  kpis: { instructors: { total: number }; conflicts: number };
  offerings: { total: number; scheduled: number };
  scheduling: { unassigned: number };
  workload: { regular: number; overload: number; praise: number };
  usage_by_day: { day: string; lec: number; lab: number }[];
  faculty_load: { status: 'complete' | 'overload' | 'in_progress' | 'not_started' }[];
}

/* ─── Helpers ────────────────────────────────────────────────── */
const EASE = [0.4, 0, 0.2, 1] as const;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUS_TONE = {
  Available: { dot: '#10B981', bg: '#ECFDF5', fg: '#047857' },
  Occupied: { dot: '#F59E0B', bg: '#FFF7ED', fg: '#C2410C' },
  Pending: { dot: '#94A3B8', bg: '#F1F5F9', fg: '#475569' },
} as const;

function fmt12(t: string | null) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
const blockLabel = (c: TodayClass) =>
  [c.program_code, `${String(c.year_level ?? '').match(/\d+/)?.[0] ?? ''}${c.block_name ?? ''}`].filter(Boolean).join(' ');

/** 5:00 AM–11:59 AM morning, 12:00 PM–5:59 PM afternoon, otherwise evening. */
function dayGreeting(d: Date) {
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins >= 5 * 60 && mins < 12 * 60) return 'Good morning';
  if (mins >= 12 * 60 && mins < 18 * 60) return 'Good afternoon';
  return 'Good evening';
}
const displayName = (u: string | null | undefined) => (u?.trim() ? u.trim()[0].toUpperCase() + u.trim().slice(1) : 'Admin');

/* ─── Header (greeting · subtitle · live clock) ──────────────── */
const DashboardHeader = memo(function DashboardHeader({ name, term, onRefresh, loading }: {
  name: string; term: string; onRefresh: () => void; loading: boolean;
}) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); }, []);
  useVisibilityAwareInterval(() => setNow(new Date()), 1_000);
  const dateStr = now?.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now?.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });

  return (
    <div className="flex items-start sm:items-center justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-[26px] sm:text-[30px] font-bold tracking-tight text-[#0B2A5B] leading-tight">
          {now ? `${dayGreeting(now)}, ${name}` : ' '}
        </h1>
        <p className="text-[15px] text-[#475569] mt-1.5">Here&apos;s what&apos;s happening with your system today.</p>
        <p className="text-[14px] text-[#64748B] mt-1 tabular-nums" aria-live="polite">
          {now ? `${dateStr} · ${timeStr}` : ' '}
        </p>
      </div>
      <div className="flex items-center gap-2.5 flex-wrap">
        {term && (
          <span className="h-11 inline-flex items-center gap-2 px-4 rounded-xl bg-white border border-[#D6E0EF] text-[14px] font-semibold text-[#0B2A5B]">
            <CalendarCheck className="w-4 h-4 text-[#1D5BD6]" /> {term}
          </span>
        )}
        {/* The cards below show skeletons while it reloads — no centred card */}
        <RefreshButton overlay={false} onRefresh={onRefresh} loading={loading} />
      </div>
    </div>
  );
});

/* ─── Building blocks ────────────────────────────────────────── */
function Section({ icon: Icon, title, action, className = '', center = false, children }: {
  icon: React.ElementType; title: string; action?: ReactNode; className?: string;
  /** Vertically centre the body when the card is stretched taller than its content */
  center?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`relative bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] p-5 sm:p-6 min-w-0 overflow-hidden flex flex-col ${className}`}>
      <span aria-hidden className="absolute left-0 top-5 bottom-5 w-1 rounded-r bg-[#1D5BD6]" />
      <div className="flex items-center justify-between flex-wrap gap-x-3 gap-y-2.5 mb-5">
        <h2 className="inline-flex items-center gap-2.5 text-[15px] font-bold uppercase tracking-[0.08em] text-[#0B2A5B] whitespace-nowrap">
          <Icon className="w-5 h-5 text-[#1D5BD6]" /> {title}
        </h2>
        {action}
      </div>
      <div className={center ? 'flex-1 flex items-center justify-center min-h-0' : ''}>{children}</div>
    </section>
  );
}

function ViewLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full border border-[#BFDBFE] bg-[#EFF6FF] text-[13px] font-semibold text-[#1D5BD6] hover:bg-[#DBEAFE] transition-colors whitespace-nowrap">
      {children} <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

/* ─── Today's schedule — 5 classes per slide, auto-advancing ─── */
const SLIDE_SIZE = 5;
const SLIDE_MS = 3000;
const ROW_H = 56;
/** Shared column widths so the fixed header lines up with the sliding rows */
const SCHEDULE_COLS = ['24%', '14%', '18%', '14%', '30%'];

function ScheduleCols() {
  return <colgroup>{SCHEDULE_COLS.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>;
}

function TodayScheduleCarousel({ classes }: { classes: TodayClass[] }) {
  const reduceMotion = useReducedMotion();
  const pages = Math.max(1, Math.ceil(classes.length / SLIDE_SIZE));
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const current = Math.min(page, pages - 1); // data refresh can shrink the list

  // Advance every 3 s; paused on hover/focus or when the tab is hidden
  useEffect(() => {
    if (pages <= 1 || paused) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') setPage(p => (Math.min(p, pages - 1) + 1) % pages);
    }, SLIDE_MS);
    return () => window.clearInterval(id);
  }, [pages, paused]);

  const rows = classes.slice(current * SLIDE_SIZE, current * SLIDE_SIZE + SLIDE_SIZE);
  const first = current * SLIDE_SIZE + 1;
  const last = current * SLIDE_SIZE + rows.length;

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="sm:overflow-x-auto">
        <div className="sm:min-w-[620px]">
          <table className="hidden sm:table w-full table-fixed text-[14px]">
            <ScheduleCols />
            <thead>
              <tr className="text-left text-[13px] font-semibold text-[#64748B] border-b border-[#EEF2F8]">
                <th className="py-2.5 pr-3">Time</th><th className="py-2.5 pr-3">Subject</th><th className="py-2.5 pr-3">Program / Block</th>
                <th className="py-2.5 pr-3">Room</th><th className="py-2.5">Faculty</th>
              </tr>
            </thead>
          </table>
          {/* Fixed height of 5 rows so the card never jumps between slides */}
          <div className="relative overflow-hidden" style={{ height: ROW_H * Math.min(SLIDE_SIZE, classes.length) }}>
            <AnimatePresence initial={false} mode="popLayout">
              <motion.div
                key={current}
                className="absolute inset-x-0 top-0"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 48 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -48 }}
                transition={{ duration: reduceMotion ? 0.15 : 0.45, ease: EASE }}
              >
                {/* Phone: two-line rows instead of a sideways-scrolling table */}
                <ul className="sm:hidden divide-y divide-[#F1F5F9]">
                  {rows.map(c => (
                    <li key={c.id} className="flex flex-col justify-center min-w-0" style={{ height: ROW_H }}>
                      <p className="flex items-center gap-2 min-w-0 text-[14px]">
                        <span className="w-2 h-2 rounded-full bg-[#1D5BD6] flex-shrink-0" />
                        <span className="font-semibold text-[#0B2A5B] whitespace-nowrap tabular-nums">{fmt12(c.start_time)}–{fmt12(c.end_time)}</span>
                        <span className="font-bold text-[#0B2A5B] truncate">{c.subject_code}</span>
                      </p>
                      <p className="pl-4 text-[13px] text-[#475569] truncate">
                        {[blockLabel(c), c.room_name, c.faculty_name].filter(Boolean).join(' · ')}
                      </p>
                    </li>
                  ))}
                </ul>
                <table className="hidden sm:table w-full table-fixed text-[14px]">
                <ScheduleCols />
                <tbody className="divide-y divide-[#F1F5F9]">
                  {rows.map(c => (
                    <tr key={c.id} className="hover:bg-[#F8FAFC] transition-colors" style={{ height: ROW_H }}>
                      <td className="pr-3 whitespace-nowrap font-semibold text-[#0B2A5B]">
                        <span className="inline-block w-2 h-2 rounded-full bg-[#1D5BD6] mr-2.5 align-middle" />{fmt12(c.start_time)}
                        <span className="text-[#94A3B8] font-normal"> – {fmt12(c.end_time)}</span>
                      </td>
                      <td className="pr-3 font-semibold text-[#0B2A5B] truncate">{c.subject_code}</td>
                      <td className="pr-3 text-[#475569] truncate">{blockLabel(c)}</td>
                      <td className="pr-3 text-[#475569] truncate">{c.room_name}</td>
                      <td className="text-[#475569] truncate">{c.faculty_name}</td>
                    </tr>
                  ))}
                </tbody>
                </table>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      {pages > 1 && (
        <div className="mt-3 pt-3 border-t border-[#F1F5F9] flex items-center justify-between gap-3">
          <span className="text-[13px] text-[#64748B] tabular-nums">
            {first}–{last} of {classes.length} classes
          </span>
          <div className="flex items-center gap-1.5" role="tablist" aria-label="Schedule pages">
            {Array.from({ length: pages }, (_, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === current}
                aria-label={`Show classes ${i * SLIDE_SIZE + 1}–${Math.min(classes.length, (i + 1) * SLIDE_SIZE)}`}
                onClick={() => setPage(i)}
                className="h-2.5 rounded-full transition-all duration-300"
                style={{ width: i === current ? 22 : 10, backgroundColor: i === current ? '#1D5BD6' : '#CBD5E1' }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Pill({ status }: { status: keyof typeof STATUS_TONE }) {
  const t = STATUS_TONE[status];
  return <span className="inline-flex flex-shrink-0 whitespace-nowrap px-2.5 py-1 rounded-full text-[12px] font-bold" style={{ backgroundColor: t.bg, color: t.fg }}>{status}</span>;
}

/* ─── Main ───────────────────────────────────────────────────── */
export default function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [an, setAn] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  /** Resolves to false when the dashboard could not be read */
  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [d, a] = await Promise.all([
        fetch('/api/dashboard', { cache: 'no-store', signal }),
        fetch('/api/analytics', { cache: 'no-store', signal }),
      ]);
      if (d.ok) setData(await d.json());
      if (a.ok) setAn(await a.json());
      return d.ok && a.ok;
    } catch {
      return false;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);
  // Live updates: re-fetch quietly when anything the dashboard counts changes
  useRealtime(
    ['term', 'rooms', 'occupancy', 'room-requests', 'schedule', 'workload', 'blocks', 'faculty'],
    () => load(undefined, true),
    { enabled: !loading },
  );
  // Fallback for time-based changes (classes starting / ending)
  useVisibilityAwareInterval(() => load(undefined, true), 60_000);

  /* Couldn't load (e.g. the server was restarting after an update): try again by
     itself — after 3 s, 8 s, 20 s, then every 30 s — until it comes back */
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (loading || data) return;
    const wait = [3_000, 8_000, 20_000][retry] ?? 30_000;
    const t = window.setTimeout(() => { setRetry(n => n + 1); load(undefined, true); }, wait);
    return () => window.clearTimeout(t);
  }, [loading, data, retry, load]);
  const reduceMotion = useReducedMotion();

  // Refresh button: the whole dashboard (and the bell) reloads behind its skeleton
  const reloadAll = useCallback(() => load(undefined, true), [load]);
  const { refreshing, refresh } = useSkeletonRefresh(reloadAll);
  const showSkeleton = useMinLoading((loading && !data) || refreshing, LOADING_DELAY);
  const term = [an?.term.semester, an?.term.school_year ? `AY ${an.term.school_year}` : null].filter(Boolean).join(' · ');
  const st = data?.stats;
  const todayName = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Manila' });
  // First day after today that has classes (for the empty "today" state)
  const nextClassDay = an
    ? [...DAYS.slice(DAYS.indexOf(todayName) + 1), ...DAYS].find(d => { const r = an.usage_by_day.find(x => x.day === d); return r && r.lec + r.lab > 0; })
    : undefined;
  const incompleteLoad = an?.faculty_load.filter(f => f.status === 'in_progress' || f.status === 'not_started').length ?? 0;

  const alerts = an && st ? [
    { label: 'Schedule Conflicts', count: an.kpis.conflicts, href: '/scheduling', icon: AlertTriangle },
    { label: 'Unassigned Subjects', count: an.scheduling.unassigned, href: '/master-schedule?status=Unassigned', icon: ClipboardList },
    { label: 'Room Requests Pending', count: st.pending_requests, href: '/room-requests', icon: DoorOpen },
    // Opens Faculty Workload on its Unassigned button (faculty with no subject yet)
    { label: 'Incomplete Faculty Load', count: incompleteLoad, href: '/workload?show=unassigned', icon: Users },
  ] : [];

  return (
    <div className="flex flex-col px-4 sm:px-6 py-6 gap-5 min-w-0 w-full max-w-7xl mx-auto">
      {/* The greeting and Refresh stay put while a refresh reloads the cards below */}
      {data && st && (
        <DashboardHeader name={displayName(data.user?.username)} term={term} onRefresh={refresh} loading={refreshing || showSkeleton} />
      )}
      <PageLoadTransition showSkeleton={showSkeleton} skeleton={<DashboardSkeleton header={!(data && st)} />} className="flex flex-col gap-5">
        {data && st ? (
          <>
            {/* ── Today strip ── */}
            <motion.section {...revealProps(0, reduceMotion)} className="relative bg-gradient-to-br from-[#EFF6FF] to-white rounded-2xl border border-[#D6E4FA] p-5 sm:p-6 overflow-hidden">
              <span aria-hidden className="absolute left-0 top-5 bottom-5 w-1 rounded-r bg-[#1D5BD6]" />
              <p className="inline-flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.1em] text-[#0B2A5B] mb-4">
                <CalendarDays className="w-4 h-4 text-[#1D5BD6]" /> Today
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-y-5">
                {[
                  { icon: CalendarCheck, label: 'Classes Today', value: st.today_schedules, href: '/master-schedule' },
                  { icon: Users, label: 'Faculty', value: an?.kpis.instructors.total ?? 0, href: '/program/faculty' },
                  { icon: BookOpen, label: 'Subjects Offered', value: an?.offerings.total ?? 0, sub: `${an?.offerings.scheduled ?? 0} scheduled`, href: '/master-schedule' },
                ].map(({ icon: Icon, label, value, sub, href }, i) => (
                  <Link key={label} href={href} className={`group flex items-center gap-3.5 px-2 sm:px-5 border-[#D6E4FA] ${i > 0 ? 'sm:border-l' : ''}`}>
                    <span className="w-12 h-12 rounded-2xl bg-white shadow-[0_2px_8px_-3px_rgba(29,91,214,0.35)] flex items-center justify-center flex-shrink-0">
                      <Icon className="w-6 h-6 text-[#1D5BD6]" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-semibold text-[#475569] group-hover:text-[#1D5BD6] transition-colors">{label}</span>
                      <span className="block text-[28px] font-bold leading-tight tabular-nums text-[#0B2A5B]">
                        {value}
                      </span>
                      {sub && <span className="block text-[12px] text-[#64748B]">{sub}</span>}
                    </span>
                  </Link>
                ))}
              </div>
            </motion.section>

            {/* ── Room status ── */}
            <motion.div {...revealProps(1, reduceMotion)}>
            <Section icon={DoorOpen} title="Room Status" action={<ViewLink href="/rooms">View Room Management</ViewLink>}>
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,9fr)_minmax(0,11fr)] gap-6 lg:gap-8 items-center">
                <div className="min-w-0 flex justify-center">
                  <div className="w-full max-w-[460px]">
                  <LoadBreakdownDonut bare compact centerLabel="Total Rooms" ringSize={180}
                    slices={[
                      { key: 'a', label: 'Available', value: st.available_rooms, color: STATUS_TONE.Available.dot },
                      { key: 'o', label: 'Occupied', value: st.occupied_rooms, color: STATUS_TONE.Occupied.dot },
                      { key: 'p', label: 'Pending', value: st.pending_occupancy, color: STATUS_TONE.Pending.dot },
                    ]} />
                  </div>
                </div>
                <ul className="sm:hidden max-h-[340px] overflow-y-auto divide-y divide-[#F1F5F9] border-t border-[#EEF2F8]">
                  {data.live_rooms.map(r => (
                    <li key={r.id} className="py-3 min-w-0">
                      <div className="flex items-center justify-between gap-3">
                        <span className="inline-flex items-center gap-2 min-w-0 font-semibold text-[15px] text-[#0B2A5B]">
                          {r.room_type === 'Laboratory' ? <Monitor className="w-4 h-4 flex-shrink-0 text-[#D97706]" /> : <BookOpen className="w-4 h-4 flex-shrink-0 text-[#1D5BD6]" />}
                          <span className="truncate">{r.room_name}</span>
                        </span>
                        <Pill status={r.occupancy_status} />
                      </div>
                      {r.subject_code && (
                        <p className="mt-1 pl-6 text-[13px] text-[#475569] break-words">
                          {r.is_now ? <b className="text-[#0B2A5B]">Now · </b> : <span className="text-[#94A3B8]">Next · </span>}
                          {r.subject_code} · {fmt12(r.start_time)}–{fmt12(r.end_time)} · {r.faculty_name}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="hidden sm:block min-w-0 overflow-x-auto">
                  <div className="max-h-[300px] overflow-y-auto">
                    <table className="w-full text-[14px] min-w-[440px]">
                      <thead className="sticky top-0 bg-white z-[1]">
                        <tr className="text-left text-[13px] font-semibold text-[#64748B] border-b border-[#EEF2F8]">
                          <th className="py-2.5 pr-3 w-[118px]">Room</th><th className="py-2.5 pr-3 w-[112px]">Status</th><th className="py-2.5">Current / Next Class</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F1F5F9]">
                        {data.live_rooms.map(r => (
                          <tr key={r.id} className="hover:bg-[#F8FAFC] transition-colors">
                            <td className="py-3 pr-3">
                              <span className="inline-flex items-center gap-2 font-semibold text-[#0B2A5B]">
                                {r.room_type === 'Laboratory' ? <Monitor className="w-4 h-4 text-[#D97706]" /> : <BookOpen className="w-4 h-4 text-[#1D5BD6]" />}
                                {r.room_name}
                              </span>
                            </td>
                            <td className="py-3 pr-3"><Pill status={r.occupancy_status} /></td>
                            <td className="py-3 text-[#475569]">
                              {r.subject_code
                                ? <>{r.is_now ? <b className="text-[#0B2A5B]">Now · </b> : <span className="text-[#94A3B8]">Next · </span>}{r.subject_code} · {fmt12(r.start_time)}–{fmt12(r.end_time)} · {r.faculty_name}</>
                                : <span className="text-[#CBD5E1]" title="No more classes today">—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </Section>
            </motion.div>

            {/* ── Today's schedule ── */}
            <motion.div {...revealProps(2, reduceMotion)}>
            <Section icon={CalendarDays} title="Today's Schedule" action={<ViewLink href="/master-schedule">View Full Schedule</ViewLink>}>
              {data.today_schedule.length === 0 ? (
                <div className="py-3 flex items-center justify-center gap-4 text-left">
                  <CalendarDays className="w-10 h-10 text-[#CBD5E1] flex-shrink-0" />
                  <div>
                  <p className="text-[16px] font-semibold text-[#0B2A5B]">No classes today</p>
                  {nextClassDay && <p className="text-[14px] text-[#64748B] mt-0.5">Next classes are on <b className="text-[#0B2A5B]">{nextClassDay}</b>.</p>}
                  </div>
                </div>
              ) : (
                <TodayScheduleCarousel classes={data.today_schedule} />
              )}
            </Section>
            </motion.div>

            {/* ── Workload overview · Scheduling alerts ── */}
            <motion.div {...revealProps(3, reduceMotion)} className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-stretch">
              <Section icon={Users} title="Workload Overview" action={<ViewLink href="/workload">View Workload</ViewLink>} center>
                {an && (
                  <div className="w-full max-w-[520px]">
                  <LoadBreakdownDonut bare compact centerLabel="Faculty" ringSize={176}
                    slices={[
                      { key: 'regular', label: 'Regular', value: an.workload.regular, color: 'var(--load-regular)' },
                      { key: 'overload', label: 'Overload', value: an.workload.overload, color: 'var(--load-overload)' },
                      { key: 'praise', label: 'Praise', value: an.workload.praise, color: 'var(--load-praise)' },
                    ]} />
                  </div>
                )}
              </Section>

              <Section icon={AlertTriangle} title="Scheduling Alerts" action={<ViewLink href="/scheduling">Open Scheduling</ViewLink>}>
                <ul className="space-y-2.5">
                  {alerts.map(({ label, count, href, icon: Icon }) => {
                    const clear = count === 0;
                    return (
                      <li key={label}>
                        <Link href={href}
                          className={`group flex items-center gap-3.5 px-4 py-3.5 rounded-xl border transition-colors ${clear ? 'bg-[#F8FAFC] border-[#E3E9F3] hover:bg-[#F1F5F9]' : 'bg-[#FFF7ED] border-[#FED7AA] hover:bg-[#FFEDD5]'}`}>
                          <span className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${clear ? 'bg-[#ECFDF5] text-[#059669]' : 'bg-white text-[#EA580C]'}`}>
                            {clear ? <CheckCircle2 className="w-5 h-5" /> : <Icon className="w-5 h-5" />}
                          </span>
                          <span className="flex-1 text-[15px] font-semibold text-[#0B2A5B]">
                            <b className="tabular-nums mr-1.5">{count}</b>{label}
                          </span>
                          <ChevronRight className="w-5 h-5 text-[#94A3B8] transition-transform group-hover:translate-x-0.5" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </Section>
            </motion.div>
          </>
        ) : (
          <div className="bg-white rounded-2xl border border-[#E3E9F3] px-5 py-16 text-center">
            <AlertTriangle className="w-8 h-8 mx-auto mb-3 text-[#94A3B8]" />
            <p className="font-semibold text-[#0B2A5B]">Could not load dashboard</p>
            <p className="text-[15px] mt-1 text-[#64748B]">
              The server may be restarting after an update — trying again automatically.
            </p>
            <motion.button
              type="button"
              onClick={() => load()}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="mt-5 inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors"
              style={{ color: '#FFFFFF' }}
            >
              Try again
            </motion.button>
          </div>
        )}
      </PageLoadTransition>
    </div>
  );
}
