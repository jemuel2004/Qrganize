'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronDown, Clock, Moon, Sun, Sunset } from 'lucide-react';
import AnchoredPopover from './AnchoredPopover';
import { SCHOOL_DAY_END_MIN, SCHOOL_DAY_START_MIN } from '@shared/schoolDay';

/*
 * Plain time picker: a button that opens 30-minute chips (7:00 AM – 6:00 PM, the school day)
 * grouped Morning / Afternoon / Evening. `after` greys out times at or before
 * it — used for an end time so it can never come before the start — and
 * `latest` the ones after it. An empty value shows `placeholder` until a time
 * is picked. With `lengths`, the pop-up also offers how long (1 hr, 1½ hrs…):
 * the button shows the whole range and starts that would run past 6 PM are
 * greyed out — one tap on a start time sets both, like Scheduling.
 * `suggestions` (e.g. the faculty's own class times that day) come first: one
 * tap sets their exact start and length; the other times fold under
 * "Another time".
 */

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const toHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const fmtTime = (t: string) => { const m = toMin(t); const h = Math.floor(m / 60); return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
/** "7:00 AM – 8:00 AM" */
const rangeLabel = (a: string, b: string) => `${fmtTime(a)} – ${fmtTime(b)}`;

// 7:00 AM … 6:00 PM inclusive — the last chip is an end time ("To 6:00 PM")
const SLOTS = Array.from({ length: (SCHOOL_DAY_END_MIN - SCHOOL_DAY_START_MIN) / 30 + 1 }, (_, i) => toHM(SCHOOL_DAY_START_MIN + i * 30));
const GROUPS = [
  { label: 'Morning', Icon: Sun, test: (m: number) => m < 12 * 60 },
  { label: 'Afternoon', Icon: Sunset, test: (m: number) => m >= 12 * 60 && m < 17 * 60 },
  { label: 'Evening', Icon: Moon, test: (m: number) => m >= 17 * 60 },
];

/** A ready-made time range offered first (e.g. one of the faculty's classes) */
export interface TimeSuggestion {
  key: string;
  /** 'HH:MM' */
  start: string;
  end: string;
  /** "IT 412 · BSIT 4C" */
  title: string;
  /** "Lab 7" — shown as a small tag on the right */
  detail?: string;
  /** Show the tag as a warning (e.g. "No room yet") */
  warn?: boolean;
  /** Small tag on the class line, e.g. "Lecture" (blue) or "Laboratory" (amber) */
  badge?: string;
  badgeTone?: 'blue' | 'amber';
  /** Shown on the button after the range when picked, e.g. "IT 412" */
  short?: string;
}

export default function SimpleTimePicker({
  value, onChange, after, latest, label, placeholder = 'Select time', lengths, length, onLengthChange,
  suggestions, suggestionsLabel,
}: {
  /** 'HH:MM' (24h), or '' when nothing is picked yet */
  value: string;
  onChange: (value: string) => void;
  /** Times at or before this are disabled */
  after?: string;
  /** Times after this are disabled */
  latest?: string;
  label: string;
  placeholder?: string;
  /** Length choices (minutes) shown above the times */
  lengths?: { min: number; label: string }[];
  /** The chosen length (minutes) */
  length?: number;
  onLengthChange?: (min: number) => void;
  /** Offered first — one tap sets their start and length */
  suggestions?: TimeSuggestion[];
  /** Heading of the suggestions, e.g. "Your classes on Friday" */
  suggestionsLabel?: string;
}) {
  const reduceMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const min = after ? toMin(after) : -1;
  // With a length, a start must leave it before the school day ends
  const max = Math.min(latest ? toMin(latest) : Infinity, length ? SCHOOL_DAY_END_MIN - length : Infinity);
  const lengthOf = (sg: TimeSuggestion) => toMin(sg.end) - toMin(sg.start);
  const picked = value ? suggestions?.find(sg => sg.start === value && lengthOf(sg) === length) : undefined;
  const hasSuggestions = !!suggestions && suggestions.length > 0;
  /** "Another time" open: always without suggestions; otherwise when a time of its own is picked */
  const [showOther, setShowOther] = useState(false);
  const range = value ? (length ? rangeLabel(value, toHM(toMin(value) + length)) : fmtTime(value)) : '';
  const shown = !value ? placeholder : picked?.short ? `${range} · ${picked.short}` : range;
  const toggle = () => {
    // Opening: the other times start folded unless a time of its own is picked
    if (!open) setShowOther(!hasSuggestions || (!!value && !picked));
    setOpen(!open);
  };
  const pickSuggestion = (sg: TimeSuggestion) => {
    onLengthChange?.(lengthOf(sg));
    onChange(sg.start);
    setOpen(false);
  };
  const otherOpen = !hasSuggestions || showOther;

  // Bring the chosen time into view when opening
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' }), 60);
    return () => window.clearTimeout(id);
  }, [open]);

  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${shown}`}
        className={`w-full h-12 px-4 rounded-xl border bg-white flex items-center gap-2.5 text-left transition-colors ${
          open ? 'border-[#1D5BD6] ring-2 ring-[#1D5BD6]/15' : 'border-[#D6E0EF] hover:border-[#9DB8E8]'
        }`}
      >
        <Clock className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
        <span className={`flex-1 text-[15px] tabular-nums truncate ${value ? 'font-semibold text-[#0B2A5B]' : 'font-medium text-[#64748B]'}`}>{shown}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.25 }} className="text-[#64748B]">
          <ChevronDown className="w-4 h-4" />
        </motion.span>
      </motion.button>

      {/* No heading inside — the field's own label says what it is; a little taller when classes are listed */}
      <AnchoredPopover open={open} onClose={close} anchorRef={triggerRef} panelRef={panelRef} width={330} maxHeight={hasSuggestions ? 470 : 400} label={label}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
        <div className="overflow-y-auto overscroll-contain">
          {hasSuggestions && (
            <div className="p-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-[#64748B] mb-1.5">{suggestionsLabel ?? 'Suggested'}</p>
              <div className="space-y-1">
                {(suggestions ?? []).map(sg => {
                  const sel = picked?.key === sg.key;
                  return (
                    <button
                      key={sg.key}
                      type="button"
                      data-selected={sel || undefined}
                      onClick={() => pickSuggestion(sg)}
                      title={`${rangeLabel(sg.start, sg.end)} · ${sg.title}${sg.detail ? ` · ${sg.detail}` : ''}`}
                      // Two short lines: the time with the room on the right, then the class
                      className={`w-full text-left rounded-lg border px-3 py-1.5 transition-colors ${
                        sel ? 'border-[#1D5BD6] bg-[#EFF6FF] ring-1 ring-[#1D5BD6]' : 'border-[#E2E8F0] bg-white hover:border-[#1D5BD6] hover:bg-[#F5F9FF]'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-[15px] font-bold tabular-nums whitespace-nowrap text-[#0B2A5B]">{rangeLabel(sg.start, sg.end)}</span>
                        {sg.detail && (
                          <span className={`ml-auto max-w-[50%] truncate text-[12px] font-semibold px-2 py-0.5 rounded-md border ${
                            sg.warn ? 'border-dashed bg-white text-[#64748B] border-[#CBD5E1]' : 'bg-[#F1F5F9] text-[#334155] border-[#E2E8F0]'
                          }`}>
                            {sg.detail}
                          </span>
                        )}
                        {sel && <Check className={`w-4 h-4 text-[#1D5BD6] flex-shrink-0 ${sg.detail ? '' : 'ml-auto'}`} strokeWidth={3} />}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span className="min-w-0 text-[13px] font-medium text-[#475569] truncate">{sg.title}</span>
                        {sg.badge && (
                          <span className={`ml-auto flex-shrink-0 text-[12px] font-semibold px-2 py-0.5 rounded-md border ${
                            sg.badgeTone === 'amber' ? 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]' : 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]'
                          }`}>
                            {sg.badge}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {hasSuggestions && (
            <button
              type="button"
              onClick={() => setShowOther(o => !o)}
              aria-expanded={showOther}
              // Stays in sight at the bottom edge when a long class list fills the pop-up
              className="sticky bottom-0 z-[1] w-full h-11 px-4 bg-white border-t border-[#E2E8F0] flex items-center justify-between text-[13px] font-semibold text-[#1D5BD6] hover:bg-[#F5F9FF] transition-colors"
            >
              Another time
              <ChevronDown className={`w-4 h-4 transition-transform ${showOther ? 'rotate-180' : ''}`} />
            </button>
          )}

          {otherOpen && lengths && onLengthChange && (
            <div className={`px-3 pt-2.5 pb-3 border-b border-[#F1F5F9] ${hasSuggestions ? 'border-t' : ''}`}>
              <p className="text-[11px] font-bold uppercase tracking-wider text-[#64748B] mb-1.5">How long</p>
              <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label="How long">
                {lengths.map(l => {
                  const on = l.min === length;
                  // A length that would run past 6 PM from the chosen start can't be picked
                  const fits = !value || toMin(value) + l.min <= SCHOOL_DAY_END_MIN;
                  return (
                    <button
                      key={l.min}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={!fits}
                      onClick={() => onLengthChange(l.min)}
                      className={`h-10 rounded-lg text-[13px] font-semibold border transition-colors ${
                        on ? 'bg-[#1D5BD6] border-[#1D5BD6] shadow-sm'
                          : !fits ? 'bg-transparent border-transparent text-[#CBD5E1] cursor-not-allowed'
                            : 'bg-white border-[#E2E8F0] text-[#0B2A5B] hover:border-[#1D5BD6] hover:bg-[#EFF6FF]'
                      }`}
                      style={on ? { color: '#FFFFFF' } : undefined}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {otherOpen && (
            <div className="p-3 space-y-3 bg-[#FAFBFD]">
              {GROUPS.map(g => {
                const list = SLOTS.filter(t => g.test(toMin(t)));
                return (
                  <div key={g.label}>
                    <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#64748B] mb-1.5">
                      <g.Icon className="w-3.5 h-3.5" /> {g.label}
                    </p>
                    <div className="grid grid-cols-3 gap-1.5">
                      {list.map(t => {
                        // A picked class shows as the class above, not as a plain time here
                        const sel = t === value && !picked;
                        const disabled = toMin(t) <= min || toMin(t) > max;
                        return (
                          <button
                            key={t}
                            type="button"
                            disabled={disabled}
                            data-selected={sel || undefined}
                            onClick={() => { onChange(t); setOpen(false); }}
                            className={`h-10 rounded-lg text-[13px] font-semibold tabular-nums border transition-colors ${
                              sel
                                ? 'bg-[#1D5BD6] border-[#1D5BD6] shadow-sm'
                                : disabled
                                  ? 'bg-transparent border-transparent text-[#CBD5E1] cursor-not-allowed'
                                  : 'bg-white border-[#E2E8F0] text-[#0B2A5B] hover:border-[#1D5BD6] hover:bg-[#EFF6FF]'
                            }`}
                            style={sel ? { color: '#FFFFFF' } : undefined}
                          >
                            {fmtTime(t)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}
