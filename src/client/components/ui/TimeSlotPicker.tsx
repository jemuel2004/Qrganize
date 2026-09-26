'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, Clock, Moon, Sun, Sunset } from 'lucide-react';
import AnchoredPopover from './AnchoredPopover';

/*
 * Start-time picker for the Scheduling session table.
 *
 * Replaces a long native <select>: slots are grouped Morning / Afternoon /
 * Evening as a chip grid, times the instructor is busy stay visible but
 * disabled (so gaps make sense), and hovering a chip previews the end time.
 */

export interface TimeSlot {
  /** 'HH:MM' (24h) */
  value: string;
  free: boolean;
  /** The class this start time would run into, e.g. "CS 412 Lab · 3:00 PM–4:30 PM" */
  conflict?: string;
}

function toMin(t: string) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}
function fmt(t: string) {
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h)) return '—';
  const hr = ((h % 24) % 12) || 12;
  return `${hr}:${String(m || 0).padStart(2, '0')} ${h % 24 >= 12 ? 'PM' : 'AM'}`;
}

const GROUPS = [
  { key: 'morning',   label: 'Morning',   Icon: Sun,    test: (m: number) => m < 12 * 60 },
  { key: 'afternoon', label: 'Afternoon', Icon: Sunset, test: (m: number) => m >= 12 * 60 && m < 17 * 60 },
  { key: 'evening',   label: 'Evening',   Icon: Moon,   test: (m: number) => m >= 17 * 60 },
] as const;

const EASE = [0.4, 0, 0.2, 1] as const;

/** Thin 7 AM–9 PM bar: the instructor's classes (grey) and where this
 *  session would land (blue, or red when it overlaps). Hover a block to see it. */
