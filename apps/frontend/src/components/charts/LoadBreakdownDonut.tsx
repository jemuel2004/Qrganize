'use client';

import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

/*
 * Donut for the Faculty Schedules summary: how the term's subjects split
 * across Regular load / Overload / Praise. Plain SVG (no chart library).
 *
 * Colours come from CSS tokens (--load-regular / --load-overload /
 * --load-praise in globals.css) — validated with the dataviz palette checker
 * for light (#FFFFFF card) and dark (#14233F card) surfaces: blue = Regular,
 * orange = Overload, golden yellow = Praise. Orange↔gold sits in the CVD
 * "floor" band and gold is light on white, so identity is also carried by the
 * gaps between slices and the always-visible legend with values + shares.
 *
 * Motion: arcs draw in clockwise one after another, legend share bars grow
 * alongside, and hovering a slice or legend row widens that slice, dims the
 * rest and swaps the centre readout. All motion is off under reduced motion.
 */

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  /** CSS colour, e.g. 'var(--load-regular)' */
  color: string;
}

const GAP = 3; // px of arc left empty between slices (the "surface gap")
const EASE = [0.4, 0, 0.2, 1] as const;

export default function LoadBreakdownDonut({
  slices,
  centerLabel = 'Subjects',
  extraRows = [],
  title,
  subtitle,
  action,
  compact = false,
  ringSize,
  centerValue,
  bare = false,
  onSliceClick,
}: {
  slices: DonutSlice[];
  centerLabel?: string;
  /** Plain stat rows shown in the legend below the slices (no swatch), e.g. instructors. */
  extraRows?: { label: string; value: number }[];
  title?: string;
  subtitle?: string;
  /** Top-right of the title row, e.g. a "View" link */
  action?: ReactNode;
  /** Smaller ring with the legend always beside it — fits a one-third-width card */
  compact?: boolean;
  /** Exact ring diameter in px (e.g. to fit a fixed-height card); small rings tighten the legend */
  ringSize?: number;
  /** Shown in the ring's centre instead of the total (e.g. a rate) */
  centerValue?: ReactNode;
  /** No card of its own — for use inside another panel */
  bare?: boolean;
  /** Makes slices and legend rows clickable (slices with a value only) */
  onSliceClick?: (key: string) => void;
}) {
  const SIZE = ringSize ?? (compact ? 148 : 184);
  const STROKE = Math.round(SIZE / 8.2);
  const dense = SIZE < 130;
  const R = (SIZE - STROKE - 8) / 2; // leave room for the hover-widened stroke
  const C = 2 * Math.PI * R;
  const reduceMotion = useReducedMotion();
  const [hover, setHover] = useState<string | null>(null);
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const active = slices.filter(s => s.value > 0);
  const hovered = hover ? slices.find(s => s.key === hover) ?? null : null;
  const pct = (v: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
  // Replay the draw-in whenever the numbers change (filters, term switch)
  const dataKey = slices.map(s => `${s.key}:${s.value}`).join('|');

  // Lay slices end-to-end around the ring, starting at 12 o'clock.
  const arcs = active.map((s, i) => {
    const len = (s.value / total) * C;
    const start = active.slice(0, i).reduce((sum, prev) => sum + (prev.value / total) * C, 0);
    const gap = active.length > 1 ? Math.min(GAP, len / 2) : 0;
    return { ...s, dash: Math.max(0, len - gap), start, index: i };
  });

  return (
    <div className={bare ? '' : `qr-donut-panel rounded-2xl ${dense ? 'p-3.5 overflow-hidden' : 'p-4 sm:p-5'}`}>
      {/* The total lives in the ring's centre only — no badge / legend row repeating it */}
      {(title || subtitle) && (
        <div className={`${dense ? 'mb-2' : 'mb-4'} min-w-0 flex items-start justify-between gap-3`}>
          <div className="min-w-0">
            {title && <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#1D5BD6]">{title}</p>}
            {subtitle && <p className="text-xs text-[#64748B] mt-0.5 truncate">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}

      <div className={compact ? 'flex flex-col min-[420px]:flex-row items-center gap-4' : 'flex flex-col sm:flex-row items-center gap-5 sm:gap-7'}>
        {/* Ring */}
        <div className="relative flex-shrink-0" style={{ width: SIZE, height: SIZE }}>
          {/* Soft halo behind the ring */}
          <div
            className="absolute inset-4 rounded-full pointer-events-none"
            style={{ boxShadow: '0 12px 32px -12px rgba(29,91,214,0.35)' }}
            aria-hidden="true"
          />
          <svg
            key={dataKey}
            width={SIZE}
            height={SIZE}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            role="img"
            aria-label={`${total} ${centerLabel.toLowerCase()}: ${slices.map(s => `${s.label} ${s.value}`).join(', ')}`}
            className="relative -rotate-90"
          >
            {/* Track */}
            <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--donut-track)" strokeWidth={STROKE} />
            {arcs.map(a => (
              <motion.circle
                key={a.key}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={R}
                fill="none"
                strokeDashoffset={-a.start}
                strokeWidth={STROKE}
                initial={reduceMotion ? false : { strokeDasharray: `0 ${C}`, strokeWidth: STROKE }}
                animate={{
                  strokeDasharray: `${a.dash} ${C - a.dash}`,
                  strokeWidth: hover === a.key ? STROKE + 6 : STROKE,
                  opacity: hover && hover !== a.key ? 0.35 : 1,
                }}
                transition={{
                  strokeDasharray: { duration: reduceMotion ? 0 : 0.7, ease: EASE, delay: reduceMotion ? 0 : 0.15 + a.index * 0.18 },
                  strokeWidth: { duration: reduceMotion ? 0 : 0.2, ease: EASE },
                  opacity: { duration: reduceMotion ? 0 : 0.2, ease: EASE },
                }}
                style={{ stroke: a.color, cursor: 'pointer' }}
                onMouseEnter={() => setHover(a.key)}
                onMouseLeave={() => setHover(null)}
                onClick={onSliceClick ? () => onSliceClick(a.key) : undefined}
              >
                <title>{`${a.label}: ${a.value} (${pct(a.value)}%)`}</title>
              </motion.circle>
            ))}
          </svg>

          {/* Centre readout — total, or the hovered slice */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={hovered?.key ?? 'total'}
                initial={reduceMotion ? false : { opacity: 0, y: 4, scale: 0.94 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.2, ease: EASE } }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.94, transition: { duration: 0.12, ease: EASE } }}
                className="flex flex-col items-center"
              >
                <span className={`${dense ? 'text-[22px]' : compact ? 'text-[28px]' : 'text-[34px]'} font-bold leading-none tabular-nums text-[#0B2A5B]`}>
                  {hovered ? hovered.value : centerValue ?? total}
                </span>
                <span
                  className={`${dense ? 'text-[10px] mt-0.5' : 'text-xs mt-1.5'} font-medium text-[#64748B] leading-tight`}
                  style={{ maxWidth: Math.min(110, SIZE - STROKE * 2 - 14) }}
                >
                  {hovered ? `${hovered.label} · ${pct(hovered.value)}%` : centerLabel}
                </span>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Legend — always present; values stay in ink colours (swatch/bar carry identity) */}
        <ul className={`${compact ? 'w-full min-w-0 flex-1' : 'w-full sm:w-auto sm:min-w-[230px]'} ${dense ? 'space-y-0 text-[13px]' : 'space-y-1 text-sm'}`}>
          {slices.map((s, i) => {
            const clickable = !!onSliceClick && s.value > 0;
            return (
            <li
              key={s.key}
              onMouseEnter={() => s.value > 0 && setHover(s.key)}
              onMouseLeave={() => setHover(null)}
              onClick={clickable ? () => onSliceClick(s.key) : undefined}
              onKeyDown={clickable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSliceClick(s.key); } } : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? `Show faculty with ${s.label}` : undefined}
              className={`rounded-lg px-2.5 ${dense ? 'py-0.5' : 'py-1.5'} transition-colors ${hover === s.key ? 'qr-donut-row-active' : ''} ${
                hover && hover !== s.key ? 'opacity-60' : ''
              } ${clickable ? 'cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40' : ''}`}
            >
              <div className="flex items-center gap-2.5">
                <span className="w-3 h-3 rounded-[3px] flex-shrink-0" style={{ backgroundColor: s.color }} aria-hidden="true" />
                <span className="text-[#22406F] font-medium">{s.label}</span>
                <span className="ml-auto pl-4 text-xs text-[#94A3B8] tabular-nums">{pct(s.value)}%</span>
                <span className="w-7 text-right font-bold tabular-nums text-[#0B2A5B]">{s.value}</span>
              </div>
              {/* Share bar */}
              <div className={`${dense ? 'mt-1' : 'mt-1.5'} ml-[22px] h-1.5 rounded-full overflow-hidden`} style={{ backgroundColor: 'var(--donut-track)' }}>
                <motion.div
                  key={dataKey}
                  className="h-full rounded-full"
                  style={{ backgroundColor: s.color }}
                  initial={reduceMotion ? false : { width: 0 }}
                  animate={{ width: `${pct(s.value)}%` }}
                  transition={{ duration: reduceMotion ? 0 : 0.7, ease: EASE, delay: reduceMotion ? 0 : 0.15 + i * 0.18 }}
                />
              </div>
            </li>
            );
          })}
          {extraRows.map(r => (
            <li key={r.label} className="flex items-center gap-2.5 px-2.5 pt-2.5 mt-1 border-t border-[#E3E9F3]">
              <span className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
              <span className="text-[#5B6F8C]">{r.label}</span>
              <span className="ml-auto pl-4 font-bold tabular-nums text-[#0B2A5B]">{r.value}</span>
            </li>
          ))}
          {onSliceClick && total > 0 && (
            <li className="px-2.5 pt-1.5 text-[11px] text-[#94A3B8]">Click a load type to see its faculty.</li>
          )}
          </ul>
      </div>
    </div>
  );
}
