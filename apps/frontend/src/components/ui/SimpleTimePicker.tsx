'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, Clock, Moon, Sun, Sunset } from 'lucide-react';
import AnchoredPopover from './AnchoredPopover';

/*
 * Plain time picker: a button that opens 30-minute chips (7:00 AM – 9:00 PM)
 * grouped Morning / Afternoon / Evening. `after` greys out times at or before
 * it — used for an end time so it can never come before the start.
 */

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const toHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const fmtTime = (t: string) => { const m = toMin(t); const h = Math.floor(m / 60); return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };

const SLOTS = Array.from({ length: (21 * 60 - 7 * 60) / 30 + 1 }, (_, i) => toHM(7 * 60 + i * 30));
const GROUPS = [
  { label: 'Morning', Icon: Sun, test: (m: number) => m < 12 * 60 },
  { label: 'Afternoon', Icon: Sunset, test: (m: number) => m >= 12 * 60 && m < 17 * 60 },
  { label: 'Evening', Icon: Moon, test: (m: number) => m >= 17 * 60 },
];

export default function SimpleTimePicker({ value, onChange, after, label }: {
  /** 'HH:MM' (24h) */
  value: string;
  onChange: (value: string) => void;
  /** Times at or before this are disabled */
  after?: string;
  label: string;
}) {
  const reduceMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const min = after ? toMin(after) : -1;

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
        onClick={() => setOpen(o => !o)}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${fmtTime(value)}`}
        className={`w-full h-12 px-4 rounded-xl border bg-white flex items-center gap-2.5 text-left transition-colors ${
          open ? 'border-[#1D5BD6] ring-2 ring-[#1D5BD6]/15' : 'border-[#D6E0EF] hover:border-[#9DB8E8]'
        }`}
      >
        <Clock className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
        <span className="flex-1 text-[15px] font-semibold text-[#0B2A5B] tabular-nums">{fmtTime(value)}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.25 }} className="text-[#64748B]">
          <ChevronDown className="w-4 h-4" />
        </motion.span>
      </motion.button>

      <AnchoredPopover open={open} onClose={close} anchorRef={triggerRef} panelRef={panelRef} width={330} maxHeight={400} label={label}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
        <div className="px-4 pt-3 pb-2 border-b border-[#F1F5F9] text-[13px] font-bold text-[#0B2A5B]">{label}</div>
        <div className="overflow-y-auto overscroll-contain p-3 space-y-3 bg-[#FAFBFD]">
          {GROUPS.map(g => {
            const list = SLOTS.filter(t => g.test(toMin(t)));
            return (
              <div key={g.label}>
                <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[#64748B] mb-1.5">
                  <g.Icon className="w-3.5 h-3.5" /> {g.label}
                </p>
                <div className="grid grid-cols-3 gap-1.5">
                  {list.map(t => {
                    const sel = t === value;
                    const disabled = toMin(t) <= min;
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
      </AnchoredPopover>
    </>
  );
}
