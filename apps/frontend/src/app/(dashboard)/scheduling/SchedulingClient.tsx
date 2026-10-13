'use client';

import { Fragment, useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'framer-motion';
import { useToast } from '@/context/ToastContext';
import BackButton from '@/components/ui/BackButton';
import { backTarget } from '@/lib/navTrail';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import TrashDropAnimation from '@/components/ui/TrashDropAnimation';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useRealtime } from '@/context/RealtimeContext';
import {
  ChevronRight, BookOpen, Monitor, Pencil,
  AlertTriangle, CheckCircle, Clock, Trash2, X,
  RefreshCw, Save, Search,
  ChevronLeft, XCircle, Loader2, AlertCircle,
  CalendarDays, Eye, ArrowRight, DoorOpen,
} from 'lucide-react';
import { ListSkeleton, TableSkeleton, Skeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { EmploymentBadge } from '@/components/ui/EmploymentBadge';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { useScrollLock } from '@/hooks/useScrollLock';
import TimeSlotPicker from '@/components/ui/TimeSlotPicker';
import CountFilterTabs from '@/components/ui/CountFilterTabs';
import Pagination from '@/components/ui/Pagination';
import { SearchInput } from '@/components/ui/SearchFilter';
import RoomPicker from '@/components/ui/RoomPicker';
import DayPicker from '@/components/ui/DayPicker';
import { TT_DAY_TONES, TT_TONE_MTH, TT_TONE_OVERLOAD, TT_TONE_SAT, TT_TONE_TF, TT_TONE_W, type DayTone } from '@/lib/dayTones';
import { useDayCombinations } from '@/lib/dayCombinations';
import { daysCode, daysLabel, matchCombination, type WeekDay } from '@shared/dayCombination';
import { blockCode, programBlockCode } from '@shared/blockCode';
import { LOAD_GRACE_UNITS, formatLoadCap, isRegularLoadComplete } from '@shared/regularLoad';
import { movedParts } from '@shared/loadSplit';
import { LUNCH_END_MIN, LUNCH_LABEL, LUNCH_START_MIN, SCHOOL_DAY_END_MIN, SCHOOL_DAY_LABEL, SCHOOL_DAY_START_MIN } from '@shared/schoolDay';
import { PATHFIT_VENUE_RULE, isPathfitSubject, isPathfitVenue } from '@shared/pathfitVenue';
import { asSessionList, fmt12, normTime, parseDays } from '@/lib/scheduleTime';
import SubjectFacultyPreview from '@/components/SubjectFacultyPreview';

/* ─── types ─────────────────────────────────────────────────── */
interface Faculty {
  id: number; name: string; employee_id: string;
  position: string; employment_status: string;
  program_code: string; program_name: string;
  remaining_regular_load: number;
  /** Assigned classes this term that still have no time slot */
  unscheduled_count?: number;
  specialization?: string | null;
}
interface PraiseRecord {
  id: number;
  praise_type?: string; description?: string; equivalent_units?: number | string;
  /** legacy field names */
  task_type?: string; units?: number | string;
}
interface WorkloadSession {
  id: number;
  day: string;
  start_time: string;
  end_time: string;
  type: 'lec' | 'lab' | string;
  room_id?: number | null;
  room_name?: string | null;
  session_hours?: number | string | null;
}
interface WorkloadLoad {
  id: number; ms_id: number; load_category: 'Regular' | 'Overload' | 'Praise';
  subject_code: string; subject_name: string;
  curriculum_units: number; curriculum_total_hours: number;
  lecture_hours: number; laboratory_hours: number;
  block_id?: number; block_name: string; year_level: string;
  block_semester: string; block_academic_year: string;
  program_code: string; schedule_status: string;
  day_pattern: string | null; start_time: string | null; end_time: string | null;
  room_name: string | null; room_type: string | null; status: string;
  overload_component?: 'lec' | 'lab' | 'full' | null;
  /** The split-off Lec/Lab portion is Praise Load, not Overload. */
  split_is_praise?: boolean;
  split_overload_units?: number | null;
  split_overload_hours?: number | null;
  /** The Lecture's share of the moved part (overloads.lec_part) — see @shared/loadSplit */
  split_lec_part?: number | string | null;
  units?: number | null;
  hours?: number | null;
  lec_scheduled?: boolean;
  lab_scheduled?: boolean;
  lec_start_time?: string | null; lec_end_time?: string | null;
  lab_start_time?: string | null; lab_end_time?: string | null;
  lec_day_pattern?: string | null; lab_day_pattern?: string | null;
  /** All schedule_sessions for this subject (full multi-session truth). */
  sessions?: WorkloadSession[] | null;
  /** Major subject with a Lecture and a Laboratory — both parts use one (laboratory) room */
  one_room?: boolean;
}
interface WorkloadSummary {
  faculty: Faculty & { designation_type: string; designation_units: number };
  loads: WorkloadLoad[];
  praise: PraiseRecord[];
  summary: {
    current_regular_load: number; regular_load_limit: number;
    total_overload_units: number;
  };
}
interface Room { id: number; room_name: string; room_type: string; capacity: number; }
interface SessionItem {
  id: string; day: string; start_time: string; hours: number;
  end_time: string; type: 'lec' | 'lab'; room_id: string;
  units: number;
}
interface ConflictInfo {
  sessionId: string;
  /** 'time' — outside the school day (an older class saved past 6 PM or over lunch); the save refuses it */
  type: 'instructor' | 'room' | 'block' | 'duplicate' | 'time';
  message: string;
  /**
   * Stable identity for counting unique conflicts.
   * Multiple detail messages may share one key (e.g. frontend + backend
   * describing the same new-session ↔ existing-session overlap).
   */
  conflictKey: string;
}

/** Build a stable key: type + new session + existing session + day + window. */
function makeConflictKey(
  type: ConflictInfo['type'],
  newSessionId: string,
  existingSessionId: string | number,
  day: string,
  existingStart: string,
  existingEnd: string,
): string {
  return [
    type,
    newSessionId,
    `ss:${existingSessionId}`,
    day,
    normTime(existingStart),
    normTime(existingEnd),
  ].join('|');
}

interface LoadRow {
  key: string;
  load: WorkloadLoad;
  component: 'lec' | 'lab';
  componentHours: number;
  componentUnits: number;
  displayHours: number;
  displayUnits: number;
  label: 'Lec' | 'Lab';
  isOverloadComponent: boolean;
  /** Praise Load subject, or the Lec/Lab portion moved to Praise */
  isPraiseComponent?: boolean;
  isScheduled: boolean;
  isSplitPortion: boolean;
  splitLabel?: 'Regular' | 'Overload' | 'Praise';
}

type AppView = 'faculty' | 'schedule';

/* ─── constants ─────────────────────────────────────────────── */
const WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT: Record<string, string> = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed',
  Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
};
function currentAcademicYear(): string {
  const now = new Date();
  const y   = now.getFullYear();
  const start = now.getMonth() >= 7 ? y : y - 1;
  return `${start}-${start + 1}`;
}

const LAB_ROOM_TYPES = ['Laboratory', 'Computer Lab'];

/**
 * The room the class's other part (its Lecture or Laboratory) already uses,
 * when this part may use it too — a Lec + Lab subject keeps one room. A
 * Laboratory needs a lab room; the Lecture of a Lec + Lab subject may use any.
 */
function pairedRoom(load: WorkloadLoad, part: 'lec' | 'lab', rooms: Room[]): Room | null {
  const sibling = asSessionList<WorkloadSession>(load.sessions)
    .find(s => (s.type === 'lab' ? 'lab' : 'lec') !== part && s.room_id != null);
  const room = sibling ? rooms.find(r => r.id === Number(sibling.room_id)) : undefined;
  if (!room || (part === 'lab' && !LAB_ROOM_TYPES.includes(room.room_type))) return null;
  return room;
}

/** Room names a part's sessions use, in order ('' sessions have no room) */
const roomNamesOf = (names: (string | null | undefined)[]) => [...new Set(names.filter((n): n is string => !!n))];

const TIME_SLOTS = Array.from({ length: 29 }, (_, i) => {
  const totalMin = 7 * 60 + i * 30;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
});

/* ─── helpers ───────────────────────────────────────────────── */
function addMinutes(t: string, mins: number): string {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
function fmtHrs(n: number): string {
  const h = Math.floor(n); const m = Math.round((n - h) * 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr${h !== 1 ? 's' : ''}`;
  return `${h} hr ${m} min`;
}
function uid(): string { return Math.random().toString(36).slice(2); }
function timeToMinutes(t: string): number {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}
function getComponentUnits(component: 'lec' | 'lab', hours: number): number {
  if (component === 'lec') return hours;
  if (component === 'lab') return (hours / 3) * 2.25;
  return 0;
}

/** Shared weekly grid — reused inside the timetable modal (not a second scheduling engine). */
interface TimetableBlockView {
  load: WorkloadLoad;
  label: 'Lec' | 'Lab';
  blockKey: string;
  start_time: string;
  end_time: string;
  day: string;
  room_name: string | null;
}

/** Academic day: 7:00 AM – 6:00 PM (faculty are out by 6 PM) — the shared school day.
 *  Classes must end by DAY_END_MIN; the timetable only stretches past 6 PM if an
 *  older class saved before this rule still runs later. */
const DAY_END_MIN  = SCHOOL_DAY_END_MIN;   // 6:00 PM — latest end time for a session
/** Lunch break for all faculty (12:00–1:00 PM) — no class may overlap it. */
const LUNCH = { start: LUNCH_START_MIN, end: LUNCH_END_MIN, label: `Lunch break · ${LUNCH_LABEL}`, kind: 'Lunch' as const };

/** Why a time is taken — shown on struck-out times, e.g. "Instructor + Room conflict". */
type BusyKind = 'Instructor' | 'Block' | 'Room' | 'Lunch';
interface BusyRange { start: number; end: number; label: string; kind: BusyKind }
const BUSY_KIND_ORDER: BusyKind[] = ['Instructor', 'Block', 'Room', 'Lunch'];
const TT_START_MIN = SCHOOL_DAY_START_MIN;    // 7:00 AM
const TT_END_MIN   = DAY_END_MIN;
/** Taller hours so class cards have room for readable text (1 hr ≈ 78 px). */
const TT_PX_PER_MIN = 1.3;
/** Wide enough for "12:00 PM" / "10:00 AM" on one line with padding. */
const TT_TIME_W = 80;
const TT_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/* Day colours with meaning: days that form one meeting pattern share a colour,
   so an MTh or TF class reads as one set across the week.
   MTh = royal blue · TF = teal · Wed = indigo · Sat = slate (weekend).
   Deliberately not blue/orange/gold/green — those are the load colours. */
const TT_LEGEND: { label: string; tone: DayTone }[] = [
  { label: 'Mon · Thu', tone: TT_TONE_MTH },
  { label: 'Tue · Fri', tone: TT_TONE_TF },
  { label: 'Wed', tone: TT_TONE_W },
  { label: 'Sat', tone: TT_TONE_SAT },
];
/** True when this Lec/Lab of the subject counts as Overload — same rule as the
 *  Overload list (expandLoads): a full Overload subject, or the split-off
 *  portion of a Lec/Lab. Praise Load is not Overload. */
function isOverloadSession(load: WorkloadLoad, component: 'lec' | 'lab'): boolean {
  return expandLoads([load], true).some(r => r.component === component && r.isOverloadComponent);
}
/** Standard meeting pairs, used when a day has no pairing in the schedule yet. */
const DEFAULT_DAY_PARTNER: Record<string, string> = {
  Monday: 'Thursday', Thursday: 'Monday',
  Tuesday: 'Friday', Friday: 'Tuesday',
  Wednesday: 'Saturday', Saturday: 'Wednesday',
};

/**
 * Timetable column order: days that meet together (the same Lec/Lab of a
 * subject on two days, e.g. Mon + Thu) sit side by side. Pairs come from the
 * actual schedule (most shared subjects first); unpaired days fall back to the
 * standard M-Th / T-F / W-Sat pairs. Pairs are ordered by their first weekday.
 */
function arrangeDays(blocks: { load: { ms_id: number }; label: string; day: string }[]): string[] {
  const days = [...TT_DAYS] as string[];
  const byClass = new Map<string, Set<string>>();
  for (const b of blocks) {
    if (!days.includes(b.day)) continue;
    const k = `${b.load.ms_id}-${b.label}`;
    byClass.set(k, (byClass.get(k) ?? new Set()).add(b.day));
  }
  const counts = new Map<string, number>();
  for (const set of byClass.values()) {
    const list = [...set].sort((a, b) => days.indexOf(a) - days.indexOf(b));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = `${list[i]}|${list[j]}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  const used = new Set<string>();
  const pairs: string[][] = [];
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]
    || Number(DEFAULT_DAY_PARTNER[b[0].split('|')[0]] === b[0].split('|')[1])
     - Number(DEFAULT_DAY_PARTNER[a[0].split('|')[0]] === a[0].split('|')[1]));
  for (const [k] of ranked) {
    const [a, b] = k.split('|');
    if (used.has(a) || used.has(b)) continue;
    pairs.push([a, b]); used.add(a); used.add(b);
  }
  for (const d of days) {
    if (used.has(d)) continue;
    const partner = DEFAULT_DAY_PARTNER[d];
    if (partner && !used.has(partner)) {
      pairs.push([d, partner].sort((x, y) => days.indexOf(x) - days.indexOf(y)));
      used.add(d); used.add(partner);
    } else {
      pairs.push([d]); used.add(d);
    }
  }
  return pairs
    .sort((a, b) => days.indexOf(a[0]) - days.indexOf(b[0]))
    .flat();
}

/** Columns, day colours and legend of the timetable */
interface TimetableDayLayout {
  cols: string[];
  toneOf: (day: string) => DayTone;
  legend: { label: string; tone: DayTone }[];
}

/** Tones handed to configured combinations, in order */
const COMBO_TONES: DayTone[] = [TT_TONE_MTH, TT_TONE_TF, TT_TONE_W, TT_TONE_SAT];

/**
 * Timetable layout. With the semester's day combinations (Settings) the days
 * of each combination sit side by side and share a colour, in the configured
 * order — e.g. MW · TTh · F. Days used by a class but by no combination are
 * added after. Without a configuration: the usual M-Th / T-F / W / Sat layout.
 */
function buildDayLayout(
  blocks: { load: { ms_id: number }; label: string; day: string }[],
  combos: readonly { days: readonly string[] }[],
): TimetableDayLayout {
  if (combos.length === 0) {
    return { cols: arrangeDays(blocks), toneOf: d => TT_DAY_TONES[d] ?? TT_TONE_SAT, legend: TT_LEGEND };
  }
  const toneByDay = new Map<string, DayTone>();
  const cols: string[] = [];
  const legend: { label: string; tone: DayTone }[] = [];
  combos.forEach((c, i) => {
    const tone = COMBO_TONES[i % COMBO_TONES.length];
    const fresh = c.days.filter(d => !toneByDay.has(d));
    if (fresh.length === 0) return; // every day already shown under an earlier combination
    for (const d of fresh) { toneByDay.set(d, tone); cols.push(d); }
    legend.push({ label: c.days.map(d => DAY_SHORT[d] ?? d).join(' · '), tone });
  });
  // Classes on days outside every combination (e.g. saved before the setting) stay visible
  const extra = WEEK_DAYS.filter(d => !toneByDay.has(d) && blocks.some(b => b.day === d));
  for (const d of extra) { toneByDay.set(d, TT_TONE_SAT); cols.push(d); }
  return { cols, toneOf: d => toneByDay.get(d) ?? TT_TONE_SAT, legend };
}

function hourMarks(endMin: number) {
  return Array.from({ length: (endMin - TT_START_MIN) / 60 + 1 }, (_, i) => TT_START_MIN + i * 60);
}

/** End minutes that cross midnight (e.g. 21:00→00:00) become 24:00+. */
function sessionEndMinutes(startTime: string, endTime: string): number {
  const start = timeToMinutes(normTime(startTime));
  let end = timeToMinutes(normTime(endTime));
  if (end <= start) end += 24 * 60;
  return end;
}

