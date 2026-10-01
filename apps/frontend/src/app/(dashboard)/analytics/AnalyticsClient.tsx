'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BookOpen, Building2, CalendarCheck,
  Monitor, UserX, Users,
} from 'lucide-react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { shownUnitsCap } from '@shared/regularLoad';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { CardSkeleton } from '@/components/ui/skeletons';
import LoadBreakdownDonut from '@/components/charts/LoadBreakdownDonut';
import { BarChart, EASE, Legend, LineChart, type Series } from './charts';
import DateRangeButton, { type Range } from './DateRangeButton';
import DetailModal, { type DetailKey, type Details } from './DetailModal';

/* ─── Data (GET /api/analytics?from&to — active term) ─────────────────────── */

type Kind = 'lec' | 'lab';
interface RoomUse { id: number; room_name: string; kind: Kind; pct: number }
interface AnalyticsData {
  range: Range;
  kpis: {
    rooms: { total: number; lec: number; lab: number };
    utilization: number;
    utilization_change: number;
    instructors: { total: number; permanent: number; contractual: number };
    conflicts: number;
  };
  room_status: { in_use: number; available: number; inactive: number };
  usage_by_day: ({ day: string } & Record<Kind, number>)[];
  usage_by_time: ({ start: number } & Record<Kind, number>)[];
  most_used: RoomUse[];
  least_used: RoomUse[];
  workload: { regular: number; overload: number; praise: number };
  class_types: Record<Kind, number>;
  scheduling: { scheduled: number; unassigned: number; conflicts: number; instructor_conflicts: number };
  capacity: { label: string; rooms: number }[];
  trends: { month: string; utilization: number; classes: number }[];
  details: Details;
  faculty_load: FacultyLoad[];
}

type LoadStatus = 'complete' | 'overload' | 'in_progress' | 'not_started';
interface FacultyLoad {
  faculty_id: number; name: string; current: number; limit: number;
  unit: 'units' | 'hours'; status: LoadStatus; needs_schedule: boolean;
}
/** Faculty load statuses, in reading order */
const LOAD_STATUS: { key: LoadStatus; label: string; color: string }[] = [
  { key: 'complete', label: 'Complete', color: '#10B981' },
  { key: 'overload', label: 'With Overload', color: '#1D5BD6' },
  { key: 'in_progress', label: 'In Progress', color: '#F59E0B' },
  { key: 'not_started', label: 'Not Started', color: '#94A3B8' },
];

const KIND: Record<Kind, { label: string; rooms: string; color: string }> = {
  lec: { label: 'Lecture', rooms: 'Lecture Rooms', color: '#1D5BD6' },
  lab: { label: 'Laboratory', rooms: 'Lab Rooms', color: '#F59E0B' },
};
const KINDS = Object.keys(KIND) as Kind[];
const roomSeries = <T extends Record<Kind, number>>(rows: T[]): Series[] =>
  KINDS.map(k => ({ key: k, label: KIND[k].rooms, color: KIND[k].color, values: rows.map(r => r[k]) }));
/** 420 → "7–9a" (short so all seven fit a one-third card) */
const bucketLabel = (min: number) => {
  const s = min / 60, e = s + 2;
  return `${s % 12 || 12}–${e % 12 || 12}${e < 12 ? 'a' : 'p'}`;
};
const percent = (n: number) => `${n}%`;

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'rooms', label: 'Room Utilization' },
  { id: 'workload', label: 'Faculty Workload' },
  { id: 'scheduling', label: 'Scheduling' },
  { id: 'classes', label: 'Class Distribution' },
  { id: 'capacity', label: 'Room Capacity' },
  { id: 'trends', label: 'Trends' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const TREND_METRICS = {
  utilization: { label: 'Room Utilization', format: percent, max: 100 },
  classes: { label: 'Scheduled Classes', format: String, max: undefined },
} as const;
type TrendMetric = keyof typeof TREND_METRICS;

/** Which tabs show each panel (Overview shows them all), in grid order */
const PANEL_TABS = {
  'room-status': ['rooms'],
  'by-day': ['rooms', 'scheduling', 'classes'],
  'most-least': ['rooms', 'capacity'],
  'faculty-load': ['workload'],
  workload: ['workload'],
  'class-type': ['classes'],
  'by-time': ['rooms', 'scheduling'],
  scheduling: ['scheduling', 'workload'],
  capacity: ['capacity', 'rooms'],
  trends: ['trends'],
} satisfies Record<string, Tab[]>;
type PanelId = keyof typeof PANEL_TABS;

/*
 * Wide desktop layout (>=1280 px): uses the screen's full width, and each row
 * of panels gets a comfortable height that grows with the screen (300-380 px)
 * so charts and rings stay large and readable. Smaller screens keep the
 * regular stacked layout.
 */
const WIDE_MIN_WIDTH = 1280;
const rowHeightFor = (screenH: number) => Math.round(Math.min(380, Math.max(300, screenH * 0.44)));

/** Visible height of the app's scroll area on a wide screen, else null */
function useWideScreen() {
  const [h, setH] = useState<number | null>(null);
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-app-scroll]');
    const calc = () => setH(window.innerWidth >= WIDE_MIN_WIDTH ? el?.clientHeight ?? window.innerHeight : null);
    calc();
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, []);
  return h;
}

