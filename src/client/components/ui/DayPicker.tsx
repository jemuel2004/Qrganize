'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CalendarDays, Check, ChevronDown } from 'lucide-react';
import AnchoredPopover from './AnchoredPopover';

/*
 * Day picker for the Scheduling session table.
 *
 * A grid of day cards showing, for the instructor: how many classes they
 * already teach that day and how many start times still fit this session.
 * Days with no free time are disabled. Each card carries the same day colour
 * as the Weekly Timetable (MTh blue, TF teal, W indigo, Sat slate).
 */

export interface DayOption {
  day: string;
  /** Classes the instructor already has that day */
  classes: number;
  /** Start times that still fit this session that day */
  freeStarts: number;
  /** Accent colour (matches the timetable's day tone) */
  accent: string;
  /** e.g. "Session 1" when another row of this form uses the day */
  usedBy?: string;
}

const EASE = [0.4, 0, 0.2, 1] as const;

export default function DayPicker({
  value,
  onChange,
  days,
}: {
  value: string;
  onChange: (day: string) => void;
  days: DayOption[];
}) {
  const reduceMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const close = useCallback(() => setOpen(false), []);

  const selected = days.find(d => d.day === value) ?? null;
  const selectedFull = !!selected && selected.freeStarts === 0;
  const available = days.filter(d => d.freeStarts > 0);

  useEffect(() => {
    if (!open) return;
    setFocusIdx(available.findIndex(d => d.day === value));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function choose(d: string) {
    onChange(d);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 2 : e.key === 'ArrowUp' ? -2 : 0;
    if (step) {
      e.preventDefault();
      setFocusIdx(i => Math.min(available.length - 1, Math.max(0, (i < 0 ? 0 : i) + step)));
    } else if (e.key === 'Enter' && available[focusIdx]) {
      e.preventDefault();
      choose(available[focusIdx].day);
    }
  }

  const focusedDay = available[focusIdx]?.day;

  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        onKeyDown={onKeyDown}
        whileTap={reduceMotion ? undefined : { scale: 0.97 }}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ height: 44, minWidth: 168 }}
        title={selectedFull ? `No free time left on ${value} for this session` : 'Choose a day'}
        className={`inline-flex items-center gap-2.5 pl-3.5 pr-2.5 rounded-xl border bg-white text-[14px] font-semibold transition-[border-color,box-shadow,background-color] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40 ${
          selectedFull
            ? 'border-red-300 text-red-700 bg-red-50/60'
            : open
              ? 'border-[#1D5BD6] text-[#0B2A5B] ring-2 ring-[#1D5BD6]/15'
              : `border-[#CBD5E1] hover:border-[#9DB8E8] ${value ? 'text-[#0B2A5B]' : 'text-[#64748B]'}`
        }`}
      >
        {selected
          ? <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: selected.accent }} aria-hidden="true" />
          : <CalendarDays className="w-3.5 h-3.5 flex-shrink-0 text-[#94A3B8]" />}
        <span className="flex-1 text-left">{value || 'Choose day'}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE }} className="inline-flex">
          <ChevronDown className="w-4 h-4 text-[#64748B]" />
        </motion.span>
      </motion.button>

      <AnchoredPopover open={open} onClose={close} anchorRef={triggerRef} panelRef={panelRef} width={320} maxHeight={420} label="Day" onKeyDown={onKeyDown}>
        <div role="listbox" aria-label="Days" className="overflow-y-auto overscroll-contain p-3 flex-1 min-h-0 bg-[#FAFBFD] grid grid-cols-2 gap-2 content-start">
          {days.map((d, i) => {
            const isSel = d.day === value;
            const full = d.freeStarts === 0;
            const focused = d.day === focusedDay;
            return (
              <motion.button
                key={d.day}
                type="button"
                role="option"
                aria-selected={isSel}
                aria-disabled={full}
                disabled={full && !isSel}
                onClick={() => !full && choose(d.day)}
                onMouseEnter={() => !full && setFocusIdx(available.findIndex(x => x.day === d.day))}
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.2, ease: EASE, delay: reduceMotion ? 0 : i * 0.03 } }}
                whileHover={full || reduceMotion ? undefined : { y: -2 }}
                whileTap={full || reduceMotion ? undefined : { scale: 0.97 }}
                title={full ? `No start time on ${d.day} fits this session` : `${d.freeStarts} start time${d.freeStarts === 1 ? '' : 's'} free on ${d.day}`}
                className={`relative overflow-hidden text-left rounded-xl border pl-3.5 pr-3 py-2.5 transition-[background-color,border-color,box-shadow] ${
                  full
                    ? 'bg-[#F4F6FA] border-[#EEF1F6] cursor-not-allowed'
                    : isSel
                      ? 'bg-[#1D5BD6] border-[#1D5BD6] shadow-[0_10px_22px_-12px_rgba(29,91,214,0.9)]'
                      : focused
                        ? 'bg-white border-[#1D5BD6] shadow-[0_8px_18px_-12px_rgba(29,91,214,0.6)]'
                        : 'bg-white border-[#E2E8F0] hover:border-[#9DB8E8] hover:shadow-[0_8px_18px_-12px_rgba(11,42,91,0.35)]'
                }`}
              >
                {/* Day colour, as on the Weekly Timetable */}
                <span
                  className="absolute left-0 inset-y-0 w-1"
                  style={{ backgroundColor: isSel ? 'rgba(255,255,255,0.7)' : d.accent, opacity: full ? 0.35 : 1 }}
                  aria-hidden="true"
                />
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-[13px] font-bold ${full ? 'text-[#94A3B8]' : isSel ? '' : 'text-[#0B2A5B]'}`}
                    // White set inline — the light-mode rule repaints `text-white` as dark ink
                    style={isSel ? { color: '#FFFFFF' } : undefined}
                  >
                    {d.day}
                  </span>
                  {isSel && <Check className="w-4 h-4 flex-shrink-0" style={{ color: '#FFFFFF' }} />}
                </div>
                <div
                  className={`mt-1 text-[11px] ${isSel ? '' : full ? 'text-red-500 font-semibold' : 'text-[#64748B]'}`}
                  style={isSel ? { color: 'rgba(255,255,255,0.85)' } : undefined}
                >
                  {full ? 'Fully booked' : d.classes === 0 ? 'No classes' : `${d.classes} class${d.classes === 1 ? '' : 'es'}`}
                </div>
              </motion.button>
            );
          })}
        </div>
      </AnchoredPopover>
    </>
  );
}
