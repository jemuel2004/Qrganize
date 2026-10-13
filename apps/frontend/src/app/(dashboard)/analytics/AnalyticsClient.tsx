'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, ArrowRight, CalendarDays, CheckCircle2 } from 'lucide-react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { CardSkeleton } from '@/components/ui/skeletons';
import type { BusiestRooms, RoomPlanningSummary } from '@shared/roomPlanning';
import {
  BusiestRoomsDialog, DonutChart, DonutLegend, EstimateLine, PLAN_VARS, roomSnapshot, snapshotSlices, TypeBars, verdictHeadline, VERDICT_STYLE,
  type Slice,
} from '@/components/roomPlanning/RoomPlanningCharts';
import { LOAD_TONE } from '@/lib/loadTone';
import { EASE } from './charts';
import DetailModal, { type DetailKey, type Details } from './DetailModal';
import ListDialog, { type ListRow } from './ListDialog';

/*
 * Analytics — pie graphs, each with its answer in a few words:
 *   Classes (how many are scheduled) · Faculty workload (who still needs load) ·
 *   Rooms at the busiest time (enough, or how many more) · Faculty rooms (who
 *   still has a class without a room); then one horizontal bar per kind of room
 *   (each opens it on Room Planning). Every key row opens what it counts: the classes
 *   on Master Schedule, the faculty in a pop-up (each opening their own page), the
 *   rooms at the busiest time. Conflicts sit as one chip on top.
 */

/* ─── Data (GET /api/analytics — active term) ─────────────────────────────── */

interface AnalyticsData {
  term?: { semester: string | null; school_year: string | null };
  kpis: {
    rooms: { total: number; lec: number; lab: number };
    utilization: number;
    utilization_change: number;
    instructors: { total: number; permanent: number; contractual: number };
    conflicts: number;
  };
  scheduling: { scheduled: number; unassigned: number };
  offerings: {
    total: number;
    scheduled: number;
    stages?: { scheduled: number; needs_schedule: number; no_faculty: number };
  };
  conflict_counts: { room: number; faculty: number; block: number };
  details: Details;
  faculty_load: {
    faculty_id: number; name: string; current: number; limit: number; unit: string;
    status: 'complete' | 'overload' | 'praise' | 'in_progress' | 'not_started';
  }[];
  /** Faculty with classes this term: every scheduled class has a room / some have none / nothing scheduled yet (older servers don't send it) */
  faculty_rooms?: {
    with_room: number; without_room: number; no_schedule: number;
    faculty?: { id: number; name: string; state: 'room' | 'none' | 'unscheduled'; no_room: number }[];
  };
  /** Room demand vs. usable rooms (older servers don't send it) */
  room_planning?: RoomPlanningSummary;
  /** The rooms in use and free at the busiest time (older servers don't send it) */
  busiest_rooms?: BusiestRooms;
}

const GREEN = '#10B981';
const AMBER = '#F59E0B';
const GREY = '#94A3B8';

const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
/** 18 · 18.25 — no trailing zeros */
const amount = (n: number) => String(Math.round(n * 100) / 100);

/** Where each class stands (older backends: worked out from the totals) */
function stagesOf(d: AnalyticsData) {
  if (d.offerings.stages) return d.offerings.stages;
  const open = Math.max(0, d.offerings.total - d.offerings.scheduled);
  const noFaculty = Math.min(open, d.scheduling.unassigned);
  return { scheduled: d.offerings.scheduled, needs_schedule: open - noFaculty, no_faculty: noFaculty };
}

/* ─── Building blocks ─────────────────────────────────────────────────────── */

function OpenLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-1 h-9 px-3 -mr-2 rounded-lg text-[14px] font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors whitespace-nowrap">
      {label} <ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
    </Link>
  );
}

