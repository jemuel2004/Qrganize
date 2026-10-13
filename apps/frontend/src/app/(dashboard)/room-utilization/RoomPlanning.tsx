'use client';

/**
 * Room Planning — "Do we have enough rooms?", answered first and in a few words.
 *
 * Top to bottom: the answer with a pie of the rooms at the busiest time (and
 * one small pie per kind of room; "In use" / "Free" open the rooms behind them)
 * · the estimate once every waiting class is
 * scheduled · the rooms in use hour by hour for the day picked · a short list
 * of what to fix, only when something needs fixing. Term and Room type scope
 * everything. Numbers come from @shared/roomPlanning via GET /api/rooms/demand
 * (the class schedule, never QR scans) and refresh by themselves.
 */

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useReducedMotion } from 'framer-motion';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import FriendlySelect from '@/components/ui/FriendlySelect';
import CountFilterTabs from '@/components/ui/CountFilterTabs';
import { CardSkeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useRealtime } from '@/context/RealtimeContext';
import { clockRange12 } from '@shared/clock12';
import {
  ROOM_ISSUE_LABEL, ROOM_POOL_LABEL, isRoomProblem,
  type PlanningClass, type RoomPlanning, type RoomPool,
} from '@shared/roomPlanning';
import {
  BusiestRoomsDialog, DonutChart, DonutLegend, EstimateLine, hourRange, kindWord, PLAN_VARS, plural, POOL_FILTER_LABEL, POOL_ICON, RoomsByHourChart,
  roomSnapshot, shownPools, snapshotSlices, TypeDonuts, verdictHeadline, verdictLine, VERDICT_STYLE, type PoolFilter,
} from '@/components/roomPlanning/RoomPlanningCharts';
import { EASE, motion } from './shared';
import MoveIntoDayDialog from './MoveIntoDayDialog';

interface PlanningResponse {
  term: { semester: string | null; school_year: string | null };
  terms: { semester: string; academic_year: string }[];
  planning: RoomPlanning;
}

const LABEL = 'block text-sm font-semibold text-[#334155] mb-1.5';
const CARD = 'bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] min-w-0';
const partLabel = (part: 'lec' | 'lab') => (part === 'lab' ? 'Laboratory' : 'Lecture');
/** Room type tabs in each kind's colour — the same as Room Usage's Lecture / Laboratory tabs */
const TAB_COLOR: Record<RoomPool, string> = { lecture: '#1D5BD6', laboratory: '#B45309', pathfit: '#475569' };

function PlanningSkeleton() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading room planning">
      <CardSkeleton className="h-[420px] rounded-2xl" />
      <CardSkeleton className="h-[380px] rounded-2xl" />
    </div>
  );
}

/** Mon · Tue · Wed … — the day the hour bars show */
function DayTabs({ days, value, onChange }: { days: string[]; value: string; onChange: (d: string) => void }) {
  const reduceMotion = useReducedMotion();
  return (
    <div role="radiogroup" aria-label="Day" className="inline-flex flex-wrap p-1 rounded-xl bg-[#F1F5F9] border border-[#E2E8F0]">
      {days.map(d => {
        const on = d === value;
        return (
          <button key={d} type="button" role="radio" aria-checked={on} aria-label={d} onClick={() => onChange(d)}
            className={`relative h-10 px-3.5 sm:px-4 rounded-lg text-[15px] font-semibold transition-colors ${on ? '' : 'text-[#334155] hover:text-[#0B2A5B]'}`}
            style={on ? { color: '#FFFFFF' } : undefined}>
            {on && <motion.span layoutId="room-planning-day" aria-hidden className="absolute inset-0 rounded-lg shadow-sm" style={{ backgroundColor: '#0B2A5B' }}
              transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }} />}
            <span className="relative">{d.slice(0, 3)}</span>
          </button>
        );
      })}
    </div>
  );
}

const FIRST_ROWS = 5;

