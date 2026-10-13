'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const WEEK = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/** 'YYYY-MM' + n months */
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * Month calendar where only the faculty's class dates can be picked — the rest
 * are greyed out. Dates already made available carry a green mark. Months are
 * limited to [minMonth, maxMonth].
 */
export default function ClassDateCalendar({
  month, onMonth, minMonth, maxMonth, today, selected, onSelect, isSelectable, isReleased, showLegend = false,
}: {
  /** 'YYYY-MM' shown */
  month: string;
  onMonth: (month: string) => void;
  minMonth: string;
  maxMonth: string;
  /** 'YYYY-MM-DD' (Manila) */
  today: string;
  selected: string;
  onSelect: (date: string) => void;
  isSelectable: (date: string) => boolean;
  isReleased: (date: string) => boolean;
  /** Explain the green mark (only needed once something is made available) */
  showLegend?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  /** Direction of the last month change, for the slide */
  const [dir, setDir] = useState(1);
  const [y, m] = month.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' });
  const canPrev = month > minMonth;
  const canNext = month < maxMonth;
  const go = (n: number) => { setDir(n); onMonth(shiftMonth(month, n)); };

  return (
    <div className="w-full select-none">
      <div className="flex items-center justify-between gap-2 mb-2">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={!canPrev}
          aria-label="Previous month"
          className="w-10 h-10 rounded-xl border border-[color:var(--border)] flex items-center justify-center text-[color:var(--foreground)] hover:border-[#1D5BD6] hover:text-[#1D5BD6] transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <p className="text-[17px] font-bold text-[color:var(--foreground)]" aria-live="polite">{label}</p>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={!canNext}
          aria-label="Next month"
          className="w-10 h-10 rounded-xl border border-[color:var(--border)] flex items-center justify-center text-[color:var(--foreground)] hover:border-[#1D5BD6] hover:text-[#1D5BD6] transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 mb-1">
        {WEEK.map(d => (
          <span key={d} className="text-center text-[13px] font-semibold text-[color:var(--foreground-muted)] py-1">{d}</span>
        ))}
      </div>

      <div className="overflow-hidden">
        <AnimatePresence mode="wait" initial={false} custom={dir}>
          <motion.div
            key={month}
            custom={dir}
            initial={reduceMotion ? false : { opacity: 0, x: 24 * dir }}
            animate={{ opacity: 1, x: 0, transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] } }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -24 * dir, transition: { duration: 0.14 } }}
            className="grid grid-cols-7 gap-1"
            role="grid"
            aria-label={label}
          >
            {cells.map((date, i) => {
              if (!date) return <span key={`blank-${i}`} aria-hidden="true" />;
              const day = Number(date.slice(8));
              const can = isSelectable(date);
              const on = date === selected;
              const released = isReleased(date);
              const isToday = date === today;
              return (
                <button
                  key={date}
                  type="button"
                  disabled={!can}
                  onClick={() => onSelect(date)}
                  aria-pressed={on}
                  aria-label={`${new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })}${can ? ', you have a class' : ''}${released ? ', made available' : ''}${isToday ? ', today' : ''}`}
                  className={`relative h-10 rounded-xl text-[15px] tabular-nums flex items-center justify-center transition-colors ${
                    on ? 'bg-[#1D5BD6] font-bold'
                      : can ? 'font-bold text-[#1D5BD6] bg-[#1D5BD6]/12 border border-[#1D5BD6]/35 hover:bg-[#1D5BD6]/20'
                        : 'text-[color:var(--foreground-disabled)] cursor-not-allowed'
                  } ${isToday && !on ? 'ring-2 ring-inset ring-[#64748B]' : ''}`}
                  style={on ? { color: '#FFFFFF' } : undefined}
                >
                  {day}
                  {released && (
                    <span
                      className={`absolute bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full ${on ? 'bg-white' : 'bg-[#059669]'}`}
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </motion.div>
        </AnimatePresence>
      </div>

      {showLegend && (
        <p className="mt-2.5 inline-flex items-center gap-1.5 text-[13px] text-[color:var(--foreground-muted)]">
          <span className="w-2 h-2 rounded-full bg-[#059669]" aria-hidden="true" /> Made available
        </p>
      )}
    </div>
  );
}
