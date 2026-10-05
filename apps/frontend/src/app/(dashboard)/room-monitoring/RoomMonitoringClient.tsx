'use client';

/**
 * Room Monitoring — "What is happening in every room right now?"
 *
 * A live board, one card per room: who is in it now (QR check-in), how much of
 * the class is left, the next class today, and rooms whose class started with
 * no check-in. Clicking a room opens its schedule: the class in it now and
 * every class it holds, grouped by day combination (instructor, subject, block,
 * time). Refreshes quietly every 30 s. Built on /api/rooms/utilization (today,
 * daily; one room, upcoming) — the same data behind Room Utilization, which
 * covers the history/report side.
 */

import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion, useDragControls, useReducedMotion } from 'framer-motion';
import { BookOpen, ChevronRight, Clock, DoorOpen, Hourglass, Loader2, Monitor, Printer, User, AlertTriangle, CheckCircle2 } from 'lucide-react';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import Modal from '@/components/ui/Modal';
import AutoHeight from '@/components/ui/AutoHeight';
import FriendlySelect from '@/components/ui/FriendlySelect';
import { SearchInput } from '@/components/ui/SearchFilter';
import { CardSkeleton, PillsSkeleton, Skeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { useSkeletonRefresh } from '@/hooks/useSkeletonRefresh';
import CountFilterTabs from '@/components/ui/CountFilterTabs';
import { dayTone } from '@/lib/dayTones';
import { useToast } from '@/context/ToastContext';
import { printRoomSchedule, type RoomClass } from './roomSchedulePrint';
import { WEEK_DAYS, daysKey, daysLabel, parseDays, sortDays, type WeekDay } from '@shared/dayCombination';
import {
  fmt12, RefreshButton, RoomIcon, useUtilization,
  type UtilRoom, type UtilRow,
} from '../room-utilization/shared';

/** Live state of a room at this moment */
type LiveStatus = 'In use' | 'Waiting' | 'No check-in' | 'Free';

/* Room identity follows the system-wide room-type colours (Room Management,
   Scheduling): Lecture = blue + book, Laboratory = amber + monitor. */
const TYPE_TONE = {
  lecture: { bar: '#1D5BD6', soft: '#EFF6FF', text: '#1D5BD6', tile: 'bg-[#EFF6FF] text-[#1D5BD6]' },
  lab:     { bar: '#F59E0B', soft: '#FFFBEB', text: '#B45309', tile: 'bg-amber-50 text-amber-600' },
};
const isLabRoom = (type: string | null | undefined) => type === 'Laboratory' || type === 'Computer Lab';

/* Live status shows in the "Now" panel: busy rooms in solid navy, Waiting in
   slate, red only for No check-in. Free rooms use their room-type tint. */
const LIVE_TONE: Record<LiveStatus, { bar: string; soft: string; text: string; label: string; dark?: boolean }> = {
  'In use':      { bar: '#0B2A5B', soft: 'linear-gradient(135deg, #0B2A5B 0%, #1E4FB8 100%)', text: '#FFFFFF', label: 'In use', dark: true },
  Waiting:       { bar: '#64748B', soft: '#EEF2F7', text: '#334155', label: 'Waiting for check-in' },
  'No check-in': { bar: '#DC2626', soft: '#FEF2F2', text: '#B91C1C', label: 'No check-in' },
  Free:          { bar: '#9DB8E8', soft: '#F2F6FD', text: '#1D5BD6', label: 'Available' },
};

const toMin = (hm: string | null) => {
  if (!hm) return -1;
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + (m || 0);
};

interface RoomNow {
  room: UtilRoom;
  status: LiveStatus;
  current: UtilRow | null;
  next: UtilRow | null;
  progress: number;      // 0..1 of the current class elapsed
  minutesLeft: number;
}

function roomNow(room: UtilRoom, rows: UtilRow[], nowMin: number): RoomNow {
  const mine = rows
    .filter(r => r.room_id === room.id && r.start)
    .sort((a, b) => toMin(a.start) - toMin(b.start));
  const current = mine.find(r => toMin(r.start) <= nowMin && nowMin < toMin(r.end)) ?? null;
  const next = mine.find(r => toMin(r.start) > nowMin) ?? null;

  let status: LiveStatus = 'Free';
  if (room.live_status === 'Occupied' || current?.status === 'Occupied') status = 'In use';
  else if (room.live_status === 'Pending' || current?.status === 'Pending') status = 'Waiting';
  else if (current?.status === 'Not Checked') status = 'No check-in';

  const s = toMin(current?.start ?? null);
  const e = toMin(current?.end ?? null);
  const progress = current && e > s ? Math.min(1, Math.max(0, (nowMin - s) / (e - s))) : 0;
  return { room, status, current, next, progress, minutesLeft: current ? Math.max(0, e - nowMin) : 0 };
}

/** "Lab-1" → "Laboratory-1", "Lec 2" → "Lecture 2"; other names unchanged. */
function displayRoomName(name: string) {
  return name
    .replace(/^lab(?![a-z])/i, 'Laboratory')
    .replace(/^lec(?![a-z])/i, 'Lecture');
}

function fmtLeft(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} hr${m ? ` ${m} min` : ''} left` : `${m} min left`;
}

/* ─── Pieces shared by the room card and the room's schedule ────────────── */

const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Lecture / Laboratory tag of a class */
function PartPill({ component }: { component: string }) {
  const lab = component.toLowerCase().startsWith('lab');
  return (
    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
      lab ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]'
    }`}>
      {lab ? 'Laboratory' : 'Lecture'}
    </span>
  );
}