function FixList({ rows }: { rows: PlanningClass[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  return (
    <>
    <ul className="rounded-xl border border-[#E2E8F0] divide-y divide-[#F1F5F9]">
      {shown.map(c => (
        <li key={c.key} className="px-4 py-3 flex flex-col md:flex-row md:items-center gap-1.5 md:gap-4">
          <div className="min-w-0 md:w-56">
            <p className="text-[15px] font-semibold text-[#0B2A5B]">{c.subject_code ?? '—'}{c.block ? ` · ${c.block}` : ''}</p>
            <p className="text-[14px] text-[#64748B]">{partLabel(c.part)} · {c.faculty_name || 'No faculty yet'}</p>
          </div>
          <div className="min-w-0 flex-1 text-[14px] text-[#475569]">
            {c.meetings.map(m => <p key={m.id}>{m.day.slice(0, 3)} {clockRange12(m.start, m.end)} · {m.room_name ?? 'No room'}</p>)}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {c.issues.map(i => (
              <span key={i} className={`inline-flex items-center gap-1 text-sm font-semibold px-3 py-1 rounded-full border ${
                isRoomProblem(i) ? 'bg-red-50 text-[#B91C1C] border-red-200' : 'bg-amber-50 text-[#B45309] border-amber-200'
              }`}>
                <AlertTriangle className="w-3.5 h-3.5" aria-hidden /> {ROOM_ISSUE_LABEL[i]}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
    {rows.length > FIRST_ROWS && (
      <button type="button" onClick={() => setAll(a => !a)} aria-expanded={all}
        className="inline-flex items-center gap-1 h-10 px-3 -ml-3 rounded-lg text-[15px] font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors">
        {all ? 'Show fewer' : `Show all ${rows.length}`}
        <ChevronRight className={`w-4 h-4 transition-transform duration-200 ${all ? '-rotate-90' : 'rotate-90'}`} />
      </button>
    )}
    </>
  );
}

/* ─── Section ─────────────────────────────────────────────────────────────── */

/** `initialPool`: open on that kind of room (a row clicked in Analytics) */
export default function RoomPlanningSection({ initialPool }: { initialPool?: RoomPool }) {
  const reduceMotion = useReducedMotion();
  const { schoolYear, semester, loading: termLoading } = useSchoolYear();
  const [res, setRes] = useState<PlanningResponse | null>(null);
  const [error, setError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [retry, setRetry] = useState(0);
  const [live, setLive] = useState(0);
  /** "2026-2027|1st Semester"; '' = the current term */
  const [termKey, setTermKey] = useState('');
  const [pool, setPool] = useState<PoolFilter>(initialPool ?? 'all');
  const [day, setDay] = useState('');
  const [moveOpen, setMoveOpen] = useState(false);
  const [slice, setSlice] = useState<string | null>(null);
  /** "In use" / "Free" clicked: the rooms behind that number */
  const [roomList, setRoomList] = useState<'use' | 'free' | null>(null);

  // Live: re-read quietly when classes, blocks, rooms, the school day or the term change
  useRealtime(['schedule', 'blocks', 'rooms', 'settings', 'term'], () => setLive(n => n + 1));

  const [ay, sem] = termKey ? termKey.split('|') : [schoolYear ?? '', semester ?? ''];
  useEffect(() => {
    if (termLoading && !termKey) return;
    const c = new AbortController();
    setFetching(true);
    const qs = new URLSearchParams({ ...(sem ? { semester: sem } : {}), ...(ay ? { academic_year: ay } : {}) });
    fetch(`/api/rooms/demand?${qs}`, { signal: c.signal, cache: 'no-store' })
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Failed to load room planning.');
        if (!d.planning) throw new Error('Room planning needs the latest server update.');
        setRes(d);
        setError('');
      })
      .catch(e => { if (!c.signal.aborted) setError(e instanceof Error ? e.message : 'Failed to load room planning.'); })
      .finally(() => { if (!c.signal.aborted) setFetching(false); });
    return () => c.abort();
  }, [ay, sem, termLoading, termKey, retry, live]);

  const showSkeleton = useMinLoading(!res && !error, LOADING_DELAY);
  const p = res?.planning ?? null;
  const pools = p ? shownPools(p.pools) : [];
  const poolOn: PoolFilter = pool === 'all' || pools.includes(pool) ? pool : 'all';

  const shell = (body: ReactNode) => <div className={`space-y-5 min-w-0 ${PLAN_VARS}`}>{body}</div>;

  if (error && !res) {
    return shell(
      <div className={`${CARD} p-5 flex items-center gap-3`}>
        <p className="text-[15px] text-[#B91C1C]">{error}</p>
        <button type="button" onClick={() => setRetry(n => n + 1)} className="text-[15px] font-semibold text-[#1D5BD6] hover:underline">Try again</button>
      </div>,
    );
  }

  const termOptions = (() => {
    const list = res?.terms ?? [];
    const cur = res?.term;
    const all = cur?.semester && cur.school_year && !list.some(t => t.semester === cur.semester && t.academic_year === cur.school_year)
      ? [{ semester: cur.semester, academic_year: cur.school_year }, ...list]
      : list;
    return all.map(t => ({ value: `${t.academic_year}|${t.semester}`, label: `${t.semester} · ${t.academic_year}` }));
  })();
  const termValue = res?.term.semester && res.term.school_year ? `${res.term.school_year}|${res.term.semester}` : '';

  /* The answer for the room type picked */
  const snap = p ? roomSnapshot(p, poolOn) : null;
  const headline = p && snap ? verdictHeadline(p, poolOn, snap) : '';
  const subline = p && snap ? verdictLine(p, poolOn, snap) : '';
  // In use / Free open their rooms (older servers don't send the lists)
  const canList = (k: string) => !!p?.busiest_rooms && ((k.startsWith('use') && (snap?.inUse ?? 0) > 0) || (k === 'free' && (snap?.free ?? 0) > 0));
  const openList = (k: string) => { if (canList(k)) setRoomList(k.startsWith('use') ? 'use' : 'free'); };
  const slices = snap ? snapshotSlices(snap, poolOn) : [];

  /* Hour by hour, for the day picked (first: the busiest day) */
  const days = p?.days ?? [];
  const busyDay = (poolOn === 'all' ? p?.totals.peak_at : p?.pools[poolOn].peak_at)?.day ?? days[0] ?? '';
  const dayShown = day && days.includes(day) ? day : busyDay;
  const row = p ? p.grid[poolOn][days.indexOf(dayShown)] ?? [] : [];
  let busiestHour = -1;
  row.forEach((c, i) => { if (c.in_use > 0 && (busiestHour < 0 || c.in_use > row[busiestHour].in_use)) busiestHour = i; });
  const usable = snap?.usable ?? 0;

  /* What to fix: classes without a suitable room, or outside 7:00 AM–6:00 PM */
  const fix = p ? p.issues.filter(c => poolOn === 'all' || c.pool === poolOn) : [];
  const needsRoom = fix.some(c => c.issues.includes('no_room') || c.issues.includes('inactive_room'));
  const late = fix.some(c => c.issues.includes('after_hours'));

  return shell(
    <>
      {/* Filters — they scope everything below */}
      <div className={`${CARD} p-4 sm:p-5`}>
        <div className="flex flex-col lg:flex-row lg:items-end gap-4 lg:gap-6">
          <div className="w-full lg:w-72 flex-shrink-0">
            <p className={LABEL}>Term</p>
            <FriendlySelect
              value={termValue}
              onChange={v => setTermKey(v)}
              label="Term"
              options={termOptions.length ? termOptions : [{ value: '', label: '…' }]}
            />
          </div>
          {pools.length > 0 && (
            <div className="min-w-0">
              <p className={LABEL}>Room type</p>
              <CountFilterTabs<PoolFilter>
                label="Room type"
                layoutId="room-planning-type"
                value={poolOn}
                onChange={setPool}
                options={[
                  { key: 'all', label: 'All rooms', count: p?.totals.usable ?? 0, color: '#0B2A5B' },
                  ...pools.map(k => {
                    const { Icon } = POOL_ICON[k];
                    return { key: k as PoolFilter, label: ROOM_POOL_LABEL[k], count: p?.pools[k].usable ?? 0, color: TAB_COLOR[k], icon: <Icon className="w-4 h-4" /> };
                  }),
                ]}
              />
            </div>
          )}
        </div>
      </div>

      <PageLoadTransition showSkeleton={showSkeleton || !p || !snap} skeleton={<PlanningSkeleton />}>
        {p && snap && (
          <div className={`space-y-5 transition-opacity duration-300 ${fetching ? 'opacity-60' : ''}`}>
            {/* 1 · The answer */}
            <section className={`${CARD} p-5 sm:p-7`}>
              <div className="flex flex-col sm:flex-row items-center gap-6 sm:gap-10">
                <DonutChart
                  slices={slices}
                  size={196}
                  label={`${POOL_FILTER_LABEL[poolOn]} at the busiest time`}
                  active={slice}
                  onActive={setSlice}
                  onPick={openList}
                  center={
                    <>
                      <span className="text-[34px] font-bold text-[#0B2A5B] leading-none">{snap.inUse}/{snap.usable}</span>
                      <span className="mt-1 text-[14px] text-[#64748B]">in use</span>
                    </>
                  }
                />
                <div className="min-w-0 w-full text-center sm:text-left">
                  <p className={`text-[28px] sm:text-[32px] font-bold leading-tight ${VERDICT_STYLE[snap.verdict].text}`}>{headline}</p>
                  <p className="mt-1.5 text-[16px] text-[#334155]">{subline}</p>
                  <div className="mt-4 max-w-sm mx-auto sm:mx-0">
                    <DonutLegend slices={slices} active={slice} onActive={setSlice} showShare={false} onPick={openList} pickable={canList} />
                  </div>
                </div>
              </div>

              {poolOn === 'all' && pools.length > 1 && (
                <div className="mt-7 pt-6 border-t border-[#EEF2F7]">
                  <TypeDonuts plan={p} picked={poolOn} onPick={setPool} />
                </div>
              )}

              {p.busiest_rooms && (
                <BusiestRoomsDialog list={p.busiest_rooms[poolOn]} which={roomList} pool={poolOn} onClose={() => setRoomList(null)} />
              )}

              <div className="mt-6 pt-5 border-t border-[#EEF2F7] space-y-2">
                <EstimateLine plan={p} pool={poolOn} />
                <p className="text-sm text-[#64748B]">From the class schedule · for planning only — the final decision rests with the school director.</p>
              </div>
            </section>

            {/* 2 · Hour by hour */}
            {days.length > 0 && (
              <section className={`${CARD} p-5 sm:p-7`}>
                <header className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
                  <div className="min-w-0">
                    <h2 className="text-[19px] font-bold text-[#0B2A5B] leading-tight">Rooms in use, hour by hour</h2>
                    <p className="text-[14px] text-[#64748B] mt-1">Each bar is all {usable} {kindWord(poolOn, usable)}.</p>
                  </div>
                  <DayTabs days={days} value={dayShown} onChange={setDay} />
                </header>
                <RoomsByHourChart key={`${poolOn}|${dayShown}`} cells={row} hours={p.hours} day={dayShown} pool={poolOn} />
                <p className="mt-4 text-[15px] text-[#334155]">
                  {busiestHour >= 0
                    ? <>Busiest on {dayShown}: <b className="text-[#0B2A5B]">{hourRange(p.hours[busiestHour])}</b> — {Math.min(row[busiestHour].in_use, usable)} of {usable} in use.</>
                    : <>No classes on {dayShown}.</>}
                </p>
              </section>
            )}

            {/* 3 · What to fix — only when something needs it */}
            {fix.length > 0 && (
              <section className={`${CARD} p-5 sm:p-7 space-y-4`}>
                <header className="flex flex-wrap items-center gap-3">
                  <span className="w-10 h-10 rounded-full bg-amber-100 text-[#B45309] flex items-center justify-center"><AlertTriangle className="w-5 h-5" aria-hidden /></span>
                  <h2 className="text-[19px] font-bold text-[#0B2A5B]">To fix: {plural(fix.length, 'class')}</h2>
                </header>
                <FixList rows={fix} />
                {(needsRoom || late) && (
                  <div className="flex flex-wrap gap-2.5">
                    {needsRoom && (
                      <Link href="/rooms" className="inline-flex items-center gap-1 h-11 px-4 rounded-lg border border-[#BFDBFE] bg-white text-[15px] font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors">
                        Give them a room <ChevronRight className="w-4 h-4" />
                      </Link>
                    )}
                    {late && (
                      <motion.button
                        type="button"
                        onClick={() => setMoveOpen(true)}
                        whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                        className="inline-flex items-center gap-1 h-11 px-4 rounded-lg border border-amber-300 bg-white text-[15px] font-semibold text-[#B45309] hover:bg-amber-50 transition-colors"
                      >
                        Move late classes into the school day <ChevronRight className="w-4 h-4" />
                      </motion.button>
                    )}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </PageLoadTransition>

      <MoveIntoDayDialog open={moveOpen} onClose={() => setMoveOpen(false)} onMoved={() => setRetry(n => n + 1)} />
    </>,
  );
}
