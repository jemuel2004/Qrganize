'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CalendarDays, Check, DoorOpen, Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { useToast } from '@/context/ToastContext';
import { useRealtime } from '@/context/RealtimeContext';
import { clockRange12 } from '@shared/clock12';
import { blockCode } from '@shared/blockCode';
import {
  RELEASE_STATE, addDays, releaseDateLabel, weekdayOf,
  type ClassDay, type ReleaseSession, type RoomRelease,
} from '@/lib/roomRelease';
import ClassDateCalendar from './ClassDateCalendar';

const ENDPOINT = '/api/instructor/room-releases';
const BTN_PRIMARY =
  'min-h-12 px-5 rounded-xl text-base font-bold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2';
const BTN_SECONDARY =
  'min-h-12 px-5 rounded-xl text-base font-semibold bg-[var(--surface-elevated)] border border-[color:var(--border)] text-[color:var(--foreground-secondary)] hover:bg-[var(--background-secondary)] transition-colors disabled:opacity-40';
const WHITE = { color: '#FFFFFF' } as const;

/** "8:30 AM – 10:00 AM" */
function timeRange(start: string, end: string): string {
  return clockRange12(start, end);
}

/** Outlined action in a class row (theme blue: --primary) */
const BTN_ROW =
  'min-h-11 px-4 rounded-xl border-2 border-[color:var(--primary)] text-[color:var(--primary)] text-[15px] font-bold hover:bg-[#1D5BD6]/10 transition-colors disabled:opacity-40 inline-flex items-center justify-center gap-2 flex-shrink-0';

/**
 * Classroom availability: a calendar of the faculty's own class dates (taken
 * from their schedule — they never work out the day themselves). Picking a
 * date shows that day's classes; each can be made available for that date
 * only, after a short confirmation. Stays open so more dates can be done.
 */
