'use client';

import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { BookOpen, CalendarClock, ChevronRight, DoorOpen, Dumbbell, Monitor, type LucideIcon } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { clock12, clockRange12 } from '@shared/clock12';
import {
  ROOM_POOL_LABEL, ROOM_POOLS, snapshotCell, type BusiestRooms,
  type PlanningCell, type PoolPlan, type RoomPlanningSummary, type RoomPool,
} from '@shared/roomPlanning';

/*
 * Simple room and progress graphs — shared by Room Utilization → Room Planning
 * and Analytics, so both show the same numbers the same way:
 *   • DonutChart / DonutLegend — a pie with the answer in the middle
 *   • BusiestRoomsDialog       — the rooms behind "In use" / "Free" at the busiest time
 *   • RoomsByHourChart         — each hour as one bar of all the rooms: in use, free
 *   • TypeDonuts               — one small pie per kind of room, with its verdict
 *   • TypeBars                 — the same as horizontal bars on one scale of rooms
 * Colours are validated steps (dataviz checker, light #FFFFFF / dark #14233F):
 * each kind of room in its system colour — Lecture blue, Laboratory amber,
 * PATHFIT slate (full = in use, a light step = free); "All rooms" mixes the
 * kinds' colours with one light free; red only for a real shortage, and a
 * label with every number. Set PLAN_VARS on a parent.
 */

export const EASE = [0.4, 0, 0.2, 1] as const;

export const PLAN_VARS = [
  '[--plan-use:#1D5BD6] [html:not(.light)_&]:[--plan-use:#4070D2]',
  '[--plan-free:#D3DEF1] [html:not(.light)_&]:[--plan-free:#2B416B]',
  '[--plan-short:#DC2626]',
  // Card colour — the 2px gap between pie slices and between bar parts
  '[--plan-surface:#FFFFFF] [html:not(.light)_&]:[--plan-surface:var(--surface)]',
  // Each kind of room in its system colour (Lecture blue, Laboratory amber, PATHFIT slate, as
  // their icons): full for rooms in use, a light step of the same colour for free ones
  '[--plan-lecture-use:#1D5BD6] [html:not(.light)_&]:[--plan-lecture-use:#4070D2]',
  '[--plan-lecture-free:#D3DEF1] [html:not(.light)_&]:[--plan-lecture-free:#2B416B]',
  '[--plan-laboratory-use:#F59E0B] [html:not(.light)_&]:[--plan-laboratory-use:#D97706]',
  '[--plan-laboratory-free:#FCE3AE] [html:not(.light)_&]:[--plan-laboratory-free:#4A3B17]',
  '[--plan-pathfit-use:#64748B] [html:not(.light)_&]:[--plan-pathfit-use:#7B8AA3]',
  '[--plan-pathfit-free:#E2E8F0] [html:not(.light)_&]:[--plan-pathfit-free:#334155]',
  // Text on a laboratory (amber) bar: navy in both themes — through a variable, because the
  // dark theme repaints any inline navy text as light
  '[--plan-laboratory-ink:#0B2A5B]',
].join(' ');

export type PoolFilter = 'all' | RoomPool;
export const POOL_FILTER_LABEL: Record<PoolFilter, string> = { all: 'All rooms', ...ROOM_POOL_LABEL };