function ViewAll({ href }: { href: string }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-1 text-xs font-semibold text-[#1D5BD6] hover:text-[#12408F] transition-colors whitespace-nowrap">
      View All <ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
    </Link>
  );
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="qr-donut-panel rounded-2xl min-w-0 h-full flex flex-col p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 min-h-5">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#1D5BD6] whitespace-nowrap">{title}</p>
        {action}
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

/** Tiny progress ring used as the Room Utilization KPI's icon */
function MiniRing({ value, color }: { value: number; color: string }) {
  const r = 17, c = 2 * Math.PI * r;
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" className="-rotate-90">
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--donut-track)" strokeWidth="5" />
      <motion.circle cx="22" cy="22" r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
        initial={{ strokeDasharray: `0 ${c}` }} animate={{ strokeDasharray: `${(Math.min(100, value) / 100) * c} ${c}` }}
        transition={{ duration: 0.8, ease: EASE, delay: 0.2 }} />
    </svg>
  );
}

/** Summary card — clicking it pops up its details in the centre */
function Kpi({ icon, tone, label, value, sub, index, onOpen }: {
  icon: ReactNode; tone: string; label: string; value: ReactNode; sub: ReactNode; index: number; onOpen: () => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      aria-label={`${label} — show details`}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE, delay: index * 0.06 } }}
      whileHover={reduceMotion ? undefined : { y: -3, boxShadow: `0 14px 28px -16px ${tone}88` }}
      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
      className="group qr-stat-tint relative h-full w-full text-left rounded-2xl border px-5 py-4 flex items-start gap-3.5 min-w-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40"
      style={{ background: `linear-gradient(135deg, ${tone}12 0%, #FFFFFF 70%)`, borderColor: `${tone}30` }}
    >
      <ArrowRight
        className="absolute top-4 right-4 w-4 h-4 opacity-0 -translate-x-1 transition-all duration-300 group-hover:opacity-100 group-hover:translate-x-0"
        style={{ color: tone }}
        aria-hidden="true"
      />
      <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ color: tone, backgroundColor: `${tone}14` }}>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[#475569] truncate">{label}</p>
        <p className="text-[26px] font-bold text-[#0B2A5B] leading-tight tabular-nums">{value}</p>
        <div className="text-[13px] text-[#64748B] mt-0.5">{sub}</div>
      </div>
    </motion.button>
  );
}

function Split({ a, b }: { a: string; b: string }) {
  return <span className="flex flex-wrap gap-x-1.5"><span>{a}</span><span className="text-[#CBD5E1]">|</span><span>{b}</span></span>;
}

