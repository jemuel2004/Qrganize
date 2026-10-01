'use client';

/**
 * Classroom Construction Recommendation — how many more regular classrooms to
 * consider building: peak simultaneous classes that need a classroom minus
 * usable lecture rooms (never faculty or class counts). Schedule-based only;
 * the QR utilization above stays a separate measure. Numbers come from
 * @shared/classroomDemand via GET /api/rooms/demand, for the active term.
 */

import { useEffect, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import Modal from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/skeletons';
import { useSchoolYear } from '@/context/SchoolYearContext';
import type { ClassroomDemand, DemandClassStatus } from '@shared/classroomDemand';
import { AnimatePresence, EASE, fmt12, motion, WHITE } from './shared';

interface DemandResponse {
  term: { semester: string | null; school_year: string | null };
  demand: ClassroomDemand;
  /** Peak demand of other terms with saved schedules (oldest first) */
  history: { academic_year: string; semester: string; peak: number }[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(s|sh|ch|x)$/.test(word) ? 'es' : 's'}`;
const fmtRange = (start: string, end: string) => `${fmt12(start)} – ${fmt12(end)}`;

const STATUS_TONE: Record<DemandClassStatus, string> = {
  Assigned: 'bg-emerald-50 text-[#047857] border-emerald-200',
  Unassigned: 'bg-amber-50 text-[#B45309] border-amber-200',
  'Inactive room': 'bg-red-50 text-[#B91C1C] border-red-200',
};

function StatusPill({ status }: { status: DemandClassStatus }) {
  return (
    <span className={`inline-flex items-center text-[12px] font-semibold px-2.5 py-0.5 rounded-full border whitespace-nowrap ${STATUS_TONE[status]}`}>
      {status}
    </span>
  );
}

/** One term of the calculation: big number + label */
function Figure({ label, value, tone = 'text-[#0B2A5B]' }: { label: string; value: number; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className={`text-3xl font-bold leading-tight tabular-nums ${tone}`}>{value}</p>
      <p className="text-[13px] font-semibold text-[#475569] mt-0.5">{label}</p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">{label}</p>
      <p className="text-[15px] font-bold text-[#0B2A5B] mt-0.5">{value}</p>
    </div>
  );
}

/** `refreshKey` — bump to re-fetch (the page's Refresh button) */
export default function ClassroomDemandSection({ refreshKey = 0 }: { refreshKey?: number }) {
  const reduceMotion = useReducedMotion();
  const { schoolYear, semester, loading: termLoading } = useSchoolYear();
  const [res, setRes] = useState<DemandResponse | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);
  const [pickedDay, setPickedDay] = useState<string | null>(null);

  // Fetched once per term (and on Refresh) — no polling; the schedule rarely changes
  useEffect(() => {
    if (termLoading) return;
    const c = new AbortController();
    const qs = new URLSearchParams({ ...(semester ? { semester } : {}), ...(schoolYear ? { academic_year: schoolYear } : {}) });
    fetch(`/api/rooms/demand?${qs}`, { signal: c.signal })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Failed to load classroom demand.');
        setRes(d);
        setError('');
      })
      .catch(e => { if (!c.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to load classroom demand.'); });
    return () => c.abort();
  }, [schoolYear, semester, termLoading, refreshKey, retry]);

  const shell = (body: React.ReactNode) => (
    <section className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] overflow-hidden min-w-0">
      {body}
    </section>
  );

  if (!res) {
    return shell(
      <div className="p-5">
        <h2 className="text-[15px] font-bold text-[#0B2A5B]">Classroom Construction Recommendation</h2>
        {error ? (
          <div className="mt-3 flex items-center gap-3">
            <p className="text-sm text-[#B91C1C]">{error}</p>
            <button type="button" onClick={() => setRetry(n => n + 1)} className="text-sm font-semibold text-[#1D5BD6] hover:underline">Try again</button>
          </div>
        ) : (
          <div className="mt-4 space-y-3" role="status" aria-label="Loading classroom demand">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        )}
      </div>,
    );
  }

  const { demand, history, term } = res;
  const { peak } = demand;
  const termLabel = [term.semester, term.school_year].filter(Boolean).join(' · ');
  const gap = demand.required - demand.usable;
  const doubleBooked = peak?.classes.filter(c => c.double_booked).length ?? 0;
  const peakWhen = peak ? `${peak.day}, ${fmtRange(peak.start, peak.end)}` : '';

  const explanation =
    demand.verdict === 'none'
      ? demand.excluded_lab + demand.lec_in_lab_room > 0
        ? `All scheduled classes${termLabel ? ` in ${termLabel}` : ''} use laboratories, so there is no current calculated requirement for regular classrooms.`
        : `No classes${termLabel ? ` in ${termLabel}` : ''} are scheduled yet, so no recommendation can be calculated.`
      : demand.verdict === 'shortage'
        ? `Based on the current class schedule, the highest simultaneous demand for regular classrooms is ${plural(demand.required, 'room')} (${peakWhen}). The school currently has ${plural(demand.usable, 'usable regular classroom')}, a capacity gap of ${plural(demand.additional, 'room')}. For planning consideration, the system recommends considering ${plural(demand.additional, 'additional classroom')} to accommodate the current scheduled demand.`
        : `Based on the current class schedule, the highest simultaneous demand for regular classrooms is ${plural(demand.required, 'room')} (${peakWhen}). The school currently has ${plural(demand.usable, 'usable regular classroom')}, so there is no capacity gap${demand.surplus > 0 ? ` (${demand.surplus} spare at the busiest time)` : ''}. No additional classrooms are recommended based on current scheduled demand.`;

  const day = demand.days.find(d => d.day === pickedDay) ?? peak;
  const openBreakdown = () => { setPickedDay(peak?.day ?? null); setOpen(true); };

  return shell(
    <>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-4 border-b border-[#EEF2F8]">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-bold text-[#0B2A5B]">Classroom Construction Recommendation</h2>
          <p className="text-xs text-[#64748B] mt-0.5">From the class schedule{termLabel ? ` · ${termLabel}` : ''}</p>
        </div>
        <motion.button
          type="button"
          onClick={openBreakdown}
          disabled={!peak}
          whileTap={reduceMotion || !peak ? undefined : { scale: 0.96 }}
          className="inline-flex items-center justify-center h-10 px-4 rounded-lg border border-[#BFDBFE] text-[14px] font-semibold text-[#1D5BD6] bg-white hover:bg-[#EFF6FF] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          View Demand Breakdown
        </motion.button>
      </div>

      <div className="p-5 space-y-4">
        {/* The answer first */}
        <div className={`rounded-xl border px-5 py-4 ${demand.additional > 0 ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
          <p className="text-sm font-semibold text-[#475569]">Recommended Additional Classrooms</p>
          <p className={`text-5xl font-bold leading-none tabular-nums mt-1 ${demand.additional > 0 ? 'text-[#B91C1C]' : 'text-[#047857]'}`}>
            {demand.additional}
          </p>
          <p className="text-sm text-[#475569] mt-2">For planning consideration — the final decision rests with the school director.</p>
        </div>

        {/* How it is calculated */}
        <div className="rounded-xl border border-[#E2E8F0] px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Figure label="Peak Classroom Demand" value={demand.required} />
            <span className="text-2xl font-bold text-[#94A3B8]" aria-hidden="true">−</span>
            <Figure label="Usable Existing Classrooms" value={demand.usable} tone="text-[#1D5BD6]" />
            <span className="text-2xl font-bold text-[#94A3B8]" aria-hidden="true">=</span>
            <Figure label="Current Classroom Gap" value={gap} tone={gap > 0 ? 'text-[#B91C1C]' : 'text-[#047857]'} />
          </div>
          {gap < 0 && <p className="text-[13px] text-[#64748B] mt-3">A negative gap means classrooms to spare, so 0 more are recommended.</p>}
        </div>

        {peak && (
          <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-5 py-4 grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Fact label="Peak Day" value={peak.day} />
            <Fact label="Peak Time" value={fmtRange(peak.start, peak.end)} />
            <Fact label="Simultaneous Classes" value={peak.peak} />
            <Fact label="Unassigned at Peak" value={`${peak.unassigned} of ${peak.peak}`} />
          </div>
        )}

        <p className="text-[15px] leading-relaxed text-[#334155]">{explanation}</p>

        {demand.assignment_issue && (
          <div className="rounded-xl border px-4 py-3 text-sm font-semibold bg-amber-50 border-amber-200 text-[#B45309]">
            Existing classroom capacity is sufficient based on peak demand, but {plural(demand.unassigned, 'scheduled class')} currently {demand.unassigned === 1 ? 'has' : 'have'} no assigned room. Review room allocation or scheduling conflicts.
          </div>
        )}
        {demand.verdict === 'shortage' && demand.unassigned > 0 && (
          <div className="rounded-xl border px-4 py-3 text-sm font-semibold bg-amber-50 border-amber-200 text-[#B45309]">
            {plural(demand.unassigned, 'scheduled class')} currently {demand.unassigned === 1 ? 'has' : 'have'} no assigned room. They are already included in the peak demand above, not added on top.
          </div>
        )}
        {doubleBooked > 0 && (
          <div className="rounded-xl border px-4 py-3 text-sm font-semibold bg-red-50 border-red-200 text-[#B91C1C]">
            {doubleBooked} classes share the same room at the busiest time. Review this room conflict.
          </div>
        )}

        {/* Past terms — recorded demand only, never a projection */}
        {history.length > 0 && (
          <div className="rounded-xl border border-[#E2E8F0] overflow-hidden">
            <p className="px-4 py-2.5 bg-[#F8FAFC] border-b border-[#E2E8F0] text-[13px] font-semibold text-[#475569]">
              Peak demand in earlier terms (recorded schedules)
            </p>
            <ul className="divide-y divide-[#F1F5F9]">
              {[...history, { academic_year: term.school_year ?? '', semester: term.semester ?? '', peak: demand.required, current: true }].map(h => (
                <li key={`${h.academic_year}|${h.semester}`} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
                  <span className="text-[#334155]">{h.academic_year} · {h.semester}{'current' in h ? ' (current)' : ''}</span>
                  <span className="font-bold text-[#0B2A5B] tabular-nums">{plural(h.peak, 'room')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Demand Breakdown" subtitle="Classes that need a classroom at the same time" size="xl">
        {day && (
          <div className="space-y-4">
            {/* Busiest time per day */}
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="School day">
              {demand.days.map(d => {
                const active = d.day === day.day;
                return (
                  <button
                    key={d.day}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setPickedDay(d.day)}
                    className={`h-10 px-4 rounded-lg text-[14px] font-semibold border transition-colors ${
                      active ? 'bg-[#1D5BD6] border-[#1D5BD6]' : 'bg-white border-[#D6E0EF] text-[#0B2A5B] hover:bg-[#EFF6FF]'
                    }`}
                    style={active ? WHITE : undefined}
                  >
                    {d.day.slice(0, 3)} · {d.peak}{d.day === peak?.day ? ' (peak)' : ''}
                  </button>
                );
              })}
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={day.day}
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.25, ease: EASE } }}
                exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.12 } }}
                className="space-y-3"
              >
                <p className="text-[15px] text-[#0B2A5B]">
                  <span className="font-bold">{day.day} · {fmtRange(day.start, day.end)}</span>
                  <span className="text-[#475569]"> — {plural(day.peak, 'class')} at once ({day.assigned} assigned, {day.unassigned} unassigned)</span>
                </p>

                {/* Desktop table */}
                <div className="hidden md:block rounded-xl border border-[#E2E8F0] overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0] text-left text-[12px] font-semibold text-[#475569]">
                        <th className="px-4 py-3">Course</th>
                        <th className="px-3 py-3">Faculty</th>
                        <th className="px-3 py-3">Day</th>
                        <th className="px-3 py-3">Start</th>
                        <th className="px-3 py-3">End</th>
                        <th className="px-3 py-3">Room</th>
                        <th className="px-3 py-3">Room Type</th>
                        <th className="px-4 py-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9]">
                      {day.classes.map(c => (
                        <tr key={c.id}>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-[#0B2A5B] whitespace-nowrap">{c.subject_code ?? '—'}{c.block ? ` · ${c.block}` : ''}</p>
                            {c.subject_name && <p className="text-xs text-[#64748B] truncate max-w-[220px]">{c.subject_name}</p>}
                          </td>
                          <td className="px-3 py-3 text-[#334155]">{c.faculty_name || '—'}</td>
                          <td className="px-3 py-3 text-[#334155] whitespace-nowrap">{c.day}</td>
                          <td className="px-3 py-3 text-[#334155] whitespace-nowrap tabular-nums">{fmt12(c.start)}</td>
                          <td className="px-3 py-3 text-[#334155] whitespace-nowrap tabular-nums">{fmt12(c.end)}</td>
                          <td className="px-3 py-3">
                            <p className="text-[#334155] whitespace-nowrap">{c.room_name ?? '—'}</p>
                            {c.double_booked && <p className="text-xs font-semibold text-[#B91C1C]">Shared room</p>}
                          </td>
                          <td className="px-3 py-3 text-[#334155] whitespace-nowrap">{c.room_type ?? '—'}</td>
                          <td className="px-4 py-3"><StatusPill status={c.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Phone cards */}
                <ul className="md:hidden rounded-xl border border-[#E2E8F0] divide-y divide-[#F1F5F9]">
                  {day.classes.map(c => (
                    <li key={c.id} className="p-4 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-[#0B2A5B]">{c.subject_code ?? '—'}{c.block ? ` · ${c.block}` : ''}</p>
                        <p className="text-[13px] text-[#475569] mt-0.5">{c.day} · {fmtRange(c.start, c.end)}</p>
                        <p className="text-[13px] text-[#475569]">{c.room_name ? `${c.room_name}${c.room_type ? ` (${c.room_type})` : ''}` : 'No room'}</p>
                        <p className="text-[13px] text-[#64748B]">{c.faculty_name || '—'}</p>
                        {c.double_booked && <p className="text-xs font-semibold text-[#B91C1C] mt-0.5">Shared room</p>}
                      </div>
                      <StatusPill status={c.status} />
                    </li>
                  ))}
                </ul>
              </motion.div>
            </AnimatePresence>

            {/* Why this number */}
            <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 text-sm text-[#475569] space-y-1">
              <p>
                <span className="font-semibold text-[#0B2A5B]">Why {plural(demand.required, 'classroom')}? </span>
                It is the most classes needing a regular classroom at the same time{peak ? ` (${peakWhen})` : ''}. Rooms are shared, so classes at other times reuse them — faculty and total class counts are not used.
              </p>
              {(demand.excluded_lab > 0 || demand.lec_in_lab_room > 0) && (
                <p>Not counted: {plural(demand.excluded_lab, 'lab session')} and {plural(demand.lec_in_lab_room, 'lecture')} already in lab rooms.</p>
              )}
              {demand.invalid > 0 && <p>{plural(demand.invalid, 'schedule')} skipped for an invalid day or time.</p>}
            </div>
          </div>
        )}
      </Modal>
    </>,
  );
}
