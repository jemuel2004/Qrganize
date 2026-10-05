'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { BookOpen, ChevronLeft, ChevronRight, Clock, Loader2, MapPin, Monitor, Users, X } from 'lucide-react';
import { blockCode } from '@shared/blockCode';
import { useRealtime } from '@/context/RealtimeContext';
import { useScrollLock } from '@/hooks/useScrollLock';
import AutoHeight from '@/components/ui/AutoHeight';
import { asSessionList, fmt12, normTime, parseDays } from '@/lib/scheduleTime';

/*
 * "Who handles this subject?" — every faculty member teaching a subject this
 * term, one card each, and their schedule for it (one section per block they
 * handle). Opened from a Scheduling row's eye (one Lecture or Laboratory
 * part) and from a subject on the Master Schedule (the whole subject).
 * Data: GET /api/scheduling/subject-instructors (one row per assigned block).
 */

interface PreviewSession {
  day: string;
  start_time: string;
  end_time: string;
  type?: string | null;
  room_name?: string | null;
}

/** One class of the subject (an assigned block) and the faculty teaching it. */
export interface SubjectInstructor {
  ms_id: number;
  faculty_id: number;
  faculty_name: string;
  block_name: string;
  year_level: string | null;
  program_code: string | null;
  day_pattern: string | null;
  start_time: string | null;
  end_time: string | null;
  room_name: string | null;
  sessions: PreviewSession[] | string | null;
}

export interface PreviewSubject {
  code: string;
  name: string;
  /** One part of the subject (a Scheduling row); left out = the whole subject */
  component?: 'lec' | 'lab' | null;
}

/** A faculty member and every class of the subject they handle. */
interface FacultyGroup {
  faculty_id: number;
  faculty_name: string;
  classes: SubjectInstructor[];
}

const NO_ROOM = 'No room assigned';
const EASE = [0.4, 0, 0.2, 1] as const;

interface Meeting { day: string; time: string; room: string; kind: 'lec' | 'lab' | null }

function getMeetings(si: SubjectInstructor, comp: 'lec' | 'lab' | null): Meeting[] {
  const all = asSessionList<PreviewSession>(si.sessions);
  const sessions = all.filter(s =>
    (comp === null || (s.type === 'lab' ? 'lab' : 'lec') === comp) && s.day && s.start_time && s.end_time);
  if (sessions.length > 0) {
    return sessions.map(s => ({
      day: s.day,
      time: `${fmt12(normTime(s.start_time))} – ${fmt12(normTime(s.end_time))}`,
      room: s.room_name ?? NO_ROOM, // its own room — not the class's first room
      kind: s.type === 'lab' ? 'lab' : 'lec',
    }));
  }
  // Legacy rows scheduled before schedule_sessions existed
  if (all.length > 0 || !si.day_pattern || !si.start_time || !si.end_time) return [];
  return parseDays(si.day_pattern).map(day => ({
    day,
    time: `${fmt12(normTime(si.start_time!))} – ${fmt12(normTime(si.end_time!))}`,
    room: si.room_name ?? NO_ROOM,
    kind: null,
  }));
}

/** One card per faculty member, in the API's order (by name, then block). */
function groupByFaculty(list: SubjectInstructor[]): FacultyGroup[] {
  const groups = new Map<number, FacultyGroup>();
  for (const si of list) {
    const g = groups.get(si.faculty_id) ?? { faculty_id: si.faculty_id, faculty_name: si.faculty_name, classes: [] };
    g.classes.push(si);
    groups.set(si.faculty_id, g);
  }
  return [...groups.values()];
}

/** "BSIT · 1A" for one class */
const classLabel = (si: SubjectInstructor) =>
  [si.program_code, blockCode(si.year_level, si.block_name)].filter(Boolean).join(' · ');

/** "BSIT · 1A, 1B, 1C" — every block a faculty member handles (programs kept apart) */
function blocksLabel(classes: SubjectInstructor[]): string {
  const byProgram = new Map<string, string[]>();
  for (const si of classes) {
    const program = si.program_code ?? '';
    byProgram.set(program, [...(byProgram.get(program) ?? []), blockCode(si.year_level, si.block_name)]);
  }
  return [...byProgram]
    .map(([program, codes]) => [program, codes.join(', ')].filter(Boolean).join(' · '))
    .join('; ');
}