/** Block chip — solid royal blue (translucent white on the navy In-use panel) */
function BlockChip({ block, onDark = false }: { block: string; onDark?: boolean }) {
  return (
    <span
      className="text-[11px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap"
      style={onDark ? { backgroundColor: 'rgba(255,255,255,0.18)', color: '#FFFFFF' } : { backgroundColor: '#1E4FB8', color: '#FFFFFF' }}
    >
      {block}
    </span>
  );
}

/** "Now" — the class in the room at this moment and how much of it is left, or that the room is free */
function NowPanel({ info }: { info: RoomNow }) {
  const reduceMotion = useReducedMotion();
  const { room, current: cls } = info;
  const type = isLabRoom(room.room_type) ? TYPE_TONE.lab : TYPE_TONE.lecture;
  // Free rooms take their room-type tint; other states their status colour
  const tone = info.status === 'Free'
    ? { ...LIVE_TONE.Free, bar: type.bar, soft: type.soft, text: type.text }
    : LIVE_TONE[info.status];
  // Text colours inside the panel (white on the navy In-use panel)
  const ink = tone.dark
    ? { strong: '#FFFFFF', body: '#DCE6F7', track: 'rgba(255,255,255,0.22)', fill: '#FFFFFF' }
    : { strong: '#0B2A5B', body: '#334155', track: 'rgba(255,255,255,0.8)', fill: tone.bar };

  return (
    <div className="rounded-xl px-3.5 py-3" style={{ background: tone.soft }}>
      {cls ? (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-[15px]" style={{ color: ink.strong }}>{cls.subject_code}</span>
            {cls.component && <PartPill component={cls.component} />}
            {cls.block && <BlockChip block={cls.block} onDark={tone.dark} />}
          </div>
          {cls.subject_name && <div className="text-sm mt-0.5 truncate" style={{ color: ink.body }}>{cls.subject_name}</div>}
          <div className="mt-2 flex items-center justify-between gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 min-w-0" style={{ color: ink.body }}>
              <User className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate">{cls.faculty_name ?? 'No instructor'}</span>
            </span>
            <span className="inline-flex items-center gap-1 font-semibold whitespace-nowrap" style={{ color: ink.strong }}>
              <Clock className="w-3.5 h-3.5" /> {fmt12(cls.start)}–{fmt12(cls.end)}
            </span>
          </div>
          {/* Time used / left */}
          <div className="mt-2.5">
            <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: ink.track }}>
              <motion.div
                className="h-full rounded-full"
                style={{ backgroundColor: ink.fill }}
                initial={reduceMotion ? false : { width: 0 }}
                animate={{ width: `${Math.round(info.progress * 100)}%` }}
                transition={{ duration: reduceMotion ? 0 : 0.6, ease: EASE_OUT }}
              />
            </div>
            <div className="mt-1 text-xs font-semibold" style={{ color: tone.dark ? ink.body : tone.text }}>
              {info.status === 'No check-in'
                ? 'Class started — instructor has not scanned the room QR'
                : info.status === 'Waiting'
                  ? 'Class started — waiting for the instructor to scan'
                  : fmtLeft(info.minutesLeft)}
            </div>
          </div>
        </>
      ) : info.status === 'In use' ? (
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: tone.text }}>
          <CheckCircle2 className="w-4 h-4" />
          In use{room.live_faculty ? ` by ${room.live_faculty}` : ''} (no class scheduled now)
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: tone.text }}>
          <DoorOpen className="w-4 h-4" /> Free right now
        </div>
      )}
    </div>
  );
}

