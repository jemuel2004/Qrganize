'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Modal from './Modal';

/*
 * Date picker that pops up in the middle of the screen: month grid
 * (Mon–Sun), month navigation, Today shortcut, Apply / Cancel.
 * `highlight` shades the week or month the selected date belongs to, so a
 * Weekly/Monthly view shows the range that will be loaded.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const EASE = [0.45, 0, 0.55, 1] as const;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return { y, m: m - 1, d }; };

/** Monday-first week containing `date` → [monday, sunday] as 'YYYY-MM-DD'. */
function weekOf(date: string): [string, string] {
  const { y, m, d } = parse(date);
  const dt = new Date(Date.UTC(y, m, d));
  const dow = dt.getUTCDay();
  const mon = new Date(dt); mon.setUTCDate(d + (dow === 0 ? -6 : 1 - dow));
  const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
  return [mon.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
}

export default function CalendarModal({
  open,
  value,
  today,
  highlight = 'day',
  onApply,
  onClose,
  applying = false,
  success = false,
}: {
  open: boolean;
  /** 'YYYY-MM-DD' */
  value: string;
  /** 'YYYY-MM-DD' — marked with a ring */
  today: string;
  highlight?: 'day' | 'week' | 'month';
  onApply: (date: string) => void;
  onClose: () => void;
  /** Apply clicked and the new date is loading — spinner, and the window stays open */
  applying?: boolean;
  /** Plays the green ✓ "Date applied!" overlay (same as Curriculum / Faculty) */
  success?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [picked, setPicked] = useState(value);
  const [cursor, setCursor] = useState(() => { const { y, m } = parse(value); return { y, m }; });
  const [dir, setDir] = useState(1);

  // Re-sync every time it opens
  useEffect(() => {
    if (!open) return;
    setPicked(value);
    const { y, m } = parse(value);
    setCursor({ y, m });
  }, [open, value]);

  const cells = useMemo(() => {
    const first = new Date(Date.UTC(cursor.y, cursor.m, 1)).getUTCDay(); // 0 Sun
    const lead = first === 0 ? 6 : first - 1;
    const days = new Date(Date.UTC(cursor.y, cursor.m + 1, 0)).getUTCDate();
    const out: (string | null)[] = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= days; d++) out.push(ymd(cursor.y, cursor.m, d));
    while (out.length % 7) out.push(null);
    return out;
  }, [cursor]);

  const [wStart, wEnd] = weekOf(picked);
  const pm = parse(picked);
  const inRange = (d: string) =>
    highlight === 'week' ? d >= wStart && d <= wEnd
      : highlight === 'month' ? (() => { const p = parse(d); return p.y === pm.y && p.m === pm.m; })()
        : false;

  const go = (delta: number) => {
    setDir(delta);
    setCursor(c => {
      const m = c.m + delta;
      return { y: c.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 };
    });
  };

  const label = highlight === 'week'
    ? `Week of ${fmtLong(wStart)} – ${fmtLong(wEnd)}`
    : highlight === 'month'
      ? `${MONTHS[pm.m]} ${pm.y}`
      : fmtLong(picked, true);

  return (
    <Modal open={open} onClose={() => { if (!applying && !success) onClose(); }} title="Select date" size="sm">
      {success && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
          <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl">
            <svg width="72" height="72" viewBox="0 0 52 52" aria-hidden="true">
              <circle className="save-success-circle" cx="26" cy="26" r="24" fill="none" stroke="#22C55E" strokeWidth="3" />
              <path className="save-success-check" fill="none" stroke="#22C55E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" d="M14.5 27 22 34.5 38 17" />
            </svg>
            <p className="text-base font-semibold text-[#0B2A5B]">Date applied!</p>
          </div>
        </div>
      )}
      <div className="space-y-4">
        {/* Month navigation */}
        <div className="flex items-center justify-between">
          <button type="button" onClick={() => go(-1)} aria-label="Previous month"
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[#475569] hover:bg-[#EFF6FF] hover:text-[#1D5BD6] transition-colors">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={`${cursor.y}-${cursor.m}`}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE } }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
              className="text-base font-bold text-[#0B2A5B]"
            >
              {MONTHS[cursor.m]} {cursor.y}
            </motion.p>
          </AnimatePresence>
          <button type="button" onClick={() => go(1)} aria-label="Next month"
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[#475569] hover:bg-[#EFF6FF] hover:text-[#1D5BD6] transition-colors">
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        {/* Grid */}
        <div>
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map(w => (
              <span key={w} className="text-center text-[11px] font-bold uppercase tracking-wider text-[#94A3B8] py-1">{w}</span>
            ))}
          </div>
          <AnimatePresence mode="wait" initial={false} custom={dir}>
            <motion.div
              key={`${cursor.y}-${cursor.m}`}
              custom={dir}
              initial={reduceMotion ? false : { opacity: 0, x: 18 * dir }}
              animate={{ opacity: 1, x: 0, transition: { duration: 0.3, ease: EASE } }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -18 * dir, transition: { duration: 0.18, ease: EASE } }}
              className="grid grid-cols-7 gap-y-1"
            >
              {cells.map((d, i) => {
                if (!d) return <span key={`e${i}`} />;
                const sel = d === picked;
                const isToday = d === today;
                const range = inRange(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setPicked(d)}
                    onDoubleClick={() => { if (!applying) onApply(d); }}
                    className={`relative h-10 flex items-center justify-center text-sm tabular-nums transition-colors ${
                      range && !sel ? 'bg-[#EAF1FC]' : ''
                    }`}
                  >
                    <span
                      className={`w-9 h-9 rounded-full flex items-center justify-center font-semibold transition-all duration-200 ${
                        sel
                          ? 'bg-[#1D5BD6] shadow-[0_6px_14px_-6px_rgba(29,91,214,0.8)]'
                          : isToday
                            ? 'ring-2 ring-[#1D5BD6]/40 text-[#1D5BD6]'
                            : 'text-[#0B2A5B] hover:bg-[#EFF6FF]'
                      }`}
                      style={sel ? { color: '#FFFFFF' } : undefined}
                    >
                      {parse(d).d}
                    </span>
                  </button>
                );
              })}
            </motion.div>
          </AnimatePresence>
        </div>

        {highlight !== 'day' && <p className="text-center text-[13px] text-[#475569]">{label}</p>}

        {/* Actions */}
        <div className="flex items-center gap-3 pt-3 border-t border-[#F1F5F9]">
          <button type="button" onClick={() => { setPicked(today); const t = parse(today); setDir(1); setCursor({ y: t.y, m: t.m }); }}
            className="text-sm font-semibold text-[#1D5BD6] hover:underline mr-auto">
            Today
          </button>
          <button type="button" onClick={onClose} disabled={applying}
            className="h-10 px-4 rounded-xl text-sm font-semibold border border-[#D6E0EF] text-[#0B2A5B] hover:bg-[#F8FAFC] transition-colors disabled:opacity-50">
            Cancel
          </button>
          <motion.button type="button" onClick={() => onApply(picked)} disabled={applying} aria-busy={applying}
            whileTap={reduceMotion || applying ? undefined : { scale: 0.97 }}
            className="h-10 min-w-[112px] px-5 inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors disabled:cursor-wait"
            style={{ color: '#FFFFFF' }}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={applying ? 'busy' : 'idle'}
                initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE } }}
                exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
                className="inline-flex items-center gap-2"
              >
                {applying
                  ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" aria-hidden="true" /> Applying…</>
                  : 'Apply'}
              </motion.span>
            </AnimatePresence>
          </motion.button>
        </div>
      </div>
    </Modal>
  );
}

function fmtLong(s: string, withWeekday = false) {
  const { y, m, d } = parse(s);
  const dt = new Date(Date.UTC(y, m, d));
  return dt.toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
    ...(withWeekday ? { weekday: 'long' } : {}),
  });
}