function WeeklyTimetableGrid({
  blocks,
  layout,
  onDelete,
  onOpen,
}: {
  blocks: TimetableBlockView[];
  /** Columns + colours (buildDayLayout) — shared with the legend above the grid */
  layout: TimetableDayLayout;
  onDelete: (msId: number, subjectCode: string, blockName: string, component: 'lec' | 'lab') => void;
  /** Click a class block → its schedule details */
  onOpen?: (load: WorkloadLoad, component: 'lec' | 'lab') => void;
}) {
  // Ends at 6 PM, unless an older class runs later (then round up to its hour)
  const gridEnd = Math.min(24 * 60, Math.max(
    TT_END_MIN,
    ...blocks.map(b => Math.ceil(sessionEndMinutes(b.start_time, b.end_time) / 60) * 60),
  ));
  const TT_HEIGHT = Math.round((gridEnd - TT_START_MIN) * TT_PX_PER_MIN);
  const TT_HOUR_MARKS = hourMarks(gridEnd);
  // Days that meet together side by side (configured combinations, or M-Th / T-F)
  const dayCols = layout.cols;
  const toneOf = layout.toneOf;
  const N = dayCols.length;
  const minsToY = (mins: number) => Math.round((mins - TT_START_MIN) * TT_PX_PER_MIN);
  const timeCol = `${TT_TIME_W}px`;
  const gridCols = `${timeCol} repeat(${N}, minmax(0, 1fr))`;

  return (
    <div className="overflow-x-auto overflow-y-auto h-full bg-white">
      <div style={{ minWidth: 720 + (TT_TIME_W - 56) }}>
        {/* Day header — sticky while body scrolls */}
        <div
          className="grid border-b border-[#E2E8F0] bg-[#F8FAFC] sticky top-0 z-30"
          style={{ gridTemplateColumns: gridCols }}
        >
          <div
            className="sticky left-0 z-40 px-2 py-2.5 text-[11px] font-semibold text-[#0F172A] tracking-wide text-center border-r border-[#E2E8F0] bg-[#F8FAFC]"
          >
            Time
          </div>
          {dayCols.map(d => {
            const tone = toneOf(d);
            return (
              <div
                key={d}
                className="px-1 py-2 text-center text-xs font-bold border-l border-[#E2E8F0]"
                style={{ color: tone.text, backgroundColor: tone.bg, boxShadow: `inset 0 3px 0 ${tone.bar}` }}
              >
                {DAY_SHORT[d]}
              </div>
            );
          })}
        </div>

        {/* 7:00 AM – 6:00 PM canvas (longer only for older classes that end later) */}
        <div className="relative bg-white" style={{ height: TT_HEIGHT }}>
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ display: 'grid', gridTemplateColumns: gridCols, zIndex: 0 }}
          >
            <div className="sticky left-0 border-r border-[#E2E8F0] bg-[#FAFBFC]" />
            {dayCols.map(d => (
              <div key={d} className="border-l border-[#F1F5F9] h-full" style={{ backgroundColor: toneOf(d).col }} />
            ))}
          </div>

          {TT_HOUR_MARKS.map(mins => {
            const y = minsToY(mins);
            const isEnd = mins === gridEnd;
            const label = fmt12(
              `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`,
            );
            return (
              <div key={mins} className="absolute left-0 right-0 pointer-events-none" style={{ top: y, zIndex: 1 }}>
                {!isEnd && (
                  <div
                    className="absolute right-0 border-t border-[#E2E8F0]"
                    style={{ left: TT_TIME_W }}
                  />
                )}
                {!isEnd && (
                  <div
                    className="absolute right-0 border-t border-[#F1F5F9]"
                    style={{ left: TT_TIME_W, top: Math.round(30 * TT_PX_PER_MIN) }}
                  />
                )}
                <div
                  className="absolute left-0 sticky z-[2] flex items-center justify-center bg-[#FAFBFC] border-r border-[#E2E8F0]"
                  style={{
                    width: TT_TIME_W,
                    height: 20,
                    top: isEnd ? -18 : -10,
                    left: 0,
                  }}
                >
                  <span className="px-1.5 text-[11px] font-semibold tabular-nums whitespace-nowrap text-[#0F172A] select-none leading-none">
                    {label}
                  </span>
                </div>
              </div>
            );
          })}

          {/* Lunch break for all faculty — no classes here */}
          <div
            className="absolute right-0 flex items-center justify-center pointer-events-none"
            style={{
              left: TT_TIME_W,
              top: minsToY(LUNCH.start),
              height: minsToY(LUNCH.end) - minsToY(LUNCH.start),
              zIndex: 2,
              backgroundImage: 'repeating-linear-gradient(135deg, rgba(245,198,107,0.28) 0 6px, rgba(253,243,220,0.55) 6px 12px)',
              borderTop: '1px dashed #F5C66B',
              borderBottom: '1px dashed #F5C66B',
            }}
            aria-label={LUNCH.label}
          >
            <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#B7791F] bg-white/85 px-2.5 py-0.5 rounded-full">
              Lunch break
            </span>
          </div>

          {blocks.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center z-[5] pointer-events-none">
              <p className="text-sm text-[#94A3B8] bg-white/90 px-4 py-2 rounded-lg border border-[#E2E8F0]">
                No scheduled classes yet
              </p>
            </div>
          )}

          {blocks.map((block) => {
            const { load, label, blockKey, start_time: st, end_time: et, day, room_name } = block;
            const colIdx = dayCols.indexOf(day);
            if (colIdx < 0) return null;

            const startMins = timeToMinutes(st);
            const endMins   = sessionEndMinutes(st, et);
            /* Clip to the fixed academic window; still show partial blocks that overlap it. */
            const visibleStart = Math.max(startMins, TT_START_MIN);
            const visibleEnd   = Math.min(endMins, gridEnd);
            if (visibleEnd <= visibleStart) return null;

            const durationMins = visibleEnd - visibleStart;
            const top   = minsToY(visibleStart);
            const cardH = Math.max(34, Math.round(durationMins * TT_PX_PER_MIN) - 2);
            const isLab = label === 'Lab';
            const typeLabel = isLab ? 'Laboratory' : 'Lecture';
            // Lecture or Laboratory — each card also shows its own room, so the meetings need no numbers
            const partLabel = isLab ? 'Lab' : 'Lec';
            const isOverload = isOverloadSession(load, isLab ? 'lab' : 'lec');
            const tone = isOverload ? TT_TONE_OVERLOAD : toneOf(day);
            const roomLabel = room_name ?? 'No room assigned';
            /* The room this meeting is held in — on every card, whatever its size */
            const roomPill = (
              <span
                className={`inline-flex items-center gap-0.5 min-w-0 text-[11px] font-bold px-1.5 rounded border leading-[17px] ${
                  room_name ? 'bg-white text-[#0B2A5B] border-[#CBD5E1]' : 'bg-amber-50 text-amber-700 border-amber-200'
                }`}
              >
                <DoorOpen className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                <span className="truncate">{room_name ?? 'No room'}</span>
              </span>
            );
            const tooltip = [
              `${load.subject_code} — ${load.subject_name}${isOverload ? ' · OVERLOAD' : ''}`,
              `${fmt12(st)} – ${fmt12(et)}`,
              `${typeLabel} · ${programBlockCode(load.program_code, load.year_level, load.block_name)} · ${roomLabel}`,
            ].join('\n');

            return (
              <div
                key={blockKey}
                title={`${tooltip}
Click for details`}
                role={onOpen ? 'button' : undefined}
                tabIndex={onOpen ? 0 : undefined}
                onClick={() => onOpen?.(load, isLab ? 'lab' : 'lec')}
                onKeyDown={e => {
                  if (onOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(load, isLab ? 'lab' : 'lec'); }
                }}
                className={`absolute rounded border group overflow-hidden transition-[transform,box-shadow] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/50 ${
                  onOpen ? 'cursor-pointer hover:-translate-y-px hover:shadow-[0_8px_18px_-10px_rgba(11,42,91,0.45)] active:scale-[0.99]' : 'cursor-default'
                }`}
                style={{
                  top: top + 1,
                  height: cardH,
                  left: `calc(${TT_TIME_W}px + ${colIdx} * ((100% - ${TT_TIME_W}px) / ${N}) + 3px)`,
                  width: `calc((100% - ${TT_TIME_W}px) / ${N} - 6px)`,
                  zIndex: 10,
                  backgroundColor: tone.bg,
                  borderColor: tone.border,
                  borderLeftWidth: 3,
                  borderLeftColor: tone.bar,
                  boxShadow: '0 1px 2px rgba(15, 23, 42, 0.05)',
                }}
              >
                <button
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    onDelete(load.ms_id, load.subject_code, load.block_name, label === 'Lab' ? 'lab' : 'lec');
                  }}
                  title="Delete schedule"
                  className="absolute top-0.5 right-0.5 w-3.5 h-3.5 rounded bg-white hover:bg-red-50 border border-[#E2E8F0] hover:border-red-200 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                  style={{ zIndex: 20 }}
                >
                  <X className="w-2 h-2 text-[#DC2626]" />
                </button>
                {cardH < 100 ? (
                  /* Short class (≈1 hr): code + badges on one line, time underneath — nothing cut off */
                  <div className="px-2 py-1 flex flex-col justify-center gap-1 h-full leading-tight pr-5" style={{ pointerEvents: 'none' }}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[13px] font-bold text-[#0F172A] truncate">{load.subject_code}</span>
                      <span
                        className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wide px-1.5 rounded whitespace-nowrap"
                        style={{ color: tone.text, backgroundColor: '#FFFFFF', border: `1px solid ${tone.border}` }}
                      >
                        {partLabel}
                      </span>
                      {load.block_name && (
                        <span className="flex-shrink-0 text-[11px] font-bold px-1.5 rounded bg-[#1E4FB8] leading-[17px] whitespace-nowrap" style={{ color: '#FFFFFF' }}>
                          {programBlockCode(load.program_code, load.year_level, load.block_name)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[12px] font-semibold tabular-nums text-[#0F172A] whitespace-nowrap">{fmt12(st)} – {fmt12(et)}</span>
                      {roomPill}
                    </div>
                    {cardH >= 76 && (
                      <div className="text-[11px] text-[#475569] truncate">{load.subject_name}</div>
                    )}
                  </div>
                ) : (
                <div className="px-2 py-1.5 flex flex-col gap-0.5 leading-tight pr-5" style={{ pointerEvents: 'none' }}>
                  {/* Code on its own line so it's never cut to "G…" */}
                  <span className="text-[14px] font-bold text-[#0F172A] leading-tight break-words">{load.subject_code}</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wide px-1.5 rounded whitespace-nowrap"
                      style={{ color: tone.text, backgroundColor: '#FFFFFF', border: `1px solid ${tone.border}` }}
                    >
                      {partLabel}
                    </span>
                    {/* Block — same royal-blue badge as the subject cards */}
                    {load.block_name && (
                      <span
                        className="flex-shrink-0 text-[11px] font-bold px-1.5 rounded bg-[#1E4FB8] leading-[17px] whitespace-nowrap"
                        // White set inline — the light-mode rule repaints `text-white` as dark ink
                        style={{ color: '#FFFFFF' }}
                      >
                        {programBlockCode(load.program_code, load.year_level, load.block_name)}
                      </span>
                    )}
                  </div>
                  {/* Descriptive title: two lines when the card is tall enough */}
                  <div className={`text-[12px] text-[#334155] leading-snug ${cardH >= 130 ? 'line-clamp-2' : 'truncate'}`}>
                    {load.subject_name}
                  </div>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[12px] font-semibold tabular-nums text-[#0F172A] whitespace-nowrap">{fmt12(st)} – {fmt12(et)}</span>
                    {roomPill}
                  </div>
                </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function expandLoads(loads: WorkloadLoad[], isPermanent: boolean): LoadRow[] {
  const rows: LoadRow[] = [];
  for (const load of loads) {
    const lecHrs   = toNum(load.lecture_hours);
    const labHrs   = toNum(load.laboratory_hours);
    const totalHrs = toNum(load.curriculum_total_hours) || (lecHrs + labHrs) || 1;
    const hasLec   = lecHrs > 0;
    const hasLab   = labHrs > 0;
    const isFullOverload = load.load_category === 'Overload';
    const oc       = (load.overload_component ?? null) as 'lec' | 'lab' | 'full' | null;
    const hasSplit  = toNum(load.split_overload_units) > 0.001 || toNum(load.split_overload_hours) > 0.001;
    const isLecLab = hasLec && hasLab;
    const isLegacyScheduled = isLecLab
      && load.schedule_status === 'Scheduled'
      && load.lec_scheduled === true
      && load.lab_scheduled === false;
    const lecSched: boolean = isLegacyScheduled
      ? true : isLecLab ? (load.lec_scheduled === true) : load.schedule_status === 'Scheduled';
    const labSched: boolean = isLegacyScheduled
      ? true : isLecLab ? (load.lab_scheduled === true) : load.schedule_status === 'Scheduled';

    if (hasSplit && !isFullOverload && (oc === 'lec' || oc === 'lab')) {
      const splitComp = oc;
      const otherComp = oc === 'lec' ? 'lab' : 'lec';
      const splitHrs  = splitComp === 'lec' ? lecHrs : labHrs;
      const splitCompU = parseFloat(getComponentUnits(splitComp, splitHrs).toFixed(4));
      let regDisplayHrs: number, regDisplayU: number, olDisplayHrs: number, olDisplayU: number;
      if (isPermanent) {
        const ilUnits  = toNum(load.units);
        const otherWU  = otherComp === 'lec' ? lecHrs : labHrs * 0.75;
        regDisplayU    = Math.max(0, ilUnits - otherWU);
        regDisplayHrs  = splitComp === 'lab' ? Math.round(regDisplayU / 0.75) : regDisplayU;
        olDisplayU     = toNum(load.split_overload_units);
        olDisplayHrs   = Math.max(0, splitHrs - regDisplayHrs);
      } else {
        const ilHours  = toNum(load.hours);
        const otherHrs = otherComp === 'lec' ? lecHrs : labHrs;
        regDisplayHrs  = Math.max(0, ilHours - otherHrs);
        regDisplayU    = regDisplayHrs;
        olDisplayHrs   = toNum(load.split_overload_hours);
        olDisplayU     = olDisplayHrs;
      }
      const splitIsScheduled = splitComp === 'lec' ? lecSched : labSched;
      const otherIsScheduled = otherComp === 'lec' ? lecSched : labSched;
      // A split Lec/Lab is ONE class meeting — the split only divides how its
      // units are counted. List it once, under Overload (or Praise), not also
      // under Regular Load.
      const splitIsPraise = Boolean(load.split_is_praise);
      rows.push({ key: `${load.id}-${splitComp}-ol`, load, component: splitComp,
        componentHours: splitHrs, componentUnits: splitCompU,
        displayHours: olDisplayHrs, displayUnits: olDisplayU,
        label: splitComp === 'lec' ? 'Lec' : 'Lab',
        isOverloadComponent: !splitIsPraise, isPraiseComponent: splitIsPraise,
        isScheduled: splitIsScheduled, isSplitPortion: true, splitLabel: splitIsPraise ? 'Praise' : 'Overload' });
      if (otherComp === 'lec' && hasLec) {
        const cu = parseFloat(getComponentUnits('lec', lecHrs).toFixed(4));
        rows.push({ key: `${load.id}-lec`, load, component: 'lec',
          componentHours: lecHrs, componentUnits: cu, displayHours: lecHrs, displayUnits: cu,
          label: 'Lec', isOverloadComponent: false, isScheduled: otherIsScheduled, isSplitPortion: false });
      } else if (otherComp === 'lab' && hasLab) {
        const cu = parseFloat(getComponentUnits('lab', labHrs).toFixed(4));
        rows.push({ key: `${load.id}-lab`, load, component: 'lab',
          componentHours: labHrs, componentUnits: cu, displayHours: labHrs, displayUnits: cu,
          label: 'Lab', isOverloadComponent: false, isScheduled: otherIsScheduled, isSplitPortion: false });
      }
      continue;
    }

    // Some of both parts moved (e.g. the Lecture all Praise + part of the Laboratory)
    const moved = hasSplit && !isFullOverload ? movedParts(load, isPermanent) : { lec: 0, lab: 0 };
    const splitIsPraise   = hasSplit && !isFullOverload && Boolean(load.split_is_praise);
    const splitAffectsLec = moved.lec > 0.001;
    const splitAffectsLab = moved.lab > 0.001;
    const isLecOverload   = isFullOverload || (splitAffectsLec && !splitIsPraise);
    const isLabOverload   = isFullOverload || (splitAffectsLab && !splitIsPraise);
    const isPraiseLoad    = load.load_category === 'Praise';
    const before = rows.length;

    if (hasLec && hasLab) {
      const lecU = parseFloat(getComponentUnits('lec', lecHrs).toFixed(4));
      const labU = parseFloat(getComponentUnits('lab', labHrs).toFixed(4));
      rows.push({ key: `${load.id}-lec`, load, component: 'lec',
        componentHours: lecHrs, componentUnits: lecU, displayHours: lecHrs, displayUnits: lecU,
        label: 'Lec', isOverloadComponent: isLecOverload, isScheduled: lecSched, isSplitPortion: false });
      rows.push({ key: `${load.id}-lab`, load, component: 'lab',
        componentHours: labHrs, componentUnits: labU, displayHours: labHrs, displayUnits: labU,
        label: 'Lab', isOverloadComponent: isLabOverload, isScheduled: labSched, isSplitPortion: false });
    } else if (hasLab) {
      const hrs = labHrs || totalHrs;
      const cu  = parseFloat(getComponentUnits('lab', hrs).toFixed(4));
      rows.push({ key: `${load.id}-lab`, load, component: 'lab',
        componentHours: hrs, componentUnits: cu, displayHours: hrs, displayUnits: cu,
        label: 'Lab', isOverloadComponent: isLabOverload, isScheduled: labSched, isSplitPortion: false });
    } else {
      const hrs = lecHrs || totalHrs;
      const cu  = parseFloat(getComponentUnits('lec', hrs).toFixed(4));
      rows.push({ key: `${load.id}-lec`, load, component: 'lec',
        componentHours: hrs, componentUnits: cu, displayHours: hrs, displayUnits: cu,
        label: 'Lec', isOverloadComponent: isLecOverload, isScheduled: lecSched, isSplitPortion: false });
    }
    if (isPraiseLoad) {
      for (let i = before; i < rows.length; i++) rows[i] = { ...rows[i], isOverloadComponent: false, isPraiseComponent: true };
    } else if (splitIsPraise) {
      for (let i = before; i < rows.length; i++) {
        if (rows[i].component === 'lec' ? splitAffectsLec : splitAffectsLab) rows[i] = { ...rows[i], isPraiseComponent: true };
      }
    }
  }
  return rows;
}

/* ─── mini components ───────────────────────────────────────── */

/* ─── Stepper: Choose Faculty → Set Time & Room ───────────────── */
const SCHEDULING_STEPS = [
  { k: 'instructor', label: 'Choose Faculty' },
  { k: 'schedule', label: 'Set Time & Room' },
] as const;

/** Faculty cards per page in Choose Faculty (same as the other faculty lists) */
const FACULTY_PAGE_SIZE = 10;

function SchedulingStepper({ current, compact }: { current: number; compact?: boolean }) {
  return (
    <div className={`flex items-center max-w-xl mx-auto px-2 ${compact ? 'mb-3' : 'mb-6'}`}>
      {SCHEDULING_STEPS.map((step, i, all) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={step.k} className="flex items-center flex-1 last:flex-none">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`w-8 h-8 rounded-full text-sm font-bold flex items-center justify-center shrink-0 transition-colors ${
                done ? 'bg-[#1D5BD6] text-white'
                  : active ? 'bg-white text-[#1D5BD6] border-2 border-[#1D5BD6]'
                  : 'bg-[#F1F5F9] text-[#94A3B8]'
              }`}>
                {done ? <CheckCircle className="w-4 h-4" /> : i + 1}
              </span>
              <span className={`text-[15px] font-semibold whitespace-nowrap ${
                active ? 'text-[#0B2A5B]' : done ? 'text-[#1D5BD6]' : 'text-[#94A3B8]'
              }`}>
                {step.label}
              </span>
            </div>
            {i < all.length - 1 && (
              <div className="relative h-0.5 flex-1 mx-3 rounded-full overflow-hidden bg-[#E2E8F0]">
                {i < current && <div key={`fill-${i}-${current}`} className="absolute inset-0 rounded-full bg-[#1D5BD6] stepper-fill" />}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ─── FacultyGroup ──────────────────────────────────────────── */
function FacultyGroup({ items, page, pageSize, selectedId, onSelect }: {
  items: Faculty[];
  /** The page shown (from 1) and its size — the order is worked out over everyone first */
  page: number; pageSize: number;
  selectedId?: number | null;
  onSelect: (f: Faculty) => void;
}) {
  if (items.length === 0) return null;
  // Incomplete instructors (regular load not yet filled) go first, lowest
  // remaining units/hrs → highest; complete ones keep their order after them.
  const remaining = (f: Faculty) => Number(f.remaining_regular_load) || 0;
  /** As shown: Permanent units drop the 0.25 grace (18.25 → 18; over stays negative, measured from 18). */
  const remainingShown = (f: Faculty) => {
    const r = remaining(f);
    if (f.employment_status !== 'Permanent') return r;
    return r > -0.001 && r < LOAD_GRACE_UNITS ? 0 : Math.round((r - LOAD_GRACE_UNITS) * 100) / 100;
  };
  /** Workload complete — the shared rule (18 of 18.25 counts for Permanent), as on Faculty Workload */
  const isComplete = (f: Faculty) => isRegularLoadComplete(remaining(f), f.employment_status === 'Permanent');
  const sorted = [...items].sort((a, b) => {
    const aDone = isComplete(a);
    const bDone = isComplete(b);
    if (aDone !== bDone) return aDone ? 1 : -1;
    return aDone ? 0 : remaining(a) - remaining(b);
  });
  return (
    <div className="mb-5">
      <div className="space-y-2">
        {sorted.slice((page - 1) * pageSize, page * pageSize).map(f => {
          const selected = f.id === selectedId;
          const complete = isComplete(f);
          const incomplete = !complete;
          return (
          <div key={f.id}
            className={`w-full text-left border rounded-xl px-4 sm:px-5 py-3.5 transition-all duration-200 shadow-sm ${
              selected
                ? 'bg-white border-[#1D5BD6] ring-1 ring-[#1D5BD6]/30 bg-[#F5FAFF] scale-[1.01]'
                : incomplete
                  // Same red pulse as the pending rows on the Workload page
                  ? 'qr-flag-pulse border-[#FECACA] hover:border-[#F87171]'
                  : 'bg-white border-[#E2E8F0] hover:border-[#1D5BD6]'
            }`}>
            {/* Phones: name and details on top, Complete / Remaining Load + Select on their own row
                (side by side they squeezed the name to "Jehu Ro…" and overlapped the position) */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-[#0B2A5B] text-base break-words sm:truncate min-w-0">{f.name}</span>
                  <EmploymentBadge status={f.employment_status} />
                  {(f.unscheduled_count ?? 0) > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold bg-[#FFF7ED] text-[#C2410C] border border-[#FED7AA]"
                      title="Assigned classes that still need a day and time">
                      <span className="relative flex w-2 h-2">
                        <span className="absolute inline-flex w-full h-full rounded-full bg-[#F97316] opacity-60 animate-ping" />
                        <span className="relative inline-flex w-2 h-2 rounded-full bg-[#EA580C]" />
                      </span>
                      {f.unscheduled_count} to schedule
                    </span>
                  )}
                </div>
                {f.specialization && (
                  <div className="text-sm text-[#1D5BD6] truncate mb-0.5">{f.specialization}</div>
                )}
                <div className="text-sm text-[#64748B]">
                  {[f.employee_id, f.position].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 flex-shrink-0 max-sm:pt-3 max-sm:border-t max-sm:border-[#0B2A5B]/10">
                {/* Complete: a green "Complete"; otherwise what is still needed */}
                {complete ? (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-bold bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0]">
                    <CheckCircle className="w-4 h-4" aria-hidden /> Complete
                  </span>
                ) : (
                  <div className="sm:text-right">
                    <div className="text-sm text-[#64748B]">Remaining Load</div>
                    <div className="text-base font-bold text-[#B91C1C]">
                      {formatLoadCap(remainingShown(f))} {f.employment_status === 'Permanent'
                        ? (remainingShown(f) === 1 ? 'unit' : 'units')
                        : (remainingShown(f) === 1 ? 'hr' : 'hrs')}
                    </div>
                  </div>
                )}
                <button type="button" onClick={() => onSelect(f)} disabled={selected}
                  className={`flex-shrink-0 inline-flex items-center justify-center gap-1.5 min-h-[44px] px-6 sm:min-h-0 sm:px-3.5 py-1.5 rounded-lg text-sm font-semibold border transition-all duration-150 active:scale-95 cursor-pointer disabled:cursor-default ${
                    selected
                      ? 'qr-btn-soft border-transparent'
                      : 'bg-white text-[#1D5BD6] border-[#BFDBFE] hover:bg-[#EFF6FF] hover:border-[#1D5BD6]'
                  }`}>
                  {selected ? <><CheckCircle className="w-4 h-4" /> Selected</> : 'Select'}
                </button>
              </div>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Status tones ──────────────────────────────────────────────
   Colour = meaning, shared with the Workload page's status dots:
   blue = regular load, orange = overload, golden yellow = praise,
   green = scheduled / done. */
type StatusTone = 'blue' | 'orange' | 'gold' | 'green';
const STATUS_TONES: Record<StatusTone, { text: string; head: string; badge: string; border: string }> = {
  blue:   { text: 'text-[#1D5BD6]',   head: 'bg-[#EFF5FF] border-[#BFD3F5] hover:border-[#93B4EA]',       badge: 'bg-[#DCE8FC] text-[#164BB5] border-[#BFD3F5]',        border: 'border-[#BFD3F5]' },
  orange: { text: 'text-orange-600',  head: 'bg-orange-50 border-orange-200 hover:border-orange-300',    badge: 'bg-orange-100 text-orange-700 border-orange-200',    border: 'border-orange-200' },
  gold:   { text: 'text-yellow-700',  head: 'bg-yellow-50 border-yellow-300 hover:border-yellow-400',    badge: 'bg-yellow-100 text-yellow-800 border-yellow-300',    border: 'border-yellow-300' },
  green:  { text: 'text-emerald-700', head: 'bg-emerald-50 border-emerald-200 hover:border-emerald-300', badge: 'bg-emerald-100 text-emerald-700 border-emerald-200', border: 'border-emerald-200' },
};

/* Motion for this page — calm and unhurried (user, 2026-10-12): the editor, the
   list fold and the page slides ease in and out over half a second (SETTLE),
   small things settle with a soft ease-out (GLIDE), exits ease in (LEAVE), and
   buttons give a little press. */
const GLIDE = [0.22, 1, 0.36, 1] as const;
const SETTLE = [0.4, 0, 0.2, 1] as const;
const LEAVE = [0.4, 0, 1, 1] as const;
/** Slow – fast – slow (easeInOutCubic): the list widening / narrowing and the editor leaving */
const FLOW = [0.65, 0, 0.35, 1] as const;
/** How long the subjects take to slide away before Back goes to the faculty list */
const BACK_OUT_MS = 380;

/** Inside the editor: the moment it starts to leave it stops taking clicks (it fades out over
 *  the list, and stays a moment after it is invisible), and takes them again if it comes back */
function ExitClickGuard() {
  const isPresent = useIsPresent();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const panel = ref.current?.closest('aside');
    if (panel) panel.style.pointerEvents = isPresent ? '' : 'none';
  }, [isPresent]);
  return <span ref={ref} hidden />;
}

/** At most this many sessions a week for one part of a class (user rule: 2 on 2026-10-11, 4 since 2026-10-12) */
const MAX_SESSIONS = 4;

/** Section heading in the scheduling form (Meeting days · Sessions per week · Session schedule) */
function StepLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mb-2 text-xs font-bold uppercase tracking-wider text-[#475569] ${className}`}>{children}</div>
  );
}

/* ─── Assigned Subjects: one card per class ─────────────────── */

interface ClassGroup { key: string; load: WorkloadLoad; rows: LoadRow[] }

/** A section's rows as classes (subject + block), Lecture part before Laboratory,
 *  sorted by subject code then block so a subject's blocks sit together. */
function groupByClass(rows: LoadRow[]): ClassGroup[] {
  const byLoad = new Map<number, ClassGroup>();
  for (const r of rows) {
    const g = byLoad.get(r.load.id) ?? { key: `class-${r.load.id}`, load: r.load, rows: [] };
    g.rows.push(r);
    byLoad.set(r.load.id, g);
  }
  const groups = [...byLoad.values()];
  for (const g of groups) g.rows.sort((a, b) => (a.component === b.component ? 0 : a.component === 'lec' ? -1 : 1));
  const opts = { numeric: true, sensitivity: 'base' } as const;
  return groups.sort((a, b) =>
    a.load.subject_code.localeCompare(b.load.subject_code, undefined, opts)
    || blockCode(a.load.year_level, a.load.block_name).localeCompare(blockCode(b.load.year_level, b.load.block_name), undefined, opts)
    || (a.load.program_code ?? '').localeCompare(b.load.program_code ?? '', undefined, opts));
}

/** A part's saved meetings in one or two short lines: "Mon / Thu · 4:00 PM – 5:00 PM" and the room(s) */
function partSchedule(row: LoadRow): { when: string[]; rooms: string[] } | null {
  const own = asSessionList<WorkloadSession>(row.load.sessions)
    .filter(x => (x.type === 'lab' ? 'lab' : 'lec') === row.component && x.day && x.start_time);
  if (own.length === 0) return null;
  const byTime = new Map<string, string[]>();
  for (const x of own) {
    const k = `${normTime(x.start_time)}|${normTime(x.end_time)}`;
    byTime.set(k, [...(byTime.get(k) ?? []), x.day]);
  }
  const when = [...byTime.entries()].map(([k, days]) => {
    const [st, et] = k.split('|');
    const inWeekOrder = [...WEEK_DAYS.filter(d => days.includes(d)), ...days.filter(d => !(WEEK_DAYS as readonly string[]).includes(d))];
    return `${inWeekOrder.map(d => DAY_SHORT[d] ?? d).join(' / ')} · ${fmt12(st)} – ${fmt12(et)}`;
  });
  return { when, rooms: roomNamesOf(own.map(x => x.room_name)) };
}

/** One part of a class (Lecture / Laboratory) inside its class's entry: the part, its schedule and
 *  its one action. A part not scheduled yet opens on a click ("Set schedule"); a scheduled one
 *  only with its Edit button (user rule). Wide list: its three cells join the class grid. */
function PartLine({ row, active, first, onOpen }: { row: LoadRow; active: boolean; first: boolean; onOpen: (row: LoadRow) => void }) {
  const reduceMotion = useReducedMotion();
  // A soft lift on hover and a press on click, in CSS (plain buttons are cheap to create by the dozen)
  const press = 'transition-[transform,background-color,border-color,box-shadow] duration-200 ease-out motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-95';
  const lec = row.component === 'lec';
  const Icon = lec ? BookOpen : Monitor;
  const sched = partSchedule(row);
  const clickable = !row.isScheduled && !active;
  const name = `${row.load.subject_code} ${lec ? 'Lecture' : 'Laboratory'}`;
  return (
    <div
      onClick={clickable ? () => onOpen(row) : undefined}
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 mt-2.5 @2xl:mt-0 @2xl:contents ${
        first ? '' : 'pt-2.5 border-t border-dashed border-[#E2E8F0]'
      } ${clickable ? '[&>*]:cursor-pointer' : ''}`}
    >
      {/* The part and its hours */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-[14px] font-bold whitespace-nowrap ${
          lec ? 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]' : 'bg-amber-50 text-amber-700 border-amber-200'
        }`}>
          <Icon className="w-4 h-4" aria-hidden /> {lec ? 'Lecture' : 'Laboratory'}
          <span className="font-semibold opacity-75 tabular-nums">· {fmtHrs(row.displayHours)}</span>
        </span>
        {row.splitLabel && (
          <span className={`text-[12px] font-bold px-2 py-0.5 rounded-full border ${
            row.splitLabel === 'Overload' ? 'bg-orange-50 text-orange-700 border-orange-200'
              : row.splitLabel === 'Praise' ? 'bg-yellow-50 text-yellow-800 border-yellow-300'
              : 'bg-slate-50 text-slate-500 border-slate-200'
          }`}>{row.splitLabel}</span>
        )}
      </div>
      {/* Its schedule */}
      <div className="col-start-1 @2xl:col-start-auto min-w-0 text-[14px] leading-snug">
        {sched ? (
          <>
            {sched.when.map(w => <div key={w} className="font-semibold text-[#0B2A5B] tabular-nums truncate">{w}</div>)}
            <div className={sched.rooms.length ? 'text-[#475569] truncate' : 'text-[#B45309] font-semibold'}>
              {sched.rooms.length ? sched.rooms.join(', ') : 'No room yet'}
            </div>
          </>
        ) : row.isScheduled ? (
          <span className="font-semibold text-emerald-700">Scheduled</span>
        ) : (
          <span className="font-semibold text-[#B45309]">Not scheduled yet</span>
        )}
      </div>
      {/* The one action */}
      <div className="col-start-2 row-start-1 row-span-2 @2xl:col-start-auto @2xl:row-start-auto @2xl:row-span-1 justify-self-end self-center">
        {active ? (
          <motion.span
            initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: 0.35, ease: GLIDE } }}
            className="inline-flex items-center gap-1 h-9 px-3 rounded-lg bg-[#1D5BD6] text-[14px] font-bold shadow-[0_6px_14px_-8px_rgba(29,91,214,0.9)]"
            style={{ color: '#FFFFFF' }}
          >
            <Pencil className="w-4 h-4" aria-hidden /> Editing
          </motion.span>
        ) : row.isScheduled ? (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onOpen(row); }}
            aria-label={`Edit the schedule of ${name}`}
            title="Change this class's day, time or room"
            className={`inline-flex items-center gap-1 h-9 px-3 rounded-lg border border-[#BFD3F5] bg-white text-[14px] font-bold text-[#1D5BD6] hover:bg-[#EFF5FF] hover:border-[#1D5BD6] hover:shadow-[0_6px_14px_-10px_rgba(29,91,214,0.8)] ${press}`}
          >
            <Pencil className="w-4 h-4" aria-hidden /> Edit
          </button>
        ) : (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onOpen(row); }}
            aria-label={`Set the schedule of ${name}`}
            className={`group/set inline-flex items-center gap-0.5 h-9 px-2 rounded-lg text-[14px] font-bold text-[#1D5BD6] whitespace-nowrap hover:bg-[#EFF5FF] ${press}`}
          >
            Set schedule <ChevronRight className="w-4 h-4 transition-transform duration-300 group-hover/set:translate-x-0.5" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}

/** One class (subject + block) in the list: its subject once, its Lecture / Laboratory parts beside it */
function ClassRow({ group, activeKey, onOpen, onPreview, flashKey = null }: {
  group: ClassGroup; activeKey: string | undefined; onOpen: (row: LoadRow) => void;
  /** Clicking the subject shows everyone teaching it (same as the editor's eye) */
  onPreview: (group: ClassGroup) => void;
  /** The part just closed in the editor — its class glows softly once, so the eye finds it */
  flashKey?: string | null;
}) {
  const load = group.load;
  const hasActive = group.rows.some(r => r.key === activeKey);
  const flash = !!flashKey && group.rows.some(r => r.key === flashKey);
  return (
    <div data-flash={flash || undefined} className={`relative isolate px-4 py-3 border-b border-[#EEF2F7] last:border-0 transition-[background-color,box-shadow] duration-300 hover:bg-[#FAFCFF] @2xl:grid @2xl:grid-cols-[minmax(0,1.5fr)_minmax(11.5rem,1fr)_minmax(0,1.7fr)_7.5rem] @2xl:items-center @2xl:gap-x-4 @2xl:gap-y-3 ${
      hasActive ? 'bg-[#EFF6FF] shadow-[inset_4px_0_0_#1D5BD6]' : ''
    }`}>
      {flash && (
        // Behind the row's text (isolate + -z-10): a soft blue wash and edge mark that fade away
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[#EFF6FF] shadow-[inset_4px_0_0_#1D5BD6]"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 1.6, delay: 1.1, ease: SETTLE }}
        />
      )}
      {/* The subject — once for the class, beside all of its parts; a click shows who teaches it */}
      <button
        type="button"
        onClick={() => onPreview(group)}
        title="See who teaches this subject and when"
        aria-label={`See who teaches ${load.subject_code}`}
        className="group/subj block w-full min-w-0 text-left rounded-lg -mx-2 px-2 py-1 hover:bg-[#F1F6FF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40 transition-colors cursor-pointer"
        style={{ gridRow: `span ${group.rows.length}` }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-base font-bold text-[#0B2A5B] leading-tight truncate group-hover/subj:text-[#1D5BD6] transition-colors">{load.subject_code}</span>
          {load.block_name && (
            <span
              className="flex-shrink-0 text-[13px] font-bold px-2 py-0.5 rounded-md bg-[#1E4FB8] leading-tight"
              // White set inline — the light-mode rule repaints `text-white` as dark ink
              style={{ color: '#FFFFFF' }}
              title={[load.program_code, load.year_level, `Block ${load.block_name}`].filter(Boolean).join(' · ')}
            >
              {blockCode(load.year_level, load.block_name)}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-[14px] text-[#334155] leading-snug truncate" title={load.subject_name}>{load.subject_name}</div>
      </button>
      {group.rows.map((row, i) => (
        <PartLine key={row.key} row={row} first={i === 0} active={row.key === activeKey} onOpen={onOpen} />
      ))}
    </div>
  );
}

/** The folded list while a subject is being edited: each class small — its code and block,
 *  then its parts as chips. The open part is filled in; a part not scheduled yet opens on a
 *  click, a scheduled one through its pencil chip (Edit). */
function CompactClassRow({ group, activeKey, onOpen, onPreview }: {
  group: ClassGroup; activeKey: string | undefined; onOpen: (row: LoadRow) => void; onPreview: (group: ClassGroup) => void;
}) {
  const load = group.load;
  const hasActive = group.rows.some(r => r.key === activeKey);
  return (
    <div
      data-active-class={hasActive || undefined}
      className={`px-3 py-2.5 border-b border-[#EEF2F7] last:border-0 transition-[background-color,box-shadow] duration-300 ${hasActive ? 'bg-[#EFF6FF] shadow-[inset_4px_0_0_#1D5BD6]' : ''}`}
    >
      <button
        type="button"
        onClick={() => onPreview(group)}
        title="See who teaches this subject and when"
        aria-label={`See who teaches ${load.subject_code}`}
        className="group/subj block w-full min-w-0 text-left rounded-md -mx-1 px-1 hover:bg-[#F1F6FF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[15px] font-bold text-[#0B2A5B] leading-tight truncate group-hover/subj:text-[#1D5BD6] transition-colors">{load.subject_code}</span>
          {load.block_name && (
            <span
              className="flex-shrink-0 text-[12px] font-bold px-1.5 py-0.5 rounded-md bg-[#1E4FB8] leading-tight"
              // White set inline — the light-mode rule repaints `text-white` as dark ink
              style={{ color: '#FFFFFF' }}
            >
              {blockCode(load.year_level, load.block_name)}
            </span>
          )}
        </div>
        <div className="text-[13px] text-[#475569] leading-snug truncate" title={load.subject_name}>{load.subject_name}</div>
      </button>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {group.rows.map(row => {
          const lec = row.component === 'lec';
          const Icon = lec ? BookOpen : Monitor;
          const active = row.key === activeKey;
          const name = `${row.load.subject_code} ${lec ? 'Lecture' : 'Laboratory'}`;
          return (
            <button
              key={row.key}
              type="button"
              onClick={() => { if (!active) onOpen(row); }}
              aria-pressed={active}
              aria-label={active ? `${name} — being edited` : `${row.isScheduled ? 'Edit' : 'Set'} the schedule of ${name}`}
              title={active ? 'Being edited' : row.isScheduled ? `Edit the ${lec ? 'Lecture' : 'Laboratory'}` : `Schedule the ${lec ? 'Lecture' : 'Laboratory'}`}
              className={`inline-flex items-center gap-1 h-8 px-2 rounded-lg border text-[13px] font-bold whitespace-nowrap transition-colors ${
                active
                  ? `${lec ? 'bg-[#1D5BD6] border-[#1D5BD6]' : 'bg-amber-500 border-amber-500'} cursor-default`
                  : lec ? 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE] hover:border-[#1D5BD6]' : 'bg-amber-50 text-amber-700 border-amber-200 hover:border-amber-500'
              }`}
              style={active ? { color: '#FFFFFF' } : undefined}
            >
              <Icon className="w-3.5 h-3.5" aria-hidden />
              {lec ? 'Lec' : 'Lab'}
              {/* Scheduled: a pencil (this chip is its Edit); not yet: an amber dot */}
              {!active && (row.isScheduled
                ? <Pencil className="w-3.5 h-3.5 opacity-80" aria-hidden />
                : <span className="w-2 h-2 rounded-full bg-[#F59E0B]" aria-hidden />)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** One load (Regular / Overload / Praise) as a list of rows, always open */
function SubjectSection({ title, tone, rows, activeKey, onOpen, onPreview, flashKey = null, empty, compact = false }: {
  title: string; tone: StatusTone; rows: LoadRow[]; activeKey: string | undefined;
  onOpen: (row: LoadRow) => void; onPreview: (group: ClassGroup) => void; flashKey?: string | null; empty: string;
  /** Folded beside the editor: small entries, no column names */
  compact?: boolean;
}) {
  const t = STATUS_TONES[tone];
  return (
    <section className={`rounded-xl border ${t.border} bg-white overflow-hidden shadow-sm`}>
      <div className={`flex items-center gap-2 ${compact ? 'px-3 py-2' : 'px-4 py-2.5'} border-b ${t.head.split(' ').filter(c => !c.startsWith('hover:')).join(' ')}`}>
        <h3 className={`${compact ? 'text-[13px] tracking-wider' : 'text-[14px] tracking-widest'} font-bold uppercase ${t.text}`}>{title}</h3>
        <span className={`text-[13px] font-bold border rounded-full px-2 py-0.5 tabular-nums ${t.badge}`}>{rows.length}</span>
      </div>
      {/* Column names on a wide list */}
      {rows.length > 0 && !compact && (
        <div className="hidden @2xl:grid grid-cols-[minmax(0,1.5fr)_minmax(11.5rem,1fr)_minmax(0,1.7fr)_7.5rem] gap-x-4 px-4 py-2 bg-[#F8FAFC] border-b border-[#EEF2F7] text-[12px] font-bold uppercase tracking-wider text-[#64748B]">
          <span>Subject</span><span>Part</span><span>Schedule</span><span className="sr-only">Action</span>
        </div>
      )}
      {rows.length === 0
        ? <p className="px-4 py-5 text-[14px] text-[#94A3B8] italic text-center">{empty}</p>
        // One entry per class: Lecture before Laboratory, a subject's blocks together
        : groupByClass(rows).map(g => compact
          ? <CompactClassRow key={g.key} group={g} activeKey={activeKey} onOpen={onOpen} onPreview={onPreview} />
          : <ClassRow key={g.key} group={g} activeKey={activeKey} onOpen={onOpen} onPreview={onPreview} flashKey={flashKey} />)}
    </section>
  );
}

/** One field of a session in the side editor: its name on the left, the control on the right */
function SessionField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-2">
      <span className="text-[12px] font-bold uppercase tracking-wide text-[#64748B]">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MAIN CLIENT
   ═══════════════════════════════════════════════════════════════ */
export default function SchedulingClient() {
  const toast = useToast();
  const { schoolYear: globalYear, semester: globalSemester, loading: syLoading } = useSchoolYear();
  const syInit = useRef(false);

  /* ── Wizard step / instructor / position-filter state lives in the URL,
     not in useState. This is the fix for "Back gets stuck on Select
     Faculty": previously these were plain useState, so there was no
     real browser-history entry per step — the app's Back button had to
     hardcode a destination, and the phone/browser Back button couldn't
     step through the wizard at all. Now every forward transition pushes a
     real history entry (router.push) and every Back button calls
     router.back(), so both Back mechanisms walk the exact same history and
     never conflict. Refreshing or deep-linking to any step also works,
     since the step is reconstructed from the URL, not lost local state. */
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const stepParam = searchParams.get('step');
  const view: AppView = stepParam === 'schedule' ? 'schedule' : 'faculty';
  const selFacultyId = searchParams.get('faculty');
  /** Master Schedule "Schedule" → this class opens directly for its assigned faculty. */
  const fromMsId = Number(searchParams.get('ms')) || null;

  const buildStepUrl = useCallback((next: Record<string, string | undefined>) => {
    const sp = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }, [searchParams, pathname]);

  const [semester, setSemester]     = useState('1st Semester');
  const [schoolYear, setSchoolYear] = useState(currentAcademicYear);
  /** Day combinations of this term — quick picks (Settings → Day Combinations) */
  const { active: dayCombos } = useDayCombinations(semester, schoolYear);
  const [loadSummaries, setLoadSummaries] = useState<Record<number, { remaining_load: number; assigned_count?: number }>>({});
  /** Faculty list: everyone, only those fully scheduled, or those with classes still needing a day/time */
  const [schedFilter, setSchedFilter] = useState<'all' | 'scheduled' | 'unscheduled'>('all');
  const [unscheduledMap, setUnscheduledMap] = useState<Record<number, number>>({});
  const [summariesLoading, setSummariesLoading] = useState(true);
  const [facultyList, setFacultyList]     = useState<Faculty[]>([]);
  const [facultyLoading, setFacultyLoading] = useState(false);
  const selFaculty = useMemo(
    () => (selFacultyId ? facultyList.find(f => String(f.id) === selFacultyId) ?? null : null),
    [facultyList, selFacultyId],
  );
  const [workload, setWorkload]           = useState<WorkloadSummary | null>(null);
  const [selLoad, setSelLoad]             = useState<LoadRow | null>(null);
  /* Assigned Subjects list: the Lecture / Laboratory switch and the search filter every load */
  const [typeFilter, setTypeFilter]       = useState<'all' | 'lec' | 'lab'>('all');
  /** Assigned Subjects search — subject code, title or block */
  const [subjectSearch, setSubjectSearch] = useState('');
  const reduceMotion = useReducedMotion();
  useEffect(() => { setTypeFilter('all'); setSubjectSearch(''); }, [selFacultyId]);
  /* Closing the editor: the class just edited glows once in the list that comes back,
     and is scrolled into sight if it isn't (the list keeps the user's place) */
  const [closedKey, setClosedKey] = useState<string | null>(null);
  const closedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closedTimer.current), []);
  const closeEditor = useCallback((key: string | null) => {
    setClosedKey(key);
    setSelLoad(null);
    window.clearTimeout(closedTimer.current);
    closedTimer.current = window.setTimeout(() => setClosedKey(null), 3200);
  }, []);
  useEffect(() => {
    if (!closedKey || selLoad) return;
    const t = window.setTimeout(() => {
      document.querySelector('[data-flash="true"]')?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    }, 900);
    return () => window.clearTimeout(t);
  }, [closedKey, selLoad, reduceMotion]);
  // The folded list scrolls to the class being edited (after it has folded)
  useEffect(() => {
    if (!selLoad) return;
    const t = window.setTimeout(() => {
      document.querySelector('[data-active-class="true"]')?.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    }, 550);
    return () => window.clearTimeout(t);
  }, [selLoad, reduceMotion]);
  /* Major Lec + Lab (one room): the room picked on one part before it is saved. The class's
     other part opens already in it — and may only use it — so the room is picked once,
     whichever part comes first. Once saved, the saved room does this (lockedRoom). */
  const [roomDraft, setRoomDraft] = useState<{ msId: number; part: 'lec' | 'lab'; roomId: string } | null>(null);
  const roomDraftRef = useRef(roomDraft);
  useEffect(() => { roomDraftRef.current = roomDraft; }, [roomDraft]);
  useEffect(() => { setRoomDraft(null); }, [selFacultyId]);
  /* Eye preview (SubjectFacultyPreview): everyone handling the row's subject */
  const [previewRow, setPreviewRow]       = useState<LoadRow | null>(null);
  /* Timetable click: open the preview straight on this instructor's schedule
     for that subject (the back arrow still lists everyone teaching it). */
  const [previewOpenMs, setPreviewOpenMs] = useState<number | null>(null);
  /** Opened from a class with both parts: show the whole subject (Lecture and Laboratory) */
  const [previewWhole, setPreviewWhole] = useState(false);
  /** A subject in the list: the same preview as the editor's eye, for the whole class */
  function openSubjectPreview(group: ClassGroup) {
    setPreviewOpenMs(null);
    setPreviewWhole(group.rows.length > 1);
    setPreviewRow(group.rows[0]);
  }
  function openTimetableBlock(load: WorkloadLoad, component: 'lec' | 'lab') {
    setPreviewWhole(false);
    setPreviewOpenMs(load.ms_id);
    setPreviewRow({
      key: `tt-${load.id}-${component}`, load, component,
      componentHours: 0, componentUnits: 0, displayHours: 0, displayUnits: 0,
      label: component === 'lab' ? 'Lab' : 'Lec',
      isOverloadComponent: false, isScheduled: true, isSplitPortion: false,
    });
  }
  const closePreview = useCallback(() => { setPreviewRow(null); setPreviewOpenMs(null); setPreviewWhole(false); }, []);
  const [panelSwitching, setPanelSwitching] = useState(false);
  const panelSwitchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rooms, setRooms]                 = useState<Room[]>([]);
  /** Latest rooms for the session builder below — a rooms reload must not rebuild the open form */
  const roomsRef = useRef<Room[]>([]);
  useEffect(() => { roomsRef.current = rooms; }, [rooms]);
  const [facultySearch, setFacultySearch] = useState('');
  /* Choose Faculty shows one page at a time; a new search, filter or term starts at page 1.
     The direction makes the next page come in from the right, the previous from the left. */
  const [facultyPage, setFacultyPage] = useState(1);
  const [facultyPageDir, setFacultyPageDir] = useState<-1 | 0 | 1>(0);
  const facultyListRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setFacultyPage(1); setFacultyPageDir(0); }, [facultySearch, schedFilter, semester, schoolYear]);
  /* Each step (and each faculty's schedule) opens at once behind its own
     skeleton, held for the same time as every other page (LOADING_DELAY) —
     no spinner over the old step. `entering` is true from the very render the
     step changes, so the new step never flashes before its skeleton. */
  const stepKey = view === 'schedule' ? `schedule:${selFacultyId ?? ''}` : 'faculty';
  const [settledStep, setSettledStep] = useState<string | null>(null);
  const entering = settledStep !== stepKey;
  useEffect(() => {
    if (settledStep === stepKey) return;
    const t = window.setTimeout(() => setSettledStep(stepKey), 0);
    return () => window.clearTimeout(t);
  }, [stepKey, settledStep]);
  const stepSkeleton = useMinLoading(entering, LOADING_DELAY) || entering;
  const [fetchingW, setFetchingW]         = useState(false);

  /* Shared by every wizard Back control. On the click the arrow turns into a
     spinning ring and the subjects into their skeleton (painted first), then it
     goes back; the step it lands on shows its own skeleton for the usual time.
     A new step ends it by itself; a timer frees it if nothing happened. */
  const [leavingStep, setLeavingStep] = useState<string | null>(null);
  const leaving = leavingStep === stepKey;
  const leaveTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  // Once another step is on screen the leave is over. Left to the timer, coming straight back
  // to the same faculty (Select again, or Forward) found it still leaving — hidden for seconds
  useEffect(() => {
    if (leavingStep === null || leavingStep === stepKey) return;
    window.clearTimeout(leaveTimer.current);
    setLeavingStep(null);
  }, [leavingStep, stepKey]);
  const goBack = useCallback(() => {
    if (leaving) return;
    setLeavingStep(stepKey);
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setLeavingStep(null), 10_000);
    // The subjects slide away first (the arrow spins meanwhile), then the page goes back
    window.setTimeout(() => {
      if (backTarget() === 'back') router.back();
      // Opened fresh (e.g. a link in a new tab) — no earlier page here: Master Schedule or the faculty list
      else router.replace(fromMsId ? '/master-schedule' : buildStepUrl({ step: undefined, faculty: undefined, ms: undefined, type: undefined }));
    }, reduceMotion ? 0 : BACK_OUT_MS);
  }, [router, fromMsId, leaving, stepKey, buildStepUrl, reduceMotion]);
  const [sessions, setSessions]       = useState<SessionItem[]>([]);
  /** "<session id>:start_time" / ":room_id" set by hand on session 2+ — session 1 no longer fills them */
  const manualSessionFields = useRef(new Set<string>());
  const [manualCount, setManualCount] = useState(1);
  /** Days to place on the next freshly created sessions (from a Day combination click) */
  const comboDaysRef = useRef<string[] | null>(null);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [saving, setSaving]           = useState(false);
  /** Save-success check overlay — same animation + 1.3s hold as the other pages. */
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    msId: number; subjectCode: string; blockName: string; component: 'lec' | 'lab';
  } | null>(null);
  const [deleting, setDeleting]         = useState(false);
  const [deleteError, setDeleteError]   = useState('');
  const [deleteSuccess, setDeleteSuccess] = useState(false);
  const [showDeleteSkeleton, setShowDeleteSkeleton] = useState(false);
  const [sessionConflicts, setSessionConflicts] = useState<ConflictInfo[]>([]);
  const [conflictsVerified, setConflictsVerified] = useState(false);
  const [checkingConflicts, setCheckingConflicts] = useState(false);
  /** Major subject one-room check from the conflict preview, for the rooms it was run with (`key`) —
   *  error: can't be saved; move: the other part follows into the room on saving */
  const [roomRule, setRoomRule] = useState<{
    key: string; error: string | null; move: { part: 'lec' | 'lab'; room_name: string } | null;
  } | null>(null);
  /** Weekly Timetable modal — closed by default so Class Assignment stays focused. */
  const [showTimetable, setShowTimetable] = useState(false);
  const [timetableEntered, setTimetableEntered] = useState(false);
  useScrollLock(showTimetable || Boolean(deleteTarget));

  useEffect(() => {
    if (!syLoading && !syInit.current) {
      syInit.current = true;
      if (globalYear)     setSchoolYear(globalYear);
      if (globalSemester) setSemester(globalSemester);
    }
  }, [syLoading, globalYear, globalSemester]);

  const loadRooms = useCallback(() => fetch('/api/rooms?status=Active')
    .then(r => r.ok ? r.json() : null)
    .then(d => { if (d) setRooms(d.rooms || []); })
    .catch(() => {}), []);
  useEffect(() => { loadRooms(); }, [loadRooms]);

  /** quiet: live-update refresh — the list stays on screen (no loading state) */
  const loadFacultyList = useCallback((quiet = false) => {
    if (!quiet) setFacultyLoading(true);
    return fetch('/api/faculty')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setFacultyList(d.faculty || d || []); })
      .catch(() => {})
      .finally(() => { if (!quiet) setFacultyLoading(false); });
  }, []);
  useEffect(() => { loadFacultyList(); }, [loadFacultyList]);

  /** Bumped by live updates when no faculty is open (nothing else would refetch the summaries). */
  const [liveTick, setLiveTick] = useState(0);

  /* `/api/faculty` only returns each instructor's load LIMIT (Contractual hours, or
     18.25 − designation units), not what's left after assignments. Pull the
     real per-term remaining load from the same endpoint the Workload page
     uses, so "complete" means the same thing on both pages. Refetched when
     the term changes or the selected faculty's workload is updated. */
  const summariesTerm = useRef('');
  useEffect(() => {
    if (!semester || !schoolYear) return;
    const controller = new AbortController();
    const term = `${semester}|${schoolYear}`;
    // Only a new term shows the loading state — refreshes keep the badges on screen
    if (summariesTerm.current !== term) setSummariesLoading(true);
    const qs = new URLSearchParams({ semester, academic_year: schoolYear }).toString();
    fetch(`/api/workload/summaries?${qs}`, { signal: controller.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.summaries) { setLoadSummaries(d.summaries); summariesTerm.current = term; }
        setUnscheduledMap(d?.unscheduled ?? {});
      })
      .catch(() => {})
      .finally(() => { if (!controller.signal.aborted) setSummariesLoading(false); });
    return () => controller.abort();
  }, [semester, schoolYear, workload, liveTick]);

  /** Term the current `workload` was fetched for (guards the Master Schedule deep link). */
  const workloadTermRef = useRef('');
  // By id: a refreshed faculty list gives a new object for the same faculty
  const selId = selFaculty?.id ?? null;
  const fetchWorkload = useCallback(() => {
    if (selId == null) return;
    setFetchingW(true);
    const qs = new URLSearchParams({ semester, academic_year: schoolYear }).toString();
    fetch(`/api/workload/${selId}?${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || data.error) { setWorkload(null); return; }
        workloadTermRef.current = `${semester}|${schoolYear}`;
        setWorkload(data);
      })
      .catch(() => setWorkload(null))
      .finally(() => setFetchingW(false));
  }, [selId, semester, schoolYear]);

  useEffect(() => { fetchWorkload(); }, [fetchWorkload]);

  /** Faculty + term on screen, so a late live-update answer never lands on another faculty. */
  const workloadKey = useRef('');
  useEffect(() => { workloadKey.current = `${selId}|${semester}|${schoolYear}`; }, [selId, semester, schoolYear]);

  /** Live updates: re-read the open faculty's workload without the skeleton.
   *  The subject being scheduled and its unsaved sessions are left alone. */
  const refreshWorkloadQuietly = useCallback(() => {
    if (selId == null) return Promise.resolve();
    const key = `${selId}|${semester}|${schoolYear}`;
    const qs = new URLSearchParams({ semester, academic_year: schoolYear }).toString();
    return fetch(`/api/workload/${selId}?${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || data.error || workloadKey.current !== key) return; // keep what is on screen
        workloadTermRef.current = `${semester}|${schoolYear}`;
        setWorkload(data);
      })
      .catch(() => {});
  }, [selId, semester, schoolYear]);

  useEffect(() => {
    setSelLoad(null); setSessions([]); setManualCount(1);
    setError(''); setSuccess(''); setSessionConflicts([]); setConflictsVerified(false);
  }, [semester, schoolYear, selFaculty?.id]);

  useEffect(() => () => {
    if (panelSwitchTimeout.current) clearTimeout(panelSwitchTimeout.current);
  }, []);

  /** Saved sessions of the subject being opened — the form starts from these
   *  (same day / time / room as the timetable) instead of a blank 7:00 AM row. */
  const prefillRef = useRef<{ key: string; sessions: WorkloadSession[] } | null>(null);

  function selectLoad(row: LoadRow) {
    const saved = asSessionList<WorkloadSession>(row.load.sessions)
      .filter(x => (x.type === 'lab' ? 'lab' : 'lec') === row.component && x.day && x.start_time)
      .sort((a, b) => WEEK_DAYS.indexOf(a.day) - WEEK_DAYS.indexOf(b.day)
        || normTime(a.start_time).localeCompare(normTime(b.start_time)));
    prefillRef.current = saved.length > 0 ? { key: row.key, sessions: saved } : null;
    setSelLoad(row); setError(''); setSuccess('');
    setSessionConflicts([]); setConflictsVerified(false);
    // A new part of a Major Lec + Lab class starts on the days its other part already uses
    const pairDaysOf = row.load.one_room && saved.length === 0
      ? WEEK_DAYS.filter(d => asSessionList<WorkloadSession>(row.load.sessions)
          .some(x => (x.type === 'lab' ? 'lab' : 'lec') !== row.component && x.day === d))
      : [];
    if (pairDaysOf.length > 0) comboDaysRef.current = pairDaysOf;
    setSessions([]); setManualCount(saved.length > 0 ? saved.length : pairDaysOf.length || 1);
    /* Selecting a subject just swaps already-loaded local state — no fetch —
       so without this it snapped instantly. A brief skeleton (the same time
       as every other page, LOADING_DELAY) makes it a deliberate transition. */
    setPanelSwitching(true);
    if (panelSwitchTimeout.current) clearTimeout(panelSwitchTimeout.current);
    panelSwitchTimeout.current = setTimeout(() => setPanelSwitching(false), LOADING_DELAY);
  }

  /* Master Schedule deep link: once this faculty's workload is in, open the
     class straight away — its first unscheduled component, or (if every part
     already has a day/time) its first component so the schedule can be edited.
     Runs once per link; refreshing the page re-applies it from the URL. */
  const appliedMsLink = useRef<string | null>(null);
  useEffect(() => {
    if (!fromMsId || view !== 'schedule' || syLoading || fetchingW || !workload || !selFaculty) return;
    if (workloadTermRef.current !== `${semester}|${schoolYear}`) return;
    const linkKey = `${fromMsId}-${selFaculty.id}`;
    if (appliedMsLink.current === linkKey) return;
    const termLoads = workload.loads.filter(l => l.block_semester === semester && l.block_academic_year === schoolYear);
    const rows = expandLoads(termLoads, selFaculty.employment_status === 'Permanent').filter(r => r.load.ms_id === fromMsId);
    appliedMsLink.current = linkKey;
    const row = rows.find(r => !r.isScheduled) ?? rows[0];
    if (!row) {
      toast.error('This class is no longer in this faculty’s workload.');
      return;
    }
    selectLoad(row);
  }, [fromMsId, view, syLoading, fetchingW, workload, selFaculty, semester, schoolYear, toast]);

  /* Deep-linked faculty that no longer exists / is inactive → back to the normal wizard. */
  useEffect(() => {
    if (!fromMsId || view !== 'schedule' || facultyLoading || facultyList.length === 0 || selFaculty) return;
    toast.error('The assigned faculty could not be found. Please pick a faculty.');
    router.replace(pathname);
  }, [fromMsId, view, facultyLoading, facultyList.length, selFaculty, toast, router, pathname]);

  useEffect(() => {
    if (!selLoad) return;
    const comp        = selLoad.component;
    const compU       = toNum(selLoad.componentUnits);
    const compHrs     = toNum(selLoad.componentHours);
    const uPerSession = parseFloat((compU   / manualCount).toFixed(4));
    const hPerSession = parseFloat((compHrs / manualCount).toFixed(4));
    // Opening an already-scheduled subject: start from its saved sessions
    const pre = prefillRef.current;
    if (pre && pre.key === selLoad.key && pre.sessions.length === manualCount) {
      prefillRef.current = null;
      setSessions(pre.sessions.map(x => {
        const start = normTime(x.start_time);
        const end = normTime(x.end_time);
        const hrs = toNum(x.session_hours)
          || Math.max(0, (sessionEndMinutes(x.start_time, x.end_time) - timeToMinutes(start)) / 60)
          || hPerSession;
        return {
          id: uid(), day: x.day, start_time: start,
          units: parseFloat((compU * (hrs / (compHrs || hrs))).toFixed(4)), hours: hrs,
          end_time: end || addMinutes(start, Math.round(hrs * 60)),
          type: comp, room_id: x.room_id != null ? String(x.room_id) : '',
        };
      }));
      setConflictsVerified(false); setSessionConflicts([]);
      return;
    }
    prefillRef.current = null;
    const comboDays = comboDaysRef.current;
    comboDaysRef.current = null;
    // A new row starts in the room the class's other part (Lecture / Laboratory)
    // already uses, when this part may use it — Lec and Lab keep one room. The
    // time picker then offers only times that room is free.
    const pair = pairedRoom(selLoad.load, comp, roomsRef.current);
    // …or, not saved yet, the room already picked for this class on either part
    const draft = roomDraftRef.current;
    const draftRoom = selLoad.load.one_room && draft && draft.msId === selLoad.load.ms_id ? draft.roomId : '';
    // Changing the session count keeps the rows already filled in (day, time,
    // room) — only new rows start blank; hours are re-split evenly.
    setSessions(prev => {
      const keep = prev.filter(s => s.type === comp);
      // Major subject: a new row takes the room the other rows already use (one room for the class)
      const shared = selLoad.load.one_room ? keep.find(s => s.room_id)?.room_id : undefined;
      return Array.from({ length: manualCount }, (_, i) => {
        const old = keep[i];
        const start = old?.start_time || '07:00';
        return {
          id: old?.id ?? uid(),
          day: comboDays?.[i] ?? old?.day ?? '',
          start_time: start,
          units: uPerSession, hours: hPerSession,
          end_time: addMinutes(start, Math.round(hPerSession * 60)),
          type: comp, room_id: old ? old.room_id : shared || (pair ? String(pair.id) : draftRoom),
        };
      });
    });
    setConflictsVerified(false); setSessionConflicts([]);
  }, [manualCount, selLoad]);

  /* ── Room + block availability for the Time and Room pickers ─────
     Every live class session this term (all faculty), with its block and
     room. Refetched whenever the workload reloads — i.e. after a save or
     delete. */
  interface RoomBooking {
    room_id: number | null; block_id: number | null;
    day: string; start_time: string; end_time: string;
    ms_id: number; type: string; subject_code: string; block_name: string;
    program_code: string | null; faculty_name: string | null;
  }
  const [roomBookings, setRoomBookings] = useState<RoomBooking[]>([]);
  useEffect(() => {
    if (!semester || !schoolYear) return;
    const controller = new AbortController();
    const qs = new URLSearchParams({ semester, academic_year: schoolYear }).toString();
    fetch(`/api/scheduling/room-bookings?${qs}`, { signal: controller.signal })
      .then(r => (r.ok ? r.json() : { bookings: [] }))
      .then(d => setRoomBookings(Array.isArray(d.bookings) ? d.bookings : []))
      .catch(() => {});
    return () => controller.abort();
  }, [semester, schoolYear, workload, liveTick]);

  /* Live updates: classes, loads, rooms or faculty changed elsewhere (another
     admin, another tab). The faculty list, rooms, the open workload and room
     availability reload quietly; the wizard step, the subject being scheduled
     and its unsaved sessions stay. Held while this page saves or deletes. */
  useRealtime(['schedule', 'workload', 'blocks', 'rooms', 'faculty'], () => {
    const jobs: Promise<unknown>[] = [loadFacultyList(true), loadRooms()];
    if (selId != null) jobs.push(refreshWorkloadQuietly()); // its effects refresh summaries + bookings
    else setLiveTick(t => t + 1);
    return Promise.all(jobs);
  }, { enabled: !facultyLoading && !fetchingW && !saving && !deleting });

  /** Major subject with a Lecture and a Laboratory: every session of both parts
   *  uses one room — picking a room for one part moves the other part too. */
  const oneRoom = selLoad?.load.one_room === true;
  /** …and both parts meet on the same days: the days its other part already uses (null = not scheduled yet) */
  const pairDays: string[] | null = (() => {
    if (!selLoad || !oneRoom) return null;
    const days = WEEK_DAYS.filter(d => asSessionList<WorkloadSession>(selLoad.load.sessions)
      .some(x => (x.type === 'lab' ? 'lab' : 'lec') !== selLoad.component && x.day === d));
    return days.length > 0 ? days : null;
  })();
  const otherPartName = selLoad?.component === 'lab' ? 'Lecture' : 'Laboratory';
  /** …and once its other part has a room, this part must use that same room — the only one offered */
  const savedLockedRoom: Room | null = (() => {
    if (!selLoad || !oneRoom) return null;
    const used = asSessionList<WorkloadSession>(selLoad.load.sessions)
      .find(x => (x.type === 'lab' ? 'lab' : 'lec') !== selLoad.component && x.room_id != null);
    return used ? rooms.find(r => r.id === Number(used.room_id)) ?? null : null;
  })();
  /** Not saved yet: the room picked on the other part of this class */
  const draftLockedRoom: Room | null = !savedLockedRoom && oneRoom && selLoad && roomDraft
    && roomDraft.msId === selLoad.load.ms_id && roomDraft.part !== selLoad.component
    ? rooms.find(r => String(r.id) === roomDraft.roomId) ?? null
    : null;
  const lockedRoom: Room | null = savedLockedRoom ?? draftLockedRoom;

  /** Major subject: why a room can't also take the class's other part at its
   *  saved times ('' = free). The class's own sessions don't count. */
  function otherPartBusyWith(roomId: number): string {
    if (!selLoad || !oneRoom) return '';
    for (const o of asSessionList<WorkloadSession>(selLoad.load.sessions)) {
      if ((o.type === 'lab' ? 'lab' : 'lec') === selLoad.component || !o.day || !o.start_time || !o.end_time) continue;
      const start = timeToMinutes(normTime(o.start_time));
      const end = sessionEndMinutes(o.start_time, o.end_time);
      for (const b of roomBookings) {
        if (Number(b.room_id) !== roomId || b.day !== o.day || Number(b.ms_id) === selLoad.load.ms_id) continue;
        if (start < sessionEndMinutes(b.start_time, b.end_time) && end > timeToMinutes(normTime(b.start_time))) {
          return `${selLoad.component === 'lec' ? 'Lab' : 'Lec'} time: ${b.subject_code} · ${[b.program_code, b.block_name].filter(Boolean).join(' ')} · ${DAY_SHORT[b.day] ?? b.day} ${fmt12(normTime(b.start_time))}`;
        }
      }
    }
    return '';
  }

  /** Major subject whose other part has no times yet: minutes each of its sessions
   *  will need — its weekly hours over this part's days (both parts meet on the same
   *  days, in the same room). 0 = nothing to keep room for. */
  const otherPartSessionMin = (() => {
    if (!selLoad || !oneRoom || pairDays) return 0;
    const weekly = toNum(selLoad.component === 'lab' ? selLoad.load.lecture_hours : selLoad.load.laboratory_hours);
    const days = new Set(sessions.map(s => s.day).filter(Boolean)).size || sessions.length || 1;
    return weekly > 0 ? Math.round((weekly / days) * 60) : 0;
  })();
  const otherPartLength = otherPartSessionMin
    ? `${otherPartSessionMin % 60 === 0 ? otherPartSessionMin / 60 : (otherPartSessionMin / 60).toFixed(1)} hr${otherPartSessionMin === 60 ? '' : 's'}`
    : '';

  /** Why a room can't be used for this session ('' = free). Ignores the
   *  component being edited (saving replaces its sessions). */
  function roomBusyWith(sess: SessionItem, roomId: number): string {
    if (!sess.day || !sess.start_time) return '';
    const start = timeToMinutes(sess.start_time);
    const end = sessionEndMinutes(sess.start_time, sess.end_time);
    for (const b of roomBookings) {
      if (Number(b.room_id) !== roomId || b.day !== sess.day) continue;
      if (selLoad && Number(b.ms_id) === selLoad.load.ms_id && (b.type === 'lab' ? 'lab' : 'lec') === selLoad.component) continue;
      const bs = timeToMinutes(normTime(b.start_time));
      const be = sessionEndMinutes(b.start_time, b.end_time);
      if (start < be && end > bs) {
        return `${b.subject_code} · ${[b.program_code, b.block_name].filter(Boolean).join(' ')} · ${fmt12(normTime(b.start_time))}–${fmt12(normTime(b.end_time))}`;
      }
    }
    for (let i = 0; i < sessions.length; i++) {
      const o = sessions[i];
      if (o.id === sess.id || o.day !== sess.day || o.room_id !== String(roomId)) continue;
      const os = timeToMinutes(o.start_time);
      const oe = sessionEndMinutes(o.start_time, o.end_time);
      if (start < oe && end > os) return `Session ${i + 1} of this subject`;
    }
    return '';
  }

  /* ── Instructor availability for the Time dropdown ──────────────
     Everything this faculty already teaches this term (every subject's
     saved sessions, incl. the other Lec/Lab of this subject), by day. The
     component being edited is left out — saving replaces its sessions. */
  const instructorBusy = useMemo(() => {
    const byDay = new Map<string, BusyRange[]>();
    if (!workload) return byDay;
    for (const l of workload.loads) {
      if (l.block_semester !== semester || l.block_academic_year !== schoolYear) continue;
      for (const s of asSessionList<WorkloadSession>(l.sessions)) {
        if (!s.day || !s.start_time || !s.end_time) continue;
        const comp = s.type === 'lab' ? 'lab' : 'lec';
        if (selLoad && l.ms_id === selLoad.load.ms_id && comp === selLoad.component) continue;
        const start = timeToMinutes(normTime(s.start_time));
        const list = byDay.get(s.day) ?? [];
        list.push({
          start,
          end: sessionEndMinutes(s.start_time, s.end_time),
          label: `${l.subject_code} ${comp === 'lab' ? 'Lab' : 'Lec'} · ${fmt12(normTime(s.start_time))}–${fmt12(normTime(s.end_time))}`,
          kind: 'Instructor',
        });
        byDay.set(s.day, list);
      }
    }
    return byDay;
  }, [workload, semester, schoolYear, selLoad]);

  /** Major subject: can its other part still fit in this room on this session's day,
   *  next to this session — clear of the instructor's and block's other classes, the
   *  room's bookings, lunch and the end of the school day? e.g. Lab 1 free only
   *  1:00–2:30 PM holds a 1.5 hr Lab but leaves nothing for its 1 hr Lecture. */
  function otherPartFits(sess: SessionItem, roomId: number): boolean {
    if (!otherPartSessionMin || !selLoad || !sess.day || !sess.start_time) return true;
    const blockId = selLoad.load.block_id;
    const taken: { start: number; end: number }[] = [
      LUNCH,
      ...(instructorBusy.get(sess.day) ?? []),
      ...sessions.filter(o => o.day === sess.day && o.start_time).map(o => o.id === sess.id ? sess : o)
        .map(o => ({ start: timeToMinutes(o.start_time), end: sessionEndMinutes(o.start_time, o.end_time) })),
    ];
    if (!sessions.some(o => o.id === sess.id)) {
      taken.push({ start: timeToMinutes(sess.start_time), end: sessionEndMinutes(sess.start_time, sess.end_time) });
    }
    for (const b of roomBookings) {
      if (b.day !== sess.day || Number(b.ms_id) === selLoad.load.ms_id) continue;
      if (Number(b.room_id) === roomId || (blockId != null && Number(b.block_id) === blockId)) {
        taken.push({ start: timeToMinutes(normTime(b.start_time)), end: sessionEndMinutes(b.start_time, b.end_time) });
      }
    }
    return TIME_SLOTS.some(t => {
      const start = timeToMinutes(t);
      const end = start + otherPartSessionMin;
      return end <= DAY_END_MIN && taken.every(x => end <= x.start || start >= x.end);
    });
  }
  /** Struck start time — the picker shows it as "Runs into …" */
  const otherPartTimeClash = (day: string, roomName?: string) =>
    `the ${otherPartLength} its ${otherPartName} needs${roomName ? ` in ${roomName}` : ''} on ${day}`;
  /** Picked room that can't take both parts — shown as "Busy · …" */
  const otherPartRoomClash = (day: string) => `${day} has no ${otherPartLength} left here for its ${otherPartName}`;
  /** The same, short enough for a room card: "No 1.5 hrs on Mon for its Lab" */
  const otherPartRoomShort = (day: string) => `No ${otherPartLength} on ${DAY_SHORT[day] ?? day} for its ${otherPartName === 'Laboratory' ? 'Lab' : 'Lecture'}`;


  /** Other classes on this day that would clash — same rules as the server
   *  check (findScheduleConflicts): this block's classes (any instructor) and,
   *  ONLY once a room is picked, that room's bookings. No room yet → rooms are
   *  not considered. The component being edited is left out — saving replaces
   *  its sessions. */
  function blockAndRoomBusy(sess: SessionItem): BusyRange[] {
    if (!sess.day || !selLoad) return [];
    const blockId = selLoad.load.block_id;
    const roomId = sess.room_id ? Number(sess.room_id) : null;
    const out: BusyRange[] = [];
    for (const b of roomBookings) {
      if (b.day !== sess.day) continue;
      if (Number(b.ms_id) === selLoad.load.ms_id && (b.type === 'lab' ? 'lab' : 'lec') === selLoad.component) continue;
      const sameBlock = blockId != null && Number(b.block_id) === blockId;
      const sameRoom = roomId != null && Number(b.room_id) === roomId;
      if (!sameBlock && !sameRoom) continue;
      const time = `${fmt12(normTime(b.start_time))}–${fmt12(normTime(b.end_time))}`;
      const start = timeToMinutes(normTime(b.start_time));
      const end = sessionEndMinutes(b.start_time, b.end_time);
      if (sameBlock) out.push({
        start, end, kind: 'Block',
        label: `${blockCode(selLoad?.load.year_level, b.block_name)} has ${b.subject_code} ${time}${b.faculty_name ? ` (${b.faculty_name})` : ''}`,
      });
      if (sameRoom) out.push({
        start, end, kind: 'Room',
        label: `Room used by ${b.subject_code} ${[b.program_code, b.block_name].filter(Boolean).join(' ')} ${time}`,
      });
    }
    return out;
  }

  /** Everything already on this day for the day timeline: the instructor's
   *  classes plus the block's and the chosen room's. */
  function dayBusy(sess: SessionItem): BusyRange[] {
    if (!sess.day) return [];
    return [...(instructorBusy.get(sess.day) ?? []), ...blockAndRoomBusy(sess)];
  }

  /** What this session can't overlap on its day: the instructor's, block's
   *  and room's existing classes + this form's other rows, each labelled. */
  function takenRanges(sess: SessionItem, all: SessionItem[] = sessions): BusyRange[] {
    if (!sess.day) return [];
    return [
      ...dayBusy(sess),
      ...all
        .map((o, i) => ({ o, i }))
        .filter(({ o }) => o.id !== sess.id && o.day === sess.day && o.start_time)
        .map(({ o, i }) => ({
          start: timeToMinutes(o.start_time),
          end: sessionEndMinutes(o.start_time, o.end_time),
          label: `Session ${i + 1} of this subject ${fmt12(o.start_time)}–${fmt12(o.end_time)}`,
          kind: 'Instructor' as const,
        })),
    ];
  }

  /** Each start time with the class it would overlap ('' = free). A start is
   *  taken when the WHOLE session (start + its length) runs into a class —
   *  e.g. a 1.5 hr session at 2:30 PM runs to 4:00 PM, into a 3:00 PM class. */
  function slotConflicts(sess: SessionItem, all: SessionItem[] = sessions): { value: string; conflict: string }[] {
    const dur = Math.round(toNum(sess.hours) * 60);
    const taken = takenRanges(sess, all);
    /* Major subject with a room picked: also rule out starts that would leave its
       other part no time in that room that day */
    const fitRoomId = otherPartSessionMin && sess.room_id ? Number(sess.room_id) : null;
    const fitRoomName = fitRoomId != null ? rooms.find(r => r.id === fitRoomId)?.room_name : undefined;
    // Only starts that finish by 6:00 PM (faculty are out by then)
    // and that don't fall inside lunch; starts that would run INTO lunch stay
    // listed but struck out, with the reason.
    return TIME_SLOTS.filter(t => {
      const m = timeToMinutes(t);
      return m + dur <= DAY_END_MIN && !(m >= LUNCH.start && m < LUNCH.end);
    }).map(t => {
      const start = timeToMinutes(t);
      const end = start + dur;
      // Every clash, not just the first: "Instructor + Room conflict — …"
      const hits = [LUNCH, ...taken].filter(b => start < b.end && end > b.start);
      if (hits.length === 0) {
        if (fitRoomId != null && !otherPartFits({ ...sess, start_time: t, end_time: addMinutes(t, dur) }, fitRoomId)) {
          return { value: t, conflict: otherPartTimeClash(sess.day, fitRoomName) };
        }
        return { value: t, conflict: '' };
      }
      const kinds = BUSY_KIND_ORDER.filter(k => hits.some(h => h.kind === k));
      if (kinds.length === 1 && kinds[0] === 'Lunch') return { value: t, conflict: LUNCH.label };
      const names = kinds.filter(k => k !== 'Lunch');
      const details = [...new Set(hits.filter(h => h.kind !== 'Lunch').map(h => h.label))];
      return { value: t, conflict: `${names.join(' + ')} conflict — ${details.join('; ')}` };
    });
  }

  /** Start times (TIME_SLOTS) that fit this session on its day. */
  function freeStartTimes(sess: SessionItem, all: SessionItem[] = sessions): string[] {
    // Lunch + the 6 PM cut-off apply even before a day is picked
    return slotConflicts(sess, all).filter(x => !x.conflict).map(x => x.value);
  }

  function updateSession(id: string, key: string, val: string | number) {
    /* Session 1's time / room fill the other sessions; a row the admin changes
       by hand keeps its own value from then on. */
    const idx = sessions.findIndex(s => s.id === id);
    const followed = key === 'start_time' || key === 'room_id';
    // Major subject: the room picked on any row is every row's room — no row keeps its own
    const sharedRoom = key === 'room_id' && oneRoom;
    if (idx > 0 && followed && !sharedRoom) manualSessionFields.current.add(`${id}:${key}`);
    // …and becomes the room of its other part too (opened next, it starts in this room)
    if (sharedRoom && selLoad && !savedLockedRoom) {
      setRoomDraft(val ? { msId: selLoad.load.ms_id, part: selLoad.component, roomId: String(val) } : null);
    }

    setSessions(prev => {
      // Picking a day — or a room — where the current time is already taken
      // (by the instructor, the block, or that room) → jump to the first free start
      const toFreeStart = (updated: SessionItem, all: SessionItem[]) => {
        const free = freeStartTimes(updated, all);
        if (free.length > 0 && !free.includes(updated.start_time)) {
          updated.start_time = free[0];
          updated.end_time = addMinutes(free[0], Math.round(toNum(updated.hours) * 60));
        }
      };
      let next = prev.map(s => {
        if (s.id !== id) return s;
        const updated = { ...s, [key]: val };
        if ((key === 'day' || key === 'room_id') && val && updated.day) toFreeStart(updated, prev);
        if (key === 'start_time') {
          updated.end_time = addMinutes(String(val), Math.round(toNum(updated.hours) * 60));
        }
        return updated;
      });

      if (sharedRoom) {
        const v = String(val);
        next = next.map(s => {
          if (s.id === id || s.room_id === v) return s;
          const updated = { ...s, room_id: v };
          if (v && updated.day) toFreeStart(updated, next);
          return updated;
        });
      } else if (idx === 0 && followed) {
        const v = String(next[0][key as 'start_time' | 'room_id']);
        next = next.map((s, i) => {
          if (i === 0 || manualSessionFields.current.has(`${s.id}:${key}`)) return s;
          if (key === 'start_time') {
            const copy = { ...s, start_time: v, end_time: addMinutes(v, Math.round(toNum(s.hours) * 60)) };
            // Only where that time is free on this session's day — never copy a conflict in
            return freeStartTimes(copy, next).includes(v) ? copy : s;
          }
          // Room: only if it is free at this session's time
          return v && roomBusyWith(s, Number(v)) ? s : { ...s, room_id: v };
        });
      }
      return next;
    });
    if (key === 'day' || key === 'start_time' || key === 'room_id') {
      setConflictsVerified(false); setSessionConflicts([]);
    }
  }

  function removeSession(id: string) {
    setSessions(prev => prev.filter(s => s.id !== id));
    // The count follows the rows left, so + / − and typing keep working from it
    setManualCount(Math.max(1, sessions.filter(s => s.id !== id).length));
    setSessionConflicts([]); setConflictsVerified(false);
  }

  const totalScheduled = sessions.reduce((a, s) => a + toNum(s.hours), 0);
  const totalUnitsUsed = sessions.reduce((a, s) => a + toNum(s.units), 0);
  const totalRequired  = toNum(selLoad?.componentHours);
  const totalUnitsReq  = toNum(selLoad?.componentUnits);
  const remaining      = parseFloat((totalRequired - totalScheduled).toFixed(4));
  const remainingUnits = parseFloat((totalUnitsReq - totalUnitsUsed).toFixed(4));
  const unitsExceeded  = remainingUnits < -0.01;
  const isComplete     = selLoad ? Math.abs(remaining) < 0.01 && !unitsExceeded : false;
  const allDaysSet     = sessions.every(s => !!s.day);
  const hasConflicts      = sessionConflicts.length > 0;
  /** Unique underlying conflicts (messages may duplicate the same overlap). */
  const uniqueConflictCount = useMemo(
    () => new Set(sessionConflicts.map(c => c.conflictKey)).size,
    [sessionConflicts],
  );
  const hasLabRoomMissing = selLoad?.component === 'lab' && sessions.some(s => !s.room_id);
  /* Major subject with a Lecture and a Laboratory: the same days as its other
     part and one room for every session. Wrong days or different rooms on the
     rows are caught here at once; the server preview checks the room against
     the other part's times (same check as the save). */
  const roomsKey = selLoad ? `${selLoad.key}|${sessions.map(s => `${s.day}:${s.room_id}`).join(',')}` : '';
  const ruleNow = roomRule && roomRule.key === roomsKey ? roomRule : null;
  const chosenRoomIds = [...new Set(sessions.map(s => s.room_id).filter(Boolean))];
  const myDays = WEEK_DAYS.filter(d => sessions.some(s => s.day === d));
  const pairDaysText = pairDays ? daysLabel(pairDays as WeekDay[]) : '';
  const daysRuleError = pairDays && selLoad && allDaysSet && sessions.length > 0 && myDays.join() !== pairDays.join()
    ? `${selLoad.load.subject_code} is a Major subject, so its Lecture and Laboratory must meet on the same days. Its ${otherPartName} is on ${pairDaysText} — use ${pairDaysText} for the ${selLoad.label === 'Lab' ? 'Laboratory' : 'Lecture'} too (the times may differ).`
    : null;
  /* PATHFIT meets only in the CCA Gym or the SAO Room (same check as the save) */
  const pathfitRoomError = selLoad && isPathfitSubject(selLoad.load.subject_code)
    && chosenRoomIds.some(id => !isPathfitVenue(rooms.find(r => String(r.id) === String(id))?.room_name))
    ? PATHFIT_VENUE_RULE : null;
  const roomRuleError = pathfitRoomError ?? (!oneRoom || !selLoad ? null
    : daysRuleError ?? (chosenRoomIds.length > 1
      ? `${selLoad.load.subject_code} is a Major subject, so its Lecture and Laboratory must use the same room. Choose one room for every session.`
      : lockedRoom && chosenRoomIds.length === 1 && chosenRoomIds[0] !== String(lockedRoom.id)
        ? `${selLoad.load.subject_code} is a Major subject, so its Lecture and Laboratory must use the same room. Its ${otherPartName} is in ${lockedRoom.room_name} — choose ${lockedRoom.room_name} for the ${selLoad.label === 'Lab' ? 'Laboratory' : 'Lecture'} too.`
        : ruleNow?.error ?? null));

  /* The semester's day combinations (Settings → Day Combinations) are quick
     picks only — any days can be scheduled (programs use their own patterns). */
  const currentCombo = dayCombos.length > 0 && allDaysSet && sessions.length > 0
    ? matchCombination(sessions.map(s => s.day), dayCombos)
    : null;
  /** Days a session may use (null = every day) — a Major Lec + Lab part: its other part's days */
  const allowedDays = pairDays ? new Set<string>(pairDays) : null;

  /** Use a combination: one session per day, in week order (times/rooms kept per row) */
  /** Sessions per week as shown (saved rows can be more than the limit until changed) */
  const shownCount = sessions.length > 0 ? sessions.length : manualCount;
  /** Typing in the count: '' while the box is cleared, then the typed number takes over */
  const [countText, setCountText] = useState<string | null>(null);
  function setSessionCount(n: number) {
    const next = Math.min(MAX_SESSIONS, Math.max(1, Math.round(n) || 1));
    if (next !== shownCount || next !== manualCount) setManualCount(next);
  }

  function applyCombination(days: readonly string[]) {
    if (!selLoad) return;
    setError('');
    if (days.length === sessions.length) {
      setSessions(prev => prev.map((s, i) => ({ ...s, day: days[i] })));
      setConflictsVerified(false); setSessionConflicts([]);
    } else {
      comboDaysRef.current = [...days];
      setManualCount(days.length);
    }
  }

  const canSave           = isComplete && allDaysSet && sessions.length > 0 && !saving && !hasConflicts && !roomRuleError;

  async function runConflictCheck() {
    if (!selLoad || sessions.length === 0) return;
    setCheckingConflicts(true);
    const found: ConflictInfo[] = [];
    for (let i = 0; i < sessions.length; i++) {
      const a = sessions[i];
      if (!a.day) continue;
      const aStart = timeToMinutes(a.start_time);
      const aEnd   = sessionEndMinutes(a.start_time, a.end_time); // midnight-aware
      // Outside the school day — the save refuses it, so it must move first
      const outside = aStart < SCHOOL_DAY_START_MIN ? 'starts before 7:00 AM'
        : aEnd > DAY_END_MIN ? 'ends after 6:00 PM'
        : aStart < LUNCH.end && aEnd > LUNCH.start ? `overlaps the lunch break (${LUNCH_LABEL})` : null;
      if (outside) {
        found.push({
          sessionId: a.id,
          type: 'time',
          message: `Session ${i + 1} (${a.day}, ${fmt12(a.start_time)}–${fmt12(a.end_time)}) ${outside}. Classes meet ${SCHOOL_DAY_LABEL} — choose a time inside the school day.`,
          conflictKey: makeConflictKey('time', a.id, 'school-day', a.day, a.start_time, a.end_time),
        });
      }
      for (let j = 0; j < i; j++) {
        const b = sessions[j];
        if (b.day !== a.day) continue;
        const bStart = timeToMinutes(b.start_time);
        const bEnd   = sessionEndMinutes(b.start_time, b.end_time);
        if (aStart < bEnd && aEnd > bStart) {
          const [idA, idB] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
          found.push({
            sessionId: a.id,
            type: 'duplicate',
            message: `Session ${i + 1} overlaps with Session ${j + 1} on ${a.day} (${fmt12(a.start_time)}–${fmt12(a.end_time)}).`,
            conflictKey: makeConflictKey('duplicate', idA, idB, a.day, b.start_time, b.end_time),
          });
        }
      }
      // Cross-component check: Lecture vs Laboratory of the same Major subject
      // (sibling sessions already saved under this master_schedule_id).
      const siblingSessions = (selLoad.load.sessions ?? []).filter(
        s => (s.type || 'lec') !== selLoad.component
      );
      for (const sib of siblingSessions) {
        if (sib.day !== a.day) continue;
        const sStart = timeToMinutes(normTime(sib.start_time));
        const sEnd   = sessionEndMinutes(sib.start_time, sib.end_time);
        if (aStart < sEnd && aEnd > sStart) {
          const sibLabel = (sib.type || 'lec') === 'lab' ? 'Laboratory' : 'Lecture';
          const st = normTime(sib.start_time);
          const et = normTime(sib.end_time);
          found.push({
            sessionId: a.id,
            type: 'instructor',
            message: `Overlaps ${selLoad.load.subject_code} ${sibLabel} on ${a.day} (${fmt12(st)}–${fmt12(et)}). Same faculty cannot teach two sessions at once.`,
            conflictKey: makeConflictKey('instructor', a.id, sib.id, a.day, st, et),
          });
        }
      }
    }
    try {
      const checkedKey = roomsKey;
      const res = await fetch('/api/scheduling/check-conflicts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          master_schedule_id: selLoad.load.ms_id,
          component: selLoad.component,
          semester, academic_year: schoolYear,
          sessions: sessions.map(s => ({ day: s.day, start_time: s.start_time, hours: s.hours, room_id: s.room_id || null })),
        }),
      });
      const data = await res.json();
      // The server refused the sessions (e.g. a time outside the school day) — show why, never "verified"
      if (res.status === 400 && typeof data.error === 'string' && !found.some(c => c.type === 'time')) {
        found.push({ sessionId: 'server', type: 'time', message: data.error, conflictKey: 'time:server' });
      }
      setRoomRule(data.room_rule ? { key: checkedKey, error: data.room_rule.error ?? null, move: data.room_rule.move ?? null } : null);
      if (Array.isArray(data.conflicts)) {
        for (const c of data.conflicts) {
          const newId = sessions[c.session_index]?.id ?? `idx:${c.session_index}`;
          const day = c.day || sessions[c.session_index]?.day || '';
          const st = normTime(c.existing_start || '00:00');
          const et = normTime(c.existing_end || '00:00');
          const existingId = c.existing_session_id ?? `${st}-${et}`;
          found.push({
            sessionId: newId,
            type: c.type,
            message: c.message,
            conflictKey: makeConflictKey(c.type, newId, existingId, day, st, et),
          });
        }
      }
    } catch { /* network error — client check only */ }
    setSessionConflicts(found); setConflictsVerified(true); setCheckingConflicts(false);
  }

  useEffect(() => {
    if (!selLoad || sessions.length === 0) return;
    if (!sessions.every(s => !!s.day)) return;
    const timer = setTimeout(() => { void runConflictCheck(); }, 800);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, selLoad?.key]);

  function openTimetable() {
    setTimetableEntered(false);
    setShowTimetable(true);
  }
  function closeTimetable() {
    setTimetableEntered(false);
    window.setTimeout(() => setShowTimetable(false), reduceMotion ? 0 : 320);
  }

  /* Must run on every render path — never after view === 'faculty' early return. */
  useEffect(() => {
    if (!showTimetable) return;
    const id = window.requestAnimationFrame(() => setTimetableEntered(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (deleteTarget || deleting) return;
      closeTimetable();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(id);
      document.removeEventListener('keydown', onKey);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTimetable, deleting, deleteTarget]);

  async function handleSave() {
    if (!selLoad || !canSave) return;
    setError(''); setSuccess(''); setSaving(true);
    try {
      const body = {
        master_schedule_id: selLoad.load.ms_id, component: selLoad.component,
        day_pattern: sessions.map(s => DAY_SHORT[s.day] || s.day).join('/'),
        split_type: 'Manual',
        sessions: sessions.map(s => ({
          day: s.day, start_time: s.start_time, hours: s.hours,
          end_time: s.end_time, type: selLoad.component, room_id: s.room_id || null,
        })),
      };
      const res  = await fetch('/api/scheduling', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        let msg = 'Save failed.';
        let serverConflicts: { session_index: number; type: ConflictInfo['type']; message: string; existing_session_id?: number; day?: string; existing_start?: string; existing_end?: string }[] = [];
        try {
          const data = await res.json() as { error?: string; conflicts?: typeof serverConflicts };
          msg = data?.error ?? msg;
          serverConflicts = Array.isArray(data?.conflicts) ? data.conflicts : [];
        } catch { /* html */ }
        // Refused for a conflict (e.g. someone else just booked that slot) → mark the rows
        if (serverConflicts.length > 0) {
          setSessionConflicts(serverConflicts.map(c => {
            const newId = sessions[c.session_index]?.id ?? `idx:${c.session_index}`;
            const st = normTime(c.existing_start || '00:00');
            const et = normTime(c.existing_end || '00:00');
            return {
              sessionId: newId, type: c.type, message: c.message,
              conflictKey: makeConflictKey(c.type, newId, c.existing_session_id ?? `${st}-${et}`, c.day || '', st, et),
            };
          }));
          setConflictsVerified(true);
          fetchWorkload(); // refresh busy times so the pickers reflect the new booking
        }
        setError(msg); toast.error(msg); return;
      }
      const result = await res.json().catch(() => null) as { moved?: { part: 'lec' | 'lab'; room_name: string } | null } | null;
      const saved = selLoad;
      // Saved: from now on the saved room keeps the class's parts together
      setRoomDraft(d => (d && d.msId === saved.load.ms_id ? null : d));
      // Major subject: the other part followed into the same room
      const moved = result?.moved ? ` The ${result.moved.part === 'lab' ? 'Laboratory' : 'Lecture'} is now in ${result.moved.room_name} too.` : '';
      setSuccess(`Schedule saved for ${saved.load.subject_code} (${saved.label}) — ${blockCode(saved.load.year_level, saved.load.block_name)}.${moved}`);
      fetchWorkload();
      // Check animation plays for 1.3s (same as Faculty / Blocks / Curriculum),
      // then the form clears and the toast confirms.
      setSaveSuccess(true);
      setTimeout(() => {
        setSaveSuccess(false);
        closeEditor(saved.key); setSessions([]);
        toast.success(`Schedule saved for ${saved.load.subject_code} — ${blockCode(saved.load.year_level, saved.load.block_name)}.${moved}`);
      }, 1300);
    } catch { setError('Connection error.'); toast.error('Connection error. Please try again.'); }
    finally { setSaving(false); }
  }

  function handleClear() {
    setSessions([]); setError(''); setSessionConflicts([]); setConflictsVerified(false);
  }

  async function handleDeleteSchedule() {
    if (!deleteTarget || deleting) return;
    setDeleting(true); setDeleteError('');
    try {
      const res = await fetch(
        `/api/scheduling?id=${deleteTarget.msId}&type=${deleteTarget.component}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        let msg = 'Failed to delete schedule.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setDeleteError(msg); toast.error(msg); return;
      }
      setDeleting(false);
      setDeleteSuccess(true);
      setShowDeleteSkeleton(true);
      fetchWorkload();
      setTimeout(() => {
        setDeleteSuccess(false);
        setShowDeleteSkeleton(false);
        setDeleteTarget(null);
        toast.delete('Schedule deleted successfully.');
      }, 1300);
      return;
    } catch { setDeleteError('Connection error. Please try again.'); }
    finally { setDeleting(false); }
  }

  /* Rooms that fit the subject: Laboratory sessions → lab rooms; the Lecture
     of a subject that has a lab (Major + Lab) → lecture or lab rooms; a pure
     lecture subject (no lab hours) → lecture rooms only. */
  const lectureRooms = rooms.filter(r => !LAB_ROOM_TYPES.includes(r.room_type));
  const labRooms     = rooms.filter(r =>  LAB_ROOM_TYPES.includes(r.room_type));
  const subjectHasLab = toNum(selLoad?.load.laboratory_hours) > 0;
  // A Major subject's Lecture shares its Laboratory's room, so it is a laboratory too —
  // and once the other part has a room, that room is the only one offered
  // PATHFIT → only the CCA Gym and the SAO Room
  const activeRooms  = selLoad && isPathfitSubject(selLoad.load.subject_code) ? rooms.filter(r => isPathfitVenue(r.room_name))
    : lockedRoom ? [lockedRoom]
    : selLoad?.component === 'lab' || oneRoom ? labRooms
    : subjectHasLab ? [...lectureRooms, ...labRooms] : lectureRooms;
  /** The class's other part's room — offered first in the Room picker */
  const pairRoom = selLoad ? pairedRoom(selLoad.load, selLoad.component, rooms) : null;
  /** Lec + Lab subjects: each part's room(s) — this part as being edited, the other as saved */
  const partRooms = (() => {
    if (!selLoad || toNum(selLoad.load.lecture_hours) <= 0 || !subjectHasLab) return null;
    const other: 'lec' | 'lab' = selLoad.component === 'lec' ? 'lab' : 'lec';
    const otherSessions = asSessionList<WorkloadSession>(selLoad.load.sessions)
      .filter(s => (s.type === 'lab' ? 'lab' : 'lec') === other);
    const parts = {} as Record<'lec' | 'lab', { names: string[]; scheduled: boolean }>;
    parts[selLoad.component] = {
      names: roomNamesOf(sessions.map(s => rooms.find(r => String(r.id) === s.room_id)?.room_name)),
      scheduled: true,
    };
    parts[other] = { names: roomNamesOf(otherSessions.map(s => s.room_name)), scheduled: otherSessions.length > 0 };
    /** Not saved yet: the room the other part will use — this part's room (one room for both), else the one picked before */
    const otherDraftId = oneRoom && parts[other].names.length === 0
      ? sessions.find(x => x.room_id)?.room_id || (roomDraft && roomDraft.msId === selLoad.load.ms_id ? roomDraft.roomId : '')
      : '';
    const otherDraft = otherDraftId ? rooms.find(r => String(r.id) === otherDraftId)?.room_name ?? null : null;
    const both = parts.lec.names.length > 0 && parts.lab.names.length > 0;
    const same = both && parts.lec.names.length === 1 && parts.lab.names.length === 1 && parts.lec.names[0] === parts.lab.names[0];
    return { parts, same, different: both && !same, otherDraft };
  })();
  const showFacultySkeleton = useMinLoading(
    // Wait for the real remaining loads on first load so cards don't flash red
    facultyLoading || (summariesLoading && Object.keys(loadSummaries).length === 0),
    facultyList.length === 0 ? LOADING_DELAY : 0,
  ) || stepSkeleton;
  const showWorkloadSkeleton = useMinLoading(fetchingW, workload == null ? LOADING_DELAY : 0) || showDeleteSkeleton || stepSkeleton;

  /* ══════════════════════════════════════════
     VIEW: FACULTY
     ══════════════════════════════════════════ */
  if (view === 'faculty') {
    // Swap the static load LIMIT for the real remaining load for this term
    const facultyWithLoad = facultyList.map(f => {
      const s = loadSummaries[f.id];
      const withN = { ...f, unscheduled_count: unscheduledMap[f.id] ?? 0 };
      return s ? { ...withN, remaining_regular_load: s.remaining_load } : withN;
    });
    const searched = facultyWithLoad.filter(f =>
      f.name.toLowerCase().includes(facultySearch.toLowerCase()) ||
      f.employee_id.toLowerCase().includes(facultySearch.toLowerCase())
    );
    /* Unscheduled = has classes still needing a day/time. Scheduled = has classes,
       all with a day/time. Faculty with no classes yet appear only under All. */
    const isUnscheduled = (f: { unscheduled_count: number }) => f.unscheduled_count > 0;
    const isScheduled = (f: { id: number; unscheduled_count: number }) =>
      f.unscheduled_count === 0 && (loadSummaries[f.id]?.assigned_count ?? 0) > 0;
    const scheduledCount = searched.filter(isScheduled).length;
    const unscheduledCount = searched.filter(isUnscheduled).length;
    const filtered = searched.filter(f =>
      schedFilter === 'all' || (schedFilter === 'scheduled' ? isScheduled(f) : isUnscheduled(f)));
    const facultyPageCount = Math.max(1, Math.ceil(filtered.length / FACULTY_PAGE_SIZE));
    const safeFacultyPage = Math.min(facultyPage, facultyPageCount);
    function goToFacultyPage(next: number) {
      setFacultyPageDir(next > safeFacultyPage ? 1 : -1);
      setFacultyPage(next);
      // From the pager at the bottom, bring the top of the list back into view
      const top = facultyListRef.current?.getBoundingClientRect().top ?? 0;
      if (top < 130) facultyListRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }

    return (
      <motion.div
        className="relative p-4 sm:p-6 max-w-3xl mx-auto w-full min-w-0"
        initial={reduceMotion ? false : { opacity: 0, x: -24 }}
        animate={{ opacity: 1, x: 0, transition: { duration: reduceMotion ? 0 : 0.5, ease: SETTLE } }}
      >
        <div className="mb-8">
          <BackButton />
          <div className="mt-4 sm:mt-7">
            <WatermarkTitle>Class Assignment</WatermarkTitle>
          </div>
        </div>

        <SchedulingStepper current={0} />

          <div className="bg-white border border-[#E2E8F0] rounded-2xl p-4 sm:p-6 shadow-sm">
            {/* Phones: two equal boxes side by side */}
            <div className="grid grid-cols-2 gap-3 mb-4 sm:flex sm:items-center sm:flex-wrap">
              <div className="flex flex-col gap-1.5 min-w-0">
                <label className="text-xs font-bold text-[#64748B] uppercase tracking-widest">Semester</label>
                <div className="bg-[#F8FAFC] border border-[#E2E8F0] text-[#0B2A5B] rounded-xl px-3.5 py-2 text-sm font-semibold sm:min-w-[160px] truncate cursor-default select-none">
                  {semester || '—'}
                </div>
              </div>
              <div className="flex flex-col gap-1.5 min-w-0">
                <label className="text-xs font-bold text-[#64748B] uppercase tracking-widest">School Year</label>
                <div className="bg-[#F8FAFC] border border-[#E2E8F0] text-[#0B2A5B] rounded-xl px-3.5 py-2 text-sm font-semibold sm:min-w-[140px] truncate cursor-default select-none">
                  {schoolYear || '—'}
                </div>
              </div>
            </div>

            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
              <input value={facultySearch} onChange={e => setFacultySearch(e.target.value)}
                placeholder="Search faculty by name…"
                className="w-full bg-white border border-[#E2E8F0] rounded-xl pl-9 pr-4 py-2.5 text-sm text-[#0B2A5B] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/40 focus:border-[#1D5BD6] transition-colors" />
            </div>

            <CountFilterTabs
              className="mb-5"
              label="Filter by schedule status"
              layoutId="scheduling-sched-filter"
              value={schedFilter}
              onChange={setSchedFilter}
              options={[
                { key: 'all', label: 'All', count: searched.length, color: '#0B2A5B' },
                { key: 'scheduled', label: 'Scheduled', count: scheduledCount, color: '#15803D', dot: '#16A34A' },
                { key: 'unscheduled', label: 'Unscheduled', count: unscheduledCount, color: '#B91C1C', dot: '#DC2626' },
              ]}
            />

            <PageLoadTransition
              showSkeleton={showFacultySkeleton}
              skeleton={<ListSkeleton rows={6} />}
            >
              <div ref={facultyListRef} className="scroll-mt-32 overflow-x-clip -mx-1 px-1">
                <motion.div
                  // A new page eases in from the side it came from; a filter or search fades up
                  key={`${schedFilter}-${safeFacultyPage}`}
                  initial={reduceMotion ? false : facultyPageDir === 0 ? { opacity: 0, y: 8 } : { opacity: 0, x: 28 * facultyPageDir }}
                  animate={{ opacity: 1, x: 0, y: 0 }}
                  transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
                >
                  <FacultyGroup
                    items={filtered}
                    page={safeFacultyPage}
                    pageSize={FACULTY_PAGE_SIZE}
                    selectedId={selFaculty?.id}
                    // Opens at once — the schedule shows its skeleton while it loads
                    onSelect={f => router.push(buildStepUrl({ step: 'schedule', faculty: String(f.id), type: undefined }))}
                  />
                  {filtered.length === 0 && (
                    <div className="text-center py-16 text-[#94A3B8] text-sm">
                      {schedFilter === 'unscheduled' && searched.length > 0
                        ? 'No classes left to schedule.'
                        : schedFilter === 'scheduled' && searched.length > 0
                          ? 'No faculty has every class scheduled yet.'
                          : 'No faculty found.'}
                    </div>
                  )}
                </motion.div>
              </div>
              {/* Outside the sliding list, so it stays put and its highlight slides to the new page */}
              <Pagination
                className="pt-4 border-t border-[#E2E8F0]"
                layoutId="scheduling-faculty-page"
                page={safeFacultyPage}
                pageCount={facultyPageCount}
                onChange={goToFacultyPage}
                total={filtered.length}
                pageSize={FACULTY_PAGE_SIZE}
                noun="faculty"
              />
            </PageLoadTransition>
          </div>
      </motion.div>
    );
  }

  /* ══════════════════════════════════════════
     VIEW: SCHEDULE DASHBOARD
     ══════════════════════════════════════════ */
  const loads = (workload?.loads ?? []).filter(
    l => l.block_semester === semester && l.block_academic_year === schoolYear
  );
  const praise   = workload?.praise ?? [];
  const isPermanent = selFaculty?.employment_status === 'Permanent';
  const allRows       = expandLoads(loads, isPermanent);
  const pendingRows   = allRows.filter(r => !r.isOverloadComponent && !r.isPraiseComponent && !r.isScheduled);
  const overloadRows  = allRows.filter(r =>  r.isOverloadComponent && !r.isScheduled);
  const praiseRows    = allRows.filter(r =>  r.isPraiseComponent && !r.isScheduled);
  const scheduledRows = allRows.filter(r => r.isScheduled);
  /* Search ignores case, spaces and dashes: "ee1" finds EE 1, "2a" finds block 2A */
  const searchKey = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[\s\-_.]/g, '');
  const subjectQuery = searchKey(subjectSearch);
  const matchesQuery = (r: LoadRow, q: string) => {
    const block = blockCode(r.load.year_level, r.load.block_name);
    return [r.load.subject_code, r.load.subject_name, block, `${r.load.program_code ?? ''}${block}`]
      .some(v => searchKey(v).includes(q));
  };
  const typeOk = (r: LoadRow) => typeFilter === 'all' || r.component === typeFilter;
  /** Rows shown in a section: the Lecture / Laboratory switch, then the search */
  const byType = (rows: LoadRow[]) => rows.filter(r => typeOk(r) && (!subjectQuery || matchesQuery(r, subjectQuery)));
  /* The list groups by load — Regular, Overload, Praise — scheduled or not */
  const regularAll  = allRows.filter(r => !r.isOverloadComponent && !r.isPraiseComponent);
  const overloadAll = allRows.filter(r => r.isOverloadComponent);
  const praiseAll   = allRows.filter(r => r.isPraiseComponent);
  const toSchedule  = pendingRows.length + overloadRows.length + praiseRows.length;
  const noMatch = subjectQuery ? 'No subjects match your search.' : null;

  interface TimetableBlock {
    load: WorkloadLoad;
    component: 'lec' | 'lab';
    label: 'Lec' | 'Lab';
    blockKey: string;
    start_time: string;
    end_time: string;
    /** Single calendar day for this session (not a day_pattern). */
    day: string;
    room_name: string | null;
  }

  /** One timetable block per schedule_sessions row — never collapse same-day splits. */
  const timetableBlocks: TimetableBlock[] = [];
  for (const l of loads) {
    const rawSessions = asSessionList<WorkloadSession>(l.sessions);
    if (rawSessions.length > 0) {
      for (const sess of rawSessions) {
        const st = normTime(sess.start_time);
        const et = normTime(sess.end_time);
        if (!sess.day || !st || !et) continue;
        const comp: 'lec' | 'lab' = (sess.type === 'lab') ? 'lab' : 'lec';
        timetableBlocks.push({
          load: l,
          component: comp,
          label: comp === 'lab' ? 'Lab' : 'Lec',
          blockKey: `${l.ms_id}-${comp}-${sess.id}`,
          start_time: st,
          end_time: et,
          day: sess.day,
          // This meeting's own room — never another meeting's (the class's first room)
          room_name: sess.room_name ?? null,
        });
      }
      continue;
    }

    // Fallback for older payloads without sessions[] (first-session fields only)
    const hasLec   = (parseFloat(String(l.lecture_hours))    || 0) > 0;
    const hasLab   = (parseFloat(String(l.laboratory_hours)) || 0) > 0;
    const isLecLab = hasLec && hasLab;
    if (isLecLab) {
      if (l.lec_scheduled === true && l.lec_start_time && l.lec_end_time) {
        for (const day of parseDays(l.lec_day_pattern ?? l.day_pattern ?? '')) {
          timetableBlocks.push({
            load: l, component: 'lec', label: 'Lec', blockKey: `${l.ms_id}-lec-${day}`,
            start_time: normTime(l.lec_start_time), end_time: normTime(l.lec_end_time),
            day, room_name: l.room_name,
          });
        }
      }
      if (l.lab_scheduled === true && l.lab_start_time && l.lab_end_time) {
        for (const day of parseDays(l.lab_day_pattern ?? l.day_pattern ?? '')) {
          timetableBlocks.push({
            load: l, component: 'lab', label: 'Lab', blockKey: `${l.ms_id}-lab-${day}`,
            start_time: normTime(l.lab_start_time), end_time: normTime(l.lab_end_time),
            day, room_name: l.room_name,
          });
        }
      }
    } else {
      const isSched = l.lec_scheduled === true || l.lab_scheduled === true || l.schedule_status === 'Scheduled';
      if (!isSched) continue;
      const comp: 'lec' | 'lab' = hasLab ? 'lab' : 'lec';
      const st   = normTime(comp === 'lec' ? (l.lec_start_time ?? l.start_time) : (l.lab_start_time ?? l.start_time));
      const et   = normTime(comp === 'lec' ? (l.lec_end_time   ?? l.end_time)   : (l.lab_end_time   ?? l.end_time));
      const dp   = comp === 'lec' ? (l.lec_day_pattern ?? l.day_pattern) : (l.lab_day_pattern ?? l.day_pattern);
      if (!st || !et || !dp) continue;
      for (const day of parseDays(dp)) {
        timetableBlocks.push({
          load: l, component: comp, label: comp === 'lec' ? 'Lec' : 'Lab',
          blockKey: `${l.ms_id}-${comp}-${day}`, start_time: st, end_time: et,
          day, room_name: l.room_name,
        });
      }
    }
  }
  // Timetable columns / colours / legend follow the semester's day combinations
  const timetableLayout = buildDayLayout(timetableBlocks, dayCombos);

  return (
    <div className="relative flex flex-col w-full min-w-0 min-h-0 h-full p-4 sm:p-6">

      {/* Save-success check — identical markup/animation to the other pages */}
      {saveSuccess && (
        <div className="fixed inset-x-0 bottom-0 top-[72px] z-40 flex flex-col items-center justify-center save-success-overlay qr-overlay-page" role="status" aria-live="polite">
          <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-[#111827] border border-white/10 shadow-2xl">
            <svg width="72" height="72" viewBox="0 0 52 52" aria-hidden="true">
              <circle className="save-success-circle" cx="26" cy="26" r="24" fill="none" stroke="#22C55E" strokeWidth="3" />
              <path
                className="save-success-check"
                fill="none" stroke="#22C55E" strokeWidth="3.5"
                strokeLinecap="round" strokeLinejoin="round"
                d="M14.5 27 22 34.5 38 17"
              />
            </svg>
            <p className="text-base font-semibold text-white">Schedule saved!</p>
          </div>
        </div>
      )}

      {/* ── Header: back to the faculty list, the faculty, the term — one for every screen ── */}
      <div className="mb-3">
        {/* ── Header / Breadcrumb ─────────────────────── */}
        <div className="flex-shrink-0 bg-white border border-[#E2E8F0] rounded-2xl px-4 sm:px-6 py-3 shadow-sm">
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <motion.button
                type="button"
                onClick={goBack}
                aria-busy={leaving}
                aria-label={leaving ? 'Going back…' : `Back to ${fromMsId ? 'Master Schedule' : 'All Faculty'}`}
                whileHover={reduceMotion || leaving ? undefined : { x: -3 }}
                whileTap={reduceMotion || leaving ? undefined : { scale: 0.9 }}
                transition={{ duration: 0.25, ease: SETTLE }}
                className={`text-[#64748B] hover:text-[#0B2A5B] transition-colors ${leaving ? 'cursor-wait' : ''}`}
              >
                {/* Clicked: the arrow becomes a spinning ring of the same size (nothing moves) */}
                {leaving
                  ? <span className="block w-5 h-5 p-0.5" aria-hidden><span className="block w-full h-full rounded-full border-[2.5px] border-[#BFD3F5] border-t-[#1D5BD6] animate-spin" /></span>
                  : <ChevronLeft className="w-5 h-5" />}
              </motion.button>
              <div className="flex items-center gap-1.5 text-sm text-[#64748B] min-w-0">
                <button
                  type="button"
                  onClick={goBack}
                  aria-busy={leaving}
                  className={`text-[#1D5BD6] hover:text-[#164BB5] font-medium whitespace-nowrap ${leaving ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
                  // Same size as the name beside it (the global button rule would make it 16px)
                  style={{ fontSize: 'inherit' }}
                >
                  {fromMsId ? 'Master Schedule' : 'All Faculty'}
                </button>
                <ChevronRight className="w-4 h-4 flex-shrink-0" />
                <span className="text-[#0B2A5B] font-semibold truncate">{selFaculty?.name}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={openTimetable}
                aria-label="View Timetable"
                title="View Timetable"
                className="qr-glow-btn inline-flex items-center gap-1.5 px-3 sm:px-3.5 py-2 rounded-xl text-sm font-semibold"
              >
                <CalendarDays className="w-4 h-4" />
                {/* Phones: the icon alone, so the faculty's name has room */}
                <span className="hidden sm:inline">View Timetable</span>
              </button>
              <button
                type="button"
                onClick={fetchWorkload}
                title="Refresh"
                className="p-2 rounded-lg hover:bg-[#F1F5F9] text-[#64748B] hover:text-[#0B2A5B] transition border border-transparent hover:border-[#E2E8F0]"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Context strip */}
          <div className="flex items-center gap-2 mt-2.5 px-3.5 py-2.5 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex-wrap text-sm">
            <CalendarDays className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
            <span className="font-bold text-[#1D5BD6]">{semester || '—'} · {schoolYear || '—'}</span>
            {selFaculty && (
              <>
                <span className="text-[#93C5FD]">•</span>
                <EmploymentBadge status={selFaculty.employment_status} />
                {selFaculty.specialization && (
                  <>
                    <span className="text-[#93C5FD]">•</span>
                    <span className="text-[#1D5BD6] truncate">{selFaculty.specialization}</span>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Body: the faculty's subjects as a list (main) · the schedule editor on the right,
          only while a subject is open. Phones: one at a time (the editor's X goes back). ── */}
      <motion.div
        className="relative flex flex-1 min-h-0 min-w-0 gap-3"
        initial={reduceMotion ? false : { opacity: 0, x: 24 }}
        animate={leaving
          ? { opacity: 0, x: 32, transition: { duration: reduceMotion ? 0 : BACK_OUT_MS / 1000, ease: LEAVE } }
          : { opacity: 1, x: 0, transition: { duration: reduceMotion ? 0 : 0.5, ease: SETTLE } }}
      >

        {/* ── Assigned subjects ── */}
        {/* While a subject is open it folds to about a quarter — the subjects stay in sight
            (the one being edited marked), and the editor gets the rest */}
        <div className={`${selLoad ? 'hidden lg:flex lg:basis-[300px] xl:basis-[340px]' : 'flex lg:basis-full'} w-full lg:w-auto lg:flex-none lg:transition-[flex-basis] lg:duration-[600ms] lg:ease-[cubic-bezier(0.65,0,0.35,1)] min-w-0 min-h-0 flex-col rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] shadow-sm overflow-hidden`}>
          <div className={`flex-shrink-0 ${selLoad ? 'px-3' : 'px-4'} py-3 border-b border-[#E2E8F0] bg-white flex flex-wrap items-center gap-x-4 gap-y-2.5 transition-[padding] duration-500`}>
            <div className="flex items-center gap-2.5 min-w-0 mr-auto">
              <h2 className="text-sm font-bold text-[#0B2A5B] uppercase tracking-widest">Assigned Subjects</h2>
              {workload && (
                <>
                  <span className={`inline-flex items-center h-6 px-2 rounded-full text-xs font-semibold border tabular-nums whitespace-nowrap ${
                    toSchedule > 0 ? 'text-red-600 bg-red-50 border-red-200' : 'text-[#94A3B8] bg-[#F4F7FC] border-[#E3E9F3]'
                  }`}>{toSchedule} to schedule</span>
                  <span className="inline-flex items-center h-6 px-2 rounded-full text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 tabular-nums whitespace-nowrap">{scheduledRows.length} done</span>
                </>
              )}
            </div>
            {/* All | Lecture | Laboratory — filters every load below (hidden while folded);
                it fades in once the list has widened, and out at once when it folds */}
            <AnimatePresence initial={false}>
            {!selLoad && (
            <motion.div
              key="type-filter"
              className="w-full sm:w-[340px]"
              initial={reduceMotion ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.4, ease: GLIDE, delay: reduceMotion ? 0 : 0.32 } }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transition: { duration: 0.12, ease: LEAVE } }}
            >
              <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[#F1F5F9] border border-[#E2E8F0]" role="group" aria-label="Filter by type">
                {([
                  { id: 'all' as const, label: 'All',        Icon: null,     on: 'text-[#0B2A5B]' },
                  { id: 'lec' as const, label: 'Lecture',    Icon: BookOpen, on: 'text-[#1D5BD6]' },
                  { id: 'lab' as const, label: 'Laboratory', Icon: Monitor,  on: 'text-amber-600' },
                ]).map(t => {
                  const active = typeFilter === t.id;
                  return (
                    <motion.button
                      key={t.id}
                      type="button"
                      aria-pressed={active}
                      // Shown only with no subject open, so nothing open can fall outside the filter
                      onClick={() => setTypeFilter(t.id)}
                      title={t.id === 'all' ? 'Show all subjects' : `Show ${t.label} subjects only`}
                      whileTap={reduceMotion ? undefined : { scale: 0.95 }}
                      transition={{ duration: 0.22, ease: SETTLE }}
                      className={`relative inline-flex items-center justify-center h-9 rounded-lg text-[14px] font-semibold transition-colors duration-300 ${
                        active ? t.on : 'text-[#64748B] hover:text-[#0B2A5B] hover:bg-white/50'
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId="sched-type-filter"
                          aria-hidden
                          className="absolute inset-0 rounded-lg bg-white shadow-[0_2px_8px_-3px_rgba(11,42,91,0.25)]"
                          transition={{ duration: reduceMotion ? 0 : 0.42, ease: SETTLE }}
                        />
                      )}
                      <span className="relative inline-flex items-center gap-1.5">
                        {t.Icon && <t.Icon className="w-4 h-4" />}
                        {t.label}
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>
            )}
            {allRows.length > 0 && !selLoad && (
              <motion.div
                key="subject-search"
                className="w-full sm:w-72"
                initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.4, ease: GLIDE, delay: reduceMotion ? 0 : 0.38 } }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transition: { duration: 0.12, ease: LEAVE } }}
              >
                <SearchInput
                  value={subjectSearch}
                  onChange={setSubjectSearch}
                  placeholder="Find subject or block — e.g. CHEM 1, 2A"
                  className="w-full"
                />
              </motion.div>
            )}
            </AnimatePresence>
          </div>

          <div className="flex-1 overflow-y-auto @container">
            <PageLoadTransition
              showSkeleton={showWorkloadSkeleton}
              skeleton={
                <div className="p-4">
                  <TableSkeleton rows={6} cols={4} />
                </div>
              }
            >
              <AnimatePresence mode="wait" initial={false}>
              <motion.div
                // A new type, or folding / unfolding: the old rows fade out, the new ones fade in
                // a moment later — by then the list has the width they are laid out for
                key={`${typeFilter}|${selLoad ? 'folded' : 'full'}`}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.45, ease: GLIDE, delay: reduceMotion ? 0 : 0.14 } }}
                exit={reduceMotion ? { opacity: 1 } : { opacity: 0, transition: { duration: 0.16, ease: LEAVE } }}
                className={`${selLoad ? 'p-2.5 space-y-3' : 'p-3 sm:p-4 space-y-4'}`}
              >
                {regularAll.length > 0 && (
                  <SubjectSection
                    title="Regular Load"
                    compact={!!selLoad}
                    tone="blue"
                    rows={byType(regularAll)}
                    activeKey={selLoad?.key}
                    onOpen={selectLoad}
                    onPreview={openSubjectPreview}
                    flashKey={selLoad ? null : closedKey}
                    empty={noMatch ?? `No ${typeFilter === 'lec' ? 'Lecture' : 'Laboratory'} subjects here.`}
                  />
                )}
                {overloadAll.length > 0 && (
                  <SubjectSection
                    title="Overload"
                    compact={!!selLoad}
                    tone="orange"
                    rows={byType(overloadAll)}
                    activeKey={selLoad?.key}
                    onOpen={selectLoad}
                    onPreview={openSubjectPreview}
                    flashKey={selLoad ? null : closedKey}
                    empty={noMatch ?? `No ${typeFilter === 'lec' ? 'Lecture' : 'Laboratory'} overload subjects.`}
                  />
                )}
                {praiseAll.length > 0 && (
                  <SubjectSection
                    title="Praise Load"
                    compact={!!selLoad}
                    tone="gold"
                    rows={byType(praiseAll)}
                    activeKey={selLoad?.key}
                    onOpen={selectLoad}
                    onPreview={openSubjectPreview}
                    flashKey={selLoad ? null : closedKey}
                    empty={noMatch ?? `No ${typeFilter === 'lec' ? 'Lecture' : 'Laboratory'} Praise Load subjects.`}
                  />
                )}
                {/* Praise tasks (not subjects) — nothing to schedule, listed for reference */}
                {praise.length > 0 && !selLoad && (
                  <section className="rounded-xl border border-yellow-300 bg-white overflow-hidden shadow-sm">
                    <div className="flex items-center gap-2 px-4 py-2.5 border-b bg-yellow-50 border-yellow-300">
                      <h3 className="text-[14px] font-bold uppercase tracking-widest text-yellow-700">Praise Tasks</h3>
                      <span className="text-[13px] font-bold border rounded-full px-2 py-0.5 tabular-nums bg-yellow-100 text-yellow-800 border-yellow-300">{praise.length}</span>
                    </div>
                    <div className="overflow-y-auto flex-1 overscroll-contain">
                      {praise.map(p => (
                        <div key={p.id} className="px-4 py-3 border-b border-[#F1F5F9] last:border-0">
                          <div className="text-[13px] font-semibold text-[#0B2A5B]">{p.praise_type ?? p.task_type ?? 'Praise task'}</div>
                          {p.description && <div className="text-xs text-[#64748B] mt-0.5">{p.description}</div>}
                          <div className="text-xs text-[#64748B] mt-0.5">{Number(p.equivalent_units ?? p.units ?? 0).toFixed(2)} units</div>
                        </div>
                      ))}
                    </div>                  </section>
                )}
                {loads.length === 0 && !fetchingW && (
                  <div className="flex flex-col items-center justify-center py-14 px-4 text-center">
                    <p className="text-[15px] text-[#64748B]">No subjects assigned yet.</p>
                  </div>
                )}
              </motion.div>
              </AnimatePresence>
            </PageLoadTransition>
          </div>
        </div>

        {/* ── Schedule editor: a narrow column on the right, fields one under another ── */}
        {/* popLayout: a closing editor leaves the row at once and fades out on top,
            so the list unfolds smoothly instead of squeezing it. It is out of sight by 0.42 s
            but only removed at 0.85 s, once everything else has settled (removing the large
            form mid-glide drops a frame); ExitClickGuard lets clicks through meanwhile */}
        <AnimatePresence initial={false} mode="popLayout">
          {selLoad && (
            <motion.aside
              key="editor"
              initial={reduceMotion ? false : { opacity: 0, x: 40, scale: 0.985 }}
              animate={{ opacity: 1, x: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.55, ease: SETTLE } }}
              exit={reduceMotion ? { opacity: 0 } : {
                opacity: 0, x: 36, scale: 0.985,
                transition: { duration: 0.85, ease: FLOW, opacity: { duration: 0.42, ease: FLOW } },
              }}
              style={{ transformOrigin: '100% 50%' }}
              aria-label="Schedule editor"
              className="flex w-full lg:w-auto lg:flex-1 min-h-0 min-w-0 flex-col rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] shadow-sm overflow-hidden"
            >
              <ExitClickGuard />
              {/* What is being scheduled, and the way out */}
              <div className={`flex-shrink-0 px-4 py-3 border-b border-[#E2E8F0] bg-white border-l-[4px] ${
                selLoad.component === 'lec' ? 'border-l-[#1D5BD6]' : 'border-l-amber-500'
              }`}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-lg font-bold text-[#0B2A5B] leading-tight">{selLoad.load.subject_code}</span>
                      {selLoad.load.block_name && (
                        <span
                          className="text-[13px] font-bold px-2 py-0.5 rounded-md bg-[#1E4FB8] leading-tight"
                          // White set inline — the light-mode rule repaints `text-white` as dark ink
                          style={{ color: '#FFFFFF' }}
                          title={`Block ${selLoad.load.block_name}`}
                        >
                          {blockCode(selLoad.load.year_level, selLoad.load.block_name)}
                        </span>
                      )}
                      <span className={`inline-flex items-center gap-1.5 text-[13px] font-bold px-2 py-0.5 rounded-full border ${
                        selLoad.component === 'lec' ? 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]' : 'bg-amber-50 text-amber-700 border-amber-200'
                      }`}>
                        {selLoad.component === 'lec' ? <BookOpen className="w-3.5 h-3.5" /> : <Monitor className="w-3.5 h-3.5" />}
                        {selLoad.label === 'Lec' ? 'Lecture' : 'Laboratory'}
                      </span>
                      {selLoad.splitLabel && (
                        <span className={`text-[13px] font-bold px-2 py-0.5 rounded-full border ${
                          selLoad.splitLabel === 'Overload' ? 'bg-orange-50 text-orange-700 border-orange-200'
                            : selLoad.splitLabel === 'Praise' ? 'bg-yellow-50 text-yellow-800 border-yellow-300'
                            : 'bg-slate-50 text-slate-500 border-slate-200'
                        }`}>{selLoad.splitLabel}</span>
                      )}
                    </div>
                    <div className="mt-1 text-[14px] text-[#475569] leading-snug truncate" title={selLoad.load.subject_name}>
                      {[selLoad.load.program_code, selLoad.load.subject_name].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setPreviewWhole(false); setPreviewRow(selLoad); }}
                    title="See everyone teaching this subject"
                    aria-label={`View schedule details for ${selLoad.load.subject_code}`}
                    className="flex-shrink-0 w-9 h-9 rounded-lg border border-[#BFD3F5] bg-[#EFF5FF] text-[#1D5BD6] hover:bg-[#DCE8FC] flex items-center justify-center transition"
                  >
                    <Eye className="w-4 h-4" />
                  </button>
                  <motion.button
                    type="button"
                    onClick={() => closeEditor(selLoad.key)}
                    title="Close"
                    aria-label="Close the schedule editor"
                    whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                    transition={{ duration: 0.22, ease: SETTLE }}
                    className="group/x flex-shrink-0 w-9 h-9 rounded-lg border border-[#E2E8F0] bg-white text-[#475569] hover:bg-[#F1F5F9] hover:text-[#0B2A5B] flex items-center justify-center transition-colors duration-300"
                  >
                    <X className="w-5 h-5 transition-transform duration-300 ease-out group-hover/x:rotate-90" />
                  </motion.button>
                </div>
              </div>

              {/* Days, sessions and each session's day / time / room — one under another */}
              <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 @container">
                {panelSwitching ? (
                <div className="space-y-3" role="status" aria-live="polite" aria-label="Loading subject">
                  {/* Subject header skeleton */}
                  <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden shadow-sm px-4 sm:px-5 py-4 space-y-2">
                    <Skeleton className="h-5 w-48 rounded" />
                    <Skeleton className="h-4 w-64 rounded" />
                    <Skeleton className="h-4 w-56 rounded" />
                  </div>

                  {/* Sessions card skeleton */}
                  <div className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm flex items-center gap-3">
                    <Skeleton className="h-4 w-20 rounded" />
                    <Skeleton className="h-7 w-24 rounded-lg" />
                  </div>

                  {/* Session schedule table skeleton */}
                  <TableSkeleton rows={2} cols={6} />
                </div>
                ) : (
                  <>
                    {/* Lec + Lab subject: both parts' rooms side by side — one room for both where it fits */}
                    {partRooms && (
                      <div className="flex flex-col items-stretch @lg:flex-row @lg:flex-wrap @lg:items-center gap-2">
                        {(['lec', 'lab'] as const).map(part => {
                          const p = partRooms.parts[part];
                          const editing = part === selLoad.component;
                          return (
                            <span
                              key={part}
                              className={`flex items-center gap-2 min-h-10 px-3 py-1.5 rounded-lg border text-[15px] ${
                                part === 'lec' ? 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1D5BD6]' : 'bg-amber-50 border-amber-200 text-amber-700'
                              } ${editing ? 'ring-2 ring-offset-1 ring-[#1D5BD6]/25' : ''}`}
                              title={editing ? 'The part you are scheduling' : `Saved ${part === 'lec' ? 'Lecture' : 'Laboratory'} room`}
                            >
                              {part === 'lec' ? <BookOpen className="w-4 h-4" /> : <Monitor className="w-4 h-4" />}
                              <span className="font-bold">{part === 'lec' ? 'Lecture' : 'Laboratory'}</span>
                              <span className="font-semibold text-[#0B2A5B]">
                                {p.names.length ? `in ${p.names.join(', ')}`
                                  : !editing && partRooms.otherDraft ? `· ${partRooms.otherDraft} (not saved yet)`
                                  : p.scheduled ? '· no room yet' : '· not scheduled yet'}
                              </span>
                            </span>
                          );
                        })}
                        {partRooms.same && <span className="text-[14px] font-semibold text-emerald-700">Same room</span>}
                        {partRooms.different && (oneRoom
                          ? <span className="text-[14px] font-semibold text-red-700">Must use one room</span>
                          : <span className="text-[14px] font-semibold text-amber-700">Different rooms</span>)}
                      </div>
                    )}
                    {error && (
                      <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-xl text-[13px] flex gap-2">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {error}
                      </div>
                    )}
                    {success && (
                      <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 px-3 py-2 rounded-xl text-[13px] flex gap-2">
                        <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {success}
                      </div>
                    )}


                    {/* Meeting days and sessions per week, side by side */}
                    <div className="grid gap-3 @lg:grid-cols-[minmax(0,1fr)_auto] items-stretch">
                    {/* Meeting days (the semester's day combinations) */}
                    {dayCombos.length > 0 && (
                      <div className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm">
                        <StepLabel>Meeting days</StepLabel>
                        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Day combination">
                          {dayCombos.map(c => {
                            const on = currentCombo === c;
                            // Major Lec + Lab: only its other part's days
                            const pairLocked = !!pairDays && c.days.join() !== pairDays.join();
                            // More days than sessions allowed (e.g. MWF): can't be used
                            const tooMany = c.days.length > MAX_SESSIONS;
                            const locked = pairLocked || tooMany;
                            return (
                              <motion.button
                                key={c.id}
                                type="button"
                                onClick={() => applyCombination(c.days)}
                                disabled={locked}
                                whileTap={reduceMotion || locked ? undefined : { scale: 0.95 }}
                                aria-pressed={on}
                                title={pairLocked ? `Its ${otherPartName} is on ${pairDaysText} — both parts use the same days`
                                  : tooMany ? `${daysLabel(c.days)} — up to ${MAX_SESSIONS} sessions a week` : daysLabel(c.days)}
                                className={`relative h-10 min-w-[56px] px-4 rounded-lg border text-sm font-bold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                  on ? 'border-[#0B2A5B]' : 'bg-white border-[#D6E0EF] text-[#0B2A5B] hover:border-[#9DB8E8] hover:bg-[#F8FAFE] disabled:hover:border-[#D6E0EF] disabled:hover:bg-white'
                                }`}
                                style={on ? { color: '#FFFFFF' } : undefined}
                              >
                                {on && (
                                  <motion.span layoutId="sched-day-combo" aria-hidden className="absolute inset-[-1px] rounded-lg bg-[#0B2A5B]"
                                    transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.4, 0, 0.2, 1] }} />
                                )}
                                <span className="relative">{daysCode(c.days)}</span>
                              </motion.button>
                            );
                          })}
                        </div>
                        {pairDays && (
                          <p className="mt-1.5 text-xs font-medium text-[#475569]">Same days as its {otherPartName}: <b className="text-[#0B2A5B]">{pairDaysText}</b> · times may differ</p>
                        )}
                      </div>
                    )}

                    {/* Sessions per week */}
                    <div className="bg-white rounded-xl border border-[#E2E8F0] p-3 shadow-sm">
                      <StepLabel>Sessions per week</StepLabel>
                      {/* One joined stepper: − count + — the count can also be typed (1 to MAX_SESSIONS) */}
                      <div className="inline-flex items-stretch h-10 rounded-lg border border-[#D6E0EF] bg-white overflow-hidden">
                        <motion.button type="button" onClick={() => setSessionCount(shownCount - 1)}
                          disabled={shownCount <= 1}
                          whileTap={reduceMotion || shownCount <= 1 ? undefined : { scale: 0.92 }}
                          aria-label="Fewer sessions" title="Fewer sessions"
                          className="w-10 flex items-center justify-center text-[#475569] hover:bg-[#F1F5F9] transition-colors text-lg font-bold disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent">−</motion.button>
                        <input
                          type="text"
                          inputMode="numeric"
                          aria-label={`Sessions per week (1 to ${MAX_SESSIONS})`}
                          title={`Type 1 to ${MAX_SESSIONS} — up to ${MAX_SESSIONS} sessions a week`}
                          value={countText ?? String(shownCount)}
                          onFocus={e => e.currentTarget.select()}
                          onChange={e => {
                            // The last digit typed wins; past the limit it stops at the limit
                            const d = e.target.value.replace(/\D/g, '').slice(-1);
                            if (!d) { setCountText(''); return; }
                            setCountText(null);
                            setSessionCount(Number(d));
                          }}
                          onBlur={() => setCountText(null)}
                          onKeyDown={e => {
                            if (e.key === 'ArrowUp') { e.preventDefault(); setSessionCount(shownCount + 1); }
                            if (e.key === 'ArrowDown') { e.preventDefault(); setSessionCount(shownCount - 1); }
                            if (e.key === 'Enter') e.currentTarget.blur();
                          }}
                          className="w-12 text-center text-base font-bold text-[#0B2A5B] border-x border-[#E2E8F0] tabular-nums bg-white focus:outline-none focus:bg-[#EFF6FF]"
                        />
                        <motion.button type="button" onClick={() => setSessionCount(shownCount + 1)}
                          disabled={shownCount >= MAX_SESSIONS}
                          whileTap={reduceMotion || shownCount >= MAX_SESSIONS ? undefined : { scale: 0.92 }}
                          aria-label="More sessions" title={shownCount >= MAX_SESSIONS ? `Up to ${MAX_SESSIONS} sessions a week` : 'More sessions'}
                          className="w-10 flex items-center justify-center text-[#475569] hover:bg-[#F1F5F9] transition-colors text-lg font-bold disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-transparent">+</motion.button>
                      </div>
                      {oneRoom && <p className="mt-2 text-xs text-[#64748B] leading-snug max-w-[16rem]">
                        {lockedRoom
                          ? <>Major subject — same room as its {otherPartName}: <b className="text-[#0B2A5B]">{lockedRoom.room_name}</b></>
                          : otherPartSessionMin
                            ? <>Major subject — one room for both parts. A room needs {otherPartLength} free for its {otherPartName} on the same days.</>
                            : 'Major subject — one room for every Lecture and Laboratory session.'}
                      </p>}
                    </div>
                    </div>

                    {/* The sessions side by side (one under another on a phone); in each, day, time and room */}
                    <div className="grid gap-3 @lg:grid-cols-2 items-start">
                    {sessions.map((sess, i) => {
                      const rowConflicts = sessionConflicts.filter(c => c.sessionId === sess.id);
                      const hasRowConflict = rowConflicts.length > 0;
                      return (
                        <div key={sess.id} className={`rounded-xl border p-3 space-y-2.5 shadow-sm transition-colors ${
                          hasRowConflict ? 'border-red-200 bg-red-50/70 shadow-[inset_3px_0_0_#EF4444]' : 'border-[#E2E8F0] bg-white'
                        }`}>
                          <div className="flex items-center gap-2.5">
                            <span className={`w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold flex-shrink-0 ${
                              hasRowConflict ? 'bg-red-100 text-red-700' : 'bg-[#EAF1FD] text-[#1D5BD6]'
                            }`}>{i + 1}</span>
                            <div className="min-w-0 flex-1 leading-tight">
                              <div className="text-[15px] font-bold text-[#0B2A5B]">
                                Session {i + 1} <span className="font-semibold text-[#64748B] tabular-nums">· {fmtHrs(toNum(sess.hours))}</span>
                              </div>
                              {hasRowConflict && (
                                <div className="mt-0.5 inline-flex items-center gap-1 text-[12px] font-semibold text-red-600">
                                  <AlertCircle className="w-3.5 h-3.5" /> {rowConflicts.every(c => c.type === 'time') ? 'Outside hours' : 'Conflict'}
                                </div>
                              )}
                            </div>
                            <motion.button type="button" onClick={() => removeSession(sess.id)}
                              whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                              aria-label={`Remove session ${i + 1}`} title={`Remove session ${i + 1}`}
                              className="w-9 h-9 rounded-lg border border-transparent text-[#94A3B8] hover:text-red-600 hover:bg-red-50 hover:border-red-200 flex items-center justify-center transition-colors">
                              <Trash2 className="w-4 h-4" />
                            </motion.button>
                          </div>
                          <SessionField label="Day">
                            <DayPicker
                              value={sess.day}
                              onChange={d => updateSession(sess.id, 'day', d)}
                              days={WEEK_DAYS.filter(d => !allowedDays || allowedDays.has(d)).map(d => {
                                const other = sessions.findIndex(o => o.id !== sess.id && o.day === d);
                                return {
                                  day: d,
                                  classes: instructorBusy.get(d)?.length ?? 0,
                                  freeStarts: freeStartTimes({ ...sess, day: d }).length,
                                  accent: timetableLayout.toneOf(d).bar,
                                  usedBy: other >= 0 ? `Session ${other + 1}` : undefined,
                                };
                              })}
                            />
                          </SessionField>
                          <SessionField label="Time">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <TimeSlotPicker
                                value={sess.start_time}
                                onChange={v => updateSession(sess.id, 'start_time', v)}
                                slots={slotConflicts(sess).map(x => ({ value: x.value, free: !x.conflict, conflict: x.conflict || undefined }))}
                                busy={dayBusy(sess)}
                                breaks={[LUNCH]}
                                durationMin={Math.round(toNum(sess.hours) * 60)}
                                day={sess.day}
                              />
                              <span className="text-[#CBD5E1] text-[13px]">→</span>
                              <span className="text-[#475569] text-xs font-semibold whitespace-nowrap flex items-center gap-1">
                                <Clock className="w-3.5 h-3.5 text-[#94A3B8]" /> {fmt12(sess.end_time)}
                              </span>
                            </div>
                          </SessionField>
                          <SessionField label="Room">
                            <RoomPicker
                              value={sess.room_id}
                              onChange={v => updateSession(sess.id, 'room_id', v)}
                              rooms={activeRooms
                                .map(r => {
                                  // Major subject: one room for both parts, so a room is only offered
                                  // when its other part still fits there on every session day
                                  const misfit = otherPartSessionMin ? sessions.find(s => !otherPartFits(s, r.id)) : undefined;
                                  return { r, misfit };
                                })
                                // Rooms that can't take both parts can't be picked: listed greyed out with the
                                // reason under the picker's folded line — unless already picked (then "Busy · why")
                                .map(({ r, misfit }) => {
                                  const picked = String(r.id) === sess.room_id;
                                  return {
                                    ...r,
                                    unavailable: misfit && !picked ? otherPartRoomShort(misfit.day) : null,
                                    busyWith: roomBusyWith(sess, r.id) || otherPartBusyWith(r.id)
                                      || (misfit ? otherPartRoomClash(misfit.day) : '') || null,
                                  };
                                })}
                              unavailableHint={otherPartSessionMin
                                ? `Its ${otherPartName} needs ${otherPartLength} free in the same room on these days.`
                                : undefined}
                              preferred={pairRoom ? { id: pairRoom.id, label: selLoad.component === 'lab' ? 'Its Lecture is here' : 'Its Laboratory is here' } : null}
                              component={selLoad.component}
                              day={sess.day}
                              timeLabel={sess.start_time ? `${fmt12(sess.start_time)} – ${fmt12(sess.end_time)}` : undefined}
                              warnEmpty={selLoad.component === 'lab'}
                            />
                          </SessionField>
                        </div>
                      );
                    })}
                    </div>

                    {hasLabRoomMissing && sessions.length > 0 && (
                      <div className="bg-amber-50 border border-amber-200 text-amber-700 px-4 py-3 rounded-xl text-[13px] flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                        No room assigned yet. You can assign a room later.
                      </div>
                    )}

                    {sessionConflicts.length > 0 && (
                      <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-3">
                        <div className="flex items-center gap-2 text-[13px] font-bold text-red-700">
                          <XCircle className="w-4 h-4 flex-shrink-0" />
                          {uniqueConflictCount} Conflict{uniqueConflictCount !== 1 ? 's' : ''} Detected — resolve before saving
                        </div>
                        {(['time', 'instructor', 'room', 'block', 'duplicate'] as ConflictInfo['type'][]).map(type => {
                          const group = sessionConflicts.filter(c => c.type === type);
                          if (group.length === 0) return null;
                          const uniqueInGroup = new Set(group.map(c => c.conflictKey)).size;
                          const cfg = {
                            time:       { label: 'Outside School Hours', color: 'text-red-700', dot: 'bg-red-500' },
                            instructor: { label: 'Faculty Conflict', color: 'text-red-700',    dot: 'bg-red-500' },
                            room:       { label: 'Room Conflict',       color: 'text-amber-700',  dot: 'bg-amber-500' },
                            block:      { label: 'Block Conflict',      color: 'text-amber-700',  dot: 'bg-amber-500'  },
                            duplicate:  { label: 'Duplicate Session',   color: 'text-purple-700', dot: 'bg-purple-500' },
                          }[type];
                          return (
                            <div key={type} className="space-y-1">
                              <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#64748B] uppercase tracking-wide">
                                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
                                {cfg.label}
                                {uniqueInGroup > 1 ? ` (${uniqueInGroup})` : ''}
                              </div>
                              {group.map((c, i) => (
                                <div key={`${c.conflictKey}-${i}`} className={`text-xs pl-3.5 leading-relaxed ${cfg.color}`}>{c.message}</div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {/* Major subject: one room for the Lecture and the Laboratory */}
                    {roomRuleError && sessions.length > 0 && (
                      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-[13px] flex items-start gap-2" role="alert">
                        <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {roomRuleError}
                      </div>
                    )}
                    {!roomRuleError && ruleNow?.move && sessions.length > 0 && (
                      <div className="bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D5BD6] px-4 py-3 rounded-xl text-[13px] flex items-start gap-2">
                        <ArrowRight className="w-4 h-4 flex-shrink-0 mt-0.5" />
                        Saving also puts the {ruleNow.move.part === 'lab' ? 'Laboratory' : 'Lecture'} in {ruleNow.move.room_name} — it has no room yet, and a Major subject keeps both in one room.
                      </div>
                    )}
                    {sessionConflicts.length === 0 && conflictsVerified && sessions.length > 0 && !roomRuleError && (
                      <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5 text-xs text-emerald-700 flex items-center gap-2">
                        <CheckCircle className="w-3.5 h-3.5" /> All sessions verified — no conflicts detected.
                      </div>
                    )}
                    {!conflictsVerified && sessions.length > 0 && allDaysSet && (
                      <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-2.5 text-xs text-[#64748B] flex items-center gap-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1D5BD6]" /> Checking for conflicts…
                      </div>
                    )}

                  </>
                )}
              </div>

              {/* Clear and Save, always in sight at the bottom — conflicts are checked by themselves as the sessions change */}
              {!panelSwitching && (
                <div className="flex-shrink-0 border-t border-[#E2E8F0] bg-white p-3 flex items-stretch gap-2">
                  <button onClick={handleClear} disabled={sessions.length === 0}
                    className="flex-shrink-0 flex items-center justify-center gap-2 px-4 sm:px-5 py-3 rounded-xl border border-[#E2E8F0] text-sm font-semibold text-[#475569] bg-white hover:bg-[#F8FAFC] disabled:opacity-40 disabled:cursor-not-allowed transition">
                    <RefreshCw className="w-4 h-4" /> Clear All
                  </button>
                  <button onClick={handleSave} disabled={!canSave || checkingConflicts}
                    className={[
                      'flex-1 min-w-0 flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-bold text-white transition',
                      !canSave || checkingConflicts ? 'bg-[#CBD5E1] cursor-not-allowed' : 'qr-btn-soft',
                    ].join(' ')}>
                    {saving
                      ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                      : hasConflicts
                        ? <><AlertTriangle className="w-4 h-4" /> Resolve Conflicts First</>
                        : roomRuleError
                          ? <><AlertTriangle className="w-4 h-4" /> {pathfitRoomError ? 'Choose CCA Gym or SAO Room' : daysRuleError || /same days/.test(roomRuleError) ? 'Use the Same Days First' : 'Use One Room First'}</>
                        : selLoad.isScheduled
                          ? <><RefreshCw className="w-4 h-4" /> <span className="truncate">Reschedule {selLoad.label} — {selLoad.load.subject_code}</span></>
                          : <><Save className="w-4 h-4" /> <span className="truncate">Save {selLoad.label} Schedule — {selLoad.load.subject_code}</span></>
                    }
                  </button>
                </div>
              )}
            </motion.aside>
          )}
        </AnimatePresence>
      </motion.div>

      {/* ── Delete Confirmation Modal ──────────────── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          data-modal-root
          onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(''); } }}
          onKeyDown={e => { if (e.key === 'Escape' && !deleting) { setDeleteTarget(null); setDeleteError(''); } }}
          tabIndex={-1} role="presentation">
          {/* Success: only the badge, straight on the dimmed page (dialog hidden) */}
          {deleteSuccess && (
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl"
              onClick={e => e.stopPropagation()}>
              <TrashDropAnimation className="bg-red-50 border-red-200" />
              <p className="text-sm font-semibold" style={{ color: '#0B2A5B' }}>Schedule deleted!</p>
            </div>
          )}
          <div className={`relative bg-white border border-[#E2E8F0] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden${deleteSuccess ? ' hidden' : ''}`}
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-6 py-5 border-b border-[#E2E8F0]">
              <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-100 flex items-center justify-center flex-shrink-0">
                <Trash2 className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-[#0B2A5B]">
                  Delete {deleteTarget.component === 'lab' ? 'Laboratory' : 'Lecture'} Schedule
                </h3>
                <p className="text-xs text-[#64748B] mt-0.5">
                  Only this component is removed — the other Lecture/Laboratory schedule is kept
                </p>
              </div>
              <button onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(''); } }}
                className="ml-auto p-1.5 rounded-lg hover:bg-[#F8FAFC] text-[#64748B] hover:text-[#0B2A5B] transition">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-[13px] text-[#475569]">
                Are you sure you want to delete the{' '}
                <strong>{deleteTarget.component === 'lab' ? 'Laboratory' : 'Lecture'}</strong>{' '}
                schedule only?
              </p>
              <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#64748B] uppercase tracking-wide">Subject</span>
                  <span className="text-[13px] font-bold text-[#0B2A5B] font-mono">{deleteTarget.subjectCode}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#64748B] uppercase tracking-wide">Component</span>
                  <span className="text-[13px] font-semibold text-[#475569]">
                    {deleteTarget.component === 'lab' ? 'Laboratory' : 'Lecture'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#64748B] uppercase tracking-wide">Block</span>
                  <span className="text-[13px] font-semibold text-[#475569]">{deleteTarget.blockName}</span>
                </div>
              </div>
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700 leading-relaxed">
                  The other component for this subject (if any) will remain scheduled.
                </p>
              </div>
              {deleteError && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                  <p className="text-xs text-red-700">{deleteError}</p>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 px-6 py-4 border-t border-[#E2E8F0] bg-[#F8FAFC]">
              <button onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(''); } }} disabled={deleting}
                className="flex-1 px-4 py-2.5 rounded-xl border border-[#E2E8F0] text-[13px] font-semibold text-[#64748B] hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed transition">
                Cancel
              </button>
              <button onClick={handleDeleteSchedule} disabled={deleting}
                className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-[13px] font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2">
                {deleting
                  ? <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Deleting…</>
                  : <><Trash2 className="w-4 h-4" /> Delete</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Weekly Timetable Modal ───────────────────── */}
      {showTimetable && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
          data-modal-root
          style={{
            backgroundColor: timetableEntered ? 'rgba(15, 23, 42, 0.35)' : 'rgba(15, 23, 42, 0)',
            /* Balanced ease: fade in ~0.4s, out ~0.3s */
            transition: reduceMotion ? 'none' : `background-color ${timetableEntered ? 400 : 300}ms cubic-bezier(0.4, 0, 0.2, 1)`,
          }}
          onClick={closeTimetable}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="weekly-timetable-title"
            onClick={e => e.stopPropagation()}
            className="bg-white border border-[#E2E8F0] rounded-2xl shadow-xl w-full flex flex-col overflow-hidden"
            style={{
              // Wide enough that each day column shows the full code + title
              maxWidth: 'min(1600px, 96vw)',
              /* A definite height (not just max-height) — otherwise the grid's
                 h-full resolves to its full 7AM–midnight height, gets clipped by
                 overflow-hidden, and there is nothing to scroll. */
              height: 'min(90vh, 900px)',
              opacity: timetableEntered ? 1 : 0,
              transform: timetableEntered ? 'translateY(0) scale(1)' : 'translateY(18px) scale(0.96)',
              transition: reduceMotion
                ? 'none'
                : timetableEntered
                  ? 'opacity 450ms cubic-bezier(0.4, 0, 0.2, 1) 60ms, transform 500ms cubic-bezier(0.4, 0, 0.2, 1) 60ms'
                  : 'opacity 280ms cubic-bezier(0.4, 0, 0.2, 1), transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div className="min-w-0">
                <h3 id="weekly-timetable-title" className="text-sm font-bold text-[#0B2A5B] flex items-center gap-2">
                  <CalendarDays className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
                  Weekly Timetable
                </h3>
                <p className="text-xs text-[#475569] mt-1 truncate">
                  {selFaculty?.name} · {semester} · A.Y. {schoolYear}
                  <span className="text-[#64748B]"> · {timetableBlocks.length} session{timetableBlocks.length !== 1 ? 's' : ''}</span>
                </p>
                <div className="flex items-center gap-1.5 mt-2 flex-wrap" aria-label="Day colours">
                  {[
                    ...timetableLayout.legend,
                    ...(timetableBlocks.some(b => isOverloadSession(b.load, b.label === 'Lab' ? 'lab' : 'lec'))
                      ? [{ label: 'Overload', tone: TT_TONE_OVERLOAD }] : []),
                  ].map(({ label, tone }) => (
                    <span
                      key={label}
                      className="inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[11px] font-semibold border"
                      style={{ color: tone.text, backgroundColor: tone.bg, borderColor: tone.border }}
                    >
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tone.bar }} />
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={closeTimetable}
                aria-label="Close timetable"
                className="p-1.5 rounded-lg hover:bg-[#F8FAFC] text-[#64748B] hover:text-[#0B2A5B] transition flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden bg-[#F8FAFC]">
              <div className="h-full bg-white border-t border-[#E2E8F0]">
                <WeeklyTimetableGrid
                  blocks={timetableBlocks}
                  layout={timetableLayout}
                  onOpen={openTimetableBlock}
                  onDelete={(msId, subjectCode, blockName, component) => {
                    setDeleteError('');
                    setDeleteTarget({ msId, subjectCode, blockName, component });
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Schedule Preview (Eye icon / timetable class) — who handles this
          subject, shared with the Master Schedule ── */}
      <SubjectFacultyPreview
        subject={previewRow
          ? { code: previewRow.load.subject_code, name: previewRow.load.subject_name, component: previewWhole ? null : previewRow.component }
          : null}
        semester={semester}
        academicYear={schoolYear}
        openMsId={previewOpenMs}
        currentFacultyId={selFaculty?.id ?? null}
        currentMsId={previewRow?.load.ms_id ?? null}
        onClose={closePreview}
      />
    </div>
  );
}