/* ─── Room card ─────────────────────────────────────────────────────────── */

function RoomCard({ info, index, onOpen }: { info: RoomNow; index: number; onOpen: () => void }) {
  const reduceMotion = useReducedMotion();
  const { room, next } = info;
  const lab = isLabRoom(room.room_type);
  const type = lab ? TYPE_TONE.lab : TYPE_TONE.lecture;
  const name = displayRoomName(room.room_name);

  return (
    <motion.div
      layout={!reduceMotion}
      // The whole card opens the room's schedule (mouse, Enter or Space)
      role="button"
      tabIndex={0}
      aria-label={`${name} — view schedule`}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.28, ease: EASE_OUT, delay: reduceMotion ? 0 : Math.min(index, 12) * 0.03 }}
      whileHover={reduceMotion ? undefined : { y: -3, transition: { duration: 0.2, ease: EASE_OUT } }}
      whileTap={reduceMotion ? undefined : { scale: 0.985, transition: { duration: 0.12 } }}
      className={`group relative rounded-2xl border bg-white overflow-hidden cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40 shadow-[0_1px_2px_rgba(15,23,42,0.05)] hover:shadow-[0_14px_28px_-16px_rgba(11,42,91,0.45)] transition-shadow ${
        info.status === 'No check-in' ? 'qr-flag-pulse border-red-300'
          : info.status === 'In use' ? 'border-[#9DB8E8]'
          : 'border-[#E2E8F0] hover:border-[#BFD3F5]'
      }`}
    >
      <div className="h-1.5" style={{ backgroundColor: type.bar }} />
      <div className="p-4">
        {/* Room — spelled out ("Lab-1" → "Laboratory-1"), with the room-type icon tile */}
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${type.tile}`}>
            <RoomIcon type={lab ? 'Laboratory' : 'Lecture'} className="w-[18px] h-[18px]" />
          </span>
          <div className="text-lg font-bold text-[#0B2A5B] truncate">{name}</div>
        </div>

        <div className="mt-4"><NowPanel info={info} /></div>

        {/* Next class today (when there is one), and the way into the room's schedule */}
        <div className="mt-3 flex items-center gap-2 text-sm min-w-0">
          {next && (
            <span className="inline-flex items-center gap-1.5 min-w-0 text-[#64748B]">
              <Hourglass className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate">
                Next: <span className="font-semibold text-[#0B2A5B]">{next.subject_code}</span>
                {next.block ? ` · ${next.block}` : ''} at <span className="font-semibold text-[#0B2A5B]">{fmt12(next.start)}</span>
              </span>
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-0.5 font-semibold text-[#1D5BD6] whitespace-nowrap">
            View schedule <ChevronRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </span>
        </div>
      </div>
    </motion.div>
  );
}

/* ─── One room's schedule (opened from a card) ──────────────────────────── */

const classes = (n: number) => `${n} ${n === 1 ? 'class' : 'classes'}`;
const SECTION_LABEL = 'text-xs font-bold uppercase tracking-wide text-[#475569]';

/** A class in the room and every day it meets at that time */
type WeeklyClass = RoomClass & { id: string; days: WeekDay[] };
/** Same class on any day: subject part, block, faculty and time */
const classId = (c: Pick<UtilRow, 'start' | 'end' | 'subject_code' | 'component' | 'block' | 'faculty_id'>) =>
  [c.start, c.end, c.subject_code, c.component, c.block, c.faculty_id].join('|');

/** One class: time · subject + Lecture/Lab + block, then instructor · subject name */
function ClassRow({ row, next, index }: {
  row: Pick<UtilRow, 'start' | 'end' | 'subject_code' | 'subject_name' | 'component' | 'block' | 'faculty_name'>;
  next: boolean;
  /** Position in the list — rows slide in one after another */
  index: number;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.li
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE_OUT, delay: reduceMotion ? 0 : 0.04 + Math.min(index, 8) * 0.045 } }}
      whileHover={reduceMotion ? undefined : { borderColor: '#9DB8E8', boxShadow: '0 10px 22px -16px rgba(11,42,91,0.55)' }}
      className="flex gap-3 rounded-xl border bg-white px-3.5 py-2.5"
      style={next ? { borderColor: '#9DB8E8', boxShadow: '0 8px 18px -14px rgba(11,42,91,0.55)' } : { borderColor: '#E3E9F3' }}
    >
      <div className="w-[86px] flex-shrink-0 pr-3 border-r border-[#EEF2F7]">
        <div className="text-[15px] font-bold text-[#0B2A5B] tabular-nums whitespace-nowrap">{fmt12(row.start)}</div>
        <div className="text-xs text-[#64748B] tabular-nums whitespace-nowrap">to {fmt12(row.end)}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-[15px] text-[#0B2A5B]">{row.subject_code}</span>
          {row.component && <PartPill component={row.component} />}
          {row.block && <BlockChip block={row.block} />}
          {next && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: '#0B2A5B', color: '#FFFFFF' }}>
              <span className="relative flex w-1.5 h-1.5" aria-hidden>
                {!reduceMotion && <span className="absolute inset-0 rounded-full animate-ping" style={{ backgroundColor: 'rgba(255,255,255,0.7)' }} />}
                <span className="relative w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#FFFFFF' }} />
              </span>
              Next
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-sm min-w-0" title={row.subject_name ?? undefined}>
          <User className="w-3.5 h-3.5 flex-shrink-0 text-[#1D5BD6]" />
          <span className="font-semibold text-[#334155] truncate flex-shrink-0 max-w-[65%]">{row.faculty_name ?? 'No instructor'}</span>
          {row.subject_name && <span className="text-[#64748B] truncate min-w-0">· {row.subject_name}</span>}
        </div>
      </div>
    </motion.li>
  );
}

/** Switching days slides the list the way of the button pressed */
const daySlide = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 24 }),
  center: { opacity: 1, x: 0, transition: { duration: 0.25, ease: EASE_OUT } },
  exit: (dir: number) => ({ opacity: 0, x: dir * -24, transition: { duration: 0.15, ease: EASE_OUT } }),
};

function RoomScheduleModal({ info, onClose }: { info: RoomNow; onClose: () => void }) {
  const reduceMotion = useReducedMotion();
  const { room } = info;
  const lab = isLabRoom(room.room_type);
  // Today's remaining classes and the week ahead — kept live like the board
  const { data, error } = useUtilization('', 'upcoming', room.id, 30_000);
  const [who, setWho] = useState('all');

  /* Every class the room has in a week. The 8 days loaded cover each weekday
     at least once — kept once each. Used for printing and the combinations. */
  const toast = useToast();
  const [printing, setPrinting] = useState(false);
  const weekly = useMemo(() => {
    const out = new Map<string, RoomClass>();
    for (const r of data?.activity ?? []) {
      if (!r.subject_code || !r.start || !r.end) continue; // walk-ins
      const key = [r.day, r.start, r.end, r.subject_code, r.component, r.block, r.faculty_id].join('|');
      if (!out.has(key)) {
        out.set(key, {
          day: r.day, start: r.start, end: r.end, subject_code: r.subject_code, subject_name: r.subject_name,
          component: r.component, block: r.block, faculty_id: r.faculty_id, faculty_name: r.faculty_name,
        });
      }
    }
    return [...out.values()];
  }, [data]);

  /* The room's classes, each once with the set of days it meets (Mon + Thu at
     1–2 PM → one "Mon / Thu" class) — the same day combinations as Scheduling */
  const classList = useMemo(() => {
    const byId = new Map<string, WeeklyClass>();
    for (const c of weekly) {
      const id = classId(c);
      const item = byId.get(id) ?? { ...c, id, days: [] };
      const day = parseDays(c.day)?.[0];
      if (day && !item.days.includes(day)) item.days.push(day);
      byId.set(id, item);
    }
    return [...byId.values()].filter(c => c.days.length > 0).map(c => ({ ...c, days: sortDays(c.days) }));
  }, [weekly]);

  const faculty = useMemo(() => {
    const byFaculty = new Map<string, { key: string; name: string; count: number }>();
    for (const c of classList) {
      const key = String(c.faculty_id ?? 'none');
      const f = byFaculty.get(key) ?? { key, name: c.faculty_name ?? 'No instructor', count: 0 };
      f.count++;
      byFaculty.set(key, f);
    }
    return [...byFaculty.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [classList]);
  // A pick that left the list (the schedule changed) falls back to everyone
  const pick = faculty.some(f => f.key === who) ? who : 'all';

  /** One tab per day combination (week order: Mon / Thu, Tue / Fri, Wed…), classes in time order */
  const combos = useMemo(() => {
    const groups = new Map<string, { key: string; days: WeekDay[]; rows: WeeklyClass[] }>();
    for (const c of classList) {
      if (pick !== 'all' && String(c.faculty_id ?? 'none') !== pick) continue;
      const key = daysKey(c.days);
      const g = groups.get(key) ?? { key, days: c.days, rows: [] };
      g.rows.push(c);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      g.rows.sort((a, b) => a.start.localeCompare(b.start) || a.subject_code.localeCompare(b.subject_code, undefined, { numeric: true }));
    }
    const idx = (d: WeekDay) => WEEK_DAYS.indexOf(d);
    return [...groups.values()].sort((a, b) =>
      idx(a.days[0]) - idx(b.days[0]) || b.days.length - a.days.length || a.key.localeCompare(b.key));
  }, [classList, pick]);
  const classTotal = combos.reduce((n, g) => n + g.rows.length, 0);

  // The very next class (for the faculty picked) gets the "Next" tag
  const nextRow = (data?.activity ?? []).find(r =>
    r.status === 'Upcoming' && r.subject_code && r.start && r.end
    && (pick === 'all' || String(r.faculty_id ?? 'none') === pick));
  const nextId = nextRow ? classId(nextRow) : null;
  const todayName = data ? WEEK_DAYS[(new Date(`${data.today}T00:00:00Z`).getUTCDay() + 6) % 7] : null;
  const print = async () => {
    if (!data || printing) return;
    setPrinting(true);
    try {
      const result = await printRoomSchedule({
        roomName: displayRoomName(room.room_name),
        classes: weekly,
        term: data.term,
      });
      if (!result.ok) toast.error('Could not open the print window. Allow pop-ups for this site, then try again.');
    } finally {
      setPrinting(false);
    }
  };
  /* One combination at a time — opens on the one with the next class (else
     today's); one that left the list (other faculty picked, schedule changed)
     falls back the same way */
  const [comboView, setComboView] = useState<{ key: string | null; dir: number }>({ key: null, dir: 1 });
  const current = combos.find(g => g.key === comboView.key)
    ?? combos.find(g => g.rows.some(r => r.id === nextId))
    ?? combos.find(g => todayName != null && g.days.includes(todayName))
    ?? combos[0] ?? null;
  const pickCombo = (key: string) => {
    const from = combos.findIndex(g => g.key === current?.key);
    setComboView({ key, dir: combos.findIndex(g => g.key === key) >= from ? 1 : -1 });
  };
  /** Next (+1) / previous (−1) combination — swipes and ← → keys; returns its position */
  const stepCombo = (delta: number) => {
    const to = combos.findIndex(g => g.key === current?.key) + delta;
    if (to < 0 || to >= combos.length) return -1;
    pickCombo(combos[to].key);
    return to;
  };
  /* Phones: swipe the list left / right to change combination (touch only —
     a mouse drag would fight with selecting text) */
  const swipe = useDragControls();
  const onTabKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const list = e.currentTarget;
    const to = stepCombo(e.key === 'ArrowRight' ? 1 : -1);
    if (to >= 0) requestAnimationFrame(() => list.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus());
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={displayRoomName(room.room_name)}
      subtitle={[lab ? 'Laboratory' : 'Lecture room', room.building, room.capacity ? `${room.capacity} seats` : ''].filter(Boolean).join(' · ')}
      icon={lab ? Monitor : BookOpen}
      size="lg"
      footer={
        <div className="flex items-center justify-end gap-3">
          <motion.button
            type="button"
            onClick={print}
            disabled={!data || printing}
            whileTap={reduceMotion || !data || printing ? undefined : { scale: 0.97 }}
            className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl text-sm font-bold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{ color: '#FFFFFF' }}
          >
            {printing
              ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#FFFFFF' }} />
              : <Printer className="w-4 h-4" style={{ color: '#FFFFFF' }} />}
            {printing ? 'Preparing…' : 'Print schedule'}
          </motion.button>
        </div>
      }
    >
      <div className="space-y-6">
        <section>
          <h3 className={`${SECTION_LABEL} mb-2`}>Right now</h3>
          <NowPanel info={info} />
        </section>

        <section>
          <div className="mb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <h3 className={SECTION_LABEL}>Class schedule{data ? ` · ${classes(classTotal)}` : ''}</h3>
            {faculty.length > 1 && (
              <div className="w-full sm:w-72">
                <FriendlySelect
                  value={pick}
                  onChange={setWho}
                  label="Faculty"
                  searchable={faculty.length > 8}
                  searchPlaceholder="Type a name…"
                  options={[
                    { value: 'all', label: 'All faculty', badge: classes(classList.length), badgeTone: 'muted' },
                    ...faculty.map(f => ({ value: f.key, label: f.name, badge: classes(f.count), badgeTone: 'blue' as const })),
                  ]}
                />
              </div>
            )}
          </div>

          {!data ? (
            error ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
            ) : (
              <div className="space-y-2" role="status" aria-label="Loading schedule">
                {[0, 1, 2].map(i => <Skeleton key={i} className="h-[76px] rounded-xl" />)}
              </div>
            )
          ) : !current ? (
            <div className="rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-10 text-center text-sm font-semibold text-[#64748B]">
              No classes are scheduled in this room.
            </div>
          ) : (
            <>
              {/* Day-combination buttons — each in its timetable colour (Mon+Thu, Tue+Fri, Wed, Sat); ← → move between them */}
              <div onKeyDown={onTabKeys}>
                <CountFilterTabs
                  className="mb-4"
                  label="Choose a day combination"
                  layoutId={`room-schedule-combo-${room.id}`}
                  value={current.key}
                  onChange={pickCombo}
                  options={combos.map(g => ({
                    key: g.key,
                    label: daysLabel(g.days),
                    count: g.rows.length,
                    color: dayTone(g.days[0]).bar,
                    dot: dayTone(g.days[0]).bar,
                  }))}
                />
              </div>

              {/* The list glides to its new height instead of jumping */}
              <AutoHeight className="overflow-hidden">
                <motion.div
                  drag={combos.length > 1 ? 'x' : false}
                  dragControls={swipe}
                  dragListener={false}
                  dragConstraints={{ left: 0, right: 0 }}
                  dragElastic={0.18}
                  dragDirectionLock
                  onPointerDown={e => { if (e.pointerType !== 'mouse' && combos.length > 1) swipe.start(e); }}
                  onDragEnd={(_, d) => {
                    if (d.offset.x < -60 || d.velocity.x < -450) stepCombo(1);
                    else if (d.offset.x > 60 || d.velocity.x > 450) stepCombo(-1);
                  }}
                  className="pb-1"
                  style={{ touchAction: 'pan-y' }}
                >
                  <AnimatePresence mode="wait" initial={false} custom={comboView.dir}>
                    <motion.div
                      key={`${pick}-${current.key}`}
                      custom={comboView.dir}
                      variants={reduceMotion ? undefined : daySlide}
                      initial="enter"
                      animate="center"
                      exit="exit"
                    >
                      <div className="mb-2 flex items-center gap-2.5">
                        <span className="w-1.5 h-6 rounded-full flex-shrink-0" style={{ backgroundColor: dayTone(current.days[0]).bar }} />
                        <span className="text-[15px] font-bold text-[#0B2A5B]">{current.days.join(' & ')}</span>
                        {todayName && current.days.includes(todayName) && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-[#EFF6FF] text-[#1D5BD6]">Today</span>
                        )}
                      </div>
                      <ul className="space-y-2">
                        {current.rows.map((r, i) => <ClassRow key={r.id} row={r} next={r.id === nextId} index={i} />)}
                      </ul>
                    </motion.div>
                  </AnimatePresence>
                </motion.div>
              </AutoHeight>
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────── */

/** No separate No check-in filter — those rooms show first under All, with a written warning above. */
type Filter = 'all' | Exclude<LiveStatus, 'No check-in'>;

export default function RoomMonitoringClient() {
  const { data, error, reload } = useUtilization('', 'daily', undefined, 30_000);
  /* First load and the Refresh button: the live strip, status tabs and room grid
     switch from skeleton to content together (the 30-second live updates keep the
     current data on screen). */
  const { refreshing, refresh } = useSkeletonRefresh(reload);
  const showSkeleton = useMinLoading((!data && !error) || refreshing, LOADING_DELAY);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  /** Room whose schedule is open */
  const [openId, setOpenId] = useState<number | null>(null);

  const rooms = useMemo(() => {
    if (!data) return [] as RoomNow[];
    const nowMin = toMin(data.now);
    return data.rooms.map(r => roomNow(r, data.activity, nowMin));
  }, [data]);
  // Follows the live board; closes if the room is no longer active
  const openRoom = openId == null ? null : rooms.find(r => r.room.id === openId) ?? null;

  const searched = rooms.filter(r => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [r.room.room_name, displayRoomName(r.room.room_name), r.room.room_type, r.room.building, r.current?.subject_code, r.current?.faculty_name, r.current?.block]
      .some(v => (v ?? '').toLowerCase().includes(q));
  });
  const count = (s: LiveStatus) => searched.filter(r => r.status === s).length;
  // Problems first, then in use, then free; by name within each
  const ORDER: Record<LiveStatus, number> = { 'No check-in': 0, Waiting: 1, 'In use': 2, Free: 3 };
  const shown = searched
    .filter(r => filter === 'all' || r.status === filter)
    .sort((a, b) => ORDER[a.status] - ORDER[b.status]
      || a.room.room_name.localeCompare(b.room.room_name, undefined, { numeric: true }));

  const noCheckIn = count('No check-in');

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <div className="mb-2 flex items-center justify-between gap-4">
        <BackButton />
        <RefreshButton overlay={false} onRefresh={refresh} loading={refreshing || showSkeleton} />
      </div>
      <div className="mt-4 sm:mt-7 mb-8">
        <WatermarkTitle>Room Monitoring</WatermarkTitle>
      </div>

      {/* Live strip */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E2E8F0] bg-white px-5 py-3.5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="relative flex w-3 h-3">
            <span className="absolute inline-flex w-full h-full rounded-full bg-[#1D5BD6] opacity-50 animate-ping" />
            <span className="relative inline-flex w-3 h-3 rounded-full bg-[#1D5BD6]" />
          </span>
          {showSkeleton ? (
            <div className="space-y-1.5" aria-hidden>
              <Skeleton className="h-5 w-32 rounded" />
              <Skeleton className="h-3 w-56 rounded" />
            </div>
          ) : (
            <div>
              <div className="text-base font-bold text-[#0B2A5B]">
                Live — {data ? fmt12(data.now) : '—'}
              </div>
              <div className="text-xs text-[#64748B]">
                {data?.term.semester ? `${data.term.semester} · A.Y. ${data.term.school_year} · ` : ''}Updates every 30 seconds
              </div>
            </div>
          )}
        </div>
        <div className="w-full sm:w-72">
          <SearchInput value={search} onChange={setSearch} placeholder="Search room, subject, faculty…" />
        </div>
      </div>

      {/* Written warning, not only colour */}
      <AnimatePresence initial={false}>
        {!showSkeleton && noCheckIn > 0 && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mb-5 flex items-start gap-3 rounded-xl border-2 border-red-300 border-l-[6px] border-l-red-600 bg-red-50 px-4 py-3">
              <AlertTriangle className="w-5 h-5 flex-shrink-0 text-red-600 mt-0.5" />
              <p className="text-sm text-red-800">
                <strong>{noCheckIn} room{noCheckIn !== 1 ? 's have' : ' has'} a class in progress with no check-in.</strong>{' '}
                The instructor has not scanned the room QR code — they may be absent or in a different room.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Counts come from the same data — placeholder until it arrives, not 0 */}
      {showSkeleton ? (
        <PillsSkeleton count={4} className="mb-5" />
      ) : (
        <CountFilterTabs
          className="mb-5"
          label="Filter rooms by status"
          layoutId="room-monitoring-filter"
          value={filter}
          onChange={setFilter}
          options={[
            { key: 'all', label: 'All rooms', count: searched.length, color: '#0B2A5B' },
            { key: 'In use', label: 'In use', count: count('In use'), color: '#0B2A5B', dot: '#0B2A5B' },
            { key: 'Free', label: 'Available', count: count('Free'), color: '#1E4FB8', dot: LIVE_TONE.Free.bar },
            { key: 'Waiting', label: 'Waiting', count: count('Waiting'), color: LIVE_TONE.Waiting.bar, dot: LIVE_TONE.Waiting.bar },
          ]}
        />
      )}

      {error && (
        <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {showSkeleton ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" role="status" aria-label="Loading rooms">
          {Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} className="min-h-[220px]" />)}
        </div>
      ) : !data ? (
        // Load failed — the error above explains it; no misleading "No rooms yet"
        null
      ) : shown.length === 0 ? (
        <div className="rounded-2xl border border-[#E2E8F0] bg-white px-6 py-14 text-center text-sm font-semibold text-[#64748B]">
          {rooms.length === 0 ? 'No rooms yet — add them in Room Management.' : 'No rooms match this filter.'}
        </div>
      ) : (
        <motion.div layout className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          <AnimatePresence mode="popLayout" initial={false}>
            {shown.map((info, i) => <RoomCard key={info.room.id} info={info} index={i} onOpen={() => setOpenId(info.room.id)} />)}
          </AnimatePresence>
        </motion.div>
      )}

      {openRoom && <RoomScheduleModal key={openRoom.room.id} info={openRoom} onClose={() => setOpenId(null)} />}
    </div>
  );
}
