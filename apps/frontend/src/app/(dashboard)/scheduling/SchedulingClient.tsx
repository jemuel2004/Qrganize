'use client';

import { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useToast } from '@/context/ToastContext';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import TrashDropAnimation from '@/components/ui/TrashDropAnimation';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useRealtime } from '@/context/RealtimeContext';
import {
  Users, ChevronRight, BookOpen, Monitor,
  AlertTriangle, CheckCircle, Clock, Trash2, X,
  RefreshCw, Save, Search,
  ChevronLeft, XCircle, Loader2, AlertCircle,
  CalendarDays, Eye, MapPin, ShieldCheck, FileClock, ArrowRight, ChevronDown, Maximize2, Minimize2,
} from 'lucide-react';
import { ListSkeleton, TableSkeleton, Skeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { EmploymentBadge, EMPLOYMENT_COLORS } from '@/components/ui/EmploymentBadge';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { useScrollLock } from '@/hooks/useScrollLock';
import TimeSlotPicker from '@/components/ui/TimeSlotPicker';
import CountFilterTabs from '@/components/ui/CountFilterTabs';
import RoomPicker from '@/components/ui/RoomPicker';
import DayPicker from '@/components/ui/DayPicker';
import { TT_DAY_TONES, TT_TONE_MTH, TT_TONE_OVERLOAD, TT_TONE_SAT, TT_TONE_TF, TT_TONE_W, type DayTone } from '@/lib/dayTones';
import { useDayCombinations } from '@/lib/dayCombinations';
import { dayCombinationError, daysCode, daysLabel, matchCombination } from '@shared/dayCombination';
import { blockCode } from '@shared/blockCode';
import { LOAD_GRACE_UNITS, formatLoadCap } from '@shared/regularLoad';

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
  units?: number | null;
  hours?: number | null;
  lec_scheduled?: boolean;
  lab_scheduled?: boolean;
  lec_start_time?: string | null; lec_end_time?: string | null;
  lab_start_time?: string | null; lab_end_time?: string | null;
  lec_day_pattern?: string | null; lab_day_pattern?: string | null;
  /** All schedule_sessions for this subject (full multi-session truth). */
  sessions?: WorkloadSession[] | null;
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
  type: 'instructor' | 'room' | 'block' | 'duplicate';
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
function fmt12(t: string): string {
  if (!t) return '—';
  const [hRaw, m] = t.split(':').map(Number);
  if (isNaN(hRaw)) return '—';
  /* Hour-mark midnight uses 24:00; treat as 12:00 AM. */
  if (hRaw === 24) return `12:${String(m).padStart(2, '0')} AM`;
  const h = hRaw;
  return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function fmtHrs(n: number): string {
  const h = Math.floor(n); const m = Math.round((n - h) * 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr${h !== 1 ? 's' : ''}`;
  return `${h} hr ${m} min`;
}
function uid(): string { return Math.random().toString(36).slice(2); }
function parseDays(pattern: string | null): string[] {
  if (!pattern) return [];
  const map: Record<string, string> = {
    M: 'Monday', T: 'Tuesday', W: 'Wednesday', TH: 'Thursday', F: 'Friday', S: 'Saturday', SU: 'Sunday',
    Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
    Monday: 'Monday', Tuesday: 'Tuesday', Wednesday: 'Wednesday',
    Thursday: 'Thursday', Friday: 'Friday', Saturday: 'Saturday', Sunday: 'Sunday',
  };
  return pattern.split('/').map(p => map[p.trim()] || '').filter(Boolean);
}
function timeToMinutes(t: string): number {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
/** Normalize Postgres time text (HH:MM:SS) to HH:MM for display/positioning. */
function normTime(t: string | null | undefined): string {
  if (!t) return '00:00';
  const parts = String(t).split(':');
  return `${parts[0].padStart(2, '0')}:${(parts[1] || '00').padStart(2, '0')}`;
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

/** Academic day: 7:00 AM – 9:00 PM. Classes must end by DAY_END_MIN (no
 *  sessions into midnight); the timetable only stretches past 9 PM if an
 *  older class saved before this rule still runs later. */
const DAY_END_MIN  = 21 * 60;   // 9:00 PM — latest end time for a session
/** Lunch break for all faculty (12:00–1:00 PM) — no class may overlap it. */
const LUNCH = { start: 12 * 60, end: 13 * 60, label: 'Lunch break · 12:00–1:00 PM', kind: 'Lunch' as const };

/** Why a time is taken — shown on struck-out times, e.g. "Instructor + Room conflict". */
type BusyKind = 'Instructor' | 'Block' | 'Room' | 'Lunch';
interface BusyRange { start: number; end: number; label: string; kind: BusyKind }
const BUSY_KIND_ORDER: BusyKind[] = ['Instructor', 'Block', 'Room', 'Lunch'];
const TT_START_MIN = 7 * 60;    // 7:00 AM
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

function asSessionList(raw: unknown): WorkloadSession[] {
  if (Array.isArray(raw)) return raw as WorkloadSession[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as WorkloadSession[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** One scheduled meeting for a subject component — used by the row "eye" preview. */
interface RowScheduleMeeting { day: string; time: string; room: string }
/** One instructor handling the previewed subject (one row per assigned block) —
 *  from /api/scheduling/subject-instructors. */
interface SubjectInstructor {
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
  sessions: WorkloadSession[] | string | null;
}
function getInstructorMeetings(si: SubjectInstructor, comp: 'lec' | 'lab'): RowScheduleMeeting[] {
  const sessions = asSessionList(si.sessions)
    .filter(s => (s.type === 'lab' ? 'lab' : 'lec') === comp && s.day && s.start_time && s.end_time);
  if (sessions.length > 0) {
    return sessions.map(s => ({
      day: s.day,
      time: `${fmt12(normTime(s.start_time))} – ${fmt12(normTime(s.end_time))}`,
      room: s.room_name ?? si.room_name ?? 'No room assigned',
    }));
  }
  // Legacy rows scheduled before schedule_sessions existed
  if (asSessionList(si.sessions).length > 0 || !si.day_pattern || !si.start_time || !si.end_time) return [];
  return parseDays(si.day_pattern).map(day => ({
    day,
    time: `${fmt12(normTime(si.start_time!))} – ${fmt12(normTime(si.end_time!))}`,
    room: si.room_name ?? 'No room assigned',
  }));
}

/** Animates its height to fit its content, so a panel glides instead of
 *  jumping when what's inside changes size. */
function AutoHeight({ children, className, reduceMotion }: {
  children: ReactNode; className?: string; reduceMotion: boolean;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div
      className={className}
      initial={false}
      animate={{ height }}
      transition={{ duration: reduceMotion ? 0 : 0.32, ease: [0.4, 0, 0.2, 1] }}
    >
      <div ref={innerRef}>{children}</div>
    </motion.div>
  );
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
  // Ends at 9 PM, unless a legacy class runs later (then round up to its hour)
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

        {/* 7:00 AM – 9:00 PM canvas (longer only for legacy classes that end later) */}
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
            const isOverload = isOverloadSession(load, isLab ? 'lab' : 'lec');
            const tone = isOverload ? TT_TONE_OVERLOAD : toneOf(day);
            const roomLabel = room_name ?? 'No room assigned';
            const tooltip = [
              `${load.subject_code} — ${load.subject_name}${isOverload ? ' · OVERLOAD' : ''}`,
              `${fmt12(st)} – ${fmt12(et)}`,
              `${typeLabel} · ${blockCode(load.year_level, load.block_name)} · ${roomLabel}`,
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
                        className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wide px-1.5 rounded"
                        style={{ color: tone.text, backgroundColor: '#FFFFFF', border: `1px solid ${tone.border}` }}
                      >
                        {isLab ? 'Lab' : 'Lec'}
                      </span>
                      {load.block_name && (
                        <span className="flex-shrink-0 text-[11px] font-bold px-1.5 rounded bg-[#1E4FB8] leading-[17px] whitespace-nowrap" style={{ color: '#FFFFFF' }}>
                          {blockCode(load.year_level, load.block_name)}
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] font-semibold tabular-nums text-[#0F172A] whitespace-nowrap">
                      {fmt12(st)} – {fmt12(et)}
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
                      className="flex-shrink-0 text-[10px] font-bold uppercase tracking-wide px-1.5 rounded"
                      style={{ color: tone.text, backgroundColor: '#FFFFFF', border: `1px solid ${tone.border}` }}
                    >
                      {isLab ? 'Lab' : 'Lec'}
                    </span>
                    {/* Block — same royal-blue badge as the subject cards */}
                    {load.block_name && (
                      <span
                        className="flex-shrink-0 text-[11px] font-bold px-1.5 rounded bg-[#1E4FB8] leading-[17px] whitespace-nowrap"
                        // White set inline — the light-mode rule repaints `text-white` as dark ink
                        style={{ color: '#FFFFFF' }}
                      >
                        {blockCode(load.year_level, load.block_name)}
                      </span>
                    )}
                  </div>
                  {/* Descriptive title: two lines when the card is tall enough */}
                  <div className={`text-[12px] text-[#334155] leading-snug ${cardH >= 130 ? 'line-clamp-2' : 'truncate'}`}>
                    {load.subject_name}
                  </div>
                  <div className="text-[12px] font-semibold tabular-nums text-[#0F172A] whitespace-nowrap">
                    {fmt12(st)} – {fmt12(et)}
                  </div>
                  {/* Type · room — only on cards tall enough (2 hr+) to fit it under the title */}
                  {cardH >= 140 && (
                    <div className={`text-[11px] font-medium truncate ${room_name ? 'text-[#475569]' : 'text-[#B45309]'}`}>
                      {typeLabel}{room_name ? ` · ${room_name}` : ' · No room'}
                    </div>
                  )}
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

    const splitAffectsLec = hasSplit && (oc === 'lec' || oc === 'full' || oc === null);
    const splitAffectsLab = hasSplit && (oc === 'lab' || oc === 'full' || oc === null);
    const isLecOverload   = isFullOverload || splitAffectsLec;
    const isLabOverload   = isFullOverload || splitAffectsLab;
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
    }
  }
  return rows;
}

/* ─── mini components ───────────────────────────────────────── */

/* ─── Stepper: Position → Instructor → Schedule ───────────────── */
const SCHEDULING_STEPS = [
  { k: 'position', label: 'Position' },
  { k: 'instructor', label: 'Faculty' },
  { k: 'schedule', label: 'Schedule' },
] as const;

function SchedulingStepper({ current, compact }: { current: number; compact?: boolean }) {
  return (
    <div className={`flex items-center max-w-xl mx-auto px-2 ${compact ? 'mb-3' : 'mb-6'}`}>
      {SCHEDULING_STEPS.map((step, i, all) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={step.k} className="flex items-center flex-1 last:flex-none">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center shrink-0 transition-colors ${
                done ? 'bg-[#1D5BD6] text-white'
                  : active ? 'bg-white text-[#1D5BD6] border-2 border-[#1D5BD6]'
                  : 'bg-[#F1F5F9] text-[#94A3B8]'
              }`}>
                {done ? <CheckCircle className="w-4 h-4" /> : i + 1}
              </span>
              <span className={`text-sm font-semibold hidden sm:block ${
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

/* ─── Back-navigation loading overlay ──────────────────────────
   Shown briefly over the current step while goBack()'s delay runs,
   before the actual history navigation happens. Fixed to the viewport (below
   the 72px app header) so the spinner is always on screen — the old overlay
   covered the whole tall page in a white blur and centred the spinner off-screen. */
function BackLoadingOverlay({ label = 'Going back…' }: { label?: string }) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 top-[72px] z-30 flex items-center justify-center qr-fade-in"
      style={{ backgroundColor: 'rgba(11, 42, 91, 0.08)' }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-3 px-5 py-3.5 rounded-2xl bg-white border border-[#E2E8F0] shadow-[0_12px_32px_-12px_rgba(11,42,91,0.35)]">
        <div className="w-6 h-6 border-[3px] border-[#DBE5F4] border-t-[#1D5BD6] rounded-full animate-spin" aria-hidden="true" />
        <p className="text-sm font-semibold text-[#0B2A5B]">{label}</p>
      </div>
    </div>
  );
}

/* ─── FacultyGroup ──────────────────────────────────────────── */
function FacultyGroup({ title, items, selectedId, loadingId, onSelect }: {
  title?: string; items: Faculty[]; selectedId?: number | null;
  /** Instructor whose schedule is opening — its button shows a spinner, others are disabled. */
  loadingId?: number | null;
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
  const sorted = [...items].sort((a, b) => {
    const aDone = remaining(a) <= 0;
    const bDone = remaining(b) <= 0;
    if (aDone !== bDone) return aDone ? 1 : -1;
    return aDone ? 0 : remaining(a) - remaining(b);
  });
  return (
    <div className="mb-6">
      {title && (
      <div className="flex items-center gap-2 mb-3 px-1">
        <Users className="w-4 h-4 text-[#64748B]" />
        <span className="text-xs font-bold text-[#64748B] uppercase tracking-widest">{title}</span>
        <span className="text-xs text-[#94A3B8]">({items.length})</span>
      </div>
      )}
      <div className="space-y-2">
        {sorted.map(f => {
          const selected = f.id === selectedId;
          const incomplete = remaining(f) > 0;
          return (
          <div key={f.id}
            className={`w-full text-left border rounded-xl px-5 py-3.5 transition-all duration-200 shadow-sm ${
              selected
                ? 'bg-white border-[#1D5BD6] ring-1 ring-[#1D5BD6]/30 bg-[#F5FAFF] scale-[1.01]'
                : incomplete
                  // Same red pulse as the pending rows on the Workload page
                  ? 'qr-flag-pulse border-[#FECACA] hover:border-[#F87171]'
                  : 'bg-white border-[#E2E8F0] hover:border-[#1D5BD6]'
            }`}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="mb-1 flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-[#0B2A5B] text-base truncate">{f.name}</span>
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
                <div className="text-sm text-[#64748B] flex items-center gap-2">
                  <span>{f.employee_id}</span><span>·</span><span>{f.position}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <div className="text-right">
                  <div className="text-xs text-[#94A3B8]">Remaining Load</div>
                  <div className={`text-base font-bold ${remainingShown(f) > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                    {formatLoadCap(remainingShown(f))} {f.employment_status === 'Permanent' ? 'units' : 'hrs'}
                  </div>
                </div>
                <button type="button" onClick={() => onSelect(f)} disabled={selected || loadingId != null}
                  className={`flex-shrink-0 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-semibold border transition-all duration-150 active:scale-95 cursor-pointer disabled:cursor-default ${
                    selected
                      ? 'qr-btn-soft border-transparent'
                      : 'bg-white text-[#1D5BD6] border-[#BFDBFE] hover:bg-[#EFF6FF] hover:border-[#1D5BD6]'
                  }`}>
                  {loadingId === f.id
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening…</>
                    : selected ? <><CheckCircle className="w-4 h-4" /> Selected</> : 'Select'}
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

/* ─── CollapsibleSection ────────────────────────────────────────
   Header row doubles as a Show/Hide toggle; the body slides open/closed.
   Sections start hidden so the admin chooses what to look at. */
function CollapsibleSection({ title, count, tone, open, onToggle, children, id, flash = false, shakeDelay }: {
  title: string; count: number; tone: StatusTone;
  open: boolean; onToggle: () => void; children: ReactNode;
  /** Scroll target for the pending / done shortcuts */
  id?: string;
  /** Brief highlight pulse after a shortcut opens this section */
  flash?: boolean;
  /** Seconds — set to make the header shake while collapsed with subjects left to schedule
   *  (staggered per section so they don't move in unison). */
  shakeDelay?: number;
}) {
  const reduceMotion = useReducedMotion();
  const t = STATUS_TONES[tone];
  const [hovered, setHovered] = useState(false);
  // Collapsed with subjects left → a short wiggle, then a ~3.8s rest, repeating.
  // Pauses while hovered so it never fights the pointer.
  const shaking = shakeDelay !== undefined && count > 0 && !open && !flash && !hovered && !reduceMotion;
  return (
    <div id={id} className="px-3 pt-2 pb-0.5 scroll-mt-2">
      <motion.button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        onHoverStart={() => setHovered(true)}
        onHoverEnd={() => setHovered(false)}
        animate={shaking
          ? { x: [0, -3, 3, -2, 2, -1, 1, 0], rotate: [0, -0.6, 0.6, -0.4, 0.4, 0, 0, 0] }
          : { x: 0, rotate: 0 }}
        transition={shaking
          ? { duration: 0.7, ease: 'easeInOut', repeat: Infinity, repeatDelay: 3.8, delay: shakeDelay }
          : { duration: 0.2 }}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl border hover:shadow-sm transition-[box-shadow,border-color,background-color] group ${t.head} ${flash ? 'qr-section-flash' : ''}`}
      >
        <span className={`text-[13px] font-bold uppercase tracking-widest ${t.text}`}>{title}</span>
        <span className={`text-xs font-bold border rounded-full px-2 py-0.5 tabular-nums ${t.badge}`}>{count}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-[#1D5BD6] group-hover:text-[#164BB5]">
          {open ? 'Hide' : 'Show'}
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.3, ease: [0.45, 0, 0.55, 1] }}
            className="inline-flex"
          >
            <ChevronDown className="w-4 h-4" />
          </motion.span>
        </span>
      </motion.button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.35, ease: [0.45, 0, 0.55, 1] }}
            className="overflow-hidden"
          >
            <div className="pt-1.5 pb-1">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Major subject: has both Lecture and Laboratory hours. */
function isMajorSubject(load: WorkloadLoad): boolean {
  return toNum(load.lecture_hours) > 0 && toNum(load.laboratory_hours) > 0;
}

/* ─── LoadSection ───────────────────────────────────────────── */
function LoadSection({ title, tone, rows, selLoadKey, onSelect, onPreview, emptyMessage, open, onToggle, expanded = false, id, flash, shakeDelay }: {
  title: string; tone: StatusTone;
  rows: LoadRow[];
  selLoadKey: string | undefined;
  onSelect: (row: LoadRow) => void;
  onPreview: (row: LoadRow) => void;
  emptyMessage?: string;
  open: boolean; onToggle: () => void;
  /** Panel expanded: long subject names wrap instead of truncating. */
  expanded?: boolean;
  id?: string;
  flash?: boolean;
  shakeDelay?: number;
}) {
  return (
    <CollapsibleSection title={title} count={rows.length} tone={tone} open={open} onToggle={onToggle} id={id} flash={flash} shakeDelay={shakeDelay}>
      {/* No inner height cap — the full-height column scrolls, so more rows fit on screen */}
      <div className={`rounded-xl border ${STATUS_TONES[tone].border} bg-white overflow-hidden flex flex-col shadow-sm`}>
        {rows.length === 0 ? (
          <div className="px-4 py-5 text-sm text-[#94A3B8] italic text-center">
            {emptyMessage ?? 'No subjects assigned.'}
          </div>
        ) : (
        <>
        <div>
        {rows.map((row, i) => {
          const isActive     = selLoadKey === row.key;
          const isLec        = row.component === 'lec';
          const prevRow      = rows[i - 1];
          const isNewSubject = !prevRow
            || prevRow.load.id !== row.load.id
            || prevRow.component !== row.component
            || prevRow.isSplitPortion !== row.isSplitPortion;
          return (
            <div
              key={row.key}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(row)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(row); }
              }}
              className={[
                'w-full text-left px-3 py-2 border-b border-[#F1F5F9] last:border-0 transition-colors cursor-pointer',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40 focus-visible:ring-inset',
                isNewSubject && i > 0 ? 'border-t border-[#E2E8F0]' : '',
                isActive
                  ? `bg-[#EFF6FF] border-l-[3px] ${isLec ? 'border-l-[#1D5BD6]' : 'border-l-amber-500'}`
                  : isMajorSubject(row.load)
                    // Major (Lecture + Lab): indigo border around the card + indigo left bar —
                    // a different hue from the blue selected card and Block badge
                    ? 'bg-white border-l-[3px] border-l-[#6366F1] shadow-[inset_0_0_0_1.5px_#C7D2FE] hover:bg-[#F7F7FF]'
                    : 'hover:bg-[#F8FAFC]',
              ].join(' ')}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                    {isLec
                      ? <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-[#EFF6FF] text-[#1D5BD6] border border-[#BFDBFE] flex-shrink-0 flex items-center gap-1">
                          <BookOpen className="w-3 h-3" /> Lecture
                        </span>
                      : <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 flex-shrink-0 flex items-center gap-1">
                          <Monitor className="w-3 h-3" /> Laboratory
                        </span>
                    }
                    {row.splitLabel && (
                      <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 border ${
                        row.splitLabel === 'Overload'
                          ? 'bg-orange-50 text-orange-700 border-orange-200'
                          : row.splitLabel === 'Praise'
                          ? 'bg-yellow-50 text-yellow-800 border-yellow-300'
                          : 'bg-slate-50 text-slate-500 border-slate-200'
                      }`}>{row.splitLabel}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[13px] font-bold text-[#0B2A5B] leading-tight truncate">{row.load.subject_code}</span>
                    {row.load.block_name && (
                      <span
                        className="flex-shrink-0 text-[11px] font-bold px-2 py-0.5 rounded-md bg-[#1E4FB8] leading-tight"
                        // White set inline — the light-mode rule repaints `text-white` as dark ink
                        style={{ color: '#FFFFFF' }}
                        title={[row.load.program_code, row.load.year_level, `Block ${row.load.block_name}`].filter(Boolean).join(' · ')}
                      >
                        {blockCode(row.load.year_level, row.load.block_name)}
                      </span>
                    )}
                  </div>
                  {/* Darker, larger title — the light grey was hard to read (older users) */}
                  <div className={`mt-0.5 text-[13px] font-medium text-[#334155] leading-snug ${expanded ? 'break-words' : 'truncate'}`} title={row.load.subject_name}>{row.load.subject_name}</div>
                </div>
                <button
                  type="button"
                  title="View schedule details"
                  aria-label="View schedule details"
                  onClick={e => { e.stopPropagation(); onPreview(row); }}
                  className="flex-shrink-0 w-8 h-8 rounded-lg border border-[#BFD3F5] bg-[#EFF5FF] text-[#1D5BD6] hover:bg-[#DCE8FC] hover:border-[#93B4EA] hover:text-[#164BB5] shadow-[0_1px_2px_rgba(29,91,214,0.12)] flex items-center justify-center transition"
                >
                  <Eye className="w-4 h-4" />
                </button>
              </div>
            </div>
          );
        })}
        </div>
        </>
        )}
      </div>
    </CollapsibleSection>
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
  const facultyStep: 'position' | 'instructor' =
    stepParam === 'instructor' || stepParam === 'schedule' ? 'instructor' : 'position';
  const positionFilter = (searchParams.get('type') as 'Permanent' | 'Contractual' | null) ?? '';
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
  /** Allowed day combinations of this term (Settings → Day Combinations) */
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
  /* Assigned Subjects panel: every section starts hidden (admin clicks Show),
     and the Lecture / Laboratory chips filter the rows in all sections. */
  const [openSections, setOpenSections]   = useState<Record<string, boolean>>({});
  const [typeFilter, setTypeFilter]       = useState<'all' | 'lec' | 'lab'>('all');
  const [panelExpanded, setPanelExpanded] = useState(false);
  const reduceMotion = useReducedMotion();
  function focusSection(id: string) {
    setOpenSections({ [id]: true });
    setFlashSection(id);
    window.setTimeout(() => {
      document.getElementById(`sched-sec-${id}`)?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }, 120);
    window.setTimeout(() => setFlashSection(cur => (cur === id ? null : cur)), 1700);
  }
  const toggleSection = (id: string) => setOpenSections(s => ({ ...s, [id]: !s[id] }));
  /* pending / done / overload chips: open that section (others close), glide to
     it and pulse it once so the eye lands there. */
  const [flashSection, setFlashSection] = useState<string | null>(null);
  useEffect(() => { setOpenSections({}); setTypeFilter('all'); }, [selFacultyId]);
  const [previewRow, setPreviewRow]       = useState<LoadRow | null>(null);
  /* Eye preview: everyone handling the previewed subject, and the one whose
     schedule is opened from its "View Schedule" button. */
  const [subjectInstructors, setSubjectInstructors] = useState<SubjectInstructor[] | null>(null);
  const [subjectInstructorsError, setSubjectInstructorsError] = useState('');
  const [viewingInstructor, setViewingInstructor] = useState<SubjectInstructor | null>(null);
  /** 1 = heading into a schedule, -1 = back to the list — drives the slide direction. */
  const [previewNavDir, setPreviewNavDir] = useState(1);
  const openInstructorSchedule = (si: SubjectInstructor) => { setPreviewNavDir(1); setViewingInstructor(si); };
  const closeInstructorSchedule = () => { setPreviewNavDir(-1); setViewingInstructor(null); };
  const previewSubjectCode = previewRow?.load.subject_code ?? null;
  /* Timetable click: open the preview straight on this instructor's schedule
     for that subject (the back arrow still lists everyone teaching it). A ref,
     so the fetch callback can switch views in the same render — no list flash. */
  const openScheduleForMs = useRef<number | null>(null);
  function openTimetableBlock(load: WorkloadLoad, component: 'lec' | 'lab') {
    openScheduleForMs.current = load.ms_id;
    setPreviewNavDir(1);
    setPreviewRow({
      key: `tt-${load.id}-${component}`, load, component,
      componentHours: 0, componentUnits: 0, displayHours: 0, displayUnits: 0,
      label: component === 'lab' ? 'Lab' : 'Lec',
      isOverloadComponent: false, isScheduled: true, isSplitPortion: false,
    });
  }
  useEffect(() => {
    setViewingInstructor(null);
    setSubjectInstructors(null);
    setSubjectInstructorsError('');
    if (!previewSubjectCode) return;
    const controller = new AbortController();
    const qs = new URLSearchParams({ subject_code: previewSubjectCode, semester, academic_year: schoolYear }).toString();
    fetch(`/api/scheduling/subject-instructors?${qs}`, { signal: controller.signal })
      .then(async res => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Unable to load faculty.');
        const list: SubjectInstructor[] = Array.isArray(data.instructors) ? data.instructors : [];
        setSubjectInstructors(list);
        if (openScheduleForMs.current != null) {
          const hit = list.find(si => si.ms_id === openScheduleForMs.current);
          if (hit) setViewingInstructor(hit);
          openScheduleForMs.current = null;
        }
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setSubjectInstructorsError(err instanceof Error ? err.message : 'Unable to load faculty.');
        setSubjectInstructors([]);
        openScheduleForMs.current = null;
      });
    return () => controller.abort();
  }, [previewSubjectCode, semester, schoolYear]);
  const [panelSwitching, setPanelSwitching] = useState(false);
  const panelSwitchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rooms, setRooms]                 = useState<Room[]>([]);
  const [facultySearch, setFacultySearch] = useState('');
  const [pendingFacultyId, setPendingFacultyId] = useState<number | null>(null);
  const [backLoading, setBackLoading] = useState(false);
  /* Position step → "Continue": show the loader briefly before moving on. */
  const [continueLoading, setContinueLoading] = useState(false);
  useEffect(() => { setContinueLoading(false); }, [facultyStep]);
  const [fetchingW, setFetchingW]         = useState(false);

  /* Shared by every wizard Back control — shows a brief loading state
     before actually walking browser history, instead of jumping instantly. */
  const goBack = useCallback(() => {
    setBackLoading(true);
    setTimeout(() => {
      // Opened straight from Master Schedule in a fresh tab — no history to walk.
      if (fromMsId && window.history.length <= 1) router.replace('/master-schedule');
      else router.back();
      setBackLoading(false);
    }, 1500);
  }, [router, fromMsId]);
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
  /** Weekly Timetable modal — closed by default so Schedule Classes stays focused. */
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
    const saved = asSessionList(row.load.sessions)
      .filter(x => (x.type === 'lab' ? 'lab' : 'lec') === row.component && x.day && x.start_time)
      .sort((a, b) => WEEK_DAYS.indexOf(a.day) - WEEK_DAYS.indexOf(b.day)
        || normTime(a.start_time).localeCompare(normTime(b.start_time)));
    prefillRef.current = saved.length > 0 ? { key: row.key, sessions: saved } : null;
    setSelLoad(row); setError(''); setSuccess('');
    setSessionConflicts([]); setConflictsVerified(false);
    setSessions([]); setManualCount(saved.length > 0 ? saved.length : 1);
    /* Selecting a subject just swaps already-loaded local state — no fetch —
       so without this it snapped instantly. A brief skeleton (same 2s as the
       Minor/Major subject-category switch) makes it feel like a deliberate,
       interactive transition instead of a jarring swap. */
    setPanelSwitching(true);
    if (panelSwitchTimeout.current) clearTimeout(panelSwitchTimeout.current);
    panelSwitchTimeout.current = setTimeout(() => setPanelSwitching(false), 2000);
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
    const section = row.isScheduled ? 'scheduled'
      : row.isOverloadComponent ? 'overload'
      : row.isPraiseComponent ? 'praise-tasks'
      : 'regular';
    setOpenSections({ [section]: true });
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
    // Changing the session count keeps the rows already filled in (day, time,
    // room) — only new rows start blank; hours are re-split evenly.
    setSessions(prev => {
      const keep = prev.filter(s => s.type === comp);
      return Array.from({ length: manualCount }, (_, i) => {
        const old = keep[i];
        const start = old?.start_time || '07:00';
        return {
          id: old?.id ?? uid(),
          day: comboDays?.[i] ?? old?.day ?? '',
          start_time: start,
          units: uPerSession, hours: hPerSession,
          end_time: addMinutes(start, Math.round(hPerSession * 60)),
          type: comp, room_id: old?.room_id ?? '',
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
      for (const s of asSessionList(l.sessions)) {
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
    // Only starts that finish by 9:00 PM (no sessions running into the night)
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
      if (hits.length === 0) return { value: t, conflict: '' };
      const kinds = BUSY_KIND_ORDER.filter(k => hits.some(h => h.kind === k));
      if (kinds.length === 1 && kinds[0] === 'Lunch') return { value: t, conflict: LUNCH.label };
      const names = kinds.filter(k => k !== 'Lunch');
      const details = [...new Set(hits.filter(h => h.kind !== 'Lunch').map(h => h.label))];
      return { value: t, conflict: `${names.join(' + ')} conflict — ${details.join('; ')}` };
    });
  }

  /** Start times (TIME_SLOTS) that fit this session on its day. */
  function freeStartTimes(sess: SessionItem, all: SessionItem[] = sessions): string[] {
    // Lunch + the 9 PM cut-off apply even before a day is picked
    return slotConflicts(sess, all).filter(x => !x.conflict).map(x => x.value);
  }

  function updateSession(id: string, key: string, val: string | number) {
    /* Session 1's time / room fill the other sessions; a row the admin changes
       by hand keeps its own value from then on. */
    const idx = sessions.findIndex(s => s.id === id);
    const followed = key === 'start_time' || key === 'room_id';
    if (idx > 0 && followed) manualSessionFields.current.add(`${id}:${key}`);

    setSessions(prev => {
      let next = prev.map(s => {
        if (s.id !== id) return s;
        const updated = { ...s, [key]: val };
        // Picking a day — or a room — where the current time is already taken
        // (by the instructor, the block, or that room) → jump to the first free start
        if ((key === 'day' || key === 'room_id') && val && updated.day) {
          const free = freeStartTimes(updated, prev);
          if (free.length > 0 && !free.includes(updated.start_time)) {
            updated.start_time = free[0];
            updated.end_time = addMinutes(free[0], Math.round(toNum(updated.hours) * 60));
          }
        }
        if (key === 'start_time') {
          updated.end_time = addMinutes(String(val), Math.round(toNum(updated.hours) * 60));
        }
        return updated;
      });

      if (idx === 0 && followed) {
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

  /* Day combinations allowed this semester (Settings → Day Combinations).
     None configured → no restriction, exactly as before. */
  const currentCombo = dayCombos.length > 0 && allDaysSet && sessions.length > 0
    ? matchCombination(sessions.map(s => s.day), dayCombos)
    : null;
  const comboError = allDaysSet && sessions.length > 0 ? dayCombinationError(sessions.map(s => s.day), dayCombos) : null;
  /** Days that appear in any allowed combination (null = every day) */
  const allowedDays = dayCombos.length > 0 ? new Set<string>(dayCombos.flatMap(c => c.days)) : null;

  /** Use a combination: one session per day, in week order (times/rooms kept per row) */
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

  const canSave           = isComplete && allDaysSet && sessions.length > 0 && !saving && !hasConflicts && !comboError;

  async function runConflictCheck() {
    if (!selLoad || sessions.length === 0) return;
    setCheckingConflicts(true);
    const found: ConflictInfo[] = [];
    for (let i = 0; i < sessions.length; i++) {
      const a = sessions[i];
      if (!a.day) continue;
      const aStart = timeToMinutes(a.start_time);
      const aEnd   = sessionEndMinutes(a.start_time, a.end_time); // midnight-aware
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
      await res.json().catch(() => null);
      const saved = selLoad;
      setSuccess(`Schedule saved for ${saved.load.subject_code} (${saved.label}) — ${blockCode(saved.load.year_level, saved.load.block_name)}`);
      fetchWorkload();
      // Check animation plays for 1.3s (same as Faculty / Blocks / Curriculum),
      // then the form clears and the toast confirms.
      setSaveSuccess(true);
      setTimeout(() => {
        setSaveSuccess(false);
        setSelLoad(null); setSessions([]);
        toast.success(`Schedule saved for ${saved.load.subject_code} — ${blockCode(saved.load.year_level, saved.load.block_name)}.`);
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
  const activeRooms  = selLoad?.component === 'lab'
    ? labRooms
    : subjectHasLab ? [...lectureRooms, ...labRooms] : lectureRooms;
  const showFacultySkeleton = useMinLoading(
    // Wait for the real remaining loads on first load so cards don't flash red
    facultyLoading || (summariesLoading && Object.keys(loadSummaries).length === 0),
    facultyList.length === 0 ? PAGE_SKELETON_MIN_MS : 0,
  );
  const showWorkloadSkeleton = useMinLoading(fetchingW, workload == null ? PAGE_SKELETON_MIN_MS : 0) || showDeleteSkeleton;

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
      f.employment_status === positionFilter &&
      (f.name.toLowerCase().includes(facultySearch.toLowerCase()) ||
      f.employee_id.toLowerCase().includes(facultySearch.toLowerCase()))
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
    const totalPermanent   = facultyList.filter(f => f.employment_status === 'Permanent').length;
    const totalContractual = facultyList.filter(f => f.employment_status === 'Contractual').length;
    /** Classes (summed over the position's faculty) that still have no day/time */
    const toSchedule = (pos: string) => facultyList
      .filter(f => f.employment_status === pos)
      .reduce((sum, f) => sum + (unscheduledMap[f.id] ?? 0), 0);
    const stepIndex = facultyStep === 'instructor' ? 1 : 0;

    return (
      <div className="relative p-4 sm:p-6 max-w-3xl mx-auto w-full min-w-0">
        {backLoading && <BackLoadingOverlay />}
        {pendingFacultyId !== null && <BackLoadingOverlay label="Opening schedule…" />}
        {continueLoading && <BackLoadingOverlay label="Loading faculty…" />}
        <div className="mb-8">
          {facultyStep === 'position' && <BackButton />}
          <div className={facultyStep === 'position' ? 'mt-4 sm:mt-7' : ''}>
            <WatermarkTitle>Schedule Classes</WatermarkTitle>
          </div>
        </div>

        <SchedulingStepper current={stepIndex} />

        {facultyStep === 'position' ? (
          <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 sm:p-6 shadow-sm">
            <h2 className="text-base font-bold text-[#0B2A5B] mb-4">Position Selection</h2>

            <div className="space-y-3">
              {([
                { key: 'Permanent' as const, label: 'Permanent', desc: 'Regular faculty members with permanent positions.', count: totalPermanent, pending: toSchedule('Permanent'), Icon: ShieldCheck },
                { key: 'Contractual' as const, label: 'Contractual', desc: 'Part-time or contractual faculty members.', count: totalContractual, pending: toSchedule('Contractual'), Icon: FileClock },
              ]).map(opt => {
                const selected = positionFilter === opt.key;
                const { fg, bg } = EMPLOYMENT_COLORS[opt.key];
                return (
                  <button key={opt.key} type="button" disabled={continueLoading} onClick={() => {
                    router.replace(buildStepUrl({
                      type: opt.key,
                      faculty: positionFilter !== opt.key ? undefined : selFacultyId ?? undefined,
                    }), { scroll: false });
                  }}
                    className={`w-full flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2.5 text-left px-4 sm:px-5 py-4 rounded-xl border transition-colors ${
                      selected ? 'ring-1' : 'border-[#E2E8F0] hover:border-[#CBD5E1]'
                    }`}
                    style={selected ? { borderColor: fg, backgroundColor: bg, ['--tw-ring-color' as string]: fg } : undefined}>
                    <span className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                      style={selected ? { backgroundColor: fg, color: '#ffffff' } : { backgroundColor: bg, color: fg }}>
                      <opt.Icon className="w-5 h-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold text-[#0B2A5B]">{opt.label} <span className="font-normal text-[#94A3B8] text-sm">({opt.count})</span></span>
                      <span className="block text-sm text-[#64748B] mt-0.5">{opt.desc}</span>
                    </span>
                    {/* Phone: status badge drops under the description instead of squeezing it */}
                    <span className="order-last w-full pl-14 sm:order-none sm:w-auto sm:pl-0 flex-shrink-0 empty:hidden">
                    {opt.pending > 0 && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-[#FFF7ED] text-[#C2410C] border border-[#FED7AA] flex-shrink-0"
                        title="Assigned classes in this group that still need a day and time">
                        <span className="relative flex w-2 h-2">
                          <span className="absolute inline-flex w-full h-full rounded-full bg-[#F97316] opacity-60 animate-ping" />
                          <span className="relative inline-flex w-2 h-2 rounded-full bg-[#EA580C]" />
                        </span>
                        {opt.pending} {opt.pending === 1 ? 'class' : 'classes'} to schedule
                      </span>
                    )}
                    {opt.pending === 0 && !summariesLoading && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-[#ECFDF5] text-[#047857] border border-[#A7F3D0] flex-shrink-0"
                        title="Every assigned class in this group has a day and time">
                        <CheckCircle className="w-3.5 h-3.5" /> All scheduled
                      </span>
                    )}
                    </span>
                    <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                      selected ? '' : 'border-[#CBD5E1]'
                    }`}
                      style={selected ? { borderColor: fg, backgroundColor: fg } : undefined}>
                      {selected && <CheckCircle className="w-4 h-4 text-white" />}
                    </span>
                  </button>
                );
              })}
            </div>

            <button type="button" disabled={!positionFilter || continueLoading}
              onClick={() => {
                setContinueLoading(true);
                setTimeout(() => router.push(buildStepUrl({ step: 'instructor' })), 1000);
              }}
              className="w-full mt-5 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold qr-btn-soft disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {continueLoading
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Loading faculty…</>
                : <>Continue to Faculty Selection <ArrowRight className="w-4 h-4" /></>}
            </button>
          </div>
        ) : (
          <div className="bg-white border border-[#E2E8F0] rounded-2xl p-5 sm:p-6 shadow-sm">
            <button type="button" onClick={goBack} disabled={backLoading}
              className="inline-flex items-center gap-2 -ml-2.5 mb-2.5 min-h-10 px-3 py-2 rounded-xl text-[15px] font-semibold text-[#1D5BD6] hover:text-[#164BB5] hover:bg-[#EFF6FF] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
              <ChevronLeft className="w-5 h-5" /> Back
            </button>
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-bold text-[#0B2A5B]">Select Faculty</h2>
              </div>
            </div>

            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-[#64748B] uppercase tracking-widest">Semester</label>
                <div className="bg-[#F8FAFC] border border-[#E2E8F0] text-[#0B2A5B] rounded-xl px-3.5 py-2 text-sm font-semibold min-w-[160px] cursor-default select-none">
                  {semester || '—'}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-[#64748B] uppercase tracking-widest">School Year</label>
                <div className="bg-[#F8FAFC] border border-[#E2E8F0] text-[#0B2A5B] rounded-xl px-3.5 py-2 text-sm font-semibold min-w-[140px] cursor-default select-none">
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
              <motion.div
                // Re-animate the list on every filter switch
                key={schedFilter}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
              >
                <FacultyGroup
                  title={positionFilter}
                  items={filtered}
                  selectedId={pendingFacultyId ?? selFaculty?.id}
                  loadingId={pendingFacultyId}
                  onSelect={f => {
                    /* Local highlight + loading skeleton while this waits —
                       kept out of the URL so it doesn't create a spare
                       history entry between "instructor picked" and
                       "schedule view shown". */
                    setPendingFacultyId(f.id);
                    setTimeout(() => {
                      router.push(buildStepUrl({ step: 'schedule', faculty: String(f.id) }));
                      setPendingFacultyId(null);
                    }, 2000);
                  }}
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
            </PageLoadTransition>
          </div>
        )}
      </div>
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
  const byType = (rows: LoadRow[]) => (typeFilter === 'all' ? rows : rows.filter(r => r.component === typeFilter));

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
    const rawSessions = asSessionList(l.sessions);
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
          room_name: sess.room_name ?? l.room_name ?? null,
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
      {backLoading && <BackLoadingOverlay />}

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

      {/* ── Instructor header — phones only (desktop shows it above the right column) ── */}
      <div className="lg:hidden mb-3">
        {/* ── Header / Breadcrumb ─────────────────────── */}
        <div className="flex-shrink-0 bg-white border border-[#E2E8F0] rounded-2xl px-4 sm:px-6 py-3 shadow-sm">
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <button type="button" onClick={goBack} disabled={backLoading} className="text-[#64748B] hover:text-[#0B2A5B] transition disabled:opacity-50 disabled:cursor-not-allowed">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-1.5 text-sm text-[#64748B] min-w-0">
                <span onClick={goBack} className="text-[#1D5BD6] hover:text-[#164BB5] cursor-pointer font-medium">
                  {fromMsId ? 'Master Schedule' : 'Faculty'}
                </span>
                <ChevronRight className="w-4 h-4 flex-shrink-0" />
                <span className="text-[#0B2A5B] font-semibold truncate">{selFaculty?.name}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={openTimetable}
                className="qr-glow-btn inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold"
              >
                <CalendarDays className="w-4 h-4" />
                View Timetable
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

      {/* ── Dashboard Body: Assigned Subjects (full-height left) · header + scheduling (right) ── */}
      <div className="flex flex-1 min-h-0 min-w-0 gap-3">

        {/* ── LEFT: Load List ───────────────────────
            On phones, this list and the Scheduling Panel act like a
            master/detail pair — the list takes the full screen until a
            subject is picked, then it's hidden (back via the button in the
            panel header) so the detail view isn't crushed into a sliver. */}
        <div className={`${selLoad ? 'hidden lg:flex' : 'flex'} w-full ${panelExpanded ? 'lg:w-[34rem] xl:w-[40rem]' : 'lg:w-72 xl:w-80'} lg:transition-[width] lg:duration-500 lg:ease-in-out flex-shrink-0 rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] shadow-sm flex-col overflow-hidden min-h-0`}>
          <div className="flex-shrink-0 px-4 py-4 border-b border-[#E2E8F0] bg-white space-y-3">
            {/* Row 1 — title left, Expand / Collapse right (desktop; phones already use full width) */}
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-[#0B2A5B] uppercase tracking-widest">Assigned Subjects</h2>
              <button
                type="button"
                onClick={() => setPanelExpanded(v => !v)}
                aria-pressed={panelExpanded}
                title={panelExpanded ? 'Collapse the list' : 'Expand to see every subject in full'}
                className="hidden lg:inline-flex items-center gap-1 h-7 px-2.5 rounded-lg text-xs font-semibold text-[#1D5BD6] border border-[#BFDBFE] bg-white hover:bg-[#EFF6FF] transition-colors flex-shrink-0"
              >
                {panelExpanded
                  ? <><Minimize2 className="w-3.5 h-3.5" /> Collapse</>
                  : <><Maximize2 className="w-3.5 h-3.5" /> Expand</>}
              </button>
            </div>
            {/* Status counts (same-size chips, colour = meaning) */}
            <div>
              {workload && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {/* Pending works like a warning light: grey when there's nothing pending,
                      lights up red (soft glow) as soon as any subject needs a schedule */}
                  <button
                    type="button"
                    onClick={() => focusSection('regular')}
                    title={pendingRows.length > 0 ? 'Open the subjects waiting for a schedule' : 'Nothing pending'}
                    className={`inline-flex items-center h-6 px-2 rounded-full text-xs font-semibold border tabular-nums transition-all duration-300 hover:-translate-y-px hover:shadow-sm active:scale-95 ${
                      pendingRows.length > 0
                        ? 'text-red-600 bg-red-50 border-red-200 qr-attn-tile'
                        : 'text-[#94A3B8] bg-[#F4F7FC] border-[#E3E9F3]'
                    }`}
                  >
                    {pendingRows.length} pending
                  </button>
                  {overloadRows.length > 0 && (
                    <button type="button" onClick={() => focusSection('overload')} title="Open the overload subjects" className="inline-flex items-center h-6 px-2 rounded-full text-xs font-semibold text-orange-700 bg-orange-50 border border-orange-200 tabular-nums transition-all duration-300 hover:-translate-y-px hover:shadow-sm active:scale-95">{overloadRows.length} overload</button>
                  )}
                  {praiseRows.length + praise.length > 0 && (
                    <button type="button" onClick={() => focusSection('praise')} title="Open the Praise Load subjects" className="inline-flex items-center h-6 px-2 rounded-full text-xs font-semibold text-yellow-800 bg-yellow-50 border border-yellow-300 tabular-nums transition-all duration-300 hover:-translate-y-px hover:shadow-sm active:scale-95">{praiseRows.length + praise.length} praise</button>
                  )}
                  <button type="button" onClick={() => focusSection('scheduled')} title="Open the scheduled subjects" className="inline-flex items-center h-6 px-2 rounded-full text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 tabular-nums transition-all duration-300 hover:-translate-y-px hover:shadow-sm active:scale-95">{scheduledRows.length} done</button>
                </div>
              )}
            </div>

            {/* Row 2 — even three-way switch: All | Lecture | Laboratory.
                Filters every section below (Praise isn't lecture/lab, so it's unaffected). */}
            <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-[#F1F5F9] border border-[#E2E8F0]" role="group" aria-label="Filter by type">
              {([
                { id: 'all' as const, label: 'All',        Icon: null,     on: 'bg-white text-[#0B2A5B] shadow-sm' },
                { id: 'lec' as const, label: 'Lecture',    Icon: BookOpen, on: 'bg-white text-[#1D5BD6] shadow-sm' },
                { id: 'lab' as const, label: 'Laboratory', Icon: Monitor,  on: 'bg-white text-amber-600 shadow-sm' },
              ]).map(t => {
                const active = typeFilter === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      setTypeFilter(t.id);
                      // Keep the form in step with the list: a Lab part can't stay open under "Lecture"
                      if (selLoad && t.id !== 'all' && selLoad.component !== t.id) setSelLoad(null);
                    }}
                    title={t.id === 'all' ? 'Show all subjects' : `Show ${t.label} subjects only`}
                    className={`inline-flex items-center justify-center gap-1.5 h-8 rounded-lg text-[13px] font-semibold transition-all duration-200 ${
                      active ? t.on : 'text-[#64748B] hover:text-[#0B2A5B] hover:bg-white/60'
                    }`}
                  >
                    {t.Icon && <t.Icon className="w-3.5 h-3.5" />}
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            <PageLoadTransition
              showSkeleton={showWorkloadSkeleton}
              skeleton={
                <div className="p-4">
                  <TableSkeleton rows={6} cols={3} />
                </div>
              }
            >
              <>
                <LoadSection
                  expanded={panelExpanded}
                  title="Regular Load"
                  id="sched-sec-regular"
                  flash={flashSection === 'regular'}
                  shakeDelay={0}
                  tone="blue"
                  rows={byType(pendingRows)}
                  selLoadKey={selLoad?.key}
                  onSelect={selectLoad}
                  onPreview={setPreviewRow}
                  emptyMessage={typeFilter === 'all' ? 'No subjects waiting for a schedule.' : `No ${typeFilter === 'lec' ? 'Lecture' : 'Laboratory'} subjects here.`}
                  open={!!openSections.regular}
                  onToggle={() => toggleSection('regular')}
                />
                {/* Overload / Praise only appear when this instructor actually has some
                    (checked before the Lecture/Lab filter, so filtering never hides the section) */}
                {overloadRows.length > 0 && (
                <LoadSection
                  expanded={panelExpanded}
                  title="Overload"
                  id="sched-sec-overload"
                  flash={flashSection === 'overload'}
                  shakeDelay={0.6}
                  tone="orange"
                  rows={byType(overloadRows)}
                  selLoadKey={selLoad?.key}
                  onSelect={selectLoad}
                  onPreview={setPreviewRow}
                  emptyMessage={`No ${typeFilter === 'lec' ? 'Lecture' : 'Laboratory'} overload subjects.`}
                  open={!!openSections.overload}
                  onToggle={() => toggleSection('overload')}
                />
                )}
                {praiseRows.length > 0 && (
                <LoadSection
                  expanded={panelExpanded}
                  title="Praise Load"
                  id="sched-sec-praise"
                  flash={flashSection === 'praise'}
                  shakeDelay={1.2}
                  tone="gold"
                  rows={byType(praiseRows)}
                  selLoadKey={selLoad?.key}
                  onSelect={selectLoad}
                  onPreview={setPreviewRow}
                  emptyMessage={`No ${typeFilter === 'lec' ? 'Lecture' : 'Laboratory'} Praise Load subjects.`}
                  open={!!openSections.praise}
                  onToggle={() => toggleSection('praise')}
                />
                )}
                {/* Praise tasks (not subjects) — nothing to schedule, listed for reference */}
                {praise.length > 0 && (
                <CollapsibleSection
                  title="Praise Tasks"
                  id={praiseRows.length > 0 ? 'sched-sec-praise-tasks' : 'sched-sec-praise'}
                  flash={praiseRows.length === 0 && flashSection === 'praise'}
                  count={praise.length}
                  tone="gold"
                  open={!!openSections['praise-tasks'] || (praiseRows.length === 0 && !!openSections.praise)}
                  onToggle={() => toggleSection(praiseRows.length > 0 ? 'praise-tasks' : 'praise')}
                >
                  <div className={`rounded-xl border border-yellow-300 bg-white overflow-hidden flex flex-col shadow-sm ${panelExpanded ? '' : 'max-h-[360px]'}`}>
                    <div className="text-[13px] font-bold text-[#64748B] uppercase tracking-wide px-4 py-2 bg-[#F8FAFC] border-b border-[#E2E8F0] flex-shrink-0 sticky top-0 z-10">Task</div>
                    <div className="overflow-y-auto flex-1 overscroll-contain">
                      {praise.map(p => (
                        <div key={p.id} className="px-4 py-3 border-b border-[#F1F5F9] last:border-0">
                          <div className="text-[13px] font-semibold text-[#0B2A5B]">{p.praise_type ?? p.task_type ?? 'Praise task'}</div>
                          {p.description && <div className="text-xs text-[#64748B] mt-0.5">{p.description}</div>}
                          <div className="text-xs text-[#64748B] mt-0.5">{Number(p.equivalent_units ?? p.units ?? 0).toFixed(2)} units</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </CollapsibleSection>
                )}
                <LoadSection
                  expanded={panelExpanded}
                  title="Scheduled"
                  id="sched-sec-scheduled"
                  flash={flashSection === 'scheduled'}
                  tone="green"
                  rows={byType(scheduledRows)}
                  selLoadKey={selLoad?.key}
                  onSelect={selectLoad}
                  onPreview={setPreviewRow}
                  emptyMessage="Nothing scheduled yet."
                  open={!!openSections.scheduled}
                  onToggle={() => toggleSection('scheduled')}
                />
                {loads.length === 0 && !fetchingW && (
                  <div className="flex flex-col items-center justify-center py-14 px-4 text-center">
                    <p className="text-[13px] text-[#64748B]">No subjects assigned yet.</p>
                  </div>
                )}
              </>
            </PageLoadTransition>
          </div>
        </div>

        {/* ── RIGHT column: instructor header on top, scheduling panel below ── */}
        <div className={`${selLoad ? 'flex' : 'hidden lg:flex'} flex-1 min-w-0 lg:min-w-[560px] min-h-0 flex-col gap-3`}>
          <div className="hidden lg:block">
            {/* ── Header / Breadcrumb ─────────────────────── */}
            <div className="flex-shrink-0 bg-white border border-[#E2E8F0] rounded-2xl px-4 sm:px-6 py-3 shadow-sm">
              <div className="flex items-center justify-between gap-3 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <button type="button" onClick={goBack} disabled={backLoading} className="text-[#64748B] hover:text-[#0B2A5B] transition disabled:opacity-50 disabled:cursor-not-allowed">
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <div className="flex items-center gap-1.5 text-sm text-[#64748B] min-w-0">
                    <span onClick={goBack} className="text-[#1D5BD6] hover:text-[#164BB5] cursor-pointer font-medium">
                      {fromMsId ? 'Master Schedule' : 'Faculty'}
                    </span>
                    <ChevronRight className="w-4 h-4 flex-shrink-0" />
                    <span className="text-[#0B2A5B] font-semibold truncate">{selFaculty?.name}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={openTimetable}
                    className="qr-glow-btn inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold"
                  >
                    <CalendarDays className="w-4 h-4" />
                    View Timetable
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
          {/* ── CENTER: Scheduling Panel ───────────────
              Hidden on phones until a subject is selected (see LEFT panel
              note) — once visible it gets the full screen width instead of
              being squeezed next to the list. lg:min-w keeps it from being
              crushed by the sidebar once both show side by side on desktop. */}
          <div className={`flex flex-1 min-h-0 min-w-0 overflow-y-auto flex-col bg-[#F8FAFC] rounded-2xl border border-[#E2E8F0] shadow-sm`}>
            {selLoad && (
              <button
                type="button"
                onClick={() => setSelLoad(null)}
                className="lg:hidden flex-shrink-0 flex items-center gap-1.5 px-4 py-3 text-[13px] font-semibold text-[#1D5BD6] border-b border-[#E2E8F0] bg-white"
              >
                <ChevronLeft className="w-4 h-4" /> Back to subject list
              </button>
            )}
            {!selLoad ? (
              <div className="flex flex-col items-center justify-center flex-1 text-center px-8 py-20">
                <h3 className="text-base font-semibold text-[#0B2A5B]">No subject selected.</h3>
              </div>
            ) : panelSwitching ? (
              <div className="p-4 space-y-3 max-w-6xl" role="status" aria-live="polite" aria-label="Loading subject">
                {/* Subject header skeleton */}
                <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden shadow-sm">
                  <div className="px-4 py-2 border-b border-[#E2E8F0] flex items-center gap-2.5">
                    <Skeleton className="w-8 h-8 rounded-lg flex-shrink-0" />
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <Skeleton className="h-4 w-40 rounded" />
                      <Skeleton className="h-3 w-56 rounded" />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 divide-x divide-[#E2E8F0]">
                    {Array.from({ length: 3 }, (_, i) => (
                      <div key={i} className="px-4 py-2 flex flex-col items-center gap-1.5">
                        <Skeleton className="h-3 w-16 rounded" />
                        <Skeleton className="h-4 w-10 rounded" />
                      </div>
                    ))}
                  </div>
                  <div className="px-4 py-1.5 bg-[#F8FAFC] border-t border-[#E2E8F0]">
                    <Skeleton className="h-3 w-72 rounded" />
                  </div>
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
              <div className="p-4 space-y-3 max-w-6xl">

                {/* Subject header */}
                <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden shadow-sm">
                  <div className={`px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between gap-3 ${
                    selLoad.component === 'lec' ? 'border-l-[3px] border-l-[#1D5BD6]' : 'border-l-[3px] border-l-amber-500'
                  }`}>
                    <div className="flex items-center gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-[#0B2A5B]">{selLoad.load.subject_code}</span>
                          <span className={`text-[13px] font-bold px-2 py-0.5 rounded-full border ${
                            selLoad.component === 'lec'
                              ? 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]'
                              : 'bg-amber-50 text-amber-700 border-amber-200'
                          }`}>
                            {selLoad.label === 'Lec' ? 'Lecture' : 'Laboratory'}
                          </span>
                        </div>
                        <div className="text-[13px] text-[#64748B] mt-0.5 truncate max-w-[320px]">{selLoad.load.subject_name}</div>
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 divide-x divide-[#E2E8F0]">
                    {[
                      { label: 'Component Hrs', value: fmtHrs(toNum(selLoad.componentHours)) },
                      { label: 'Sessions',      value: String(sessions.length || '—') },
                      { label: 'Hrs / Session', value: sessions.length > 0 ? fmtHrs(toNum(sessions[0].hours)) : '—' },
                    ].map(({ label, value }) => (
                      <div key={label} className="px-4 py-2.5 text-center">
                        <div className="text-[13px] text-[#64748B] mb-0.5">{label}</div>
                        <div className="font-bold text-[#0B2A5B] text-base">{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="px-4 py-2.5 bg-[#F8FAFC] border-t border-[#E2E8F0] flex items-center gap-4 text-sm text-[#64748B] flex-wrap">
                    <span><span className="text-[#94A3B8]">Block:</span> <span className="font-semibold text-[#475569]">{blockCode(selLoad.load.year_level, selLoad.load.block_name)}</span></span>
                    <span><span className="text-[#94A3B8]">Year:</span> <span className="font-semibold text-[#475569]">{selLoad.load.year_level}</span></span>
                    <span><span className="text-[#94A3B8]">Sem:</span> <span className="font-semibold text-[#475569]">{selLoad.load.block_semester}</span></span>
                    <span><span className="text-[#94A3B8]">Program:</span> <span className="font-semibold text-[#475569]">{selLoad.load.program_code}</span></span>
                    <span><span className="text-[#94A3B8]">Units:</span> <span className="font-semibold text-[#475569]">{toNum(selLoad.componentUnits).toFixed(2)}</span></span>
                  </div>
                </div>

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

                {/* Day combination (semester setting) + session count */}
                <div className="bg-white rounded-xl border border-[#E2E8F0] p-3.5 shadow-sm space-y-3">
                  {dayCombos.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Day combination">
                      <span className="text-sm font-bold text-[#64748B] uppercase tracking-widest mr-1">Days</span>
                      {dayCombos.map(c => {
                        const on = currentCombo === c;
                        return (
                          <motion.button
                            key={c.id}
                            type="button"
                            onClick={() => applyCombination(c.days)}
                            whileTap={reduceMotion ? undefined : { scale: 0.95 }}
                            aria-pressed={on}
                            title={daysLabel(c.days)}
                            className={`relative h-9 px-3 rounded-lg border text-sm font-bold transition-colors ${
                              on ? 'border-[#0B2A5B]' : 'bg-white border-[#D6E0EF] text-[#0B2A5B] hover:border-[#9DB8E8] hover:bg-[#F8FAFE]'
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
                  )}
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-[#64748B] uppercase tracking-widest">Sessions</span>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => setManualCount(c => Math.max(1, c - 1))}
                        className="w-9 h-9 rounded-lg bg-[#F1F5F9] border border-[#E2E8F0] flex items-center justify-center text-[#475569] hover:bg-[#E2E8F0] transition text-lg font-bold">−</button>
                      <span className="w-10 text-center text-base font-bold text-[#0B2A5B]">{sessions.length > 0 ? sessions.length : manualCount}</span>
                      <button onClick={() => setManualCount(c => c + 1)}
                        className="w-9 h-9 rounded-lg bg-[#F1F5F9] border border-[#E2E8F0] flex items-center justify-center text-[#475569] hover:bg-[#E2E8F0] transition text-lg font-bold">+</button>
                    </div>
                  </div>
                  {comboError && (
                    <p className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-[13px] text-red-700">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {comboError}
                    </p>
                  )}
                </div>

                {/* SESSION TABLE */}
                {sessions.length > 0 && (
                  <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden shadow-sm">
                    <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-[#F8FAFC]">
                      <span className="text-xs font-bold text-[#64748B] uppercase tracking-widest">Session Schedule</span>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full text-[13px]">
                        <thead>
                          <tr className="bg-[#F8FAFC] text-[11px] font-semibold text-[#64748B] uppercase tracking-wider border-b border-[#E2E8F0]">
                            <th className="px-3 py-2.5 text-left w-14">Ses.</th>
                            <th className="px-3 py-2.5 text-left w-24">Hours</th>
                            <th className="px-3 py-2.5 text-left">Day</th>
                            <th className="px-3 py-2.5 text-left">Time</th>
                            <th className="px-3 py-2.5 text-left">Room</th>
                            <th className="px-3 py-2.5 text-center w-12">Del</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#F1F5F9]">
                          {sessions.map((sess, i) => {
                            const rowConflicts = sessionConflicts.filter(c => c.sessionId === sess.id);
                            const hasRowConflict = rowConflicts.length > 0;
                            return (
                            <tr key={sess.id} className={`transition ${hasRowConflict ? 'bg-red-50 border-l-[3px] border-l-red-500' : 'hover:bg-[#F8FAFC]'}`}>
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-bold text-[#475569]">{i + 1}</span>
                                  {hasRowConflict && <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />}
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="flex flex-col gap-0.5">
                                  <span className="font-semibold tabular-nums text-[#475569]">{parseFloat(String(sess.hours)).toFixed(2)} hr</span>
                                  <span className="text-xs text-[#94A3B8]">{toNum(selLoad.componentHours)} hrs ÷ {sessions.length}</span>
                                </div>
                              </td>
                              <td className="px-3 py-2.5">
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
                              </td>
                              <td className="px-3 py-2.5">
                                <div className="flex items-center gap-2">
                                  {/* Only times the instructor is free on this day can be picked;
                                      busy ones stay visible (struck through) so gaps make sense. */}
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
                              </td>
                              <td className="px-3 py-2.5">
                                <RoomPicker
                                  value={sess.room_id}
                                  onChange={v => updateSession(sess.id, 'room_id', v)}
                                  rooms={activeRooms.map(r => ({ ...r, busyWith: roomBusyWith(sess, r.id) || null }))}
                                  component={selLoad.component}
                                  day={sess.day}
                                  timeLabel={sess.start_time ? `${fmt12(sess.start_time)} – ${fmt12(sess.end_time)}` : undefined}
                                  warnEmpty={selLoad.component === 'lab'}
                                />
                              </td>
                              <td className="px-3 py-2.5 text-center">
                                <button onClick={() => removeSession(sess.id)}
                                  className="w-8 h-8 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 flex items-center justify-center transition mx-auto">
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {sessions.length > 1 && (
                      <p className="px-4 py-2.5 text-xs text-[#64748B] border-t border-[#F1F5F9]">
                        Session 1&apos;s time and room fill the other sessions — change any row to set it on its own.
                      </p>
                    )}
                  </div>
                )}

                {selLoad.isScheduled && (
                  <div className="bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D5BD6] px-4 py-3 rounded-xl text-[13px] flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 flex-shrink-0" />
                    Rescheduling {selLoad.label === 'Lab' ? 'Laboratory' : 'Lecture'} — saving will replace the existing {selLoad.label === 'Lab' ? 'Laboratory' : 'Lecture'} schedule only.
                  </div>
                )}

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
                    {(['instructor', 'room', 'block', 'duplicate'] as ConflictInfo['type'][]).map(type => {
                      const group = sessionConflicts.filter(c => c.type === type);
                      if (group.length === 0) return null;
                      const uniqueInGroup = new Set(group.map(c => c.conflictKey)).size;
                      const cfg = {
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
                {sessionConflicts.length === 0 && conflictsVerified && sessions.length > 0 && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-2.5 text-xs text-emerald-700 flex items-center gap-2">
                    <CheckCircle className="w-3.5 h-3.5" /> All sessions verified — no conflicts detected.
                  </div>
                )}
                {!conflictsVerified && sessions.length > 0 && allDaysSet && (
                  <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-2.5 text-xs text-[#64748B] flex items-center gap-2">
                    {checkingConflicts
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin text-[#1D5BD6]" /> Checking for conflicts…</>
                      : <><Search className="w-3.5 h-3.5" /> Checking for conflicts… or click &quot;Check Conflicts&quot; below.</>
                    }
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-3 flex-wrap">
                  <button onClick={runConflictCheck} disabled={sessions.length === 0 || checkingConflicts}
                    className={[
                      'flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold transition',
                      'disabled:opacity-40 disabled:cursor-not-allowed',
                      conflictsVerified && !hasConflicts && sessions.length > 0
                        ? 'border-emerald-200 text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                        : conflictsVerified && hasConflicts
                          ? 'border-red-200 text-red-700 bg-red-50 hover:bg-red-100'
                          : 'border-[#E2E8F0] text-[#475569] bg-white hover:bg-[#F8FAFC]',
                    ].join(' ')}>
                    {checkingConflicts
                      ? <><Loader2 className="w-4 h-4 animate-spin" /> Checking…</>
                      : conflictsVerified && !hasConflicts && sessions.length > 0
                        ? <><CheckCircle className="w-4 h-4" /> No Conflicts</>
                        : conflictsVerified && hasConflicts
                          ? <><XCircle className="w-4 h-4" /> {uniqueConflictCount} Conflict{uniqueConflictCount !== 1 ? 's' : ''}</>
                          : <><Search className="w-4 h-4" /> Check Conflicts</>
                    }
                  </button>

                  <button onClick={handleClear} disabled={sessions.length === 0}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[#E2E8F0] text-sm font-semibold text-[#475569] bg-white hover:bg-[#F8FAFC] disabled:opacity-40 disabled:cursor-not-allowed transition">
                    <RefreshCw className="w-4 h-4" /> Clear All
                  </button>

                  <button onClick={handleSave} disabled={!canSave || checkingConflicts}
                    className={[
                      'flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold text-white transition',
                      !canSave || checkingConflicts ? 'bg-[#CBD5E1] cursor-not-allowed' : 'qr-btn-soft',
                    ].join(' ')}>
                    {saving
                      ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</>
                      : hasConflicts
                        ? <><AlertTriangle className="w-4 h-4" /> Resolve Conflicts First</>
                        : selLoad.isScheduled
                          ? <><RefreshCw className="w-4 h-4" /> Reschedule {selLoad.label} — {selLoad.load.subject_code}</>
                          : <><Save className="w-4 h-4" /> Save {selLoad.label} Schedule — {selLoad.load.subject_code}</>
                    }
                  </button>
                </div>

                <div className="pb-4" />
              </div>
            )}
          </div>
        </div>
      </div>

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

      {/* ── Schedule Preview (Eye icon) ─────────────────
          Balanced ease: backdrop fades while the card rises + scales in
          (~0.45s); closing plays the reverse a little quicker (~0.3s). */}
      <AnimatePresence>
      {previewRow && (() => {
        const comp = previewRow.component;
        const typeLabel = comp === 'lec' ? 'Lecture' : 'Laboratory';
        const instructorCount = subjectInstructors
          ? new Set(subjectInstructors.map(si => si.faculty_id)).size
          : 0;
        const meetings = viewingInstructor ? getInstructorMeetings(viewingInstructor, comp) : [];
        const ease = [0.4, 0, 0.2, 1] as const;
        // List <-> schedule: slide in from the side you're heading to, out the other way
        const previewSlide = {
          enter: (dir: number) => (reduceMotion ? { opacity: 1 } : { opacity: 0, x: 28 * dir }),
          center: { opacity: 1, x: 0, transition: { duration: reduceMotion ? 0 : 0.3, ease } },
          exit: (dir: number) => (reduceMotion ? { opacity: 1 } : { opacity: 0, x: -28 * dir, transition: { duration: 0.2, ease } }),
        };
        // Cards settle in one after another
        const cardIn = (i: number) => ({
          initial: reduceMotion ? false : { opacity: 0, y: 10 },
          animate: { opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.3, ease, delay: reduceMotion ? 0 : 0.06 * i } },
        }) as const;
        return (
          <motion.div
            key="row-preview"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: reduceMotion ? 0 : 0.4, ease } }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.3, ease } }}
            className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-[rgba(15,23,42,0.35)]"
            data-modal-root
            onClick={() => setPreviewRow(null)}
            role="presentation"
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.45, ease, delay: reduceMotion ? 0 : 0.05 } }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.3, ease } }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="row-preview-title"
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
                        {viewingInstructor ? (
                          <motion.button
                            key="back"
                            type="button"
                            onClick={closeInstructorSchedule}
                            aria-label="Back to faculty"
                            initial={reduceMotion ? false : { opacity: 0, x: 8, scale: 0.8 }}
                            animate={{ opacity: 1, x: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.25, ease } }}
                            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 8, scale: 0.8, transition: { duration: 0.18, ease } }}
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
                            animate={{ opacity: 1, scale: 1, transition: { duration: reduceMotion ? 0 : 0.25, ease } }}
                            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8, transition: { duration: 0.18, ease } }}
                            className="inline-flex"
                          >
                            {comp === 'lec'
                              ? <BookOpen className="w-5 h-5 text-[#1D5BD6]" />
                              : <Monitor className="w-5 h-5 text-amber-600" />}
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 id="row-preview-title" className="text-base font-bold text-[#0B2A5B] leading-snug">
                          {previewRow.load.subject_code} • {typeLabel}
                        </h3>
                        <AnimatePresence initial={false}>
                          {!viewingInstructor && subjectInstructors && instructorCount > 0 && (
                            <motion.span
                              key="count-badge"
                              initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
                              animate={{ opacity: 1, scale: 1, transition: { duration: reduceMotion ? 0 : 0.25, ease } }}
                              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.85, transition: { duration: 0.18, ease } }}
                              className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#EAF1FC] text-[#1D5BD6] border border-[#BFD3F5]"
                            >
                              {instructorCount} Assigned
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </div>
                      <p className="text-sm text-[#64748B] mt-0.5">
                        {previewRow.load.subject_name}
                        {!viewingInstructor && subjectInstructors && (
                          <> • {instructorCount} Assigned Faculty</>
                        )}
                      </p>
                    </div>
                  </div>
                  <motion.button
                    type="button"
                    onClick={() => setPreviewRow(null)}
                    aria-label="Close"
                    whileHover={reduceMotion ? undefined : { rotate: 90 }}
                    whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                    transition={{ duration: 0.2, ease }}
                    className="p-1.5 -mr-1.5 -mt-1 rounded-lg hover:bg-[#F1F5F9] text-[#64748B] hover:text-[#0B2A5B] transition-colors flex-shrink-0"
                  >
                    <X className="w-5 h-5" />
                  </motion.button>
                </div>
              </div>

              {/* Body height glides between the list and a schedule; the views
                  slide sideways — forward to a schedule, back to the list. */}
              <AutoHeight className="min-h-0 overflow-y-auto overflow-x-hidden" reduceMotion={!!reduceMotion}>
                <AnimatePresence mode="wait" initial={false} custom={previewNavDir}>
                  <motion.div
                    key={viewingInstructor ? `sched-${viewingInstructor.ms_id}` : 'list'}
                    custom={previewNavDir}
                    variants={previewSlide}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    className="px-5 py-4 space-y-3"
                  >
                {!viewingInstructor ? (
                  /* ── List: every instructor handling this subject ── */
                  subjectInstructors === null ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#64748B]">
                      <Loader2 className="w-4 h-4 animate-spin text-[#1D5BD6]" /> Loading faculty…
                    </div>
                  ) : subjectInstructorsError ? (
                    <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-2xl px-4 py-3.5">
                      {subjectInstructorsError}
                    </div>
                  ) : subjectInstructors.length === 0 ? (
                    <div className="text-sm text-[#94A3B8] italic bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl px-4 py-3.5">
                      No faculty are assigned to this subject yet.
                    </div>
                  ) : (
                    subjectInstructors.map((si, i) => {
                      const isCurrent = si.faculty_id === selFaculty?.id;
                      return (
                        <motion.div
                          key={si.ms_id}
                          {...cardIn(i)}
                          className={`flex items-center gap-3.5 border rounded-2xl px-4 py-3.5 transition-colors hover:border-[#BFD3F5] ${
                            isCurrent ? 'bg-[#F5F9FF] border-[#BFD3F5]' : 'bg-[#F8FAFC] border-[#E2E8F0]'
                          }`}
                        >
                          <div className="w-11 h-11 rounded-xl bg-[#EAF1FC] border border-[#D6E3F8] flex items-center justify-center flex-shrink-0">
                            <BookOpen className="w-5 h-5 text-[#1D5BD6]" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-xs text-[#64748B] flex items-center gap-1.5">
                              Faculty
                              {isCurrent && (
                                <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-[#DCE8FC] text-[#164BB5]">Current</span>
                              )}
                            </div>
                            <div className="text-[15px] font-bold text-[#0B2A5B] truncate">{si.faculty_name}</div>
                            <div className="text-xs text-[#64748B] truncate">
                              {[si.program_code, blockCode(si.year_level, si.block_name)].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                          <motion.button
                            type="button"
                            onClick={() => openInstructorSchedule(si)}
                            whileHover={reduceMotion ? undefined : { y: -1 }}
                            whileTap={reduceMotion ? undefined : { scale: 0.95 }}
                            transition={{ duration: 0.18, ease }}
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
                {/* Instructor card */}
                <motion.div {...cardIn(0)} className="flex items-center gap-3.5 bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl px-4 py-3.5">
                  <div className="w-11 h-11 rounded-xl bg-[#EAF1FC] border border-[#D6E3F8] flex items-center justify-center flex-shrink-0">
                    <Users className="w-5 h-5 text-[#1D5BD6]" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs text-[#64748B]">Faculty</div>
                    <div className="text-[15px] font-bold text-[#0B2A5B] truncate">{viewingInstructor.faculty_name}</div>
                    <div className="text-xs text-[#64748B] truncate">
                      {[viewingInstructor.program_code, blockCode(viewingInstructor.year_level, viewingInstructor.block_name)].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </motion.div>

                {meetings.length === 0 ? (
                  <motion.div {...cardIn(1)} className="text-sm text-[#94A3B8] italic bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl px-4 py-3.5">
                    Not yet scheduled — no day, time, or room assigned.
                  </motion.div>
                ) : (
                  meetings.map((m, i) => (
                    <motion.div key={i} {...cardIn(i + 1)} className="flex items-center gap-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-2xl px-4 py-3.5">
                      <Clock className="w-4 h-4 text-[#64748B] flex-shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[15px] font-bold text-[#0B2A5B] leading-tight">{m.day}</div>
                        <div className="text-[13px] text-[#64748B] tabular-nums mt-0.5">{m.time}</div>
                      </div>
                      <span className={`ml-auto flex items-center gap-1.5 text-[13px] text-right min-w-0 ${m.room === 'No room assigned' ? 'text-[#64748B]' : 'font-semibold text-[#0B2A5B]'}`}>
                        <MapPin className="w-4 h-4 text-[#64748B] flex-shrink-0" />
                        <span className="truncate">{m.room}</span>
                      </span>
                    </motion.div>
                  ))
                )}
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
    </div>
  );
}
