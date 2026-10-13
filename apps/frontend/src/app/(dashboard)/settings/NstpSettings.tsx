'use client';

/**
 * Settings → Day Combinations → NSTP: Saturday (fixed), its time, and the
 * handler's name typed in (the handler needs no QRganize account — a plain text
 * box on purpose, never a faculty picker). Shown on the Class Program only:
 * no room, no faculty workload, no conflict checks (@shared/nstp). Controlled by
 * DayCombinationsSection, whose one Save saves it.
 */

import { CalendarDays, Lock } from 'lucide-react';
import SimpleTimePicker from '@/components/ui/SimpleTimePicker';
import { NSTP_HANDLER_MAX, type NstpSchedule } from '@shared/nstp';

const LABEL = 'block text-xs font-semibold uppercase tracking-wide text-[#64748B] mb-1.5';

export default function NstpSettings({ value, onChange }: {
  /** null while loading */
  value: NstpSchedule | null;
  onChange: (next: NstpSchedule) => void;
}) {
  return (
    <section className="rounded-xl border border-[#E3E9F3] bg-white p-4 sm:p-5" aria-labelledby="nstp-settings-title">
      <p id="nstp-settings-title" className="text-sm font-bold text-[#0B2A5B]">NSTP</p>
      <p className="mt-0.5 mb-4 text-sm text-[#64748B]">On the Class Program only — no room, not part of faculty workload.</p>

      {value === null ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className={i === 3 ? 'sm:col-span-3' : undefined}>
              <div className="h-3 w-20 rounded bg-[#E2E8F0] mb-2.5" />
              <div className="h-12 rounded-xl bg-[#F1F5F9]" />
            </div>
          ))}
        </div>
      ) : (
        /* Day · Start · End in one row, the handler under them (the Settings window is narrow) */
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <span className={LABEL}>Day</span>
            {/* Fixed: NSTP is always on Saturday */}
            <div className="h-12 px-4 rounded-xl border border-[#E2E8F0] bg-[#F1F5F9] flex items-center gap-2.5" title="NSTP is always on Saturday">
              <CalendarDays className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
              <span className="flex-1 min-w-0 text-[15px] font-semibold text-[#0B2A5B] whitespace-nowrap truncate">Saturday</span>
              <Lock className="w-4 h-4 text-[#94A3B8] flex-shrink-0" aria-label="Cannot be changed" />
            </div>
          </div>
          <div>
            <span className={LABEL}>Start</span>
            <SimpleTimePicker
              label="NSTP start time"
              placeholder="Start time"
              value={value.start_time ?? ''}
              latest="17:30"
              onChange={start => onChange({
                ...value,
                start_time: start,
                // An end at or before the new start is cleared
                end_time: value.end_time && value.end_time > start ? value.end_time : null,
              })}
            />
          </div>
          <div>
            <span className={LABEL}>End</span>
            <SimpleTimePicker
              label="NSTP end time"
              placeholder="End time"
              value={value.end_time ?? ''}
              after={value.start_time ?? undefined}
              onChange={end => onChange({ ...value, end_time: end })}
            />
          </div>
          <div className="sm:col-span-3">
            <label htmlFor="nstp-handler" className={LABEL}>Subject handler</label>
            {/* The box is drawn by this wrapper (light mode strips a focused input's own border) */}
            <div className="flex h-12 rounded-xl border border-[#D6E0EF] bg-white transition-colors focus-within:border-[#1D5BD6] focus-within:ring-2 focus-within:ring-[#1D5BD6]/20">
              <input
                id="nstp-handler"
                type="text"
                autoComplete="off"
                maxLength={NSTP_HANDLER_MAX}
                value={value.handler_name}
                onChange={e => onChange({ ...value, handler_name: e.target.value })}
                placeholder="Type the name, e.g. Roy Sumaoy"
                className="w-full min-w-0 rounded-xl border-0 bg-transparent px-4 text-base text-[#0B2A5B] caret-[#1D5BD6] font-semibold placeholder:font-medium placeholder:text-[#94A3B8] outline-none focus:border-0! focus:shadow-none!"
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
