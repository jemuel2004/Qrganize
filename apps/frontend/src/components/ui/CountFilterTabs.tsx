'use client';

import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/*
 * Row of large filter buttons with counts (e.g. All · Assigned · Unassigned).
 * One highlight slides between the buttons and takes each one's colour; the
 * count badge pops when its number changes. Used on Faculty Workload,
 * Scheduling, Master Schedule, Faculty Schedule and Room Utilization (also
 * without counts, as a plain switch such as Daily · Weekly · Monthly).
 */

export interface CountFilterOption<K extends string> {
  key: K;
  label: string;
  /** Number badge — leave out for a plain option (e.g. Daily / Weekly) */
  count?: number;
  /** Fill of the highlight when this option is selected */
  color: string;
  /** Small status dot shown before the label (omit for none) */
  dot?: string;
  /** Small icon before the label — takes the text colour (white when selected) */
  icon?: ReactNode;
}

export default function CountFilterTabs<K extends string>({
  options,
  value,
  onChange,
  label,
  layoutId,
  className = '',
}: {
  options: CountFilterOption<K>[];
  value: K;
  onChange: (key: K) => void;
  /** Accessible name for the group */
  label: string;
  /** Unique per page so two filter rows never share a highlight */
  layoutId: string;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  /* Phones: one even grid of equal tiles (2 × 2 for four, rows of three for
     more) instead of buttons wrapping into a ragged 2 + 1. With counts, each
     tile shows the number on top and the label under it. From sm up it is the
     usual row of buttons. */
  const n = options.length;
  const phoneCols = n === 1 ? 'grid-cols-1' : n === 2 || n === 4 ? 'grid-cols-2' : 'grid-cols-3';
  const stacked = options.some(o => o.count !== undefined);
  return (
    <div className={`grid ${phoneCols} gap-2 sm:flex sm:flex-wrap sm:gap-2.5 ${className}`} role="tablist" aria-label={label}>
      {options.map(opt => {
        const active = value === opt.key;
        const dot = opt.dot && (
          <span className="w-2.5 h-2.5 flex-shrink-0 rounded-full transition-colors duration-200" style={{ backgroundColor: active ? '#FFFFFF' : opt.dot }} />
        );
        const icon = opt.icon && <span className="inline-flex flex-shrink-0" aria-hidden="true">{opt.icon}</span>;
        return (
          <motion.button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.key)}
            whileHover={reduceMotion || active ? undefined : { y: -2 }}
            whileTap={reduceMotion ? undefined : { scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 420, damping: 28 }}
            className={`relative isolate min-w-0 flex items-center justify-center text-center rounded-xl border-2 font-bold transition-[border-color,color,box-shadow] duration-200 ${
              stacked
                ? 'flex-col gap-1 min-h-[64px] px-1 py-2'
                : 'gap-1.5 min-h-[48px] px-2 leading-tight text-[length:clamp(13px,3.6vw,15px)]'
            } sm:inline-flex sm:flex-row sm:gap-2 sm:min-h-[44px] sm:px-4 sm:py-0 sm:text-[15px] sm:leading-normal ${
              active ? 'border-transparent shadow-[0_8px_18px_-10px_rgba(11,42,91,0.55)]' : 'bg-white border-[#CBD5E1] text-[#0B2A5B] hover:border-[#1D5BD6]'
            }`}
            // White set inline — the light-mode rule repaints `text-white` as dark ink
            style={active ? { color: '#FFFFFF' } : undefined}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute -inset-[2px] -z-10 rounded-xl"
                initial={false}
                animate={{ backgroundColor: opt.color }}
                transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 32 }}
                aria-hidden="true"
              />
            )}
            {stacked ? (
              <>
                {/* Phone: dot / icon + number on one line. From sm the wrapper
                    dissolves (contents) and the number moves after the label. */}
                <span className="flex items-center justify-center gap-1.5 sm:contents">
                  {dot}
                  {icon}
                  {opt.count !== undefined && (
                    <motion.span
                      key={opt.count}
                      initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 26 }}
                      className={`text-[19px] leading-none tabular-nums text-center sm:order-last sm:min-w-[26px] sm:px-1.5 sm:py-0.5 sm:rounded-full sm:text-[14px] sm:leading-normal ${active ? 'sm:bg-white/25' : 'sm:bg-[#F1F5F9]'}`}
                      style={active ? { color: '#FFFFFF' } : { color: '#334155' }}
                    >
                      {opt.count}
                    </motion.span>
                  )}
                </span>
                <span className="max-w-full leading-tight text-[length:clamp(12px,3.5vw,14px)] sm:text-[15px] sm:leading-normal">{opt.label}</span>
              </>
            ) : (
              <>{dot}{icon}{opt.label}</>
            )}
          </motion.button>
        );
      })}
    </div>
  );
}