export const POOL_ICON: Record<RoomPool, { Icon: LucideIcon; color: string }> = {
  lecture: { Icon: BookOpen, color: '#1D5BD6' },
  laboratory: { Icon: Monitor, color: '#D97706' },
  pathfit: { Icon: Dumbbell, color: '#475569' },
};

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(s|sh|ch|x)$/.test(word) ? 'es' : 's'}`;
/** 9 → "9–10 AM", 11 → "11 AM–12 PM" */
export function hourRange(h: number) {
  const ap = (x: number) => (x < 12 ? 'AM' : 'PM');
  const n = (x: number) => x % 12 || 12;
  return ap(h) === ap(h + 1) ? `${n(h)}–${n(h + 1)} ${ap(h)}` : `${n(h)} ${ap(h)}–${n(h + 1)} ${ap(h + 1)}`;
}

/** Kinds of room worth showing: rooms there, classes for them, or classes waiting for them */
export const shownPools = (pools: Record<RoomPool, PoolPlan>) =>
  ROOM_POOLS.filter(p => pools[p].usable > 0 || pools[p].meetings > 0 || pools[p].projected.classes > 0);

/* ─── The answer for one kind of room (or all) ────────────────────────────── */

export type Verdict = 'enough' | 'full' | 'short' | 'none';

export interface RoomSnapshot {
  usable: number;
  /** At the busiest time: rooms in use, rooms free, classes with no room left */
  inUse: number;
  free: number;
  short: number;
  /** "Monday, 9:00 AM" */
  when: string | null;
  /** Rooms to add for the current schedule */
  more: number;
  /** At least this many more once every class has a day and time (estimate) */
  later: number;
  /** Classes with no day and time yet */
  waiting: number;
  verdict: Verdict;
  /** All rooms: the rooms in use of each kind at the busiest moment (null for one kind, or an older server) */
  byPool: Record<RoomPool, number> | null;
}

/** The busiest time of one kind of room (or all): how many are in use, free and short, and the verdict */
export function roomSnapshot(plan: RoomPlanningSummary, pool: PoolFilter): RoomSnapshot {
  const kind = pool === 'all' ? null : plan.pools[pool];
  const at = kind ? kind.peak_at : plan.totals.peak_at;
  // The hour slot holding the busiest moment — the same one its room lists (busiest_rooms) read
  const idx = snapshotCell(plan, pool);
  const cell: PlanningCell | null = idx ? plan.grid[pool][idx[0]][idx[1]] : null;
  const usable = kind ? kind.usable : plan.totals.usable;
  const meetings = kind ? kind.meetings : plan.totals.meetings;
  const inUse = Math.min(cell?.in_use ?? 0, usable);
  const short = cell?.short ?? 0;
  const more = kind ? kind.additional : plan.totals.additional;
  const verdict: Verdict = meetings === 0 ? 'none' : more > 0 || short > 0 ? 'short' : usable > 0 && inUse >= usable ? 'full' : 'enough';
  return {
    usable, inUse, free: Math.max(0, usable - inUse), short,
    when: at ? `${at.day}, ${clock12(at.start)}` : null,
    more: Math.max(more, short),
    later: kind ? kind.projected.additional : plan.totals.projected_additional,
    waiting: kind ? kind.projected.classes : plan.totals.pending_classes,
    verdict,
    byPool: pool === 'all' && cell?.by_pool ? cell.by_pool : null,
  };
}

export const VERDICT_STYLE: Record<Verdict, { text: string; chip: string }> = {
  enough: { text: 'text-[#047857]', chip: 'bg-emerald-50 text-[#047857] border-emerald-200' },
  full: { text: 'text-[#12408F] [html:not(.light)_&]:text-[#9DB8E8]', chip: 'bg-[#EFF6FF] text-[#12408F] border-[#BFD3F5] [html:not(.light)_&]:text-[#9DB8E8]' },
  short: { text: 'text-[#B91C1C]', chip: 'bg-red-50 text-[#B91C1C] border-red-200' },
  none: { text: 'text-[#64748B]', chip: 'bg-[#F1F5F9] text-[#64748B] border-[#E2E8F0]' },
};

/** The verdict in a few words: "Enough", "Fully used", "Need 2 more" */
export function verdictShort(s: RoomSnapshot) {
  return s.verdict === 'short' ? `Need ${s.more} more` : s.verdict === 'full' ? 'Fully used' : s.verdict === 'enough' ? 'Enough' : 'No classes yet';
}

/** "Laboratory in use" — the kinds' words on a pie of all rooms */
export const MIX_WORD: Record<RoomPool, string> = { lecture: 'Lecture', laboratory: 'Laboratory', pathfit: 'PATHFIT' };
/** The text on a bar of that kind: white on blue / slate, navy on amber (white on amber is hard to read) */
export const POOL_INK: Record<RoomPool, string> = { lecture: '#FFFFFF', laboratory: 'var(--plan-laboratory-ink)', pathfit: '#FFFFFF' };

/**
 * The pie's slices for a snapshot: in use, free, and (only when there is one) short — in the
 * kind's colours. All rooms: one "in use" slice per kind (Lecture blue, Laboratory amber, PATHFIT
 * slate; keys `use-lecture` …) and one free. Every in-use key starts with "use".
 */
export function snapshotSlices(s: RoomSnapshot, pool: PoolFilter = 'all'): Slice[] {
  const short = s.short > 0 ? [{ key: 'short', label: 'No room left', value: s.short, color: 'var(--plan-short)' }] : [];
  if (pool !== 'all') {
    return [
      { key: 'use', label: 'In use', value: s.inUse, color: `var(--plan-${pool}-use)` },
      { key: 'free', label: 'Free', value: s.free, color: `var(--plan-${pool}-free)` },
      ...short,
    ];
  }
  const by = s.byPool;
  const used = by ? ROOM_POOLS.filter(k => by[k] > 0) : [];
  return [
    ...(by && used.length
      ? used.map(k => ({ key: `use-${k}`, label: `${MIX_WORD[k]} in use`, value: by[k], color: `var(--plan-${k}-use)` }))
      : [{ key: 'use', label: 'In use', value: s.inUse, color: 'var(--plan-use)' }]),
    { key: 'free', label: 'Free', value: s.free, color: 'var(--plan-free)' },
    ...short,
  ];
}

/* ─── Pie (donut) ─────────────────────────────────────────────────────────── */

export interface Slice { key: string; label: string; value: number; color: string; href?: string }

/** Ring segment between two angles (radians, clockwise from 12 o'clock) in a 200 × 200 box */
function segment(a0: number, a1: number, r: number, inner: number) {
  const pt = (a: number, rad: number) => `${(100 + rad * Math.sin(a)).toFixed(3)} ${(100 - rad * Math.cos(a)).toFixed(3)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${pt(a0, r)} A ${r} ${r} 0 ${large} 1 ${pt(a1, r)} L ${pt(a1, inner)} A ${inner} ${inner} 0 ${large} 0 ${pt(a0, inner)} Z`;
}

/**
 * A pie with a hole: the answer sits in the middle (`center`), the slices
 * sweep in, and pointing at a slice (or its legend row, with the same
 * `active`) lifts it out.
 */
export function DonutChart({ slices, size = 168, center, label, active = null, onActive, onPick }: {
  slices: Slice[];
  size?: number;
  center?: ReactNode;
  /** Accessible name — the slices' numbers are added */
  label: string;
  active?: string | null;
  onActive?: (key: string | null) => void;
  /** Clicking a slice opens what it counts (the key row does the same, for keyboards) */
  onPick?: (key: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const maskId = useId();
  const total = slices.reduce((n, s) => n + Math.max(0, s.value), 0);
  const R = 92;
  const inner = 60;
  const parts: (Slice & { a0: number; a1: number; mid: number })[] = [];
  for (const s of slices) {
    if (s.value <= 0) continue;
    const a0 = parts.length ? parts[parts.length - 1].a1 : 0;
    const a1 = a0 + (s.value / total) * Math.PI * 2;
    parts.push({ ...s, a0, a1, mid: (a0 + a1) / 2 });
  }
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 200 200" width={size} height={size} role="img"
        aria-label={`${label}: ${slices.map(s => `${s.label} ${s.value}`).join(', ')}`}
        onPointerLeave={() => onActive?.(null)}
      >
        <defs>
          {/* Sweeps the ring in clockwise from 12 o'clock */}
          <mask id={maskId}>
            <motion.circle cx="100" cy="100" r="50" fill="none" stroke="white" strokeWidth="101" transform="rotate(-90 100 100)"
              initial={reduceMotion ? false : { pathLength: 0 }} animate={{ pathLength: 1 }}
              transition={{ duration: reduceMotion ? 0 : 0.9, ease: EASE, delay: 0.1 }} />
          </mask>
        </defs>
        <g mask={`url(#${maskId})`}>
          {total === 0 ? (
            <circle cx="100" cy="100" r={(R + inner) / 2} fill="none" stroke="var(--donut-track)" strokeWidth={R - inner} />
          ) : parts.length === 1 ? (
            <circle cx="100" cy="100" r={(R + inner) / 2} fill="none" stroke={parts[0].color} strokeWidth={R - inner}
              onPointerEnter={() => onActive?.(parts[0].key)} onClick={onPick ? () => onPick(parts[0].key) : undefined}
              className={onPick ? 'cursor-pointer' : ''} />
          ) : (
            parts.map(p => (
              <motion.path
                key={p.key}
                d={segment(p.a0, p.a1, R, inner)}
                fill={p.color}
                stroke="var(--plan-surface)"
                strokeWidth="2.5"
                strokeLinejoin="round"
                onPointerEnter={() => onActive?.(p.key)}
                onClick={onPick ? () => onPick(p.key) : undefined}
                animate={{ x: active === p.key ? Math.sin(p.mid) * 5 : 0, y: active === p.key ? -Math.cos(p.mid) * 5 : 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 28 }}
                className={onActive || onPick ? 'cursor-pointer' : ''}
              />
            ))
          )}
        </g>
      </svg>
      {center && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-6">
          {center}
        </div>
      )}
    </div>
  );
}

