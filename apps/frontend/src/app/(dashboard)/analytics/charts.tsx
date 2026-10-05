'use client';

import { useId, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/*
 * Small plain-HTML/SVG charts for Analytics: meter, pie chart, column (bar)
 * chart and mini bars. Colours come from CSS variables set once on the page
 * (VIZ_VARS) so the light and dark themes each get their own validated steps
 * (dataviz palette checker, light #FFFFFF / dark #14233F).
 */

export const EASE = [0.4, 0, 0.2, 1] as const;

/** Chart colour roles — light values, then the dark-theme steps */
export const VIZ_VARS = [
  '[--viz-accent:#1D5BD6] [html:not(.light)_&]:[--viz-accent:#5384E4]',
  // Card colour — the 2px gap between pie slices / touching bars
  '[--viz-surface:#FFFFFF] [html:not(.light)_&]:[--viz-surface:var(--surface)]',
  // Scheduling stages, furthest along → not started (one hue; dark theme flips)
  '[--stage-1:#12408F] [--stage-2:#1D5BD6] [--stage-3:#9DB8E8]',
  '[html:not(.light)_&]:[--stage-1:#86A9EC] [html:not(.light)_&]:[--stage-2:#5384E4] [html:not(.light)_&]:[--stage-3:#2E549C]',
].join(' ');

/** Progress meter — the fill grows in; the track is a light step of the same family */
export function Meter({ value, color = 'var(--viz-accent)', height = 8, delay = 0, label }: {
  /** 0–100 */
  value: number; color?: string; height?: number; delay?: number; label?: string;
}) {
  const reduceMotion = useReducedMotion();
  const w = Math.max(0, Math.min(100, value));
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height, backgroundColor: 'var(--donut-track)' }}
      role="meter" aria-valuenow={Math.round(w)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <motion.div className="h-full rounded-full" style={{ backgroundColor: color }}
        initial={reduceMotion ? false : { width: 0 }} animate={{ width: `${w}%` }}
        transition={{ duration: reduceMotion ? 0 : 0.7, ease: EASE, delay: reduceMotion ? 0 : delay }} />
    </div>
  );
}

export interface Part { key: string; label: string; value: number; color: string }

/* ─── Pie chart ───────────────────────────────────────────────────────────── */

const R = 90; // slice radius in a 200×200 box — leaves room for a hovered slice to pop out
/** Slice outline, angles in radians clockwise from 12 o'clock */
function slicePath(a0: number, a1: number) {
  const pt = (a: number) => `${100 + R * Math.sin(a)} ${100 - R * Math.cos(a)}`;
  return `M 100 100 L ${pt(a0)} A ${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${pt(a1)} Z`;
}

/**
 * Pie chart for a part-to-whole split (≤ 6 parts). It sweeps in; pointing at a
 * slice — or at its legend row (PartLegend with the same `active`) — pops it
 * out and shows its number.
 */
export function PieChart({ parts, size = 176, active, onActive, label }: {
  parts: Part[]; size?: number; active: string | null; onActive: (key: string | null) => void; label: string;
}) {
  const reduceMotion = useReducedMotion();
  const maskId = useId();
  const total = parts.reduce((s, p) => s + p.value, 0);
  const slices: (Part & { a0: number; a1: number; mid: number })[] = [];
  for (const p of parts) {
    if (p.value <= 0) continue;
    const a0 = slices.length ? slices[slices.length - 1].a1 : 0;
    const a1 = a0 + (p.value / total) * Math.PI * 2;
    slices.push({ ...p, a0, a1, mid: (a0 + a1) / 2 });
  }
  const on = slices.find(s => s.key === active) ?? null;

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} role="img" onPointerLeave={() => onActive(null)}
        aria-label={`${label}: ${parts.map(p => `${p.label} ${p.value}`).join(', ')}`}>
        <defs>
          {/* Sweeps the pie in clockwise from 12 o'clock */}
          <mask id={maskId}>
            <motion.circle cx="100" cy="100" r="50" fill="none" stroke="white" strokeWidth="101" transform="rotate(-90 100 100)"
              initial={reduceMotion ? false : { pathLength: 0 }} animate={{ pathLength: 1 }}
              transition={{ duration: reduceMotion ? 0 : 0.9, ease: EASE, delay: 0.15 }} />
          </mask>
        </defs>
        <g mask={`url(#${maskId})`}>
          {total === 0 ? (
            <circle cx="100" cy="100" r={R} fill="var(--donut-track)" />
          ) : slices.length === 1 ? (
            <circle cx="100" cy="100" r={R} fill={slices[0].color} onPointerEnter={() => onActive(slices[0].key)} />
          ) : (
            slices.map(s => (
              <motion.path
                key={s.key}
                d={slicePath(s.a0, s.a1)}
                fill={s.color}
                stroke="var(--viz-surface)"
                strokeWidth="2.4"
                strokeLinejoin="round"
                onPointerEnter={() => onActive(s.key)}
                animate={{ x: active === s.key ? Math.sin(s.mid) * 6 : 0, y: active === s.key ? -Math.cos(s.mid) * 6 : 0 }}
                transition={{ type: 'spring', stiffness: 400, damping: 28 }}
                className="cursor-pointer"
              />
            ))
          )}
        </g>
      </svg>
      {/* Readout on the slice pointed at — the number leads */}
      {on && (
        <div
          className="pointer-events-none absolute z-10 rounded-xl bg-white border border-[#E2E8F0] shadow-lg px-3 py-1.5 whitespace-nowrap text-center"
          style={{
            left: `${(100 + Math.sin(on.mid) * R * 0.55) / 2}%`,
            top: `${(100 - Math.cos(on.mid) * R * 0.55) / 2}%`,
            transform: 'translate(-50%, -50%)',
          }}
          aria-hidden
        >
          <p className="text-[15px] font-bold text-[#0B2A5B] leading-tight">{on.value} <span className="text-[12px] font-semibold text-[#64748B]">· {Math.round((on.value / total) * 100)}%</span></p>
          <p className="text-[11px] text-[#475569]">{on.label}</p>
        </div>
      )}
    </div>
  );
}

