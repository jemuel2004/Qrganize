'use client';

import { motion, useReducedMotion } from 'framer-motion';

/*
 * Row of large filter buttons with counts (e.g. All · Assigned · Unassigned).
 * One highlight slides between the buttons and takes each one's colour; the
 * count badge pops when its number changes. Used on Faculty Workload and on
 * Scheduling's faculty list.
 */

export interface CountFilterOption<K extends string> {
  key: K;
  label: string;
  count: number;
  /** Fill of the highlight when this option is selected */
  color: string;
  /** Small status dot shown before the label (omit for none) */
  dot?: string;
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
  return (
    <div className={`flex flex-wrap gap-2.5 ${className}`} role="tablist" aria-label={label}>
      {options.map(opt => {
        const active = value === opt.key;
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
            className={`relative isolate inline-flex items-center gap-2 min-h-[44px] px-4 rounded-xl border-2 text-[15px] font-bold transition-[border-color,color,box-shadow] duration-200 ${
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
            {opt.dot && (
              <span className="w-2.5 h-2.5 rounded-full transition-colors duration-200" style={{ backgroundColor: active ? '#FFFFFF' : opt.dot }} />
            )}
            {opt.label}
            <motion.span
              key={opt.count}
              initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 500, damping: 26 }}
              className={`min-w-[26px] px-1.5 py-0.5 rounded-full text-[13px] tabular-nums text-center ${active ? 'bg-white/25' : 'bg-[#F1F5F9]'}`}
              style={active ? { color: '#FFFFFF' } : { color: '#334155' }}
            >
              {opt.count}
            </motion.span>
          </motion.button>
        );
      })}
    </div>
  );
}
