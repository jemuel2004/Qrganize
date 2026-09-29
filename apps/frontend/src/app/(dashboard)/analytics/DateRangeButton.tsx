'use client';

import { useCallback, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { CalendarDays, ChevronDown, Loader2 } from 'lucide-react';
import AnchoredPopover from '@/components/ui/AnchoredPopover';

/* Date range for Analytics: quick presets or a custom From / To. */

export interface Range { from: string; to: string }

const DAY_MS = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const todayMs = () => Date.parse(`${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })}T00:00:00Z`);
const fmt = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const PRESETS: { label: string; range: () => Range }[] = [
  { label: 'Last 7 days', range: () => ({ from: ymd(todayMs() - 6 * DAY_MS), to: ymd(todayMs()) }) },
  { label: 'Last 30 days', range: () => ({ from: ymd(todayMs() - 30 * DAY_MS), to: ymd(todayMs()) }) },
  { label: 'This month', range: () => { const t = new Date(todayMs()); return { from: ymd(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)), to: ymd(todayMs()) }; } },
  { label: 'Last 3 months', range: () => { const t = new Date(todayMs()); return { from: ymd(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 3, t.getUTCDate())), to: ymd(todayMs()) }; } },
];

const INPUT = 'w-full h-9 rounded-lg border border-[#D6E0EF] bg-white px-2.5 text-sm text-[#0B2A5B] focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/25 focus:border-[#1D5BD6]';

export default function DateRangeButton({ value, onChange, loading }: { value: Range | null; onChange: (r: Range) => void; loading: boolean }) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Range | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const pick = (r: Range) => { setOpen(false); onChange(r); };

  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        onClick={() => { setDraft(value); setOpen(v => !v); }}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`h-10 inline-flex items-center gap-2 px-3.5 rounded-xl border bg-white text-sm font-medium text-[#0B2A5B] shadow-[0_1px_3px_rgba(11,42,91,0.06)] transition-colors ${
          open ? 'border-[#1D5BD6] ring-2 ring-[#1D5BD6]/15' : 'border-[#D6E0EF] hover:border-[#9DB8E8]'
        }`}
      >
        {loading ? <Loader2 className="w-4 h-4 text-[#1D5BD6] animate-spin" /> : <CalendarDays className="w-4 h-4 text-[#1D5BD6]" />}
        {value ? `${fmt(value.from)} – ${fmt(value.to)}` : 'Select dates'}
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }} className="text-[#64748B]">
          <ChevronDown className="w-4 h-4" />
        </motion.span>
      </motion.button>

      <AnchoredPopover open={open} onClose={close} anchorRef={triggerRef} panelRef={panelRef} width={280} maxHeight={400} label="Date range" align="end"
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
        <div className="p-2">
          {PRESETS.map(p => (
            <button key={p.label} type="button" onClick={() => pick(p.range())}
              className="w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-[#0B2A5B] hover:bg-[#EFF6FF] hover:text-[#1D5BD6] transition-colors">
              {p.label}
            </button>
          ))}
        </div>
        <div className="border-t border-[#F1F5F9] p-3 space-y-2.5 bg-[#FAFBFD]">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-semibold text-[#64748B]">From
              <input type="date" className={`${INPUT} mt-1`} value={draft?.from ?? ''} max={draft?.to}
                onChange={e => setDraft(d => ({ from: e.target.value, to: d?.to ?? e.target.value }))} />
            </label>
            <label className="text-xs font-semibold text-[#64748B]">To
              <input type="date" className={`${INPUT} mt-1`} value={draft?.to ?? ''} min={draft?.from}
                onChange={e => setDraft(d => ({ from: d?.from ?? e.target.value, to: e.target.value }))} />
            </label>
          </div>
          <button type="button" disabled={!draft?.from || !draft?.to} onClick={() => draft && pick(draft)}
            className="w-full h-9 rounded-lg text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors disabled:opacity-50"
            style={{ color: '#FFFFFF' }}>
            Apply
          </button>
        </div>
      </AnchoredPopover>
    </>
  );
}