const TL_START = 7 * 60;
const TL_END = 21 * 60;
function DayTimeline({ busy, breaks = [], preview, conflict }: {
  busy: { start: number; end: number; label: string }[];
  breaks?: { start: number; end: number; label: string }[];
  preview: { start: number; end: number };
  conflict: boolean;
}) {
  const pct = (m: number) => `${((Math.min(Math.max(m, TL_START), TL_END) - TL_START) / (TL_END - TL_START)) * 100}%`;
  const width = (a: number, b: number) =>
    `${((Math.min(b, TL_END) - Math.max(a, TL_START)) / (TL_END - TL_START)) * 100}%`;
  return (
    <div className="mt-2.5">
      <div className="relative h-3 rounded-full bg-[#EEF2F8] overflow-hidden">
        {breaks.map(b => (
          <span
            key={`break-${b.start}`}
            title={b.label}
            className="absolute inset-y-0 border-x border-white"
            style={{
              left: pct(b.start), width: width(b.start, b.end),
              backgroundImage: 'repeating-linear-gradient(135deg, #F5C66B 0 3px, #FDF3DC 3px 6px)',
            }}
          />
        ))}
        {busy.map(b => (
          <span
            key={`${b.start}-${b.label}`}
            title={b.label}
            className="absolute inset-y-0 bg-[#94A3B8] border-x border-white"
            style={{ left: pct(b.start), width: width(b.start, b.end) }}
          />
        ))}
        <span
          className={`absolute inset-y-0 rounded-full ring-2 ring-white transition-[left,width,background-color] duration-200 ${conflict ? 'bg-red-500' : 'bg-[#1D5BD6]'}`}
          style={{ left: pct(preview.start), width: width(preview.start, preview.end) }}
          aria-hidden="true"
        />
      </div>
      <div className="relative h-3 mt-0.5 text-[9px] font-semibold text-[#94A3B8] tabular-nums">
        {[7, 10, 13, 16, 19].map(h => (
          <span key={h} className="absolute -translate-x-1/2 first:translate-x-0" style={{ left: pct(h * 60) }}>
            {h % 12 || 12}{h < 12 ? 'a' : 'p'}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function TimeSlotPicker({
  value,
  onChange,
  slots,
  durationMin,
  day,
  busy = [],
  breaks = [],
}: {
  value: string;
  onChange: (value: string) => void;
  slots: TimeSlot[];
  /** Session length — used for the end-time preview */
  durationMin: number;
  /** Selected day, for the header ('' = no day yet) */
  day: string;
  /** The instructor's classes on this day (minutes from midnight), drawn on
   *  the day timeline so struck-out times make sense */
  busy?: { start: number; end: number; label: string }[];
  /** Fixed breaks for everyone (e.g. lunch 12:00–1:00 PM), drawn hatched on the timeline */
  breaks?: { start: number; end: number; label: string }[];
}) {
  const reduceMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(-1);
  const close = useCallback(() => setOpen(false), []);

  const currentTaken = !!day && !slots.find(s => s.value === value)?.free;
  const freeSlots = slots.filter(s => s.free);
  const preview = hover ?? value;
  const hoveredConflict = hover ? slots.find(s => s.value === hover)?.conflict : undefined;

  // Bring the selected chip into view when opening
  useEffect(() => {
    if (!open) return;
    setFocusIdx(freeSlots.findIndex(s => s.value === value));
    const id = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, 30);
    return () => window.clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function choose(v: string) {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    const cols = 3;
    const move = (d: number) => {
      e.preventDefault();
      setFocusIdx(i => {
        const n = Math.min(freeSlots.length - 1, Math.max(0, (i < 0 ? 0 : i) + d));
        setHover(freeSlots[n]?.value ?? null);
        return n;
      });
    };
    if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'ArrowDown') move(cols);
    else if (e.key === 'ArrowUp') move(-cols);
    else if (e.key === 'Enter' && freeSlots[focusIdx]) { e.preventDefault(); choose(freeSlots[focusIdx].value); }
  }

  const focusedValue = freeSlots[focusIdx]?.value;

  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        onKeyDown={onKeyDown}
        whileTap={reduceMotion ? undefined : { scale: 0.97 }}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{ height: 44, minWidth: 148 }}
        title={day ? `Start time — only times the instructor is free on ${day} can be picked` : 'Start time — pick a day to see the instructor’s free times'}
        className={`group inline-flex items-center gap-2.5 pl-3.5 pr-2.5 rounded-xl border bg-white text-[14px] font-semibold tabular-nums transition-[border-color,box-shadow,background-color] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40 ${
          currentTaken
            ? 'border-red-300 text-red-700 bg-red-50/60'
            : open
              ? 'border-[#1D5BD6] text-[#0B2A5B] ring-2 ring-[#1D5BD6]/15'
              : 'border-[#CBD5E1] text-[#0B2A5B] hover:border-[#9DB8E8]'
        }`}
      >
        <Clock className={`w-4 h-4 flex-shrink-0 ${currentTaken ? 'text-red-500' : 'text-[#1D5BD6]'}`} />
        <span className="flex-1 text-left">{fmt(value)}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE }} className="inline-flex">
          <ChevronDown className="w-4 h-4 text-[#64748B]" />
        </motion.span>
      </motion.button>

      <AnchoredPopover open={open} onClose={close} anchorRef={triggerRef} panelRef={panelRef} label="Start time" onKeyDown={onKeyDown}>
        {/* Header */}
        <div className="px-4 pt-3 pb-2 border-b border-[#F1F5F9] flex-shrink-0">
          <p className="text-[13px] font-semibold text-[#0B2A5B]">
            {day
              ? <>{day} <span className="text-[#94A3B8] font-medium">· {durationMin >= 60 ? `${Math.floor(durationMin / 60)} hr` : ''}{durationMin % 60 ? ` ${durationMin % 60} min` : ''}</span></>
              : 'Pick a day first'}
          </p>
          {day && (
            <DayTimeline
              busy={busy}
              breaks={breaks}
              preview={{ start: toMin(preview), end: toMin(preview) + durationMin }}
              conflict={!!(hover ? hoveredConflict : currentTaken)}
            />
          )}
        </div>

        {/* Slots */}
        <div role="listbox" aria-label="Start time" className="overflow-y-auto overscroll-contain px-3 py-2.5 space-y-3 flex-1 min-h-0">
          {GROUPS.map(g => {
            const items = slots.filter(s => g.test(toMin(s.value)));
            if (items.length === 0) return null;
            return (
              <div key={g.key}>
                <div className="flex items-center gap-1.5 px-1 mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[#64748B]">
                  <g.Icon className="w-3.5 h-3.5" /> {g.label}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {items.map(s => {
                    const selected = s.value === value;
                    const focused = s.value === focusedValue;
                    return (
                      <button
                        key={s.value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        // aria-disabled (not disabled) so hovering a struck-out time can explain why
                        aria-disabled={!s.free}
                        data-selected={selected}
                        onClick={() => { if (s.free) choose(s.value); }}
                        onMouseEnter={() => setHover(s.value)}
                        onMouseLeave={() => setHover(null)}
                        title={s.free ? undefined : `Runs into ${s.conflict ?? 'another class'}`}
                        className={`h-8 rounded-lg text-[12px] font-semibold tabular-nums border transition-all duration-150 ${
                          !s.free
                            ? 'bg-[#F8FAFC] border-transparent text-[#CBD5E1] line-through cursor-not-allowed'
                            : selected
                              ? 'bg-[#1D5BD6] border-[#1D5BD6] shadow-[0_6px_14px_-8px_rgba(29,91,214,0.8)]'
                              : `bg-white text-[#0B2A5B] hover:border-[#1D5BD6] hover:bg-[#EFF6FF] hover:-translate-y-px ${focused ? 'border-[#1D5BD6] bg-[#EFF6FF]' : 'border-[#E2E8F0]'}`
                        }`}
                        // White set inline — the light-mode rule repaints `text-white` as dark ink
                        style={selected && s.free ? { color: '#FFFFFF' } : undefined}
                      >
                        {fmt(s.value)}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Only shown to explain a struck-out time */}
        {hoveredConflict && (
          <div className="px-4 py-2 border-t border-red-100 bg-red-50 flex-shrink-0 text-[12px] text-red-700 truncate" title={`Runs into ${hoveredConflict}`}>
            Runs into {hoveredConflict}
          </div>
        )}
      </AnchoredPopover>
    </>
  );
}
