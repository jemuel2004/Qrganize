'use client';

import { useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/*
 * Small plain-HTML/SVG charts for Analytics. Bars and lines share one frame
 * (y-axis ticks, dashed grid, x labels) so they line up and look alike.
 */

export const EASE = [0.4, 0, 0.2, 1] as const;

export interface Series { key: string; label: string; color: string; values: number[] }

/** Round the axis top up to a tidy number so ticks read cleanly */
function niceMax(v: number) {
  if (v <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(v / 4)));
  const tick = [1, 2, 2.5, 5, 10].map(m => m * step).find(t => t * 4 >= v) ?? v / 4;
  return tick * 4;
}

/** x position in % — 'band' centres each label in its slot (bars), 'point' spreads edge to edge (lines) */
const xPos = (i: number, n: number, mode: 'band' | 'point') =>
  mode === 'band' ? ((i + 0.5) / n) * 100 : n > 1 ? 4 + (i / (n - 1)) * 92 : 50;

/** `fill` stretches the chart to its parent's height (fit-to-screen layout); otherwise a fixed h-44 plot */
function Frame({ max, format, labels, mode, fill, children }: {
  max: number; format: (n: number) => string; labels: string[]; mode: 'band' | 'point'; fill?: boolean; children: ReactNode;
}) {
  const ticks = [0, 1, 2, 3, 4].map(i => (max * i) / 4);
  const top = (v: number) => `${100 - (v / max) * 100}%`;
  return (
    <div className={`flex gap-2 ${fill ? 'h-full' : ''}`} style={fill ? { minHeight: 96 } : undefined}>
      <div className="w-9 flex-shrink-0 flex flex-col text-[11px] text-[#94A3B8] tabular-nums">
        <div className={`relative ${fill ? 'flex-1 min-h-0' : 'h-44'}`}>
          {ticks.map(t => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ top: top(t) }}>{format(t)}</span>
          ))}
        </div>
        <div className="h-4 mt-2.5" />
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className={`relative ${fill ? 'flex-1 min-h-0' : 'h-44'}`}>
          {ticks.map(t => (
            <div key={t} className="absolute inset-x-0 border-t border-dashed" style={{ top: top(t), borderColor: 'var(--donut-track)' }} />
          ))}
          {children}
        </div>
        <div className="relative h-4 mt-2.5 text-xs font-medium text-[#64748B]">
          {labels.map((l, i) => (
            <span key={i} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${xPos(i, labels.length, mode)}%` }}>
              {l}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Legend({ series }: { series: Pick<Series, 'key' | 'label' | 'color'>[] }) {
  return (
    <div className="flex items-center gap-3.5 text-[13px] text-[#475569]">
      {series.map(s => (
        <span key={s.key} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Grouped vertical bars — one group per label, one bar per series */
export function BarChart({ labels, series, format = String, fill }: { labels: string[]; series: Series[]; format?: (n: number) => string; fill?: boolean }) {
  const reduceMotion = useReducedMotion();
  const max = niceMax(Math.max(0, ...series.flatMap(s => s.values)));
  return (
    <Frame max={max} format={format} labels={labels} mode="band" fill={fill}>
      <div className="absolute inset-0 flex">
        {labels.map((l, i) => (
          <div key={l} className="flex-1 flex items-end justify-center gap-1 px-1">
            {series.map(s => (
              <motion.div
                key={s.key}
                title={`${l} · ${s.label}: ${s.values[i]}`}
                className="w-full max-w-[16px] rounded-t-[4px]"
                style={{ backgroundColor: s.color }}
                initial={reduceMotion ? false : { height: 0 }}
                animate={{ height: `${(s.values[i] / max) * 100}%` }}
                transition={{ duration: reduceMotion ? 0 : 0.6, ease: EASE, delay: reduceMotion ? 0 : i * 0.05 }}
              />
            ))}
          </div>
        ))}
      </div>
    </Frame>
  );
}

/** Lines with dots and a soft area fill; hover shows every series' value */
export function LineChart({ labels, series, format = String, max: fixedMax, fill }: {
  labels: string[]; series: Series[]; format?: (n: number) => string; max?: number; fill?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const max = fixedMax ?? niceMax(Math.max(0, ...series.flatMap(s => s.values)));
  const n = labels.length;
  const x = (i: number) => xPos(i, n, 'point');
  const y = (v: number) => 100 - (v / max) * 100;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');

  return (
    <Frame max={max} format={format} labels={labels} mode="point" fill={fill}>
      {/* Revealed left→right with a clip (pathLength dashes break with non-scaling strokes) */}
      <motion.svg
        viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible"
        initial={reduceMotion ? false : { clipPath: 'inset(0 100% 0 0)' }}
        animate={{ clipPath: 'inset(0 0% 0 0)' }}
        transition={{ duration: reduceMotion ? 0 : 0.9, ease: EASE }}
      >
        {series.map(s => (
          <g key={s.key}>
            <motion.path
              d={`${path(s.values)} L${x(n - 1)},100 L${x(0)},100 Z`} fill={s.color}
              initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 0.08 }} transition={{ duration: 0.6, ease: EASE }}
            />
            <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </motion.svg>
      {/* Dots are HTML so they stay round while the SVG stretches */}
      {series.map(s => s.values.map((v, i) => (
        <motion.span
          key={`${s.key}-${i}`}
          className="absolute w-2 h-2 -ml-1 -mt-1 rounded-full bg-white border-2 pointer-events-none"
          style={{ left: `${x(i)}%`, top: `${y(v)}%`, borderColor: s.color }}
          initial={reduceMotion ? false : { scale: 0 }}
          animate={{ scale: hover === i ? 1.5 : 1 }}
          transition={{ duration: 0.25, ease: EASE, delay: reduceMotion || hover != null ? 0 : 0.5 + i * 0.05 }}
        />
      )))}
      {hover != null && <div className="absolute top-0 bottom-0 border-l border-dashed border-[#94A3B8] pointer-events-none" style={{ left: `${x(hover)}%` }} />}
      <div className="absolute inset-0 flex" onMouseLeave={() => setHover(null)}>
        {labels.map((_, i) => <div key={i} className="flex-1" onMouseEnter={() => setHover(i)} />)}
      </div>
      {hover != null && (
        <div
          className="absolute -top-2 z-10 pointer-events-none rounded-lg bg-white border border-[#E2E8F0] shadow-lg px-2.5 py-1.5 text-xs whitespace-nowrap"
          style={{ left: `${x(hover)}%`, transform: `translateX(${x(hover) > 70 ? '-105%' : '8px'})` }}
        >
          <p className="font-semibold text-[#0B2A5B]">{labels[hover]}</p>
          {series.map(s => (
            <p key={s.key} className="text-[#475569]"><span style={{ color: s.color }}>●</span> {s.label} {format(s.values[hover])}</p>
          ))}
        </div>
      )}
    </Frame>
  );
}