export default function ReleaseClassroomDialog({
  open, onClose, onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** A release was made or taken back — the page reloads its schedule */
  onChanged: () => void;
}) {
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const [ready, setReady] = useState(false);
  const [today, setToday] = useState('');
  const [now, setNow] = useState('');
  const [maxAhead, setMaxAhead] = useState(180);
  const [reasons, setReasons] = useState<string[]>([]);
  const [classDays, setClassDays] = useState<ClassDay[]>([]);
  const [releases, setReleases] = useState<RoomRelease[]>([]);
  const [month, setMonth] = useState('');
  const [date, setDate] = useState('');
  const [sessions, setSessions] = useState<ReleaseSession[] | null>(null);
  const [loadingDay, setLoadingDay] = useState(false);
  const [error, setError] = useState('');
  /** Confirmation step: the classes about to be made available */
  const [confirming, setConfirming] = useState<ReleaseSession[] | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [takingBack, setTakingBack] = useState<number | null>(null);
  /** The picked date's classes — on phones they sit under the calendar, so they are brought into view */
  const dayRef = useRef<HTMLDivElement>(null);
  const showDayOnPhone = useCallback(() => {
    if (window.matchMedia('(max-width: 767px)').matches) {
      dayRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
  }, [reduceMotion]);

  const loadOverview = useCallback(async (signal?: AbortSignal) => {
    const res = await fetch(ENDPOINT, { cache: 'no-store', signal });
    if (!res.ok) throw new Error();
    const d = await res.json();
    setToday(String(d.today ?? ''));
    setNow(String(d.now ?? ''));
    setMaxAhead(Number(d.max_days_ahead) || 180);
    setReasons(Array.isArray(d.reasons) ? d.reasons : []);
    setClassDays(Array.isArray(d.class_days) ? d.class_days : []);
    setReleases(Array.isArray(d.releases) ? d.releases : []);
    return d as { today?: string };
  }, []);

  const loadDay = useCallback(async (day: string, signal?: AbortSignal) => {
    const res = await fetch(`${ENDPOINT}?date=${encodeURIComponent(day)}`, { cache: 'no-store', signal });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Could not load your classes for that date.');
    setSessions(Array.isArray(d.sessions) ? d.sessions : []);
    setReleases(Array.isArray(d.releases) ? d.releases : []);
    setNow(String(d.now ?? ''));
  }, []);

  // Fresh each time it opens; the calendar starts on this month
  useEffect(() => {
    if (!open) return;
    setReady(false); setDate(''); setSessions(null); setConfirming(null); setReason(''); setError('');
    const ctrl = new AbortController();
    loadOverview(ctrl.signal)
      .then(d => { setMonth(String(d.today ?? '').slice(0, 7)); setReady(true); })
      .catch(() => { if (!ctrl.signal.aborted) setError('Unable to reach the server. Please try again.'); });
    return () => ctrl.abort();
  }, [open, loadOverview]);

  // The picked date's classes
  useEffect(() => {
    if (!open || !date) return;
    const ctrl = new AbortController();
    setLoadingDay(true);
    setError('');
    loadDay(date, ctrl.signal)
      .catch(err => { if (!ctrl.signal.aborted) { setSessions(null); setError(err instanceof Error ? err.message : 'Could not load your classes.'); } })
      .finally(() => { if (!ctrl.signal.aborted) setLoadingDay(false); });
    return () => ctrl.abort();
  }, [open, date, loadDay]);

  // Live while open: a room request on a freed room, a class time starting or ending
  // (room clock), a class added or moved — the calendar and the picked date re-read quietly
  useRealtime(['occupancy', 'room-requests', 'schedule'], () => {
    void loadOverview().catch(() => {});
    if (date) void loadDay(date).catch(() => {});
  }, { enabled: open && ready && !saving });

  const lastDate = today ? addDays(today, maxAhead) : '';
  const dayEnds = useMemo(() => new Map(classDays.map(d => [d.day, d.last_end])), [classDays]);
  const releasedDates = useMemo(() => new Set(releases.map(r => r.date)), [releases]);
  /** Only the faculty's class dates, from today (while a class is still ahead) to the last allowed date */
  const isSelectable = useCallback((d: string) => {
    if (!today || d < today || d > lastDate) return false;
    const end = dayEnds.get(weekdayOf(d));
    if (!end) return false;
    return d > today || end > now;
  }, [today, lastDate, dayEnds, now]);

  async function confirmRelease() {
    if (!confirming || saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, session_ids: confirming.map(s => s.session_id), reason }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setError(d.error || 'Could not save. Please try again.'); return; }
      toast.success(String(d.message || 'Your room is now free for others on that date.'));
      setConfirming(null);
      setReason('');
      onChanged();
      await loadDay(date).catch(() => {});
    } catch {
      setError('Unable to reach the server. Please check your connection.');
    } finally {
      setSaving(false);
    }
  }

  async function takeBack(s: ReleaseSession) {
    if (!s.release_id) return;
    setTakingBack(s.session_id);
    setError('');
    try {
      const res = await fetch(`${ENDPOINT}/${s.release_id}`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setError(d.error || 'Could not take the classroom back. Please try again.'); return; }
      toast.success(`${s.room_name} is yours again on ${releaseDateLabel(date)}.`);
      onChanged();
      await loadDay(date).catch(() => {});
    } catch {
      setError('Unable to reach the server. Please check your connection.');
    } finally {
      setTakingBack(null);
    }
  }

  const eligible = (sessions ?? []).filter(s => !s.released && !s.ended);
  const started = (s: ReleaseSession) => date === today && s.start_time <= now;
  // Keys go straight on the element (React refuses a key inside spread props)
  const fade = {
    initial: reduceMotion ? false : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] as const } },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, transition: { duration: 0.15 } },
  };

  return (
    <Modal
      open={open}
      onClose={() => { if (!saving) onClose(); }}
      title={confirming ? 'Free My Room?' : 'Free My Room'}
      icon={DoorOpen}
      size={confirming ? 'sm' : 'xl'}
      // Calendar view: no footer bar (the header ✕ closes) so everything fits without scrolling
      footer={confirming ? (
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
          <button type="button" onClick={() => { setConfirming(null); setError(''); }} disabled={saving} className={BTN_SECONDARY}>
            Cancel
          </button>
          <button type="button" onClick={confirmRelease} disabled={saving} className={BTN_PRIMARY} style={WHITE}>
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Freeing…</> : 'Free My Room'}
          </button>
        </div>
      ) : undefined}
    >
      {error && (
        <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] leading-snug text-red-700">
          {error}
        </div>
      )}

      {confirming ? (
        /* ── Confirmation ── */
        <div className="space-y-5">
          <p className="text-[15px] leading-relaxed text-[color:var(--foreground-secondary)]">
            Your room will be free for other faculty on this date, during your class time only. Faculty whose class has no room are told by notification.
          </p>
          {confirming.length === 1 ? (
            <dl className="rounded-xl border border-[color:var(--border)] bg-[var(--background-secondary)] px-4 py-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[15px]">
              <dt className="font-semibold text-[color:var(--foreground-muted)]">Room</dt>
              <dd className="font-bold text-[color:var(--foreground)]">{confirming[0].room_name}</dd>
              <dt className="font-semibold text-[color:var(--foreground-muted)]">Date</dt>
              <dd className="font-bold text-[color:var(--foreground)]">{releaseDateLabel(date, true)}</dd>
              <dt className="font-semibold text-[color:var(--foreground-muted)]">Time</dt>
              <dd className="font-bold tabular-nums text-[color:var(--foreground)]">{timeRange(confirming[0].start_time, confirming[0].end_time)}</dd>
            </dl>
          ) : (
            <div className="rounded-xl border border-[color:var(--border)] bg-[var(--background-secondary)] px-4 py-3 text-[15px]">
              <p className="font-bold text-[color:var(--foreground)] mb-1.5">{releaseDateLabel(date, true)}</p>
              <ul className="space-y-1">
                {confirming.map(s => (
                  <li key={s.session_id} className="tabular-nums text-[color:var(--foreground-secondary)]">
                    <span className="font-semibold text-[color:var(--foreground)]">{timeRange(s.start_time, s.end_time)}</span> · {s.room_name}
                    <span className="text-[color:var(--foreground-muted)]"> · {s.subject_code}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {reasons.length > 0 && (
            <div>
              <p className="text-[15px] font-semibold text-[color:var(--foreground)] mb-2">
                Reason <span className="font-normal text-[color:var(--foreground-muted)]">(optional)</span>
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Reason">
                {reasons.map(r => {
                  const on = reason === r;
                  return (
                    <button
                      key={r}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      // Tapping the chosen reason again clears it
                      onClick={() => setReason(on ? '' : r)}
                      className={`min-h-12 px-3 rounded-xl border-2 text-[15px] font-semibold text-left inline-flex items-center gap-2 transition-colors ${
                        on ? 'border-[#1D5BD6] bg-[#1D5BD6]' : 'border-[color:var(--border)] text-[color:var(--foreground)] hover:border-[#9DB8E8]'
                      }`}
                      style={on ? WHITE : undefined}
                    >
                      {on && <Check className="w-4 h-4 flex-shrink-0" strokeWidth={3} />}
                      {r}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : !ready ? (
        <div className="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-6" aria-busy="true">
          <div className="h-[372px] rounded-2xl bg-[var(--background-secondary)] animate-pulse" />
          <div className="h-[200px] rounded-2xl bg-[var(--background-secondary)] animate-pulse" />
        </div>
      ) : classDays.length === 0 ? (
        <p className="rounded-xl border border-[color:var(--border)] px-4 py-6 text-center text-[15px] text-[color:var(--foreground-muted)]">
          You have no classes with an assigned classroom this term.
        </p>
      ) : (
        /* ── Calendar + the picked date's classes ── */
        <div className="grid grid-cols-1 md:grid-cols-[300px_1fr] gap-6">
          <ClassDateCalendar
            month={month}
            onMonth={setMonth}
            minMonth={today.slice(0, 7)}
            maxMonth={lastDate.slice(0, 7)}
            today={today}
            selected={date}
            onSelect={d => {
              setDate(d);
              setSessions(null);
              // No entry animation with reduced motion — bring the classes into view straight away
              if (reduceMotion) requestAnimationFrame(showDayOnPhone);
            }}
            isSelectable={isSelectable}
            isReleased={d => releasedDates.has(d)}
            showLegend={releasedDates.size > 0}
          />

          <div ref={dayRef} className="min-w-0 scroll-mt-2">
            <AnimatePresence mode="wait" initial={false}>
              {!date ? (
                <motion.div key="hint" {...fade} className="h-full min-h-[160px] rounded-2xl border-2 border-dashed border-[color:var(--border)] flex flex-col items-center justify-center gap-2 px-5 py-8 text-center">
                  <CalendarDays className="w-8 h-8 text-[#1D5BD6]" />
                  <p className="text-[15px] font-semibold text-[color:var(--foreground)]">Tap a highlighted date</p>
                  <p className="text-[14px] text-[color:var(--foreground-muted)]">Only the days you have a class can be picked.</p>
                </motion.div>
              ) : (
                <motion.div key={date} {...fade} onAnimationComplete={showDayOnPhone} className="space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <h3 className="text-[17px] font-bold text-[color:var(--foreground)]">{releaseDateLabel(date, true)}</h3>
                    {/* Away the whole day: every remaining class at once */}
                    {eligible.length > 1 && (
                      <button type="button" onClick={() => { setConfirming(eligible); setError(''); }} className="min-h-10 px-3 rounded-xl text-[15px] font-semibold text-[color:var(--primary)] hover:bg-[#1D5BD6]/10 transition-colors">
                        Free all rooms
                      </button>
                    )}
                  </div>
                  {loadingDay || !sessions ? (
                    <div className="rounded-xl border border-[color:var(--border)] divide-y divide-[color:var(--border)]" aria-busy="true">
                      {[0, 1, 2].map(i => <div key={i} className="h-[62px] bg-[var(--background-secondary)] animate-pulse" />)}
                    </div>
                  ) : sessions.length === 0 ? (
                    <p className="rounded-xl border border-[color:var(--border)] px-4 py-4 text-[15px] text-[color:var(--foreground-muted)]">
                      No classes with a classroom on this date.
                    </p>
                  ) : (
                    <ul className="rounded-xl border border-[color:var(--border)] bg-[var(--surface-elevated)] divide-y divide-[color:var(--border)]">
                      {sessions.map(s => {
                        const block = [s.program_code, blockCode(s.year_level, s.block_name)].filter(Boolean).join(' ');
                        return (
                          <li key={s.session_id} className={`px-4 py-2 flex items-center gap-3 ${s.ended ? 'opacity-60' : ''}`}>
                            <div className="min-w-0 flex-1" title={`${s.subject_code} ${s.subject_name}`}>
                              <p className="text-[16px] font-bold tabular-nums text-[color:var(--foreground)]">
                                {timeRange(s.start_time, s.end_time)}
                                <span className="font-semibold text-[color:var(--foreground-secondary)]"> · {s.room_name}</span>
                              </p>
                              <p className="text-[14px] text-[color:var(--foreground-muted)] truncate">{s.subject_code} · {block}</p>
                            </div>
                            {s.ended ? (
                              <span className="text-[14px] font-semibold text-[color:var(--foreground-muted)] flex-shrink-0">Ended</span>
                            ) : s.released ? (
                              <div className="flex items-center gap-2 flex-shrink-0">
                                {s.reserved_by ? (
                                  // Another faculty asked for the room then — it stays theirs
                                  <span className={`text-[13px] font-semibold px-2.5 py-1 rounded-lg border ${RELEASE_STATE.reserved.cls}`} title={`Reserved by ${s.reserved_by}`}>Reserved by another faculty</span>
                                ) : (
                                  <span className={`text-[13px] font-semibold px-2.5 py-1 rounded-lg border ${RELEASE_STATE.open.cls}`}>Free for others</span>
                                )}
                                {!started(s) && !s.reserved_by && (
                                  <button type="button" onClick={() => takeBack(s)} disabled={takingBack !== null} className="min-h-10 px-2 rounded-lg text-[14px] font-semibold text-[color:var(--foreground-secondary)] hover:text-[color:var(--primary)] inline-flex items-center gap-1.5 disabled:opacity-40">
                                    {takingBack === s.session_id && <Loader2 className="w-4 h-4 animate-spin" />} Take back
                                  </button>
                                )}
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => { setConfirming([s]); setError(''); }}
                                aria-label={`Free Room: ${s.room_name}, ${timeRange(s.start_time, s.end_time)}`}
                                className={BTN_ROW}
                              >
                                Free Room
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
    </Modal>
  );
}