/** The pie's key: colour · label · count · share. A row with `href` opens that list; with
 *  `onPick`, the rows `pickable` allows open what they count (an arrow marks them). */
export function DonutLegend({ slices, active = null, onActive, showShare = true, format = String, onPick, pickable }: {
  slices: Slice[];
  active?: string | null;
  onActive?: (key: string | null) => void;
  showShare?: boolean;
  /** How a value reads (e.g. as a percentage) */
  format?: (n: number) => string;
  onPick?: (key: string) => void;
  pickable?: (key: string) => boolean;
}) {
  const total = slices.reduce((n, s) => n + Math.max(0, s.value), 0);
  // An arrow on every row that opens something (a list or a page)
  const arrows = !!onPick || slices.some(s => s.href);
  return (
    <ul className="w-full space-y-0.5" onPointerLeave={() => onActive?.(null)}>
      {slices.map(s => {
        const on = active === s.key;
        const canPick = !!onPick && (pickable ? pickable(s.key) : true);
        const body = (
          <>
            <span className="w-3.5 h-3.5 rounded-[4px] flex-shrink-0" style={{ backgroundColor: s.color }} aria-hidden />
            <span className={`min-w-0 truncate ${on ? 'font-semibold text-[#0B2A5B]' : 'text-[#334155]'}`}>{s.label}</span>
            <span className="ml-auto pl-2 font-bold text-[#0B2A5B] tabular-nums">{format(s.value)}</span>
            {showShare && <span className="w-12 text-right text-sm text-[#64748B] tabular-nums">{total ? Math.round((s.value / total) * 100) : 0}%</span>}
            {arrows && (
              <ChevronRight aria-hidden className={`w-4 h-4 flex-shrink-0 transition-transform duration-200 ${canPick || s.href ? 'text-[#1D5BD6] group-hover:translate-x-0.5' : 'invisible'}`} />
            )}
          </>
        );
        const cls = `w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[15px] text-left transition-[background-color,opacity] duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40 ${
          on ? 'bg-[#F1F5F9]' : active ? 'opacity-60' : ''
        }`;
        const events = { onPointerEnter: () => onActive?.(s.key), onFocus: () => onActive?.(s.key), onBlur: () => onActive?.(null) };
        return (
          <li key={s.key}>
            {s.href
              ? <Link href={s.href} {...events} className={`group ${cls} hover:bg-[#F4F7FC]`}>{body}</Link>
              : canPick
                ? <button type="button" onClick={() => onPick?.(s.key)} {...events} aria-label={`${s.label}: ${format(s.value)} — show them`} className={`group ${cls} hover:bg-[#F4F7FC] cursor-pointer`}>{body}</button>
                : <div {...events} tabIndex={onActive ? 0 : undefined} className={cls}>{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/* ─── Each kind of room as a small pie ────────────────────────────────────── */

/** One small pie per kind of room: rooms in use at its busiest time, and the verdict. `onPick` makes them choose that kind. */
export function TypeDonuts({ plan, picked = 'all', onPick }: {
  plan: RoomPlanningSummary;
  picked?: PoolFilter;
  onPick?: (pool: RoomPool) => void;
}) {
  const pools = shownPools(plan.pools);
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {pools.map(key => {
        const s = roomSnapshot(plan, key);
        const { Icon, color } = POOL_ICON[key];
        const on = picked === key;
        const body = (
          <>
            <DonutChart
              slices={snapshotSlices(s, key)}
              size={104}
              label={`${ROOM_POOL_LABEL[key]} at the busiest time`}
              center={<span className="text-[17px] font-bold text-[#0B2A5B] leading-none">{s.inUse}/{s.usable}</span>}
            />
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[15px] font-bold text-[#0B2A5B]">
                <Icon className="w-4 h-4 flex-shrink-0" style={{ color }} aria-hidden /> {ROOM_POOL_LABEL[key]}
              </p>
              <p className="text-sm text-[#64748B]">{s.inUse} of {s.usable} in use at the busiest time</p>
              <span className={`mt-1.5 inline-flex items-center h-8 px-3 rounded-full border text-sm font-bold ${VERDICT_STYLE[s.verdict].chip}`}>
                {verdictShort(s)}
              </span>
            </div>
          </>
        );
        const cls = `w-full h-full flex items-center gap-3.5 rounded-xl border px-3 py-3 text-left transition-colors ${
          on ? 'border-[#1D5BD6] bg-[#F4F8FF]' : 'border-[#E3E9F3]'
        }`;
        return (
          <li key={key}>
            {onPick
              ? <button type="button" onClick={() => onPick(key)} aria-pressed={on} className={`${cls} hover:border-[#9DB8E8] cursor-pointer`}>{body}</button>
              : <div className={cls}>{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/* ─── Each kind of room as a horizontal bar ───────────────────────────────── */

/** Soft tile behind each kind's icon */
const POOL_TINT: Record<RoomPool, string> = { lecture: '#EFF6FF', laboratory: '#FFFBEB', pathfit: '#F1F5F9' };

/** Scale marks from 0 past `max` in round steps (1, 2, 5, 10, 20, 25, 50…), at most 6 */
function scaleTicks(max: number): number[] {
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find(s => max / s <= 5) ?? Math.ceil(max / 5);
  const top = Math.max(step, Math.ceil(max / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

/** Wide screens: label | bar | count | verdict, shared by the rows and the scale under them so
 *  they line up. Phones: the label with its verdict on top, the bar and count under it. */
const BAR_GRID = 'grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[13rem_minmax(0,1fr)_4.5rem_7.25rem] gap-x-4';

/**
 * One horizontal bar per kind of room, all on one scale of rooms, in that kind's colour:
 * full for rooms in use at its busiest time, light for free ones, and red only for
 * classes with no room left — with the count and the verdict beside it. Bars ≤ 24px, square at the baseline and
 * rounded at the tip; pointing at (or focusing) a row shows all its numbers at the tip.
 * `hrefOf` makes each row open that kind.
 */
export function TypeBars({ plan, hrefOf }: {
  plan: RoomPlanningSummary;
  hrefOf?: (pool: RoomPool) => string;
}) {
  const reduceMotion = useReducedMotion();
  /** The row pointed at or focused — its numbers show at the bar's tip */
  const [tip, setTip] = useState<RoomPool | null>(null);
  const rows = shownPools(plan.pools).map(key => ({ key, s: roomSnapshot(plan, key) }));
  const ticks = scaleTicks(Math.max(1, ...rows.map(r => r.s.usable + r.s.short)));
  const top = ticks[ticks.length - 1];
  const pct = (n: number) => `${(n / top) * 100}%`;
  const anyShort = rows.some(r => r.s.short > 0);
  const chip = (s: RoomSnapshot) => (
    <span className={`inline-flex items-center h-8 px-3 rounded-full border text-sm font-bold whitespace-nowrap ${VERDICT_STYLE[s.verdict].chip}`}>
      {verdictShort(s)}
    </span>
  );
  const swatch = (colors: string[], label: string) => (
    <li className="inline-flex items-center gap-2">
      <span className="inline-flex gap-[2px]">
        {colors.map(c => <span key={c} className="w-3 h-3 rounded-[3px]" style={{ backgroundColor: c }} />)}
      </span>
      {label}
    </li>
  );
  const kinds = rows.map(r => r.key);

  return (
    <div>
      <ul className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm font-medium text-[#475569]" aria-hidden>
        {swatch(kinds.map(k => `var(--plan-${k}-use)`), 'In use')}
        {swatch(kinds.map(k => `var(--plan-${k}-free)`), 'Free')}
        {anyShort && swatch(['var(--plan-short)'], 'No room left')}
      </ul>

      <ul className="space-y-1 sm:space-y-0">
        {rows.map(({ key, s }, i) => {
          const { Icon, color } = POOL_ICON[key];
          const body = (
            <>
              <div className="col-span-2 row-start-1 sm:col-span-1 sm:col-start-1 flex items-center gap-3 min-w-0 pt-2 sm:py-3">
                <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: POOL_TINT[key] }}>
                  <Icon className="w-[18px] h-[18px]" style={{ color }} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[15px] font-bold text-[#0B2A5B] truncate">{ROOM_POOL_LABEL[key]}</span>
                    {/* Phones: the verdict beside the name (wide screens: its own column) */}
                    <span className="sm:hidden flex-shrink-0">{chip(s)}</span>
                  </span>
                  {s.when && <span className="block text-sm text-[#64748B] truncate">Busiest: {s.when}</span>}
                </span>
              </div>

              {/* The bar, on the scale's grid lines (wide screens) */}
              <div className="col-start-1 row-start-2 sm:col-start-2 sm:row-start-1 relative flex items-center py-2 sm:py-0">
                <span aria-hidden className="hidden sm:block absolute inset-0">
                  {ticks.map(t => (
                    <span key={t} className="absolute inset-y-0 w-px" style={{ left: pct(t), backgroundColor: t === 0 ? '#CBD5E1' : '#EEF2F7' }} />
                  ))}
                </span>
                <span className="relative block h-6 w-full" aria-hidden>
                  <motion.span
                    className="absolute inset-y-0 left-0 flex gap-[2px] overflow-hidden rounded-r-[4px] transition-[width] duration-500 ease-out"
                    style={{ width: pct(s.usable + s.short) }}
                    initial={reduceMotion ? false : { clipPath: 'inset(0 100% 0 0)' }}
                    animate={{ clipPath: 'inset(0 0% 0 0)' }}
                    transition={{ duration: reduceMotion ? 0 : 0.8, ease: EASE, delay: reduceMotion ? 0 : 0.15 + i * 0.08 }}
                  >
                    {s.inUse > 0 && <span className="h-full" style={{ flex: `${s.inUse} 1 0%`, backgroundColor: `var(--plan-${key}-use)` }} />}
                    {s.free > 0 && <span className="h-full" style={{ flex: `${s.free} 1 0%`, backgroundColor: `var(--plan-${key}-free)` }} />}
                    {s.short > 0 && <span className="h-full" style={{ flex: `${s.short} 1 0%`, backgroundColor: 'var(--plan-short)' }} />}
                  </motion.span>
                  {/* Every number of the row, at the bar's tip (wide screens) */}
                  {tip === key && (
                    <motion.span
                      initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.18, ease: EASE }}
                      className="hidden sm:block pointer-events-none absolute bottom-full mb-2 z-20 -translate-x-1/2 whitespace-nowrap rounded-lg border border-[#E3E9F3] bg-white px-3 py-2 shadow-[0_10px_24px_-12px_rgba(11,42,91,0.35)]"
                      style={{ left: `${Math.min(88, Math.max(12, ((s.usable + s.short) / top) * 100))}%` }}
                    >
                      <span className="block text-sm font-semibold text-[#64748B]">{ROOM_POOL_LABEL[key]}{s.when ? ` · ${s.when}` : ''}</span>
                      {([
                        [s.inUse, 'in use', `var(--plan-${key}-use)`],
                        [s.free, 'free', `var(--plan-${key}-free)`],
                        ...(s.short > 0 ? [[s.short, s.short === 1 ? 'class with no room left' : 'classes with no room left', 'var(--plan-short)'] as const] : []),
                      ] as const).map(([n, word, c]) => (
                        <span key={word} className="mt-0.5 flex items-center gap-2 text-sm">
                          <span className="w-3 h-[3px] rounded-full" style={{ backgroundColor: c }} />
                          <b className="text-[#0B2A5B] tabular-nums">{n}</b>
                          <span className="text-[#475569]">{word}</span>
                        </span>
                      ))}
                    </motion.span>
                  )}
                </span>
              </div>

              <span className="col-start-2 row-start-2 sm:col-start-3 sm:row-start-1 self-center text-[17px] font-bold text-[#0B2A5B] tabular-nums whitespace-nowrap">
                {s.inUse}<span className="font-semibold text-[#94A3B8]"> / {s.usable}</span>
              </span>
              <span className="hidden sm:block sm:col-start-4 sm:row-start-1 self-center justify-self-end">{chip(s)}</span>
            </>
          );
          const label = `${ROOM_POOL_LABEL[key]}: ${s.inUse} of ${s.usable} in use at the busiest time${s.when ? `, ${s.when}` : ''}${s.short ? `, ${s.short} with no room left` : ''} — ${verdictShort(s)}`;
          // The row pointed at or focused stands out: the others soften
          const cls = `bar-row ${BAR_GRID} px-3 rounded-xl transition-[opacity,background-color] duration-200 ${
            tip === key ? 'bg-[#F8FAFC]' : tip ? 'opacity-55' : ''
          }`;
          const point = {
            onPointerEnter: () => setTip(key),
            onPointerLeave: () => setTip(t => (t === key ? null : t)),
            onFocus: () => setTip(key),
            onBlur: () => setTip(t => (t === key ? null : t)),
          };
          return (
            <li key={key}>
              {hrefOf
                ? <Link href={hrefOf(key)} aria-label={label} {...point} className={`${cls} focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40`}>{body}</Link>
                : <div aria-label={label} role="group" tabIndex={0} {...point} className={`${cls} focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40`}>{body}</div>}
            </li>
          );
        })}
      </ul>

      {/* The scale: number of rooms */}
      <div className={`hidden sm:grid ${BAR_GRID} px-3 mt-1`} aria-hidden>
        <span />
        <div className="relative h-5">
          {ticks.map(t => (
            <span key={t} className="absolute top-0 -translate-x-1/2 text-[12px] font-medium text-[#94A3B8] tabular-nums" style={{ left: pct(t) }}>{t}</span>
          ))}
        </div>
        <span className="text-[12px] font-medium text-[#94A3B8]">rooms</span>
        <span />
      </div>
    </div>
  );
}

const KIND_WORD: Record<PoolFilter, [string, string]> = {
  all: ['room', 'rooms'],
  lecture: ['lecture room', 'lecture rooms'],
  laboratory: ['laboratory', 'laboratories'],
  pathfit: ['PATHFIT venue', 'PATHFIT venues'],
};
/** "laboratory" for 1, "laboratories" otherwise */
export const kindWord = (pool: PoolFilter, n: number) => KIND_WORD[pool][n === 1 ? 0 : 1];
/** "1 laboratory", "8 laboratories", "2 rooms" */
export const kindCount = (pool: PoolFilter, n: number) => `${n} ${kindWord(pool, n)}`;

/** For all rooms: the one kind that is short, so the answer can name it ("laboratory"); otherwise 'all' */
function shortKind(plan: RoomPlanningSummary, pool: PoolFilter): PoolFilter {
  if (pool !== 'all') return pool;
  const kinds = shownPools(plan.pools).filter(k => plan.pools[k].additional > 0 || plan.pools[k].max_short > 0);
  return kinds.length === 1 ? kinds[0] : 'all';
}

/** The answer in a few words: "Enough rooms", "Enough laboratories, but none to spare", "Need 1 more laboratory" */
export function verdictHeadline(plan: RoomPlanningSummary, pool: PoolFilter, s: RoomSnapshot) {
  if (s.verdict === 'short') return `Need ${s.more} more ${kindWord(shortKind(plan, pool), s.more)}`;
  if (s.verdict === 'full') return `Enough ${kindWord(pool, 2)}, but none to spare`;
  if (s.verdict === 'enough') return `Enough ${kindWord(pool, 2)}`;
  return 'No classes scheduled yet';
}

/** The line under it: when the busiest time is, and what happens then */
export function verdictLine(plan: RoomPlanningSummary, pool: PoolFilter, s: RoomSnapshot) {
  if (!s.when) return 'There are no classes in this term\u2019s schedule yet.';
  if (s.verdict === 'short') {
    const n = s.short || s.more;
    const kind = shortKind(plan, pool);
    return `Busiest time: ${s.when} — ${n} ${n === 1 ? 'class has' : 'classes have'} no ${kind === 'all' ? 'room' : kindWord(kind, 1)} left.`;
  }
  if (s.verdict === 'full') return `Busiest time: ${s.when} — every one is in use.`;
  return `Busiest time: ${s.when}`;
}

/** The estimate in one line: rooms to add once every waiting class has a day and time */
export function EstimateLine({ plan, pool }: { plan: RoomPlanningSummary; pool: PoolFilter }) {
  const s = roomSnapshot(plan, pool);
  if (s.waiting === 0) return null;
  // All rooms: which kinds make up the total ("1 lecture room, 8 laboratories")
  const kinds = pool === 'all'
    ? shownPools(plan.pools).filter(k => plan.pools[k].projected.additional > 0).map(k => kindCount(k, plan.pools[k].projected.additional))
    : [];
  return (
    <p className="flex items-start gap-2.5 text-[15px] text-[#334155]">
      <span className="inline-flex items-center h-7 px-2.5 rounded-md border border-[#CBD5E1] text-sm font-bold text-[#475569] flex-shrink-0">Later</span>
      <span>
        {s.later > 0
          ? <>When the {plural(s.waiting, 'waiting class')} {s.waiting === 1 ? 'is' : 'are'} scheduled: <b className="text-[#0B2A5B]">at least {s.later} more {kindWord(pool, s.later)}</b>{kinds.length > 1 ? ` (${kinds.join(', ')})` : ''}.</>
          : <>The {plural(s.waiting, 'waiting class')} will fit in the free room time.</>}
        {' '}<span className="text-[#64748B]">Estimate.</span>
      </span>
    </p>
  );
}

/* ─── Rooms in use, hour by hour ──────────────────────────────────────────── */

const ap = (h: number) => (h < 12 ? 'AM' : 'PM');
const hourLabel = (h: number) => `${h % 12 || 12} ${ap(h)}`;
const hourTiny = (h: number) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;

/** Kinds in a bar of all rooms, bottom to top — Lecture on top, so the count sits on blue */
const STACK: RoomPool[] = ['pathfit', 'laboratory', 'lecture'];

/**
 * One bar per hour, each the height of all the rooms: the full-colour part is
 * the rooms in use at that hour's busiest moment (in the kind's colour; all
 * rooms: one colour per kind, stacked), the light part the rooms still free,
 * and a red part on top only when classes have no room left. The number in
 * the bar is the rooms in use; pointing at a bar shows the hour's numbers.
 */
export function RoomsByHourChart({ cells, hours, day, pool = 'all', height = 240 }: {
  cells: PlanningCell[];
  hours: number[];
  day: string;
  /** The kind of room the bars are (its colours), or all rooms (mixed) */
  pool?: PoolFilter;
  height?: number;
}) {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const usable = cells.reduce((m, c) => Math.max(m, c.usable), 0);
  const top = Math.max(1, usable + cells.reduce((m, c) => Math.max(m, c.short), 0));
  const px = (n: number) => (n / top) * height;
  const c = active != null ? cells[active] : null;
  const anyShort = cells.some(x => x.short > 0);
  const useColor = pool === 'all' ? 'var(--plan-use)' : `var(--plan-${pool}-use)`;
  const freeColor = pool === 'all' ? 'var(--plan-free)' : `var(--plan-${pool}-free)`;
  const useInk = pool === 'all' ? '#FFFFFF' : POOL_INK[pool];
  // All rooms: each kind in its own colour (when the server says how many of each are in use)
  const mix = pool === 'all' && cells.some(x => x.by_pool);
  const kinds = mix ? [...STACK].reverse().filter(k => cells.some(x => (x.by_pool?.[k] ?? 0) > 0)) : [];
  const partsOf = (cell: PlanningCell) => (cell.by_pool ? STACK.filter(k => (cell.by_pool?.[k] ?? 0) > 0) : []);
  return (
    <div className="select-none">
      <div className="relative" style={{ height }} onPointerLeave={() => setActive(null)}>
        <div className="absolute inset-0 flex gap-1.5 sm:gap-2.5">
          {cells.map((cell, i) => {
            const inUse = Math.min(cell.in_use, cell.usable);
            const free = Math.max(0, cell.usable - inUse);
            const on = active === i;
            const delay = reduceMotion ? 0 : 0.1 + i * 0.04;
            const grow = (h: number) => ({
              initial: reduceMotion ? false : { height: 0 },
              animate: { height: h },
              transition: { duration: reduceMotion ? 0 : 0.55, ease: EASE, delay },
            } as const);
            return (
              <div
                key={i}
                role="img"
                tabIndex={0}
                aria-label={`${day}, ${hourRange(hours[i])}: ${inUse} in use${
                  mix && cell.by_pool && inUse > 0 ? ` (${partsOf(cell).map(k => `${cell.by_pool?.[k]} ${MIX_WORD[k].toLowerCase()}`).join(', ')})` : ''
                }, ${free} free${cell.short ? `, ${cell.short} with no room left` : ''}`}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className={`relative flex-1 min-w-0 h-full rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/50 transition-opacity duration-200 ${active != null && !on ? 'opacity-55' : ''}`}
              >
                <div className="mx-auto w-full max-w-[60px] h-full flex flex-col justify-end">
                {cell.short > 0 && (
                  <motion.span {...grow(Math.max(0, px(cell.short) - 2))} className="relative block w-full rounded-t-[5px] overflow-hidden" style={{ backgroundColor: 'var(--plan-short)' }}>
                    {px(cell.short) >= 22 && <span className="absolute inset-x-0 top-1 text-center text-[12px] sm:text-[13px] font-bold" style={{ color: '#FFFFFF' }}>+{cell.short}</span>}
                  </motion.span>
                )}
                {cell.short > 0 && <span className="block h-[2px]" aria-hidden />}
                {free > 0 && (
                  <motion.span {...grow(Math.max(0, px(free) - (inUse > 0 ? 2 : 0)))} className={`block w-full ${cell.short > 0 ? '' : 'rounded-t-[5px]'}`} style={{ backgroundColor: freeColor }} />
                )}
                {free > 0 && inUse > 0 && <span className="block h-[2px]" aria-hidden />}
                {inUse > 0 && (() => {
                  const parts = mix ? partsOf(cell) : [];
                  // The count sits on the top part: navy on amber, white on blue / slate
                  const ink = parts.length ? POOL_INK[parts[parts.length - 1]] : useInk;
                  return (
                    <motion.span
                      {...grow(px(inUse))}
                      className={`relative w-full overflow-hidden ${parts.length ? 'flex flex-col-reverse gap-[2px]' : 'block'} ${free > 0 || cell.short > 0 ? '' : 'rounded-t-[5px]'}`}
                      style={parts.length ? undefined : { backgroundColor: useColor }}
                    >
                      {parts.map(k => (
                        <span key={k} className="block w-full min-h-0" style={{ flex: `${cell.by_pool?.[k] ?? 0} 1 0%`, backgroundColor: `var(--plan-${k}-use)` }} />
                      ))}
                      {px(inUse) >= 24 && (
                        <span className="absolute inset-x-0 top-1.5 text-center text-[12px] sm:text-[15px] font-bold tabular-nums" style={{ color: ink }}>{inUse}</span>
                      )}
                    </motion.span>
                  );
                })()}
                </div>
              </div>
            );
          })}
        </div>

        {/* What the bar pointed at says — the numbers lead */}
        {c && active != null && (
          <div
            className="pointer-events-none absolute z-10 top-2 rounded-xl bg-white border border-[#E2E8F0] shadow-lg px-3.5 py-2.5 whitespace-nowrap"
            style={{
              left: `${((active + 0.5) / cells.length) * 100}%`,
              transform: `translateX(${active <= 1 ? '-12%' : active >= cells.length - 2 ? '-88%' : '-50%'})`,
            }}
            aria-hidden
          >
            <p className="text-sm font-semibold text-[#64748B] mb-1">{day}, {hourRange(hours[active])}</p>
            <p className="text-[15px] text-[#0B2A5B]"><b className="tabular-nums">{Math.min(c.in_use, c.usable)}</b> in use · <b className="tabular-nums">{Math.max(0, c.usable - c.in_use)}</b> free</p>
            {mix && c.by_pool && c.in_use > 0 && (
              <p className="mt-1 flex gap-3 text-sm text-[#334155]">
                {[...partsOf(c)].reverse().map(k => (
                  <span key={k} className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-[3px]" style={{ backgroundColor: `var(--plan-${k}-use)` }} />
                    <b className="tabular-nums text-[#0B2A5B]">{c.by_pool?.[k]}</b> {MIX_WORD[k].toLowerCase()}
                  </span>
                ))}
              </p>
            )}
            {c.short > 0 && <p className="text-[15px] font-bold text-[#B91C1C]">{plural(c.short, 'class')} with no room left</p>}
          </div>
        )}
      </div>
      <div className="flex gap-1.5 sm:gap-2.5 mt-2" aria-hidden>
        {hours.map((h, i) => (
          <span key={h} className={`flex-1 min-w-0 text-center text-[12px] sm:text-[13px] font-medium whitespace-nowrap ${active === i ? 'text-[#0B2A5B]' : 'text-[#64748B]'}`}>
            <span className="sm:hidden">{hourTiny(h)}</span>
            <span className="hidden sm:inline">{hourLabel(h)}</span>
          </span>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[15px] text-[#334155]">
        {mix && kinds.length
          ? kinds.map(k => (
            <span key={k} className="inline-flex items-center gap-2"><span className="w-3.5 h-3.5 rounded-[4px]" style={{ backgroundColor: `var(--plan-${k}-use)` }} aria-hidden /> {MIX_WORD[k]} in use</span>
          ))
          : <span className="inline-flex items-center gap-2"><span className="w-3.5 h-3.5 rounded-[4px]" style={{ backgroundColor: useColor }} aria-hidden /> In use</span>}
        <span className="inline-flex items-center gap-2"><span className="w-3.5 h-3.5 rounded-[4px]" style={{ backgroundColor: freeColor }} aria-hidden /> Free</span>
        {anyShort && <span className="inline-flex items-center gap-2"><span className="w-3.5 h-3.5 rounded-[4px]" style={{ backgroundColor: 'var(--plan-short)' }} aria-hidden /> No room left</span>}
      </div>
    </div>
  );
}

/* ─── The rooms behind "In use" / "Free" (Room Planning and Analytics) ────── */

const partLabel = (part: 'lec' | 'lab') => (part === 'lab' ? 'Laboratory' : 'Lecture');

/** "Laboratory" — one room of that kind */
const oneKind = (pool: RoomPool) => {
  const w = kindWord(pool, 1);
  return w.charAt(0).toUpperCase() + w.slice(1);
};

function RoomTile({ pool }: { pool: RoomPool }) {
  const { Icon, color } = POOL_ICON[pool];
  const tint: Record<RoomPool, string> = { lecture: '#EFF6FF', laboratory: '#FFFBEB', pathfit: '#F1F5F9' };
  return (
    <span className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: tint[pool] }}>
      <Icon className="w-[18px] h-[18px]" style={{ color }} aria-hidden />
    </span>
  );
}

/** Which rooms are in use at the busiest time (and the class in each), or free and until when */
export function BusiestRoomsDialog({ list, which, pool, onClose }: {
  list: BusiestRooms;
  which: 'use' | 'free' | null;
  pool: PoolFilter;
  onClose: () => void;
}) {
  const reduceMotion = useReducedMotion();
  // Lecture rooms, then laboratories, then PATHFIT venues — by name within each
  const byKind = <T extends { pool: RoomPool }>(rows: T[]) => [...rows].sort((a, b) => ROOM_POOLS.indexOf(a.pool) - ROOM_POOLS.indexOf(b.pool));
  const free = byKind(list.free);
  const used = byKind(list.in_use);
  const count = which === 'free' ? free.length : used.length;
  const title = which === 'free' ? `${count} free ${kindWord(pool, count)}` : `${count} ${kindWord(pool, count)} in use`;
  const row = (i: number) => ({
    initial: reduceMotion ? false : { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 10) * 0.03 } },
  });
  return (
    <Modal
      open={which != null}
      onClose={onClose}
      title={title}
      subtitle={list.at ? `At the busiest time · ${list.at.day}, ${clock12(list.at.start)}` : undefined}
      icon={which === 'free' ? DoorOpen : CalendarClock}
      size="md"
    >
      {count === 0 ? (
        <p className="py-8 text-center text-[15px] text-[#64748B]">{which === 'free' ? 'No room is free at the busiest time.' : 'No room is in use at the busiest time.'}</p>
      ) : (
        <ul className="rounded-xl border border-[#E2E8F0] divide-y divide-[#F1F5F9]">
          {which === 'free'
            ? free.map((r, i) => (
              <motion.li key={r.room_id} {...row(i)} className="flex items-center gap-3 px-4 py-3">
                <RoomTile pool={r.pool} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-bold text-[#0B2A5B] truncate">{r.room_name}</span>
                  <span className="block text-sm text-[#64748B]">{oneKind(r.pool)}</span>
                </span>
                <span className="text-[14px] font-semibold text-[#047857] text-right">
                  {r.until ? `Free until ${clock12(r.until)}` : 'Free the rest of the day'}
                </span>
              </motion.li>
            ))
            : used.map((r, i) => (
              <motion.li key={r.room_id} {...row(i)} className="flex items-start gap-3 px-4 py-3">
                <RoomTile pool={r.pool} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-bold text-[#0B2A5B] truncate">{r.room_name}</span>
                  {r.classes.map((c, j) => (
                    <span key={j} className="block text-[14px] text-[#334155]">
                      <b className="font-semibold text-[#0B2A5B]">{c.subject_code ?? '—'}</b>{c.block ? ` · ${c.block}` : ''} · {partLabel(c.part)}
                      <span className="block text-sm text-[#64748B]">{c.faculty_name || 'No faculty yet'} · {clockRange12(c.start, c.end)}</span>
                    </span>
                  ))}
                </span>
              </motion.li>
            ))}
        </ul>
      )}
    </Modal>
  );
}