function RoomRank({ title, rooms }: { title: string; rooms: RoomUse[] }) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="min-w-0">
      <p className="text-sm font-bold text-[#0B2A5B] mb-3">{title}</p>
      {rooms.length === 0 ? <p className="text-sm text-[#94A3B8]">No room hours in this range.</p> : (
        <ul className="space-y-3">
          {rooms.map((r, i) => (
            <li key={r.id} className="text-sm">
              <div className="flex items-center gap-1.5">
                {r.kind === 'lab' ? <Monitor className="w-3.5 h-3.5 text-[#D97706]" /> : <BookOpen className="w-3.5 h-3.5 text-[#1D5BD6]" />}
                <span className="font-semibold text-[#0B2A5B] truncate">{r.room_name}</span>
                <span className="ml-auto font-bold tabular-nums text-[#0B2A5B]">{r.pct}%</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--donut-track)' }}>
                <motion.div className="h-full rounded-full" style={{ backgroundColor: KIND[r.kind].color }}
                  initial={reduceMotion ? false : { width: 0 }} animate={{ width: `${r.pct}%` }}
                  transition={{ duration: reduceMotion ? 0 : 0.6, ease: EASE, delay: reduceMotion ? 0 : i * 0.06 }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SchedulingOverview({ s, wide }: { s: AnalyticsData['scheduling']; wide: boolean }) {
  const items = [
    { icon: CalendarCheck, tone: '#1D5BD6', label: 'Scheduled Classes', value: s.scheduled },
    { icon: UserX, tone: '#F59E0B', label: 'Unassigned Classes', value: s.unassigned },
    { icon: AlertTriangle, tone: '#DC2626', label: 'Scheduling Conflicts', value: s.conflicts, alert: true },
    { icon: Users, tone: '#6366F1', label: 'Faculty Conflicts', value: s.instructor_conflicts, alert: true },
  ];
  return (
    <div className={`grid gap-x-4 gap-y-6 ${wide ? 'grid-cols-4' : 'grid-cols-2'}`}>
      {items.map(({ icon: Icon, tone, label, value, alert }) => (
        <div key={label} className="min-w-0">
          <span className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ color: tone, backgroundColor: `${tone}14` }}>
            <Icon className="w-5 h-5" />
          </span>
          <p className="text-[13px] font-medium text-[#64748B] leading-tight" style={{ minHeight: '2.5em' }}>{label}</p>
          <p className="text-2xl font-bold text-[#0B2A5B] tabular-nums mt-1">{value}</p>
          {alert && value > 0 && <p className="text-xs font-semibold text-[#DC2626]">Needs attention</p>}
        </div>
      ))}
    </div>
  );
}

function CapacityBars({ rows }: { rows: AnalyticsData['capacity'] }) {
  const reduceMotion = useReducedMotion();
  const total = rows.reduce((s, r) => s + r.rooms, 0);
  return (
    <ul className="space-y-5">
      {rows.map((r, i) => {
        const share = total ? Math.round((r.rooms / total) * 100) : 0;
        return (
          <li key={r.label} className="grid grid-cols-[84px_minmax(0,1fr)_76px] items-center gap-3 text-sm">
            <span className="text-[#475569] font-medium">{r.label}</span>
            <div className="h-2.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--donut-track)' }}>
              <motion.div className="h-full rounded-full" style={{ backgroundColor: ['#93B4F0', '#4F86EE', '#1D5BD6', '#12408F'][i] }}
                initial={reduceMotion ? false : { width: 0 }} animate={{ width: `${share}%` }}
                transition={{ duration: reduceMotion ? 0 : 0.6, ease: EASE, delay: reduceMotion ? 0 : i * 0.08 }} />
            </div>
            <span className="text-right tabular-nums text-[#0B2A5B] font-semibold">{r.rooms} <span className="text-[#94A3B8] font-normal">({share}%)</span></span>
          </li>
        );
      })}
    </ul>
  );
}

/** Where every faculty member's regular load stands — donut + one column per status */
function FacultyLoadPanel({ rows, ring }: { rows: FacultyLoad[]; ring?: number }) {
  const reduceMotion = useReducedMotion();
  const fmt = (n: number) => (Math.abs(n - Math.round(n)) < 0.001 ? String(Math.round(n)) : n.toFixed(2));
  return (
    <Panel title="Faculty Load Status" action={<ViewAll href="/workload" />}>
      <div className="h-full grid grid-cols-1 xl:grid-cols-[420px_minmax(0,1fr)] gap-6 min-h-0">
        <LoadBreakdownDonut bare compact ringSize={ring} centerLabel="Faculty"
          slices={LOAD_STATUS.map(s => ({ key: s.key, label: s.label, value: rows.filter(r => r.status === s.key).length, color: s.color }))} />
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 min-h-0">
          {LOAD_STATUS.map(st => {
            const list = rows.filter(r => r.status === st.key);
            return (
              <div key={st.key} className="min-w-0 flex flex-col min-h-0 rounded-xl border border-[#E3E9F3] bg-white/60">
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#EEF2F8]">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: st.color }} />
                  <span className="text-[13px] font-bold text-[#0B2A5B] truncate">{st.label}</span>
                  <span className="ml-auto text-[13px] font-bold tabular-nums text-[#475569]">{list.length}</span>
                </div>
                {list.length === 0 ? (
                  <p className="px-3 py-4 text-[13px] text-[#94A3B8]">None yet</p>
                ) : (
                  <ul className="flex-1 min-h-0 overflow-y-auto max-h-56 divide-y divide-[#F1F5F9]">
                    {list.map((f, i) => (
                      <li key={f.faculty_id}>
                        <Link href={`/workload?facultyId=${f.faculty_id}`} className="block px-3 py-2 hover:bg-[#F4F7FC] transition-colors">
                          <p className="text-[13px] font-semibold text-[#0B2A5B] truncate">{f.name}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--donut-track)' }}>
                              <motion.div className="h-full rounded-full" style={{ backgroundColor: st.color }}
                                initial={reduceMotion ? false : { width: 0 }}
                                animate={{ width: `${f.limit ? Math.min(100, (f.current / f.limit) * 100) : 0}%` }}
                                transition={{ duration: reduceMotion ? 0 : 0.5, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 8) * 0.03 }} />
                            </div>
                            <span className="text-[11px] text-[#64748B] tabular-nums whitespace-nowrap">{fmt(f.current)}/{fmt(f.unit === 'units' ? shownUnitsCap(f.limit) : f.limit)} {f.unit === 'units' ? 'u' : 'h'}</span>
                          </div>
                          {f.needs_schedule && <p className="text-[11px] font-semibold text-[#C2410C] mt-0.5">Needs a class schedule</p>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

export default function AnalyticsPage() {
  const reduceMotion = useReducedMotion();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [range, setRange] = useState<Range | null>(null); // null → server default (last 30 days)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [metric, setMetric] = useState<TrendMetric>('utilization');
  const [detail, setDetail] = useState<DetailKey | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const screenH = useWideScreen();
  const fit = screenH != null; // wide desktop layout
  const ring = fit ? 170 : undefined;

  const load = useCallback(async (silent = false) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    if (!silent) setLoading(true);
    try {
      const qs = range ? `?from=${range.from}&to=${range.to}` : '';
      const res = await fetch(`/api/analytics${qs}`, { signal: ac.signal, cache: 'no-store' });
      if (!res.ok) throw new Error();
      setData(await res.json());
      setError(false);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError' && !silent) setError(true);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);
  useRealtime(['term', 'rooms', 'occupancy', 'schedule', 'workload', 'blocks', 'faculty'], () => load(true), { enabled: !loading });
  useVisibilityAwareInterval(() => load(true), 60_000);

  const showSkeleton = useMinLoading(loading && !data, PAGE_SKELETON_MIN_MS);
  const k = data?.kpis;

  const visibleIds = (Object.keys(PANEL_TABS) as PanelId[])
    .filter(id => tab === 'overview' || (PANEL_TABS[id] as readonly Tab[]).includes(tab));

  const panels: { id: PanelId; node: ReactNode; span?: string }[] = data ? [
    {
      id: 'room-status',
      node: (
        <LoadBreakdownDonut compact ringSize={ring} title="Room Utilization" action={<ViewAll href="/room-utilization" />}
          centerValue={`${data.kpis.utilization}%`} centerLabel="Utilization Rate"
          slices={[
            { key: 'in_use', label: 'In Use', value: data.room_status.in_use, color: '#1D5BD6' },
            { key: 'available', label: 'Available', value: data.room_status.available, color: '#7FA8F0' },
            { key: 'inactive', label: 'Inactive', value: data.room_status.inactive, color: '#94A3B8' },
          ]} />
      ),
    },
    {
      id: 'by-day',
      node: (
        <Panel title="Room Usage by Day" action={<Legend series={roomSeries(data.usage_by_day)} />}>
          <BarChart labels={data.usage_by_day.map(d => d.day.slice(0, 3))} series={roomSeries(data.usage_by_day)} fill={fit} />
        </Panel>
      ),
    },
    {
      id: 'most-least',
      node: (
        <Panel title="Most & Least Utilized Rooms" action={<ViewAll href="/room-utilization" />}>
          <div className="grid grid-cols-2 gap-5">
            <RoomRank title="Most Utilized" rooms={data.most_used} />
            <RoomRank title="Least Utilized" rooms={data.least_used} />
          </div>
        </Panel>
      ),
    },
    {
      id: 'faculty-load',
      span: 'md:col-span-2 xl:col-span-3',
      node: <FacultyLoadPanel rows={data.faculty_load} ring={ring} />,
    },
    {
      id: 'workload',
      node: (
        <LoadBreakdownDonut compact ringSize={ring} title="Faculty Workload" action={<ViewAll href="/faculty-schedules" />} centerLabel="Faculty"
          slices={[
            { key: 'regular', label: 'Regular', value: data.workload.regular, color: 'var(--load-regular)' },
            { key: 'overload', label: 'Overload', value: data.workload.overload, color: 'var(--load-overload)' },
            { key: 'praise', label: 'Praise', value: data.workload.praise, color: 'var(--load-praise)' },
          ]} />
      ),
    },
    {
      id: 'class-type',
      node: (
        <LoadBreakdownDonut compact ringSize={ring} title="Class Type Distribution" centerLabel="Total Classes"
          slices={KINDS.map(kd => ({ key: kd, label: KIND[kd].label, value: data.class_types[kd], color: KIND[kd].color }))} />
      ),
    },
    {
      id: 'by-time',
      node: (
        <Panel title="Room Usage by Time" action={<Legend series={roomSeries(data.usage_by_time)} />}>
          <LineChart labels={data.usage_by_time.map(b => bucketLabel(b.start))} series={roomSeries(data.usage_by_time)} fill={fit} />
        </Panel>
      ),
    },
    {
      id: 'scheduling',
      node: (
        <Panel title="Scheduling Overview" action={<ViewAll href="/scheduling" />}>
          <SchedulingOverview s={data.scheduling} wide={fit} />
        </Panel>
      ),
    },
    {
      id: 'capacity',
      node: (
        <Panel title="Room Capacity Utilization" action={<ViewAll href="/rooms" />}>
          <CapacityBars rows={data.capacity} />
        </Panel>
      ),
    },
    {
      id: 'trends',
      node: (
        <Panel title="Overall Trends" action={
          <select value={metric} onChange={e => setMetric(e.target.value as TrendMetric)} aria-label="Trend metric"
            className="h-8 rounded-lg border border-[#D6E0EF] bg-white px-2 text-xs font-medium text-[#0B2A5B] focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/25">
            {(Object.keys(TREND_METRICS) as TrendMetric[]).map(m => <option key={m} value={m}>{TREND_METRICS[m].label}</option>)}
          </select>
        }>
          <LineChart
            key={metric}
            labels={data.trends.map(t => t.month)}
            series={[{ key: metric, label: TREND_METRICS[metric].label, color: '#1D5BD6', values: data.trends.map(t => t[metric]) }]}
            format={TREND_METRICS[metric].format}
            max={TREND_METRICS[metric].max}
            fill={fit}
          />
        </Panel>
      ),
    },
  ] : [];
  const visible = panels.filter(p => visibleIds.includes(p.id));
  const change = k?.utilization_change ?? 0;

  return (
    <div
      className={`mx-auto w-full min-w-0 space-y-5 ${fit ? '' : 'p-4 sm:p-6 max-w-7xl'}`}
      style={fit ? { maxWidth: 1680, padding: '24px 28px 32px' } : undefined}
    >
      <div className="flex-shrink-0">
        <BackButton />
        <div className="mt-4 sm:mt-7 mb-4">
          <WatermarkTitle>Analytics</WatermarkTitle>
        </div>
        {/* Tabs · date range */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div role="tablist" aria-label="Analytics sections"
            className="flex-1 min-w-0 flex gap-1 overflow-x-auto p-1 rounded-full bg-[#EAF0FA] border border-[#DCE5F3]" style={{ scrollbarWidth: 'none' }}>
            {TABS.map(t => {
              const on = t.id === tab;
              return (
                <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => setTab(t.id)}
                  className={`relative flex-shrink-0 px-4 h-10 rounded-full text-sm font-semibold transition-colors ${on ? '' : 'text-[#475569] hover:text-[#0B2A5B]'}`}
                  style={on ? { color: '#FFFFFF' } : undefined}>
                  {on && <motion.span layoutId="analytics-tab" className="absolute inset-0 rounded-full bg-[#0B2A5B] shadow-[0_4px_12px_-4px_rgba(11,42,91,0.5)]"
                    transition={{ duration: reduceMotion ? 0 : 0.35, ease: EASE }} />}
                  <span className="relative">{t.label}</span>
                </button>
              );
            })}
          </div>
          <div className="self-end lg:self-auto">
            <DateRangeButton value={range ?? data?.range ?? null} onChange={setRange} loading={loading && !!data} />
          </div>
        </div>
      </div>

      {error && !data ? (
        <p className="py-16 text-center text-sm text-[#64748B]">Unable to load analytics. Please try again.</p>
      ) : (
        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={
            <div className="space-y-5" role="status" aria-label="Loading analytics">
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                {Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} className="h-24" />)}
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                {Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} className="h-64" />)}
              </div>
            </div>
          }
        >
          {data && k ? (
            <div className={`space-y-5 transition-opacity duration-300 ${loading ? 'opacity-60' : ''}`}>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 flex-shrink-0">
                <Kpi index={0} onOpen={() => setDetail('rooms')} tone="#1D5BD6" icon={<Building2 className="w-5 h-5" />} label="Total Rooms" value={k.rooms.total}
                  sub={<Split a={`Lecture: ${k.rooms.lec}`} b={`Lab: ${k.rooms.lab}`} />} />
                <Kpi index={1} onOpen={() => setDetail('utilization')} tone="#10B981" icon={<MiniRing value={k.utilization} color="#10B981" />} label="Room Utilization Rate" value={`${k.utilization}%`}
                  sub={
                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                      <span className={`inline-flex items-center font-semibold ${change > 0 ? 'text-[#059669]' : change < 0 ? 'text-[#DC2626]' : 'text-[#64748B]'}`}>
                        {change > 0 ? <ArrowUp className="w-3 h-3" /> : change < 0 ? <ArrowDown className="w-3 h-3" /> : null}
                        {Math.abs(change)}%
                      </span>
                      vs. last period
                    </span>
                  } />
                <Kpi index={2} onOpen={() => setDetail('faculty')} tone="#6366F1" icon={<Users className="w-5 h-5" />} label="Total Faculty" value={k.instructors.total}
                  sub={<Split a={`Permanent: ${k.instructors.permanent}`} b={`Contractual: ${k.instructors.contractual}`} />} />
                <Kpi index={3} onOpen={() => setDetail('conflicts')} tone="#DC2626" icon={<AlertTriangle className="w-5 h-5" />} label="Scheduling Conflicts" value={k.conflicts}
                  sub={k.conflicts > 0 ? <span className="font-semibold text-[#DC2626]">Requires attention</span> : <span className="font-semibold text-[#059669]">All clear</span>} />
              </div>

              <motion.div
                layout={!reduceMotion}
                className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 items-stretch gap-5"
                style={screenH != null ? { gridAutoRows: `${rowHeightFor(screenH)}px` } : undefined}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  {visible.map(p => (
                    <motion.div
                      key={p.id}
                      layout={!reduceMotion}
                      initial={reduceMotion ? false : { opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1, transition: { duration: 0.35, ease: EASE } }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, transition: { duration: 0.2, ease: EASE } }}
                      className={`min-w-0 min-h-0 [&>*]:h-full ${p.span ?? ''}`}
                    >
                      {p.node}
                    </motion.div>
                  ))}
                </AnimatePresence>
              </motion.div>
            </div>
          ) : null}
        </PageLoadTransition>
      )}

      {data && <DetailModal open={detail} details={data.details} rate={data.kpis.utilization} onClose={() => setDetail(null)} />}
    </div>
  );
}