/** Legend rows for a pie: swatch · label · count · share. Pointing at / focusing a row highlights its slice. */
export function PartLegend({ parts, columns = 1, active, onActive }: {
  parts: Part[]; columns?: 1 | 2; active?: string | null; onActive?: (key: string | null) => void;
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <ul className={`grid ${columns === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'} gap-x-4 gap-y-1`} onPointerLeave={() => onActive?.(null)}>
      {parts.map(p => {
        const on = active === p.key;
        return (
          <li key={p.key}>
            <button
              type="button"
              onPointerEnter={() => onActive?.(p.key)}
              onFocus={() => onActive?.(p.key)}
              onBlur={() => onActive?.(null)}
              className={`w-full flex items-center gap-2 min-w-0 rounded-lg px-2 py-1.5 text-sm text-left transition-[background-color,opacity] duration-200 cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40 ${
                on ? 'bg-[#F1F5F9]' : active ? 'opacity-55' : ''
              }`}
            >
              <span className="w-3 h-3 rounded-[3px] flex-shrink-0" style={{ backgroundColor: p.color }} aria-hidden />
              <span className={`truncate ${on ? 'font-semibold text-[#0B2A5B]' : 'text-[#475569]'}`}>{p.label}</span>
              <span className="ml-auto pl-2 font-bold text-[#0B2A5B] tabular-nums">{p.value}</span>
              <span className="w-10 text-right text-[12px] text-[#94A3B8] tabular-nums">{total ? Math.round((p.value / total) * 100) : 0}%</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ─── Column (bar) chart ──────────────────────────────────────────────────── */

export interface Series { key: string; label: string; color: string; values: number[] }

/** Round the axis top up to a tidy number so ticks read cleanly */
function niceMax(v: number) {
  if (v <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(v / 4)));
  const tick = [1, 2, 2.5, 5, 10].map(m => m * step).find(t => t * 4 >= v) ?? v / 4;
  return tick * 4;
}

/**
 * Vertical bars, one group per label (one bar per series). Bars grow from the
 * baseline; pointing at a group — or tabbing to it — shows every series' value.
 * `labelMax` writes the value on the tallest bar (single-series charts).
 */
export function ColumnChart({ labels, titles, series, max, format, height = 200, labelMax = false, details }: {
  labels: string[];
  /** Readout heading per group (defaults to the label) */
  titles?: string[];
  series: Series[];
  /** Fixed axis top (e.g. 100 for %); otherwise a tidy number above the tallest bar */
  max?: number;
  format: (n: number) => string;
  height?: number;
  labelMax?: boolean;
  /** Extra readout line per group */
  details?: (i: number) => ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const top = max ?? niceMax(Math.max(1, ...series.flatMap(s => s.values)));
  const ticks = [0, 1, 2, 3, 4].map(i => (top * i) / 4);
  const n = labels.length;
  const barW = `min(${series.length > 1 ? 18 : 26}px, ${Math.floor(72 / series.length)}%)`;
  // The tallest bar of a single-series chart gets its value written on top
  let peak = -1;
  if (labelMax && series.length === 1) {
    const vals = series[0].values;
    for (let i = 0; i < vals.length; i++) if (vals[i] > 0 && (peak < 0 || vals[i] > vals[peak])) peak = i;
  }

  return (
    <div className="flex gap-2 select-none">
      <div className="w-9 flex-shrink-0 relative text-[11px] text-[#94A3B8] tabular-nums" style={{ height }} aria-hidden>
        {ticks.map(t => (
          <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (t / top) * 100}%` }}>{format(t)}</span>
        ))}
      </div>
      <div className="flex-1 min-w-0">
        <div className="relative" style={{ height }} onPointerLeave={() => setActive(null)}>
          {ticks.map(t => (
            <div key={t} className="absolute inset-x-0 border-t" style={{ top: `${100 - (t / top) * 100}%`, borderColor: 'var(--donut-track)' }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex">
            {labels.map((l, i) => {
              const on = active === i;
              return (
                <div
                  key={l + i}
                  tabIndex={0}
                  role="group"
                  aria-label={`${titles?.[i] ?? l}: ${series.map(s => `${s.label} ${format(s.values[i] ?? 0)}`).join(', ')}`}
                  onPointerEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className="relative flex-1 min-w-0 flex items-end justify-center gap-0.5 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40"
                >
                  <span aria-hidden className={`absolute inset-y-0 inset-x-[8%] rounded-md transition-colors duration-200 ${on ? 'bg-[#F1F5F9]' : ''}`} />
                  {series.map((s, si) => {
                    const v = s.values[i] ?? 0;
                    return (
                      <motion.div
                        key={s.key}
                        className="relative rounded-t-[4px]"
                        style={{ width: barW, backgroundColor: s.color }}
                        initial={reduceMotion ? false : { height: 0 }}
                        animate={{ height: `${Math.min(100, (v / top) * 100)}%` }}
                        transition={{ duration: reduceMotion ? 0 : 0.6, ease: EASE, delay: reduceMotion ? 0 : 0.1 + i * 0.05 + si * 0.04 }}
                      >
                        {i === peak && (
                          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 text-[12px] font-bold text-[#0B2A5B] whitespace-nowrap">{format(v)}</span>
                        )}
                      </motion.div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Readout for the group pointed at — values lead, labels follow */}
          {active != null && (
            <div
              className="pointer-events-none absolute z-10 top-1 rounded-xl bg-white border border-[#E2E8F0] shadow-lg px-3 py-2 whitespace-nowrap"
              style={{
                left: `${((active + 0.5) / n) * 100}%`,
                transform: `translateX(${active === 0 ? '-12%' : active === n - 1 ? '-88%' : '-50%'})`,
              }}
              aria-hidden
            >
              <p className="text-[12px] font-semibold text-[#64748B] mb-1">{titles?.[active] ?? labels[active]}</p>
              {series.map(s => (
                <p key={s.key} className="flex items-center gap-2 text-[13px]">
                  <span className="w-3 h-0.5 rounded-full" style={{ backgroundColor: s.color }} />
                  <span className="font-bold text-[#0B2A5B] tabular-nums">{format(s.values[active] ?? 0)}</span>
                  <span className="text-[#475569]">{s.label}</span>
                </p>
              ))}
              {details?.(active)}
            </div>
          )}
        </div>
        <div className="flex mt-2" aria-hidden>
          {labels.map((l, i) => (
            <span key={l + i} className={`flex-1 min-w-0 text-center text-[11px] sm:text-[12px] font-medium whitespace-nowrap ${active === i ? 'text-[#0B2A5B]' : 'text-[#64748B]'}`}>{l}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Legend for a bar chart with two or more series (a swatch per series) */
export function SeriesLegend({ series }: { series: Pick<Series, 'key' | 'label' | 'color'>[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[#475569]">
      {series.map(s => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-[3px]" style={{ backgroundColor: s.color }} aria-hidden />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Tiny monthly bars for a summary tile: past months grey, the latest in the accent */
export function MiniBars({ values, labels, format }: { values: number[]; labels: string[]; format: (n: number) => string }) {
  const reduceMotion = useReducedMotion();
  const top = Math.max(1, ...values);
  return (
    <div>
      <div className="flex items-end gap-1.5 h-10" role="img" aria-label={labels.map((l, i) => `${l} ${format(values[i])}`).join(', ')}>
        {values.map((v, i) => (
          <div key={i} className="flex-1 h-full flex items-end" title={`${labels[i]}: ${format(v)}`}>
            <motion.div
              className="w-full rounded-t-[3px]"
              style={{ backgroundColor: i === values.length - 1 ? 'var(--viz-accent)' : '#CBD5E1', minHeight: 2 }}
              initial={reduceMotion ? false : { height: 0 }}
              animate={{ height: `${(v / top) * 100}%` }}
              transition={{ duration: reduceMotion ? 0 : 0.6, ease: EASE, delay: reduceMotion ? 0 : 0.25 + i * 0.06 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5 text-[11px] text-[#94A3B8]" aria-hidden>
        {labels.map((l, i) => <span key={i} className="flex-1 text-center">{l}</span>)}
      </div>
    </div>
  );
}

/* ─── Hours ───────────────────────────────────────────────────────────────── */

/** 9 → "9a" */
export const hourShort = (h: number) => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
/** 9 → "9–10 AM", 11 → "11 AM–12 PM" */
export function hourRange(h: number) {
  const ap = (x: number) => (x < 12 ? 'AM' : 'PM');
  const n = (x: number) => x % 12 || 12;
  return ap(h) === ap(h + 1) ? `${n(h)}–${n(h + 1)} ${ap(h)}` : `${n(h)} ${ap(h)}–${n(h + 1)} ${ap(h + 1)}`;
}

/** The busiest cell of a [day][hour] grid (first one on a tie) */
export function busiest(counts: number[][]) {
  let best = { d: 0, h: 0, n: -1 };
  for (let d = 0; d < counts.length; d++) {
    for (let h = 0; h < counts[d].length; h++) if (counts[d][h] > best.n) best = { d, h, n: counts[d][h] };
  }
  return best;
}
