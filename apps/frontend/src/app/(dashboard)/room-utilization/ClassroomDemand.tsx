'use client';

/**
 * Classroom Planning — "Do we need more classrooms?", in plain words.
 * Classrooms are shared, so the answer comes from the busiest moment of the
 * week: the most classes that need a regular classroom at the same time,
 * compared with the usable lecture rooms (never faculty or class counts).
 * Schedule-based only; the QR utilization stays a separate measure. Numbers
 * come from @shared/classroomDemand via GET /api/rooms/demand, for the
 * active term.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useReducedMotion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, ChevronRight, Info } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/skeletons';
import { useSchoolYear } from '@/context/SchoolYearContext';
import type { ClassroomDemand, DemandClassStatus } from '@shared/classroomDemand';
import { SCHOOL_DAY_CLASS_MIN, SCHOOL_DAY_END_MIN, SCHOOL_DAY_START_MIN, minutesLabel } from '@shared/schoolDay';
import { AnimatePresence, EASE, fmt12, motion, WHITE } from './shared';

interface DemandResponse {
  term: { semester: string | null; school_year: string | null };
  demand: ClassroomDemand;
  /** Peak demand of other terms with saved schedules (oldest first) */
  history: { academic_year: string; semester: string; peak: number }[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(s|sh|ch|x)$/.test(word) ? 'es' : 's'}`;
const fmtRange = (start: string, end: string) => `${fmt12(start)} – ${fmt12(end)}`;
/** The school day (shared with Scheduling): "7:00 AM", "6:00 PM", 10 hours of class per room */
const SCHOOL_START = minutesLabel(SCHOOL_DAY_START_MIN);
const SCHOOL_END = minutesLabel(SCHOOL_DAY_END_MIN);
const ROOM_DAY_HOURS = SCHOOL_DAY_CLASS_MIN / 60;

/* Room status of a class, in plain words */
const STATUS_TONE: Record<DemandClassStatus, string> = {
  Assigned: 'bg-emerald-50 text-[#047857] border-emerald-200',
  Unassigned: 'bg-amber-50 text-[#B45309] border-amber-200',
  'Inactive room': 'bg-red-50 text-[#B91C1C] border-red-200',
};
const STATUS_LABEL: Record<DemandClassStatus, string> = {
  Assigned: 'Has a room',
  Unassigned: 'No room yet',
  'Inactive room': 'Room inactive',
};

function StatusPill({ status }: { status: DemandClassStatus }) {
  return (
    <span className={`inline-flex items-center text-[12px] font-semibold px-2.5 py-0.5 rounded-full border whitespace-nowrap ${STATUS_TONE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Something to review, with where to fix it */
function Notice({ tone, children, action }: {
  tone: 'amber' | 'red'; children: React.ReactNode; action?: { href: string; label: string };
}) {
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm font-semibold flex flex-col sm:flex-row sm:items-center gap-2.5 ${
      tone === 'red' ? 'bg-red-50 border-red-200 text-[#B91C1C]' : 'bg-amber-50 border-amber-200 text-[#B45309]'
    }`}>
      <span className="flex items-start gap-2.5 flex-1 min-w-0">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
        <span>{children}</span>
      </span>
      {action && (
        <Link
          href={action.href}
          className="self-start sm:self-auto inline-flex items-center gap-1 h-9 px-3.5 rounded-lg bg-white border border-current/30 text-[13px] font-bold whitespace-nowrap hover:bg-white/70 transition-colors"
        >
          {action.label} <ChevronRight className="w-4 h-4" />
        </Link>
      )}
    </div>
  );
}

type Tile = 'use' | 'free' | 'short';
const TILE_STYLE: Record<Tile, string> = {
  use: 'bg-[#1D5BD6] border-[#1D5BD6]',
  free: 'bg-white border-[#BFD3F5]',
  short: 'bg-red-50 border-red-400 border-dashed',
};

/** One square per classroom at the busiest time — in use, still free, or a
 *  class with no classroom to go to. Very large counts skip the picture. */
function RoomTiles({ inUse, free, short }: { inUse: number; free: number; short: number }) {
  const reduceMotion = useReducedMotion();
  const tiles: Tile[] = [
    ...Array.from({ length: inUse }, () => 'use' as const),
    ...Array.from({ length: free }, () => 'free' as const),
    ...Array.from({ length: short }, () => 'short' as const),
  ];
  return (
    <div className="space-y-3">
      {tiles.length <= 120 && (
        <div className="flex flex-wrap gap-1.5" aria-hidden="true">
          {tiles.map((t, i) => (
            <motion.span
              key={i}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: { duration: 0.25, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 40) * 0.02 } }}
              className={`w-7 h-7 rounded-md border-2 ${TILE_STYLE[t]}`}
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-[#334155]">
        <Key tile="use" label="In use" n={inUse} />
        {free > 0 && <Key tile="free" label="Still free" n={free} />}
        {short > 0 && <Key tile="short" label="Class with no classroom" n={short} />}
      </div>
    </div>
  );
}

function Key({ tile, label, n }: { tile: Tile; label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`w-4 h-4 rounded border-2 ${TILE_STYLE[tile]}`} aria-hidden="true" />
      {label} <b className="text-[#0B2A5B] tabular-nums">{n}</b>
    </span>
  );
}

/** `refreshKey` — bump to re-fetch */
export default function ClassroomDemandSection({ refreshKey = 0 }: { refreshKey?: number }) {
  const reduceMotion = useReducedMotion();
  const { schoolYear, semester, loading: termLoading } = useSchoolYear();
  const [res, setRes] = useState<DemandResponse | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [showHow, setShowHow] = useState(false);

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
        <h2 className="text-[17px] font-bold text-[#0B2A5B]">Do we need more classrooms?</h2>
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
  const doubleBooked = peak?.classes.filter(c => c.double_booked).length ?? 0;
  const peakWhen = peak ? `${peak.day}, ${fmtRange(peak.start, peak.end)}` : '';
  const shortage = demand.verdict === 'shortage';
  const none = demand.verdict === 'none';
  /** Lab classes (or lectures held in a lab) — they never use a regular classroom */
  const hasLabClasses = demand.excluded_lab + demand.lec_in_lab_room > 0;
  /** The day's class hours decide (more than fit 7 AM–6 PM in the rooms the busiest moment needs) */
  const byHours = demand.basis === 'hours' && !!demand.hours_day;
  const hoursDay = demand.hours_day;
  const hoursText = hoursDay ? `${Math.round(hoursDay.class_minutes / 6) / 10}` : '0';
  /** Why the number is what it is, in one sentence */
  const needText = byHours && hoursDay
    ? `${hoursDay.day}'s classes add up to ${hoursText} hours. Faculty are out by ${SCHOOL_END}, so a classroom holds ${ROOM_DAY_HOURS} hours of classes a day — that needs ${plural(demand.required, 'classroom')}`
    : `At the busiest time, ${plural(demand.required, 'class')} ${demand.required === 1 ? 'needs' : 'need'} a classroom`;

  /* The answer, first and in plain words */
  const answer = none
    ? {
        title: 'Nothing to work out yet',
        text: hasLabClasses
          ? 'Every scheduled class this term is held in a laboratory, so no regular classrooms are needed.'
          : 'No classes are scheduled for this term yet.',
      }
    : shortage
      ? {
          title: `${plural(demand.additional, 'more classroom')} needed`,
          text: `${needText}, but ${
            demand.usable === 0 ? 'there are no usable classrooms' : `only ${plural(demand.usable, 'classroom')} can be used`}.`,
        }
      : {
          title: 'No new classrooms needed',
          text: byHours
            ? `${needText}, and you have ${plural(demand.usable, 'usable classroom')}.`
            : demand.surplus > 0
              ? `Even at the busiest time, ${demand.surplus} of your ${plural(demand.usable, 'classroom')} ${demand.surplus === 1 ? 'is' : 'are'} still free.`
              : 'At the busiest time every classroom is in use, so there are none to spare.',
        };

  const day = demand.days.find(d => d.day === pickedDay) ?? peak;
  const openBreakdown = () => { setPickedDay(peak?.day ?? null); setOpen(true); };

  return shell(
    <>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-5 py-4 border-b border-[#EEF2F8]">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-bold text-[#0B2A5B]">Do we need more classrooms?</h2>
          <p className="text-[13px] text-[#64748B] mt-0.5">Based on this term&apos;s class schedule{termLabel ? ` · ${termLabel}` : ''}</p>
        </div>
        <motion.button
          type="button"
          onClick={openBreakdown}
          disabled={!peak}
          whileTap={reduceMotion || !peak ? undefined : { scale: 0.96 }}
          className="inline-flex items-center justify-center gap-1 h-10 px-4 rounded-lg border border-[#BFDBFE] text-[14px] font-semibold text-[#1D5BD6] bg-white hover:bg-[#EFF6FF] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          See the busiest times <ChevronRight className="w-4 h-4" />
        </motion.button>
      </div>

      <div className="p-5 space-y-4">
        {/* 1 · The answer */}
        <div className={`rounded-xl border px-5 py-4 flex items-start gap-4 ${
          shortage ? 'bg-red-50 border-red-200' : none ? 'bg-[#F8FAFC] border-[#E2E8F0]' : 'bg-emerald-50 border-emerald-200'
        }`}>
          <span className={`w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0 ${
            shortage ? 'bg-red-100 text-[#B91C1C]' : none ? 'bg-[#EEF2F8] text-[#64748B]' : 'bg-emerald-100 text-[#047857]'
          }`}>
            {shortage ? <AlertTriangle className="w-6 h-6" /> : none ? <Info className="w-6 h-6" /> : <CheckCircle2 className="w-6 h-6" />}
          </span>
          <div className="min-w-0">
            <p className={`text-2xl font-bold leading-tight ${shortage ? 'text-[#B91C1C]' : none ? 'text-[#0B2A5B]' : 'text-[#047857]'}`}>
              {answer.title}
            </p>
            <p className="text-[15px] text-[#334155] mt-1">{answer.text}</p>
            <p className="text-[13px] text-[#64748B] mt-2">For planning only — the final decision rests with the school director.</p>
          </div>
        </div>

        {/* 2 · The busiest time, as a picture of the classrooms */}
        {peak && (
          <div className="rounded-xl border border-[#E2E8F0] px-5 py-4 space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">The busiest time of the week</p>
              <p className="text-[17px] font-bold text-[#0B2A5B] mt-0.5">{peakWhen}</p>
              <p className="text-sm text-[#475569]">
                {plural(peak.peak, 'class')} at the same time · you have {plural(demand.usable, 'usable classroom')}
              </p>
              {byHours && hoursDay && (
                <p className="text-sm text-[#475569] mt-1">
                  {hoursDay.day}&apos;s classes add up to {hoursText} hours — fitted between {SCHOOL_START} and {SCHOOL_END}, they need {plural(demand.required, 'classroom')}.
                </p>
              )}
            </div>
            <RoomTiles
              inUse={Math.min(demand.required, demand.usable)}
              free={demand.surplus}
              short={demand.additional}
            />
            {peak.unassigned > 0 && (
              <p className="text-[13px] text-[#64748B]">
                {peak.unassigned} of these {peak.peak} classes {peak.unassigned === 1 ? "doesn't" : "don't"} have a room yet.
              </p>
            )}
          </div>
        )}

        {/* 3 · What needs attention */}
        {demand.assignment_issue && (
          <Notice tone="amber" action={{ href: '/rooms', label: 'Give them a room' }}>
            {plural(demand.unassigned, 'scheduled class')} {demand.unassigned === 1 ? "doesn't" : "don't"} have a room yet. There are enough classrooms — {demand.unassigned === 1 ? 'it just needs' : 'they just need'} to be given one.
          </Notice>
        )}
        {shortage && demand.unassigned > 0 && (
          <Notice tone="amber" action={{ href: '/rooms', label: 'Give them a room' }}>
            {plural(demand.unassigned, 'scheduled class')} {demand.unassigned === 1 ? "doesn't" : "don't"} have a room yet. {demand.unassigned === 1 ? 'It is' : 'They are'} already counted above.
          </Notice>
        )}
        {doubleBooked > 0 && (
          <Notice tone="red">
            {doubleBooked} classes are booked in the same room at the busiest time. Fix this room conflict in Scheduling.
          </Notice>
        )}
        {demand.after_hours.length > 0 && (
          <Notice tone="amber" action={{ href: '/scheduling', label: 'Move them' }}>
            {plural(demand.after_hours.length, 'class')} {demand.after_hours.length === 1 ? 'runs' : 'run'} outside {SCHOOL_START}–{SCHOOL_END}, but faculty are out by {SCHOOL_END}:{' '}
            {demand.after_hours.slice(0, 4).map(c => `${c.subject_code ?? '—'}${c.block ? ` ${c.block}` : ''} (${c.day.slice(0, 3)} ${fmtRange(c.start, c.end)})`).join(', ')}
            {demand.after_hours.length > 4 ? ` and ${demand.after_hours.length - 4} more` : ''}. Moving them into the day adds to the classrooms needed.
          </Notice>
        )}

        {/* 4 · How it is worked out — on request */}
        <div>
          <button
            type="button"
            onClick={() => setShowHow(s => !s)}
            aria-expanded={showHow}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#1D5BD6] hover:text-[#164BB5] transition-colors"
          >
            <motion.span animate={{ rotate: showHow ? 90 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.25, ease: EASE }} className="inline-flex">
              <ChevronRight className="w-4 h-4" />
            </motion.span>
            How is this worked out?
          </button>
          <AnimatePresence initial={false}>
            {showHow && (
              <motion.div
                key="how"
                initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1, transition: { duration: reduceMotion ? 0 : 0.35, ease: EASE } }}
                exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0, transition: { duration: 0.25, ease: EASE } }}
                className="overflow-hidden"
              >
                <ul className="mt-3 space-y-2 text-sm leading-relaxed text-[#334155] list-disc pl-5">
                  <li>
                    Classrooms are shared during the day, so what matters is the moment in the week when the
                    <b> most classes</b> need a regular classroom at once{peak ? ` — ${peakWhen}, with ${plural(demand.required, 'class')}` : ''}.
                  </li>
                  <li>
                    That is compared with your <b>{plural(demand.usable, 'usable classroom')}</b> (active lecture rooms){
                      shortage
                        ? `: ${plural(demand.additional, 'class')} would have no classroom, so ${plural(demand.additional, 'more classroom')} ${demand.additional === 1 ? 'is' : 'are'} needed.`
                        : demand.surplus > 0
                          ? `: ${demand.surplus} would still be free, so no more are needed.`
                          : ': every one would be in use, so no more are needed.'
                    }
                  </li>
                  <li>
                    Classes must fit between {SCHOOL_START} and {SCHOOL_END} (faculty are out by {SCHOOL_END}; lunch 12:00–1:00 PM stays free), so one
                    classroom holds at most <b>{ROOM_DAY_HOURS} hours</b> of classes a day. If a day&apos;s classes add up to more than the
                    busiest moment&apos;s classrooms can hold, that day decides
                    {hoursDay ? ` — the most is ${hoursDay.day}, ${hoursText} hours, which needs ${plural(hoursDay.rooms_by_hours, 'classroom')}` : ''}.
                  </li>
                  <li>Laboratory classes, and lectures already held in a laboratory, don&apos;t use a regular classroom, so they aren&apos;t counted. The number of faculty or of classes doesn&apos;t matter.</li>
                  {demand.invalid > 0 && <li>{plural(demand.invalid, 'schedule')} skipped for an invalid day or time.</li>}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Past terms — recorded busiest times only, never a projection */}
        {history.length > 0 && (
          <div className="rounded-xl border border-[#E2E8F0] overflow-hidden">
            <p className="px-4 py-2.5 bg-[#F8FAFC] border-b border-[#E2E8F0] text-[13px] font-semibold text-[#475569]">
              Classrooms needed at the busiest time, by term
            </p>
            <ul className="divide-y divide-[#F1F5F9]">
              {[...history, { academic_year: term.school_year ?? '', semester: term.semester ?? '', peak: demand.required, current: true }].map(h => (
                <li key={`${h.academic_year}|${h.semester}`} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
                  <span className="text-[#334155]">{h.academic_year} · {h.semester}{'current' in h ? ' (this term)' : ''}</span>
                  <span className="font-bold text-[#0B2A5B] tabular-nums">{plural(h.peak, 'classroom')}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="The busiest times" subtitle="Classes that need a regular classroom at the same time" size="xl">
        {day && (
          <div className="space-y-4">
            {/* The busiest moment of each day */}
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
                    {d.day} · {d.peak} at once{d.day === peak?.day ? ' (busiest)' : ''}
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
                  <span className="font-bold">{day.day}, {fmtRange(day.start, day.end)}</span>
                  <span className="text-[#475569]"> — {plural(day.peak, 'class')} at the same time ({day.assigned} with a room, {day.unassigned} without)</span>
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
                        <th className="px-4 py-3">Room status</th>
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
                {byHours && hoursDay
                  ? `${hoursDay.day}'s classes add up to ${hoursText} hours, and a classroom holds ${ROOM_DAY_HOURS} hours of classes between ${SCHOOL_START} and ${SCHOOL_END}. At the busiest moment${peak ? ` (${peakWhen})` : ''} ${plural(peak?.peak ?? 0, 'class')} meet at once.`
                  : `That is the most classes needing a regular classroom at the same time${peak ? ` (${peakWhen})` : ''}. Classrooms are shared, so classes at other times reuse them.`}
              </p>
              {hasLabClasses && (
                <p>Not counted: {plural(demand.excluded_lab, 'lab class')} and {plural(demand.lec_in_lab_room, 'lecture')} already held in a laboratory.</p>
              )}
              {demand.invalid > 0 && <p>{plural(demand.invalid, 'schedule')} skipped for an invalid day or time.</p>}
            </div>
          </div>
        )}
      </Modal>
    </>,
  );
}
