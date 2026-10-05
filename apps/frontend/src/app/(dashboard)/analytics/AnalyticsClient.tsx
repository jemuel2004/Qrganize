'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BookOpen, Building2, CalendarCheck, CalendarDays,
  CheckCircle2, Clock, Monitor, Users,
} from 'lucide-react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { shownUnitsCap } from '@shared/regularLoad';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { CardSkeleton } from '@/components/ui/skeletons';
import {
  busiest, ColumnChart, EASE, hourRange, hourShort, Meter, MiniBars, PartLegend, PieChart, SeriesLegend, VIZ_VARS, type Part,
} from './charts';
import DateRangeButton, { type Range } from './DateRangeButton';
import DetailModal, { type DetailKey, type Details } from './DetailModal';

/*
 * Analytics — two questions, in reading order:
 *   1. How far along is this term's work? (classes scheduled, faculty loads)
 *   2. How are the rooms used? (busiest hours, most / least used rooms)
 * Four summary tiles on top answer both at a glance; each opens its details.
 */

/* ─── Data (GET /api/analytics?from&to — active term) ─────────────────────── */

type Kind = 'lec' | 'lab';
type HeatKind = 'all' | Kind;
interface RoomUse { id: number; room_name: string; kind: Kind; pct: number }
interface AnalyticsData {
  range: Range;
  term?: { semester: string | null; school_year: string | null };
  kpis: {
    rooms: { total: number; lec: number; lab: number };
    utilization: number;
    utilization_change: number;
    utilization_by_kind?: Record<Kind, number>;
    instructors: { total: number; permanent: number; contractual: number };
    conflicts: number;
  };
  most_used: RoomUse[];
  least_used: RoomUse[];
  scheduling: { scheduled: number; unassigned: number };
  offerings: {
    total: number;
    scheduled: number;
    stages?: { scheduled: number; needs_schedule: number; no_faculty: number };
    unscheduled_by_program: { program: string; count: number }[];
  };
  conflict_counts: { room: number; faculty: number; block: number };
  /** % of each day's bookable room time that is booked */
  usage_by_day_pct?: ({ day: string } & Record<HeatKind, number>)[];
  heatmap: {
    hours: number[];
    rooms?: Record<HeatKind, number>;
    days: ({ day: string; values: number[] } & Partial<Record<HeatKind, number[]>>)[];
  };
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
/** Faculty load statuses, in reading order (grey = not started yet) */
const LOAD_STATUS: { key: LoadStatus; label: string; color: string }[] = [
  { key: 'complete', label: 'Complete', color: '#10B981' },
  { key: 'overload', label: 'With Overload', color: '#1D5BD6' },
  { key: 'in_progress', label: 'In Progress', color: '#F59E0B' },
  { key: 'not_started', label: 'Not Started', color: '#94A3B8' },
];

/* Room types keep their colours from Room Management: Lecture blue, Laboratory amber */
const KIND: Record<Kind, { label: string; rooms: string; color: string; Icon: typeof BookOpen }> = {
  lec: { label: 'Lecture', rooms: 'Lecture rooms', color: '#1D5BD6', Icon: BookOpen },
  lab: { label: 'Laboratory', rooms: 'Lab rooms', color: '#F59E0B', Icon: Monitor },
};

const shortDate = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/** Where each class stands (older backends: worked out from the totals) */
function stagesOf(d: AnalyticsData) {
  if (d.offerings.stages) return d.offerings.stages;
  const open = Math.max(0, d.offerings.total - d.offerings.scheduled);
  const noFaculty = Math.min(open, d.scheduling.unassigned);
  return { scheduled: d.offerings.scheduled, needs_schedule: open - noFaculty, no_faculty: noFaculty };
}

/** Rooms in use per [day][hour] for one room type (older backends: % of all rooms only) */
function heatCounts(d: AnalyticsData, kind: HeatKind) {
  const total = d.heatmap.rooms?.[kind] ?? d.kpis.rooms.total;
  const counts = d.heatmap.days.map(day => day[kind] ?? day.values.map(v => Math.round((v / 100) * total)));
  return { total, counts };
}

/* ─── Building blocks ─────────────────────────────────────────────────────── */

function ViewAll({ href, label = 'View all' }: { href: string; label?: string }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-1 h-9 px-3 -mr-2 rounded-lg text-[13px] font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors whitespace-nowrap">
      {label} <ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
    </Link>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="text-[13px] font-bold uppercase tracking-[0.12em] text-[#64748B] mb-3">{children}</h2>;
}

/** Plain white card: title, a short line saying what it shows, optional link */
function Card({ index, title, subtitle, action, className = '', children }: {
  index: number; title: string; subtitle?: ReactNode; action?: ReactNode; className?: string; children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE, delay: reduceMotion ? 0 : 0.15 + index * 0.07 } }}
      className={`bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_2px_rgba(11,42,91,0.05)] p-5 sm:p-6 min-w-0 flex flex-col ${className}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 mb-5">
        <div className="min-w-0">
          <h3 className="text-[17px] font-bold text-[#0B2A5B] leading-tight">{title}</h3>
          {subtitle && <div className="text-[13px] text-[#64748B] mt-1">{subtitle}</div>}
        </div>
        {action}
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </motion.section>
  );
}

/** Summary tile — a link to its page or a button that opens its details */
function StatTile({ index, icon: Icon, tone = 'var(--viz-accent)', label, value, context, href, onOpen, children }: {
  index: number; icon: typeof Users; tone?: string; label: string; value: ReactNode; context?: ReactNode;
  href?: string; onOpen?: () => void; children?: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-[#EFF6FF]" style={{ color: tone }}>
          <Icon className="w-[18px] h-[18px]" />
        </span>
        <span className="text-sm font-semibold text-[#475569] min-w-0 truncate">{label}</span>
        <ArrowRight className="ml-auto w-4 h-4 flex-shrink-0 text-[#94A3B8] transition-all duration-200 group-hover:text-[#1D5BD6] group-hover:translate-x-0.5" aria-hidden />
      </div>
      <p className="mt-4 text-[32px] leading-none font-bold text-[#0B2A5B]">{value}</p>
      {context && <p className="mt-1.5 text-[13px] text-[#64748B]">{context}</p>}
      {children && <div className="mt-4">{children}</div>}
    </>
  );
  const cls = 'group flex flex-col justify-start h-full w-full text-left bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_2px_rgba(11,42,91,0.05)] p-5 transition-colors hover:border-[#BFD3F5] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40';
  return (
    <motion.div
      className="h-full min-w-0"
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE, delay: reduceMotion ? 0 : index * 0.06 } }}
      whileHover={reduceMotion ? undefined : { y: -3 }}
      whileTap={reduceMotion ? undefined : { scale: 0.985 }}
    >
      {href
        ? <Link href={href} className={cls}>{body}</Link>
        : <button type="button" onClick={onOpen} className={cls}>{body}</button>}
    </motion.div>
  );
}

/** Small segmented switch (one navy pill slides to the option picked) */
function Toggle<K extends string>({ options, value, onChange, label, layoutId }: {
  options: { key: K; label: string }[]; value: K; onChange: (k: K) => void; label: string; layoutId: string;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-1 rounded-full bg-[#F1F5F9] border border-[#E2E8F0]">
      {options.map(o => {
        const on = o.key === value;
        return (
          <button key={o.key} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.key)}
            className={`relative h-8 px-3.5 rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors ${on ? '' : 'text-[#334155] hover:text-[#0B2A5B]'}`}
            style={on ? { color: '#FFFFFF' } : undefined}>
            {on && <motion.span layoutId={layoutId} aria-hidden className="absolute inset-0 rounded-full shadow-sm" style={{ backgroundColor: '#0B2A5B' }}
              transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }} />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ─── Cards ───────────────────────────────────────────────────────────────── */

function SchedulingCard({ data, index }: { data: AnalyticsData; index: number }) {
  const reduceMotion = useReducedMotion();
  const [slice, setSlice] = useState<string | null>(null);
  const st = stagesOf(data);
  const total = st.scheduled + st.needs_schedule + st.no_faculty;
  const parts: Part[] = [
    { key: 'scheduled', label: 'Scheduled', value: st.scheduled, color: 'var(--stage-1)' },
    { key: 'needs', label: 'Needs a time', value: st.needs_schedule, color: 'var(--stage-2)' },
    { key: 'none', label: 'No faculty yet', value: st.no_faculty, color: 'var(--stage-3)' },
  ];
  const programs = data.offerings.unscheduled_by_program.slice(0, 6);
  const top = Math.max(1, ...programs.map(p => p.count));
  return (
    <Card index={index} title="Scheduling progress" subtitle={`${total} classes this term`} action={<ViewAll href="/scheduling" label="Open Scheduling" />}>
      <div className="flex items-center gap-5">
        <PieChart parts={parts} size={150} active={slice} onActive={setSlice} label="Classes this term" />
        <p className="min-w-0">
          <span className="block text-[38px] leading-none font-bold text-[#0B2A5B]">{share(st.scheduled, total)}%</span>
          <span className="block mt-1.5 text-sm text-[#64748B]">of classes have a day and time</span>
        </p>
      </div>
      <div className="mt-4"><PartLegend parts={parts} active={slice} onActive={setSlice} /></div>

      {programs.length > 0 && (
        <div className="mt-6 pt-5 border-t border-[#EEF2F7]">
          <p className="text-[13px] font-bold text-[#0B2A5B] mb-3">Still to schedule, by program</p>
          <ul className="space-y-2.5">
            {programs.map((p, i) => (
              <li key={p.program} className="grid grid-cols-[4.5rem_minmax(0,1fr)_2.5rem] items-center gap-3 text-sm">
                <span className="font-semibold text-[#334155] truncate">{p.program}</span>
                <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--donut-track)' }}>
                  <motion.div className="h-full rounded-full" style={{ backgroundColor: 'var(--viz-accent)' }}
                    initial={reduceMotion ? false : { width: 0 }} animate={{ width: `${(p.count / top) * 100}%` }}
                    transition={{ duration: reduceMotion ? 0 : 0.6, ease: EASE, delay: reduceMotion ? 0 : 0.2 + i * 0.06 }} />
                </div>
                <span className="text-right font-bold text-[#0B2A5B] tabular-nums">{p.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** Where every faculty member's regular load stands — one bar, then the names under each status */
function FacultyLoadCard({ data, index, onFaculty }: { data: AnalyticsData; index: number; onFaculty: () => void }) {
  const reduceMotion = useReducedMotion();
  const [slice, setSlice] = useState<string | null>(null);
  const rows = data.faculty_load;
  const fmt = (n: number) => (Math.abs(n - Math.round(n)) < 0.001 ? String(Math.round(n)) : n.toFixed(2));
  const parts: Part[] = LOAD_STATUS.map(s => ({ key: s.key, label: s.label, value: rows.filter(r => r.status === s.key).length, color: s.color }));
  const needs = rows.filter(r => r.needs_schedule).length;
  const k = data.kpis.instructors;
  return (
    <Card
      index={index}
      title="Faculty load status"
      subtitle={
        <button type="button" onClick={onFaculty} className="font-medium text-[#475569] hover:text-[#1D5BD6] underline-offset-2 hover:underline">
          {k.total} faculty · {k.permanent} permanent · {k.contractual} contractual
        </button>
      }
      action={<ViewAll href="/workload" label="Open Workload" />}
    >
      <div className="flex flex-col sm:flex-row items-center gap-6">
        <PieChart parts={parts} size={168} active={slice} onActive={setSlice} label="Faculty by load status" />
        <div className="w-full min-w-0">
          <PartLegend parts={parts} columns={2} active={slice} onActive={setSlice} />
          {needs > 0 && (
            <p className="mt-3 mx-2 inline-flex items-center gap-2 rounded-lg bg-[#FFF7ED] border border-[#FED7AA] px-3 py-2 text-[13px] font-semibold text-[#9A3412]">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              {needs} {needs === 1 ? 'faculty member has' : 'faculty have'} a load but still need a class schedule
            </p>
          )}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {LOAD_STATUS.map(st => {
          const list = rows.filter(r => r.status === st.key);
          return (
            <div key={st.key} className="min-w-0 flex flex-col rounded-xl border border-[#E3E9F3]">
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[#EEF2F8]">
                <span className="w-2.5 h-2.5 rounded-[3px]" style={{ backgroundColor: st.color }} aria-hidden />
                <span className="text-[13px] font-bold text-[#0B2A5B] truncate">{st.label}</span>
                <span className="ml-auto text-[13px] font-bold tabular-nums text-[#475569]">{list.length}</span>
              </div>
              {list.length === 0 ? (
                <p className="px-3 py-4 text-[13px] text-[#94A3B8]">None</p>
              ) : (
                <ul className="overflow-y-auto max-h-56 divide-y divide-[#F1F5F9]">
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
                          <span className="text-[11px] text-[#64748B] tabular-nums whitespace-nowrap">
                            {fmt(f.current)}/{fmt(f.unit === 'units' ? shownUnitsCap(f.limit) : f.limit)} {f.unit === 'units' ? 'u' : 'h'}
                          </span>
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
    </Card>
  );
}

/** Bar graph: how much of each day's room time is booked, lecture vs lab rooms */
function UseByDayCard({ data, index }: { data: AnalyticsData; index: number }) {
  // Older backends: worked out from the hourly counts (each room-hour of a 10-hour class day)
  const rows = data.usage_by_day_pct ?? data.heatmap.days.map(d => {
    const of = (k: HeatKind, total: number) => (total ? Math.min(100, Math.round(((d[k] ?? []).reduce((s, n) => s + n, 0) / (total * 10)) * 1000) / 10) : 0);
    const rooms = data.heatmap.rooms;
    return { day: d.day, all: d.values.reduce((s, v) => s + v, 0) / 10, lec: rooms ? of('lec', rooms.lec) : 0, lab: rooms ? of('lab', rooms.lab) : 0 };
  });
  const series = (['lec', 'lab'] as Kind[]).map(k => ({ key: k, label: KIND[k].rooms, color: KIND[k].color, values: rows.map(r => r[k]) }));
  const free = rows.filter(r => r.all === 0).map(r => r.day);
  return (
    <Card index={index} title="Room use by day" subtitle="Share of each day's room hours that are booked" action={<SeriesLegend series={series} />}>
      <ColumnChart
        labels={rows.map(r => r.day.slice(0, 3))}
        titles={rows.map(r => r.day)}
        series={series}
        max={100}
        format={n => `${Math.round(n * 10) / 10}%`}
        height={220}
        details={i => <p className="mt-1 pt-1 border-t border-[#EEF2F7] text-[12px] text-[#64748B]">All rooms: <span className="font-semibold text-[#0B2A5B]">{rows[i].all}%</span></p>}
      />
      {free.length > 0 && free.length < rows.length && (
        <p className="mt-4 text-[13px] text-[#475569]">No classes on <span className="font-semibold text-[#0B2A5B]">{free.join(', ')}</span> — rooms are free all day.</p>
      )}
    </Card>
  );
}

/** Bar graph: rooms in use each hour of the day picked (opens on the busiest day) */
function BusiestHoursCard({ data, index }: { data: AnalyticsData; index: number }) {
  const { total, counts } = heatCounts(data, 'all');
  const days = data.heatmap.days.map(d => d.day);
  const hours = data.heatmap.hours;
  const peak = busiest(counts);
  const [picked, setPicked] = useState<string | null>(null);
  const day = picked ?? days[peak.d] ?? days[0];
  const d = Math.max(0, days.indexOf(day));
  const row = data.heatmap.days[d];
  return (
    <Card index={index} title="Busiest hours" subtitle="Rooms in use each hour, 7 AM–6 PM">
      <div className="mb-4">
        <Toggle options={days.map(x => ({ key: x, label: x.slice(0, 3) }))} value={day} onChange={setPicked} label="Day" layoutId="analytics-hours-day" />
      </div>
      {peak.n > 0 && (
        <div className="mb-4 flex items-start gap-2.5 text-sm text-[#475569]">
          <span className="w-7 h-7 rounded-lg bg-[#EFF6FF] text-[#1D5BD6] flex items-center justify-center flex-shrink-0"><Clock className="w-4 h-4" /></span>
          <p className="pt-1">
            Busiest of the week: <span className="font-bold text-[#0B2A5B] whitespace-nowrap">{days[peak.d]}, {hourRange(hours[peak.h])}</span>
            {' '}— {peak.n} of {total} rooms ({share(peak.n, total)}%)
          </p>
        </div>
      )}
      <ColumnChart
        key={day}
        labels={hours.map(hourShort)}
        titles={hours.map(h => `${day}, ${hourRange(h)}`)}
        series={[{ key: 'all', label: `of ${total} rooms in use`, color: 'var(--viz-accent)', values: counts[d] ?? [] }]}
        format={n => String(Math.round(n))}
        max={Math.max(4, total)}
        height={200}
        labelMax
        details={i => row?.lec && row?.lab
          ? <p className="mt-1 text-[12px] text-[#64748B]">Lecture {row.lec[i]} · Lab {row.lab[i]}</p>
          : null}
      />
    </Card>
  );
}

function RoomRank({ title, rooms }: { title: string; rooms: RoomUse[] }) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="min-w-0">
      <p className="text-[13px] font-bold text-[#0B2A5B] mb-3">{title}</p>
      {rooms.length === 0 ? <p className="text-sm text-[#94A3B8]">No rooms yet.</p> : (
        <ul className="space-y-3">
          {rooms.map((r, i) => {
            const Icon = KIND[r.kind].Icon;
            return (
              <li key={r.id} className="text-sm">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: KIND[r.kind].color }} aria-label={KIND[r.kind].label} />
                  <span className="font-semibold text-[#334155] truncate">{r.room_name}</span>
                  <span className="ml-auto pl-1 font-bold tabular-nums text-[#0B2A5B]">{r.pct}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--donut-track)' }}>
                  <motion.div className="h-full rounded-full" style={{ backgroundColor: KIND[r.kind].color }}
                    initial={reduceMotion ? false : { width: 0 }} animate={{ width: `${r.pct}%` }}
                    transition={{ duration: reduceMotion ? 0 : 0.6, ease: EASE, delay: reduceMotion ? 0 : 0.2 + i * 0.06 }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RoomUseCard({ data, index, onRooms }: { data: AnalyticsData; index: number; onRooms: () => void }) {
  const r = data.kpis.rooms;
  const byKind = data.kpis.utilization_by_kind;
  const underHalf = data.capacity.find(c => c.label === 'Under 50%')?.rooms ?? 0;
  return (
    <Card
      index={index}
      title="Room utilization"
      subtitle={
        <button type="button" onClick={onRooms} className="font-medium text-[#475569] hover:text-[#1D5BD6] underline-offset-2 hover:underline">
          {r.total} active rooms · {r.lec} lecture · {r.lab} lab
        </button>
      }
      action={<ViewAll href="/room-utilization" />}
    >
      {byKind && (
        <div className="space-y-3.5 mb-6">
          {(['lec', 'lab'] as Kind[]).map((k, i) => {
            const Icon = KIND[k].Icon;
            return (
              <div key={k}>
                <div className="flex items-center gap-2 text-sm mb-1.5">
                  <Icon className="w-4 h-4" style={{ color: KIND[k].color }} aria-hidden />
                  <span className="font-semibold text-[#334155]">{KIND[k].rooms}</span>
                  <span className="ml-auto font-bold text-[#0B2A5B]">{byKind[k]}%</span>
                </div>
                <Meter value={byKind[k]} color={KIND[k].color} delay={0.2 + i * 0.1} label={`${KIND[k].rooms} utilization`} />
              </div>
            );
          })}
        </div>
      )}
      <div className="grid grid-cols-2 gap-5">
        <RoomRank title="Most used" rooms={data.most_used} />
        <RoomRank title="Least used" rooms={data.least_used} />
      </div>
      {underHalf > 0 && (
        <p className="mt-5 pt-4 border-t border-[#EEF2F7] text-[13px] text-[#475569]">
          <span className="font-bold text-[#0B2A5B]">{underHalf} of {r.total}</span> rooms are booked less than half the week.
        </p>
      )}
    </Card>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [range, setRange] = useState<Range | null>(null); // null → server default (last 30 days)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [detail, setDetail] = useState<DetailKey | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
  const st = data ? stagesOf(data) : null;
  const classTotal = st ? st.scheduled + st.needs_schedule + st.no_faculty : 0;
  const loads = data?.faculty_load ?? [];
  const loadDone = loads.filter(f => f.status === 'complete' || f.status === 'overload').length;
  const change = k?.utilization_change ?? 0;
  const conflicts = data?.conflict_counts;
  const term = data?.term;

  return (
    <div className={`mx-auto w-full max-w-[1600px] min-w-0 p-4 sm:p-6 xl:px-8 ${VIZ_VARS}`}>
      <BackButton />
      <div className="mt-4 sm:mt-7 mb-5">
        <WatermarkTitle>Analytics</WatermarkTitle>
      </div>

      {/* One row of filters above everything they scope */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {term?.semester && (
          <span className="inline-flex items-center gap-2 h-10 px-4 rounded-full bg-white border border-[#E3E9F3] text-sm font-semibold text-[#0B2A5B]">
            <CalendarDays className="w-4 h-4 text-[#1D5BD6]" />
            {term.semester}{term.school_year ? ` · A.Y. ${term.school_year}` : ''}
          </span>
        )}
        <DateRangeButton value={range ?? data?.range ?? null} onChange={setRange} loading={loading && !!data} />
      </div>

      {error && !data ? (
        <p className="py-16 text-center text-sm text-[#64748B]">Unable to load analytics. Please try again.</p>
      ) : (
        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={
            <div className="space-y-6" role="status" aria-label="Loading analytics">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                {Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} className="h-[184px]" />)}
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
                <CardSkeleton className="h-[440px]" />
                <CardSkeleton className="h-[440px] xl:col-span-2" />
                <CardSkeleton className="h-[440px] xl:col-span-2" />
                <CardSkeleton className="h-[440px]" />
              </div>
            </div>
          }
        >
          {data && k && st ? (
            <div className={`space-y-8 transition-opacity duration-300 ${loading ? 'opacity-60' : ''}`}>
              {/* At a glance */}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                <StatTile index={0} icon={CalendarCheck} label="Classes scheduled" href="/scheduling"
                  value={`${share(st.scheduled, classTotal)}%`}
                  context={`${st.scheduled} of ${classTotal} classes have a day and time`}>
                  <Meter value={share(st.scheduled, classTotal)} label="Classes scheduled" />
                </StatTile>
                <StatTile index={1} icon={Users} label="Faculty loads complete" href="/workload"
                  value={`${share(loadDone, loads.length)}%`}
                  context={`${loadDone} of ${loads.length} faculty have a full load`}>
                  <Meter value={share(loadDone, loads.length)} label="Faculty loads complete" />
                </StatTile>
                <StatTile index={2} icon={Building2} label="Room utilization" onOpen={() => setDetail('utilization')}
                  value={`${k.utilization}%`}
                  context={
                    <span className="inline-flex flex-wrap items-center gap-x-1.5">
                      <span className={`inline-flex items-center gap-0.5 font-semibold ${change > 0 ? 'text-[#047857]' : change < 0 ? 'text-[#B91C1C]' : 'text-[#64748B]'}`}>
                        {change > 0 ? <ArrowUp className="w-3.5 h-3.5" /> : change < 0 ? <ArrowDown className="w-3.5 h-3.5" /> : null}
                        {change === 0 ? 'No change' : `${Math.abs(change)} pts`}
                      </span>
                      since {shortDate(data.range.from)}
                    </span>
                  }>
                  <MiniBars values={data.trends.map(t => t.utilization)} labels={data.trends.map(t => t.month)} format={n => `${n}%`} />
                </StatTile>
                <StatTile index={3} icon={k.conflicts > 0 ? AlertTriangle : CheckCircle2} tone={k.conflicts > 0 ? '#DC2626' : '#047857'}
                  label="Scheduling conflicts" onOpen={() => setDetail('conflicts')}
                  value={k.conflicts}
                  context={k.conflicts > 0
                    ? <span className="font-semibold text-[#B91C1C]">Needs attention</span>
                    : <span className="font-semibold text-[#047857]">All clear</span>}>
                  {conflicts && (
                    <p className="text-[13px] text-[#64748B]">
                      Room {conflicts.room} · Faculty {conflicts.faculty} · Block {conflicts.block}
                    </p>
                  )}
                </StatTile>
              </div>

              <section>
                <SectionLabel>Term progress</SectionLabel>
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 items-stretch">
                  <SchedulingCard data={data} index={0} />
                  <div className="xl:col-span-2 min-w-0 flex [&>*]:flex-1">
                    <FacultyLoadCard data={data} index={1} onFaculty={() => setDetail('faculty')} />
                  </div>
                </div>
              </section>

              <section>
                <SectionLabel>Room usage</SectionLabel>
                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-5 items-stretch">
                  <UseByDayCard data={data} index={2} />
                  <BusiestHoursCard data={data} index={3} />
                  <div className="lg:col-span-2 xl:col-span-1 min-w-0 flex [&>*]:flex-1">
                    <RoomUseCard data={data} index={4} onRooms={() => setDetail('rooms')} />
                  </div>
                </div>
              </section>
            </div>
          ) : null}
        </PageLoadTransition>
      )}

      {data && <DetailModal open={detail} details={data.details} rate={data.kpis.utilization} onClose={() => setDetail(null)} />}
    </div>
  );
}
