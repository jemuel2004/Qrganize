'use client';

/**
 * Room Utilization → Room Planning → "Move … into the school day": classes that meet outside the
 * school day get a free room and time inside it, automatically (GET / POST
 * /api/scheduling/into-day). The list shows each class, its faculty, where it
 * is now and where it goes — then where it went. A Major subject's Lecture and
 * Laboratory can move together (one laboratory, the same days), so a class may
 * list both parts; a class inside the day may move to make room for one (it
 * says for which). A class that can't be placed says why and opens straight in
 * Scheduling for its faculty.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { LUNCH_LABEL, SCHOOL_DAY_LABEL } from '@shared/schoolDay';
import { ArrowRight, CheckCircle2, ChevronRight, XCircle } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/skeletons';
import { useMinLoading } from '@/hooks/useMinLoading';
import { fmt12 } from './shared';

interface Meeting { day: string; start: string; end: string; room: string | null }
interface MovePart { part: 'lec' | 'lab'; from: Meeting[]; to: Meeting[] | null }
interface MoveClass {
  msId: number;
  subjectCode: string;
  subjectName: string;
  block: string;
  facultyId: number | null;
  facultyName: string | null;
  employmentStatus: string | null;
  /** The part outside the school day — or both parts when they move together */
  parts: MovePart[];
  /** This class moves only to make room for that class */
  makesRoomFor: { msId: number; subjectCode: string; block: string } | null;
  /** Why it can't be moved (null = every part has a new place) */
  reason: string | null;
  /** Set after moving */
  moved?: boolean;
}