/** A pie card: title, the answer in a few words, the pie with its key, and where to go next */
function PieCard({ index, title, answer, answerClass = 'text-[#0B2A5B]', note, children, footer }: {
  index: number; title: string; answer: ReactNode; answerClass?: string; note?: ReactNode; children: ReactNode; footer?: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      initial={reduceMotion ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE, delay: reduceMotion ? 0 : index * 0.07 } }}
      className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_2px_rgba(11,42,91,0.05)] p-5 sm:p-6 min-w-0 flex flex-col"
    >
      <h3 className="text-[15px] font-semibold text-[#64748B]">{title}</h3>
      <p className={`mt-1 text-[20px] font-bold leading-snug ${answerClass}`}>{answer}</p>
      {/* Always one line tall, so every card's pie sits at the same height */}
      <p className="mt-0.5 text-[14px] text-[#64748B] min-h-[1.3rem]">{note}</p>
      <div className="mt-5 flex-1 flex flex-col items-center gap-4">{children}</div>
      {footer && <div className="mt-4 flex justify-end">{footer}</div>}
    </motion.section>
  );
}

/* ─── Page ────────────────────────────────────────────────────────────────── */

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [detail, setDetail] = useState<DetailKey | null>(null);
  /** "In use" / "Free" on the busiest-time card: the rooms behind that number */
  const [roomList, setRoomList] = useState<'use' | 'free' | null>(null);
  /** A Faculty workload / Faculty rooms row: the faculty behind that number */
  const [people, setPeople] = useState<{ card: 'load' | 'rooms'; key: string } | null>(null);
  const router = useRouter();
  const [hover, setHover] = useState<Record<string, string | null>>({});
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (silent = false) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/analytics', { signal: ac.signal, cache: 'no-store' });
      if (!res.ok) throw new Error();
      setData(await res.json());
      setError(false);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError' && !silent) setError(true);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);
  useRealtime(['term', 'rooms', 'occupancy', 'schedule', 'workload', 'blocks', 'faculty', 'settings'], () => load(true), { enabled: !loading });
  useVisibilityAwareInterval(() => load(true), 60_000);

  const showSkeleton = useMinLoading(loading && !data, PAGE_SKELETON_MIN_MS);
  const term = data?.term;
  const hoverOf = (card: string) => ({ active: hover[card] ?? null, onActive: (k: string | null) => setHover(h => ({ ...h, [card]: k })) });

  /* ── The four pies ── */
  const st = data ? stagesOf(data) : null;
  const classTotal = st ? st.scheduled + st.needs_schedule + st.no_faculty : 0;
  const classSlices: Slice[] = st ? [
    { key: 'scheduled', label: 'Scheduled', value: st.scheduled, color: GREEN, href: '/master-schedule?status=Scheduled' },
    { key: 'time', label: 'Needs a day and time', value: st.needs_schedule, color: AMBER, href: '/master-schedule?status=Assigned' },
    { key: 'faculty', label: 'No faculty yet', value: st.no_faculty, color: GREY, href: '/master-schedule?status=Unassigned' },
  ] : [];

  const loads = data?.faculty_load ?? [];
  const count = (s: string) => loads.filter(f => f.status === s).length;
  const facultySlices: Slice[] = [
    { key: 'complete', label: 'Complete', value: count('complete'), color: GREEN },
    // The Workload screens' colours: Overload orange, Praise gold, Regular blue (a Regular Load
    // still being filled) — not amber for In Progress, which can't be told apart from gold
    { key: 'overload', label: 'With Overload', value: count('overload'), color: LOAD_TONE.overload },
    { key: 'praise', label: 'With Praise Load', value: count('praise'), color: LOAD_TONE.praise },
    { key: 'in_progress', label: 'In Progress', value: count('in_progress'), color: LOAD_TONE.regular },
    { key: 'not_started', label: 'Not Started', value: count('not_started'), color: GREY },
  ];
  const fullLoad = count('complete') + count('overload') + count('praise');
  const needLoad = loads.length - fullLoad;

  const plan = data?.room_planning;
  const snap = plan ? roomSnapshot(plan, 'all') : null;
  const roomAnswer = plan && snap ? verdictHeadline(plan, 'all', snap) : '';
  const canList = (k: string) => !!data?.busiest_rooms && ((k.startsWith('use') && (snap?.inUse ?? 0) > 0) || (k === 'free' && (snap?.free ?? 0) > 0));
  const openList = (k: string) => { if (canList(k)) setRoomList(k.startsWith('use') ? 'use' : 'free'); };

  // Faculty and rooms: a room for every scheduled class, or still a class without one
  const fr = data?.faculty_rooms;
  const roomSlices: Slice[] = fr ? [
    { key: 'room', label: 'Have a room', value: fr.with_room, color: GREEN },
    { key: 'none', label: 'No room yet', value: fr.without_room, color: AMBER },
    // Only while someone has no class with a day and time yet
    ...(fr.no_schedule > 0 ? [{ key: 'unscheduled', label: 'No schedule yet', value: fr.no_schedule, color: GREY }] : []),
  ] : [];
  const roomFaculty = fr ? fr.with_room + fr.without_room + fr.no_schedule : 0;
  // Never "every faculty" while someone has nothing scheduled yet
  const roomAnswerText = !fr ? ''
    : fr.without_room > 0 ? `${fr.without_room} still need a room`
      : fr.no_schedule > 0 ? 'No one is missing a room' : 'Every faculty has a room';
  const roomNote = fr && fr.without_room === 0 && fr.no_schedule > 0
    ? `${fr.no_schedule} ${fr.no_schedule === 1 ? 'has' : 'have'} no schedule yet`
    : `${fr?.with_room ?? 0} of ${roomFaculty} have a room for every class`;
  const conflicts = data?.kpis.conflicts ?? 0;

  /* ── Every key row opens what it counts ── */
  const goTo = (slices: Slice[]) => (k: string) => {
    const href = slices.find(s => s.key === k)?.href;
    if (href) router.push(href);
  };
  const hasAny = (slices: Slice[]) => (k: string) => (slices.find(s => s.key === k)?.value ?? 0) > 0;
  const openPeople = (card: 'load' | 'rooms', slices: Slice[]) => (k: string) => { if (hasAny(slices)(k)) setPeople({ card, key: k }); };
  const peopleView = ((): { title: string; rows: ListRow[]; footer?: { href: string; label: string } } | null => {
    if (!people) return null;
    if (people.card === 'load') {
      const rows = loads
        .filter(f => f.status === people.key)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(f => ({ key: String(f.faculty_id), name: f.name, note: `Regular load ${amount(f.current)} of ${amount(f.limit)} ${f.unit}`, href: `/workload?facultyId=${f.faculty_id}` }));
      const full = people.key === 'complete' || people.key === 'overload' || people.key === 'praise';
      return {
        title: facultySlices.find(s => s.key === people.key)?.label ?? '',
        rows,
        footer: { href: `/workload?show=${full ? 'complete' : 'incomplete'}`, label: 'Open Workload' },
      };
    }
    const state = people.key === 'room' ? 'room' : people.key === 'none' ? 'none' : 'unscheduled';
    const rows = (fr?.faculty ?? []).filter(f => f.state === state).map(f => ({
      key: String(f.id),
      name: f.name,
      note: state === 'none' ? `${f.no_room} ${f.no_room === 1 ? 'class' : 'classes'} without a room`
        : state === 'unscheduled' ? 'No class has a day and time yet' : undefined,
      href: `/scheduling?step=schedule&faculty=${f.id}`,
    }));
    return {
      title: roomSlices.find(s => s.key === people.key)?.label ?? '',
      rows,
      footer: state === 'none' ? { href: '/rooms?open=no-room', label: 'Open Classes Without a Room' }
        : state === 'unscheduled' ? { href: '/scheduling', label: 'Open Class Assignment' } : undefined,
    };
  })();

  return (
    <div className={`mx-auto w-full max-w-[1600px] min-w-0 p-4 sm:p-6 xl:px-8 ${PLAN_VARS}`}>
      <BackButton />
      <div className="mt-4 sm:mt-7 mb-5">
        <WatermarkTitle>Analytics</WatermarkTitle>
      </div>

      {/* The term and conflicts at a glance */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {term?.semester && (
          <span className="inline-flex items-center gap-2 h-10 px-4 rounded-full bg-white border border-[#E3E9F3] text-sm font-semibold text-[#0B2A5B]">
            <CalendarDays className="w-4 h-4 text-[#1D5BD6]" />
            {term.semester}{term.school_year ? ` · A.Y. ${term.school_year}` : ''}
          </span>
        )}
        {data && (
          <button
            type="button"
            onClick={() => setDetail('conflicts')}
            className={`inline-flex items-center gap-2 h-10 px-4 rounded-full border text-sm font-semibold transition-colors ${
              conflicts > 0 ? 'bg-red-50 border-red-200 text-[#B91C1C] hover:bg-red-100' : 'bg-emerald-50 border-emerald-200 text-[#047857] hover:bg-emerald-100'
            }`}
          >
            {conflicts > 0 ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
            {conflicts > 0 ? `${conflicts} scheduling ${conflicts === 1 ? 'conflict' : 'conflicts'}` : 'No scheduling conflicts'}
          </button>
        )}
      </div>

      {error && !data ? (
        <p className="py-16 text-center text-sm text-[#64748B]">Unable to load analytics. Please try again.</p>
      ) : (
        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={
            <div className="space-y-5" role="status" aria-label="Loading analytics">
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5">
                {Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} className="h-[440px]" />)}
              </div>
              {/* Rooms by type (bars) — the same height as the card */}
              <CardSkeleton className="h-[466px]" />
            </div>
          }
        >
          {data && st ? (
            <div className={`space-y-5 transition-opacity duration-300 ${loading ? 'opacity-60' : ''}`}>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-5 items-stretch">
                <PieCard index={0} title="Classes" answer={`${st.scheduled} of ${classTotal} scheduled`} note="Have a day and time"
                  footer={<OpenLink href="/scheduling" label="Class Assignment" />}>
                  <DonutChart slices={classSlices} label="Classes" {...hoverOf('classes')} onPick={goTo(classSlices)}
                    center={<><span className="text-[30px] font-bold text-[#0B2A5B] leading-none">{share(st.scheduled, classTotal)}%</span><span className="mt-1 text-[13px] text-[#64748B]">scheduled</span></>} />
                  <DonutLegend slices={classSlices} {...hoverOf('classes')} />
                </PieCard>

                <PieCard index={1} title="Faculty workload"
                  answer={needLoad > 0 ? `${needLoad} still need more load` : 'Everyone has a full load'}
                  answerClass={needLoad > 0 ? 'text-[#B45309]' : 'text-[#047857]'}
                  note={`${fullLoad} of ${loads.length} have a full load`}
                  footer={<OpenLink href="/workload" label="Workload" />}>
                  <DonutChart slices={facultySlices} label="Faculty workload" {...hoverOf('faculty')} onPick={openPeople('load', facultySlices)}
                    center={<><span className="text-[30px] font-bold text-[#0B2A5B] leading-none">{fullLoad}/{loads.length}</span><span className="mt-1 text-[13px] text-[#64748B]">full load</span></>} />
                  <DonutLegend slices={facultySlices} {...hoverOf('faculty')} onPick={openPeople('load', facultySlices)} pickable={hasAny(facultySlices)} />
                </PieCard>

                {snap ? (
                  <PieCard index={2} title="Rooms at the busiest time" answer={roomAnswer} answerClass={VERDICT_STYLE[snap.verdict].text}
                    note={snap.when ?? undefined}
                    footer={<OpenLink href="/room-utilization?tab=planning" label="Room Planning" />}>
                    <DonutChart slices={snapshotSlices(snap)} label="Rooms at the busiest time" {...hoverOf('rooms')} onPick={openList}
                      center={<><span className="text-[30px] font-bold text-[#0B2A5B] leading-none">{snap.inUse}/{snap.usable}</span><span className="mt-1 text-[13px] text-[#64748B]">in use</span></>} />
                    <DonutLegend slices={snapshotSlices(snap)} showShare={false} {...hoverOf('rooms')} onPick={openList} pickable={canList} />
                  </PieCard>
                ) : (
                  <PieCard index={2} title="Rooms at the busiest time" answer="Needs the latest server update">
                    <p className="text-sm text-[#64748B]">Room numbers will appear once the server is updated.</p>
                  </PieCard>
                )}

                {fr ? (
                  <PieCard index={3} title="Faculty rooms"
                    answer={roomAnswerText}
                    answerClass={fr.without_room > 0 ? 'text-[#B45309]' : 'text-[#047857]'}
                    note={roomNote}
                    footer={<OpenLink href="/rooms?open=no-room" label="Classes Without a Room" />}>
                    <DonutChart slices={roomSlices} label="Faculty rooms" {...hoverOf('faculty-rooms')} onPick={openPeople('rooms', roomSlices)}
                      center={<><span className="text-[30px] font-bold text-[#0B2A5B] leading-none">{fr.with_room}/{roomFaculty}</span><span className="mt-1 text-[13px] text-[#64748B]">have a room</span></>} />
                    <DonutLegend slices={roomSlices} {...hoverOf('faculty-rooms')} onPick={openPeople('rooms', roomSlices)} pickable={k => hasAny(roomSlices)(k) && !!fr.faculty} />
                  </PieCard>
                ) : (
                  <PieCard index={3} title="Faculty rooms" answer="Needs the latest server update">
                    <p className="text-sm text-[#64748B]">Room numbers will appear once the server is updated.</p>
                  </PieCard>
                )}
              </div>

              {plan && (
                <motion.section
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE, delay: 0.3 } }}
                  className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_2px_rgba(11,42,91,0.05)] p-5 sm:p-6 min-w-0"
                >
                  <header className="flex flex-wrap items-start justify-between gap-3 mb-5">
                    <div>
                      <h3 className="text-[17px] font-bold text-[#0B2A5B]">Rooms by type</h3>
                      <button type="button" onClick={() => setDetail('rooms')} className="mt-0.5 text-[14px] text-[#64748B] hover:text-[#1D5BD6] hover:underline underline-offset-2">
                        {plan.totals.usable} usable rooms · at the busiest time
                      </button>
                    </div>
                    <OpenLink href="/room-utilization?tab=planning" label="Room Planning" />
                  </header>
                  <TypeBars plan={plan} hrefOf={pool => `/room-utilization?tab=planning&type=${pool}`} />
                  <div className="mt-5 pt-4 border-t border-[#EEF2F7]">
                    <EstimateLine plan={plan} pool="all" />
                  </div>
                </motion.section>
              )}
            </div>
          ) : null}
        </PageLoadTransition>
      )}

      {data && <DetailModal open={detail} details={data.details} onClose={() => setDetail(null)} />}
      {data?.busiest_rooms && (
        <BusiestRoomsDialog list={data.busiest_rooms} which={roomList} pool="all" onClose={() => setRoomList(null)} />
      )}
      <ListDialog
        open={!!peopleView}
        title={peopleView?.title ?? ''}
        subtitle={peopleView ? `${peopleView.rows.length} faculty` : undefined}
        rows={peopleView?.rows ?? []}
        footer={peopleView?.footer}
        onClose={() => setPeople(null)}
      />
    </div>
  );
}