async function fetchInstructors(query: string, signal?: AbortSignal): Promise<SubjectInstructor[]> {
  const res = await fetch(`/api/scheduling/subject-instructors?${query}`, { signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Unable to load faculty.');
  return Array.isArray(data.instructors) ? data.instructors : [];
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-[#DCE8FC] text-[#164BB5]">{children}</span>
  );
}

export default function SubjectFacultyPreview({
  subject,
  semester,
  academicYear,
  onClose,
  openMsId = null,
  currentFacultyId = null,
  currentMsId = null,
}: {
  /** The subject to show; null = closed */
  subject: PreviewSubject | null;
  semester: string;
  academicYear: string;
  onClose: () => void;
  /** Open straight on the schedule of whoever teaches this class (the back arrow still lists everyone) */
  openMsId?: number | null;
  /** The faculty member being worked on — marked "Current" */
  currentFacultyId?: number | null;
  /** The class the pop-up was opened from — its block is marked "This block" and listed first */
  currentMsId?: number | null;
}) {
  const reduceMotion = useReducedMotion();
  const open = subject !== null;
  const query = subject
    ? new URLSearchParams({ subject_code: subject.code, semester, academic_year: academicYear }).toString()
    : '';

  const [instructors, setInstructors] = useState<SubjectInstructor[] | null>(null);
  const [error, setError] = useState('');
  /* The faculty member whose schedule is open — null shows the list */
  const [viewingId, setViewingId] = useState<number | null>(null);
  /** 1 = heading into a schedule, -1 = back to the list — drives the slide direction. */
  const [navDir, setNavDir] = useState(1);
  const openSchedule = (g: FacultyGroup) => { setNavDir(1); setViewingId(g.faculty_id); };
  const backToList = () => { setNavDir(-1); setViewingId(null); };

  const groups = useMemo(() => (instructors ? groupByFaculty(instructors) : null), [instructors]);
  const viewing = groups?.find(g => g.faculty_id === viewingId) ?? null;

  useScrollLock(open);

  useEffect(() => {
    setViewingId(null);
    setInstructors(null);
    setError('');
    if (!query) return;
    const controller = new AbortController();
    fetchInstructors(query, controller.signal)
      .then(list => {
        setInstructors(list);
        // Same render as the list arrives — no list flash before the schedule
        const hit = openMsId != null ? list.find(si => si.ms_id === openMsId) : undefined;
        if (hit) { setNavDir(1); setViewingId(hit.faculty_id); }
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Unable to load faculty.');
        setInstructors([]);
      });
    return () => controller.abort();
  }, [query, openMsId]);

  /* Live: a class assigned, moved or rescheduled elsewhere shows up here too.
     A late answer for a subject that is no longer open is dropped. */
  const activeQuery = useRef('');
  useEffect(() => { activeQuery.current = query; }, [query]);
  useRealtime(['schedule', 'workload', 'faculty', 'rooms'], () => {
    const q = activeQuery.current;
    if (!q) return;
    return fetchInstructors(q).then(list => {
      if (activeQuery.current !== q) return;
      setInstructors(list);
      setError('');
      // The open schedule goes back to the list once that faculty no longer handles the subject
      setViewingId(id => (id != null && list.some(si => si.faculty_id === id) ? id : null));
    });
  }, { enabled: open && instructors !== null });

  /* Esc closes — handled before anything underneath (e.g. the open timetable) sees it */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {subject && (() => {
        const comp = subject.component ?? null;
        const typeLabel = comp === 'lec' ? 'Lecture' : comp === 'lab' ? 'Laboratory' : null;
        const facultyCount = groups?.length ?? 0;
        const hasCurrentClass = (g: FacultyGroup) => currentMsId != null && g.classes.some(c => c.ms_id === currentMsId);
        const cardChip = (g: FacultyGroup) =>
          currentFacultyId != null && g.faculty_id === currentFacultyId ? 'Current' : hasCurrentClass(g) ? 'This block' : null;
        // The block the pop-up was opened from comes first; the rest keep their order
        const viewingClasses = viewing
          ? [...viewing.classes].sort((a, b) => Number(b.ms_id === currentMsId) - Number(a.ms_id === currentMsId))
          : [];
        // List <-> schedule: slide in from the side you're heading to, out the other way
        const previewSlide = {
          enter: (dir: number) => (reduceMotion ? { opacity: 1 } : { opacity: 0, x: 28 * dir }),
          center: { opacity: 1, x: 0, transition: { duration: reduceMotion ? 0 : 0.3, ease: EASE } },
          exit: (dir: number) => (reduceMotion ? { opacity: 1 } : { opacity: 0, x: -28 * dir, transition: { duration: 0.2, ease: EASE } }),
        };
        // Cards settle in one after another
        const cardIn = (i: number) => ({
          initial: reduceMotion ? false : { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.3, ease: EASE, delay: reduceMotion ? 0 : 0.06 * Math.min(i, 8) } },
        }) as const;
        return (
          <motion.div
            key="subject-faculty-preview"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: reduceMotion ? 0 : 0.4, ease: EASE } }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.3, ease: EASE } }}
            className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-[rgba(15,23,42,0.35)]"
            data-modal-root
            onClick={onClose}
            role="presentation"
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.45, ease: EASE, delay: reduceMotion ? 0 : 0.05 } }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.3, ease: EASE } }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="subject-faculty-preview-title"
              onClick={e => e.stopPropagation()}
              className="bg-white border border-[#E2E8F0] rounded-2xl shadow-xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden"
            >
              {/* Header: icon + "CODE • Lecture", subject name below, divider inset from the edges.
                  List view also shows how many faculty handle the subject;
                  schedule view swaps the subject icon for a back arrow. */}
              <div className="px-5 pt-5 flex-shrink-0">
                <div className="flex items-start justify-between gap-3 pb-4 border-b border-[#E2E8F0]">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="w-7 h-7 -ml-1 flex items-center justify-center flex-shrink-0">
                      <AnimatePresence mode="wait" initial={false}>
                        {viewing ? (
                          <motion.button
                            key="back"
                            type="button"
                            onClick={backToList}
                            aria-label="Back to faculty"
                            initial={reduceMotion ? false : { opacity: 0, x: 8, scale: 0.8 }}
                            animate={{ opacity: 1, x: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.25, ease: EASE } }}
                            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 8, scale: 0.8, transition: { duration: 0.18, ease: EASE } }}
                            whileHover={reduceMotion ? undefined : { x: -2 }}
                            whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                            className="p-1 rounded-lg text-[#1D5BD6] hover:bg-[#EAF1FC] transition-colors"
                          >
                            <ChevronLeft className="w-5 h-5" />
                          </motion.button>
                        ) : (
                          <motion.span
                            key="icon"
                            initial={reduceMotion ? false : { opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1, transition: { duration: reduceMotion ? 0 : 0.25, ease: EASE } }}
                            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8, transition: { duration: 0.18, ease: EASE } }}
                            className="inline-flex"
                          >
                            {comp === 'lab'
                              ? <Monitor className="w-5 h-5 text-amber-600" />
                              : <BookOpen className="w-5 h-5 text-[#1D5BD6]" />}
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 id="subject-faculty-preview-title" className="text-base font-bold text-[#0B2A5B] leading-snug">
                          {subject.code}{typeLabel ? ` • ${typeLabel}` : ''}
                        </h3>
                        <AnimatePresence initial={false}>
                          {!viewing && groups && facultyCount > 0 && (
                            <motion.span
                              key="count-badge"
                              initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
                              animate={{ opacity: 1, scale: 1, transition: { duration: reduceMotion ? 0 : 0.25, ease: EASE } }}
                              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85, transition: { duration: 0.18, ease: EASE } }}
                              className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#EAF1FC] text-[#1D5BD6] border border-[#BFD3F5]"
                            >
                              {facultyCount} Assigned
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </div>
                      <p className="text-sm text-[#64748B] mt-0.5">
                        {subject.name}
                        {!viewing && groups && (
                          <> • {facultyCount} Assigned Faculty</>
                        )}
                      </p>
                    </div>
                  </div>
                  <motion.button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    whileHover={reduceMotion ? undefined : { rotate: 90 }}
                    whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                    transition={{ duration: 0.2, ease: EASE }}
                    className="p-1.5 -mr-1.5 -mt-1 rounded-lg hover:bg-[#F1F5F9] text-[#64748B] hover:text-[#0B2A5B] transition-colors flex-shrink-0"
                  >
                    <X className="w-5 h-5" />
                  </motion.button>
                </div>
              </div>

              {/* Body height glides between the list and a schedule; the views
                  slide sideways — forward to a schedule, back to the list. */}
              <AutoHeight className="min-h-0 overflow-y-auto overflow-x-hidden">
                <AnimatePresence mode="wait" initial={false} custom={navDir}>
                  <motion.div
                    key={viewing ? `sched-${viewing.faculty_id}` : 'list'}
                    custom={navDir}
                    variants={previewSlide}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    className="px-5 py-4 space-y-3"
                  >
                {!viewing ? (
                  /* ── List: one card per faculty member handling this subject ── */
                  groups === null ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#64748B]">
                      <Loader2 className="w-4 h-4 animate-spin text-[#1D5BD6]" /> Loading faculty…
                    </div>
                  ) : error ? (
                    <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-2xl px-4 py-3.5">
                      {error}
                    </div>
                  ) : groups.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] italic bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl px-4 py-3.5">
                      No faculty are assigned to this subject yet.
                    </div>
                  ) : (
                    groups.map((g, i) => {
                      const chip = cardChip(g);
                      return (
                        <motion.div
                          key={g.faculty_id}
                          {...cardIn(i)}
                          className={`flex items-center gap-3.5 border rounded-2xl px-4 py-3.5 transition-colors hover:border-[#BFD3F5] ${
                            chip ? 'bg-[#F5F9FF] border-[#BFD3F5]' : 'bg-[#F8FAFC] border-[#E2E8F0]'
                          }`}
                        >
                          <div className="w-11 h-11 rounded-xl bg-[#EAF1FC] border border-[#D6E3F8] flex items-center justify-center flex-shrink-0">
                            <BookOpen className="w-5 h-5 text-[#1D5BD6]" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-xs text-[#64748B] flex items-center gap-1.5">
                              Faculty
                              {chip && <Chip>{chip}</Chip>}
                            </div>
                            <div className="text-[15px] font-bold text-[#0B2A5B] leading-snug break-words">{g.faculty_name}</div>
                            <div className="text-xs text-[#64748B] leading-snug break-words mt-0.5">{blocksLabel(g.classes)}</div>
                          </div>
                          <motion.button
                            type="button"
                            onClick={() => openSchedule(g)}
                            whileHover={reduceMotion ? undefined : { y: -1 }}
                            whileTap={reduceMotion ? undefined : { scale: 0.95 }}
                            transition={{ duration: 0.18, ease: EASE }}
                            className="group flex-shrink-0 inline-flex items-center gap-1 pl-3.5 pr-2.5 py-2 rounded-full border border-[#1D5BD6] text-[#1D5BD6] text-[13px] font-semibold hover:bg-[#EAF1FC] hover:shadow-[0_6px_14px_-8px_rgba(29,91,214,0.6)] transition-[background-color,box-shadow]"
                          >
                            View Schedule
                            <ChevronRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                          </motion.button>
                        </motion.div>
                      );
                    })
                  )
                ) : (
                <>
                {/* Faculty card */}
                <motion.div {...cardIn(0)} className="flex items-center gap-3.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl px-4 py-3.5">
                  <div className="w-11 h-11 rounded-xl bg-[#EAF1FC] border border-[#D6E3F8] flex items-center justify-center flex-shrink-0">
                    <Users className="w-5 h-5 text-[#1D5BD6]" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs text-[#64748B]">Faculty</div>
                    <div className="text-[15px] font-bold text-[#0B2A5B] leading-snug break-words">{viewing.faculty_name}</div>
                    <div className="text-xs text-[#64748B]">
                      {viewing.classes.length} block{viewing.classes.length === 1 ? '' : 's'}
                    </div>
                  </div>
                </motion.div>

                {/* One section per block this faculty member handles */}
                {viewingClasses.map((si, i) => {
                  const meetings = getMeetings(si, comp);
                  const thisBlock = currentMsId != null && si.ms_id === currentMsId;
                  // Whole subject: name each meeting's part when the block has both Lecture and Laboratory
                  const showKind = meetings.some(m => m.kind === 'lec') && meetings.some(m => m.kind === 'lab');
                  return (
                    <motion.div
                      key={si.ms_id}
                      {...cardIn(i + 1)}
                      className={`border rounded-2xl px-4 pt-3 pb-1.5 ${thisBlock ? 'bg-[#F5F9FF] border-[#BFD3F5]' : 'bg-[#F8FAFC] border-[#E2E8F0]'}`}
                    >
                      <div className="flex items-center gap-2 pb-1">
                        <span className="text-[14px] font-bold text-[#0B2A5B]">{classLabel(si)}</span>
                        {thisBlock && <Chip>This block</Chip>}
                      </div>
                      {meetings.length === 0 ? (
                        <p className="text-sm text-[#94A3B8] italic pb-2">
                          Not yet scheduled — no day, time, or room assigned.
                        </p>
                      ) : (
                        <div className="divide-y divide-[#E2E8F0]">
                          {meetings.map((m, j) => (
                            <div key={j} className="flex items-center gap-3 py-2">
                              <Clock className="w-4 h-4 text-[#64748B] flex-shrink-0" />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-[15px] font-bold text-[#0B2A5B] leading-tight">{m.day}</span>
                                  {showKind && m.kind && (
                                    <span className={`text-[11px] font-semibold px-2 py-px rounded-full border ${
                                      m.kind === 'lab'
                                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                                        : 'bg-[#EAF1FC] text-[#1D5BD6] border-[#BFD3F5]'
                                    }`}>
                                      {m.kind === 'lab' ? 'Laboratory' : 'Lecture'}
                                    </span>
                                  )}
                                </div>
                                <div className="text-[13px] text-[#64748B] tabular-nums mt-0.5">{m.time}</div>
                              </div>
                              <span className={`ml-auto flex items-center gap-1.5 text-[13px] text-right min-w-0 ${m.room === NO_ROOM ? 'text-[#64748B]' : 'font-semibold text-[#0B2A5B]'}`}>
                                <MapPin className="w-4 h-4 text-[#64748B] flex-shrink-0" />
                                <span className="truncate">{m.room}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  );
                })}
                </>
                )}
                  </motion.div>
                </AnimatePresence>
              </AutoHeight>
            </motion.div>
          </motion.div>
        );
      })()}
    </AnimatePresence>
  );
}