const SHORT: Record<string, string> = { Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun' };

/** "Mon & Thu · 5:30 PM – 7:00 PM · Lecture-2" — one time when every meeting shares it */
function describe(meetings: Meeting[]): string {
  if (meetings.length === 0) return '—';
  const rooms = [...new Set(meetings.map(m => m.room).filter(Boolean))].join(', ') || 'no room';
  const sameTime = meetings.every(m => m.start === meetings[0].start && m.end === meetings[0].end);
  const when = sameTime
    ? `${meetings.map(m => SHORT[m.day] ?? m.day).join(' & ')} · ${fmt12(meetings[0].start)} – ${fmt12(meetings[0].end)}`
    : meetings.map(m => `${SHORT[m.day] ?? m.day} ${fmt12(m.start)} – ${fmt12(m.end)}`).join(', ');
  return `${when} · ${rooms}`;
}

const PART_LABEL = { lec: 'Lecture', lab: 'Laboratory' } as const;
const placeable = (c: MoveClass) => !c.reason && c.parts.length > 0 && c.parts.every(p => p.to);

const schedulingLink = (c: MoveClass) =>
  (c.facultyId != null ? `/scheduling?step=schedule&faculty=${c.facultyId}&ms=${c.msId}` : `/scheduling?ms=${c.msId}`);

export default function MoveIntoDayDialog({ open, onClose, onMoved }: {
  open: boolean;
  onClose: () => void;
  /** After moving — refresh what the page shows */
  onMoved: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [phase, setPhase] = useState<'loading' | 'review' | 'saving' | 'done' | 'error'>('loading');
  const [classes, setClasses] = useState<MoveClass[]>([]);
  const [error, setError] = useState('');
  const showSkeleton = useMinLoading(open && phase === 'loading');

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPhase('loading'); setError(''); setClasses([]);
    fetch('/api/scheduling/into-day', { cache: 'no-store' })
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) { setError(data.error || 'Could not load the classes.'); setPhase('error'); return; }
        setClasses(Array.isArray(data.classes) ? data.classes : []);
        setPhase('review');
      })
      .catch(() => { if (alive) { setError('Connection error. Please try again.'); setPhase('error'); } });
    return () => { alive = false; };
  }, [open]);

  const movable = classes.filter(placeable).length;
  // What moves (or moved) first, then the classes that need a look
  const shown = [...classes].sort((a, b) =>
    Number(!(phase === 'done' ? a.moved : placeable(a))) - Number(!(phase === 'done' ? b.moved : placeable(b))));
  const movedCount = classes.filter(c => c.moved).length;

  async function moveAll() {
    setPhase('saving'); setError('');
    try {
      const r = await fetch('/api/scheduling/into-day', { method: 'POST' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setError(data.error || 'The classes could not be moved.'); setPhase('review'); return; }
      setClasses(Array.isArray(data.results) ? data.results : []);
      setPhase('done');
      onMoved();
    } catch {
      setError('Connection error. Please try again.'); setPhase('review');
    }
  }

  const close = () => { if (phase !== 'saving') onClose(); };
  const tap = reduceMotion ? undefined : { scale: 0.96 };

  return (
    <Modal
      open={open}
      onClose={close}
      title={phase === 'done' ? 'Classes Moved' : 'Move Into the School Day'}
      subtitle={`${SCHOOL_DAY_LABEL} · lunch ${LUNCH_LABEL} stays free`}
      size="lg"
      footer={
        <div className="flex gap-3">
          {phase === 'done' || phase === 'error' || (phase === 'review' && movable === 0) ? (
            <motion.button type="button" whileTap={tap} onClick={close}
              className="flex-1 bg-[#1D5BD6] hover:bg-[#2E7DD1] text-white py-3 rounded-xl text-[15px] font-bold transition-colors">
              Done
            </motion.button>
          ) : (
            <>
              <motion.button type="button" whileTap={tap} onClick={close} disabled={phase === 'saving'}
                className="flex-1 border border-[#CBD5E1] text-[#334155] py-3 rounded-xl text-[15px] font-semibold hover:bg-[#F8FAFC] transition-colors disabled:opacity-50">
                Cancel
              </motion.button>
              <motion.button type="button" whileTap={tap} onClick={() => { void moveAll(); }} disabled={phase !== 'review' || movable === 0}
                className="flex-1 bg-[#1D5BD6] hover:bg-[#2E7DD1] text-white py-3 rounded-xl text-[15px] font-bold transition-colors flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-wait">
                {phase === 'saving'
                  ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Moving…</>
                  : `Move ${movable === 1 ? 'Class' : `${movable} Classes`}`}
              </motion.button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {showSkeleton || phase === 'loading' ? (
          <div className="space-y-3" role="status" aria-label="Loading classes">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="rounded-xl border border-[#E2E8F0] p-4 space-y-2.5">
                <Skeleton className="h-4 w-48 rounded" />
                <Skeleton className="h-3.5 w-36 rounded" />
                <Skeleton className="h-3.5 w-full rounded" />
              </div>
            ))}
          </div>
        ) : phase === 'error' ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] font-semibold text-[#B91C1C]">{error}</p>
        ) : classes.length === 0 ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[15px] font-semibold text-[#047857]">
            Every class already meets inside the school day.
          </p>
        ) : (
          <>
            <p className="text-[15px] text-[#334155] leading-relaxed">
              {phase === 'done'
                ? `${movedCount} of ${classes.length} ${classes.length === 1 ? 'class was' : 'classes were'} moved. Here is where each one is now.`
                : 'These classes meet outside the school day. Each one gets a free room and time inside the day — on the same days when possible — checked the same way as saving on the Scheduling page.'}
            </p>
            {error && <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-[#B91C1C]">{error}</p>}
            <ul className="space-y-3">
              {shown.map(c => {
                const ok = phase === 'done' ? !!c.moved : placeable(c);
                const both = c.parts.length > 1;
                return (
                  <li key={c.msId} className={`rounded-xl border p-4 ${ok ? 'border-[#E2E8F0] bg-white' : 'border-amber-200 bg-amber-50/60'}`}>
                    <div className="flex items-start gap-3">
                      {phase === 'done' && (ok
                        ? <CheckCircle2 className="w-5 h-5 text-[#16A34A] flex-shrink-0 mt-0.5" aria-label="Moved" />
                        : <XCircle className="w-5 h-5 text-[#B45309] flex-shrink-0 mt-0.5" aria-label="Not moved" />)}
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <p className="text-[15px] text-[#0B2A5B]">
                          <b className="font-mono">{c.subjectCode}</b> · {c.block}{both ? '' : ` · ${PART_LABEL[c.parts[0]?.part ?? 'lec']}`}
                          <span className="block text-sm text-[#475569]">{c.facultyName ?? 'No faculty'}{c.employmentStatus ? ` · ${c.employmentStatus}` : ''}</span>
                        </p>
                        {c.parts.map(p => (
                          <div key={p.part} className={both ? 'pl-3 border-l-2 border-[#BFDBFE] space-y-1' : 'space-y-1'}>
                            {both && <p className="text-[13px] font-bold text-[#334155]">{PART_LABEL[p.part]}</p>}
                            <p className="text-sm text-[#64748B]">
                              <span className="font-semibold text-[#B45309]">{phase === 'done' && ok ? 'Was' : 'Now'}:</span> {describe(p.from)}
                            </p>
                            {ok && p.to && (
                              <p className="text-sm text-[#0B2A5B] flex items-start gap-1.5">
                                <ArrowRight className="w-4 h-4 text-[#16A34A] flex-shrink-0 mt-0.5" aria-hidden="true" />
                                <span><span className="font-semibold text-[#15803D]">{phase === 'done' ? 'Now' : 'New'}:</span> {describe(p.to)}</span>
                              </p>
                            )}
                          </div>
                        ))}
                        {both && ok && (
                          <p className="text-[13px] text-[#475569]">Its Lecture and Laboratory move together — one laboratory, the same days.</p>
                        )}
                        {c.makesRoomFor && ok && (
                          <p className="text-[13px] text-[#475569]">
                            Moves to make room for <b className="font-mono text-[#0B2A5B]">{c.makesRoomFor.subjectCode}</b> · {c.makesRoomFor.block}.
                          </p>
                        )}
                        {!ok && (
                          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                            <p className="text-sm font-semibold text-[#B45309] flex-1">Not moved — {c.reason ?? 'no free room and time was found'}.</p>
                            <Link href={schedulingLink(c)}
                              className="self-start inline-flex items-center gap-1 h-9 px-3 rounded-lg bg-white border border-amber-300 text-[13px] font-bold text-[#B45309] hover:bg-amber-50 transition-colors whitespace-nowrap">
                              Open in Scheduling <ChevronRight className="w-4 h-4" />
                            </Link>
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
