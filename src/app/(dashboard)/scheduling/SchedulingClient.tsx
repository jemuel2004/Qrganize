'use client';

import { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { useToast } from '@/client/context/ToastContext';
import { useSchoolYear } from '@/client/context/SchoolYearContext';
import {
  Users, ChevronRight, BookOpen, Monitor,
  Star, AlertTriangle, CheckCircle, Clock, Plus, Trash2, X,
  RefreshCw, Save, Search,
  ChevronLeft, XCircle, Loader2, AlertCircle, TrendingUp,
  CalendarDays,
} from 'lucide-react';
import { ListSkeleton, TableSkeleton } from '@/client/components/ui/skeletons';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/client/hooks/useMinLoading';
import { useScrollLock } from '@/client/hooks/useScrollLock';

/* ─── types ─────────────────────────────────────────────────── */
interface Faculty {
  id: number; name: string; employee_id: string;
  position: string; employment_status: string;
  program_code: string; program_name: string;
  remaining_regular_load: number;
}
interface PraiseRecord { id: number; task_type: string; units: number; }
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
  block_name: string; year_level: string;
  block_semester: string; block_academic_year: string;
  program_code: string; schedule_status: string;
  day_pattern: string | null; start_time: string | null; end_time: string | null;
  room_name: string | null; room_type: string | null; status: string;
  overload_component?: 'lec' | 'lab' | 'full' | null;
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
  isScheduled: boolean;
  isSplitPortion: boolean;
  splitLabel?: 'Regular' | 'Overload';
}

type AppView = 'faculty' | 'schedule';

/* ─── constants ─────────────────────────────────────────────── */
const WEEK_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT: Record<string, string> = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed',
  Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
};
const SEMESTERS = ['1st Semester', '2nd Semester'];

function currentAcademicYear(): string {
  const now = new Date();
  const y   = now.getFullYear();
  const start = now.getMonth() >= 7 ? y : y - 1;
  return `${start}-${start + 1}`;
}
function generateAcademicYears(): string[] {
  const base = parseInt(currentAcademicYear().split('-')[0], 10);
  return [-1, 0, 1, 2].map(d => `${base + d}-${base + d + 1}`);
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
  load: { ms_id: number; subject_code: string; subject_name: string; block_name: string };
  label: 'Lec' | 'Lab';
  blockKey: string;
  start_time: string;
  end_time: string;
  day: string;
  room_name: string | null;
}

/** Fixed academic day — covers all Admin TIME_SLOTS (07:00–21:00) plus overnight ends. */
const TT_START_MIN = 7 * 60;    // 7:00 AM
const TT_END_MIN   = 24 * 60;   // midnight — evening labs (e.g. 21:00–00:00) must remain visible
const TT_PX_PER_MIN = 0.95;
/** Wide enough for "12:00 PM" / "10:00 AM" on one line with padding. */
const TT_TIME_W = 80;
const TT_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const TT_HOUR_MARKS = Array.from(
  { length: (TT_END_MIN - TT_START_MIN) / 60 + 1 },
  (_, i) => TT_START_MIN + i * 60,
);

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

function WeeklyTimetableGrid({
  blocks,
  onDelete,
}: {
  blocks: TimetableBlockView[];
  onDelete: (msId: number, subjectCode: string, blockName: string, component: 'lec' | 'lab') => void;
}) {
  const TT_HEIGHT = Math.round((TT_END_MIN - TT_START_MIN) * TT_PX_PER_MIN);
  const N = TT_DAYS.length;
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
          {TT_DAYS.map(d => (
            <div
              key={d}
              className="px-1 py-2.5 text-center text-xs font-semibold text-[#0F172A] border-l border-[#E2E8F0]"
            >
              {DAY_SHORT[d]}
            </div>
          ))}
        </div>

        {/* Fixed 7:00–midnight canvas (covers evening TIME_SLOTS + overnight ends) */}
        <div className="relative bg-white" style={{ height: TT_HEIGHT }}>
          <div
            className="absolute inset-0 pointer-events-none"
            style={{ display: 'grid', gridTemplateColumns: gridCols, zIndex: 0 }}
          >
            <div className="sticky left-0 border-r border-[#E2E8F0] bg-[#FAFBFC]" />
            {TT_DAYS.map(d => (
              <div key={d} className="border-l border-[#F1F5F9] h-full" />
            ))}
          </div>

          {TT_HOUR_MARKS.map(mins => {
            const y = minsToY(mins);
            const isEnd = mins === TT_END_MIN;
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

          {blocks.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center z-[5] pointer-events-none">
              <p className="text-sm text-[#94A3B8] bg-white/90 px-4 py-2 rounded-lg border border-[#E2E8F0]">
                No scheduled classes yet
              </p>
            </div>
          )}

          {blocks.map((block) => {
            const { load, label, blockKey, start_time: st, end_time: et, day, room_name } = block;
            const colIdx = (TT_DAYS as readonly string[]).indexOf(day);
            if (colIdx < 0) return null;

            const startMins = timeToMinutes(st);
            const endMins   = sessionEndMinutes(st, et);
            /* Clip to the fixed academic window; still show partial blocks that overlap it. */
            const visibleStart = Math.max(startMins, TT_START_MIN);
            const visibleEnd   = Math.min(endMins, TT_END_MIN);
            if (visibleEnd <= visibleStart) return null;

            const durationMins = visibleEnd - visibleStart;
            const top   = minsToY(visibleStart);
            const cardH = Math.max(28, Math.round(durationMins * TT_PX_PER_MIN) - 2);
            const isLab = label === 'Lab';
            const typeLabel = isLab ? 'Laboratory' : 'Lecture';
            const roomLabel = room_name ?? 'No room assigned';
            const tooltip = [
              `${load.subject_code} — ${load.subject_name}`,
              `${fmt12(st)} – ${fmt12(et)}`,
              `${typeLabel} · Block ${load.block_name} · ${roomLabel}`,
            ].join('\n');

            return (
              <div
                key={blockKey}
                title={tooltip}
                className={[
                  'absolute rounded border group cursor-default overflow-hidden',
                  isLab
                    ? 'bg-[#F8FAFC] border-[#CBD5E1]'
                    : 'bg-[#EFF6FF] border-[#BFDBFE]',
                ].join(' ')}
                style={{
                  top: top + 1,
                  height: cardH,
                  left: `calc(${TT_TIME_W}px + ${colIdx} * ((100% - ${TT_TIME_W}px) / ${N}) + 3px)`,
                  width: `calc((100% - ${TT_TIME_W}px) / ${N} - 6px)`,
                  zIndex: 10,
                  borderLeftWidth: 3,
                  borderLeftColor: isLab ? '#64748B' : '#3C91E6',
                  boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
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
                <div className="px-1.5 py-1 flex flex-col gap-0 leading-tight pr-4" style={{ pointerEvents: 'none' }}>
                  <div className="text-[11px] font-bold text-[#0F172A] truncate">
                    {load.subject_code}
                  </div>
                  {cardH >= 48 && (
                    <div className="text-[9px] text-[#475569] truncate">
                      {load.subject_name}
                    </div>
                  )}
                  <div className="text-[9px] font-semibold tabular-nums text-[#0F172A] truncate">
                    {fmt12(st)} – {fmt12(et)}
                  </div>
                  {cardH >= 72 && (
                    <div className={`text-[9px] truncate ${room_name ? 'text-[#64748B]' : 'text-[#B45309]'}`}>
                      {typeLabel} · Block {load.block_name}
                      {room_name ? ` · ${room_name}` : ' · No room'}
                    </div>
                  )}
                </div>
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
      rows.push({ key: `${load.id}-${splitComp}-reg`, load, component: splitComp,
        componentHours: splitHrs, componentUnits: splitCompU,
        displayHours: regDisplayHrs, displayUnits: regDisplayU,
        label: splitComp === 'lec' ? 'Lec' : 'Lab', isOverloadComponent: false,
        isScheduled: splitIsScheduled, isSplitPortion: true, splitLabel: 'Regular' });
      rows.push({ key: `${load.id}-${splitComp}-ol`, load, component: splitComp,
        componentHours: splitHrs, componentUnits: splitCompU,
        displayHours: olDisplayHrs, displayUnits: olDisplayU,
        label: splitComp === 'lec' ? 'Lec' : 'Lab', isOverloadComponent: true,
        isScheduled: splitIsScheduled, isSplitPortion: true, splitLabel: 'Overload' });
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
  }
  return rows;
}

/* ─── mini components ───────────────────────────────────────── */
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    Scheduled:  'bg-emerald-50 text-emerald-700 border-emerald-200',
    Assigned:   'bg-[#EFF6FF] text-[#3C91E6] border-[#BFDBFE]',
    Unassigned: 'bg-slate-50 text-slate-500 border-slate-200',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${map[status] ?? map.Unassigned}`}>
      {status}
    </span>
  );
}

/* ─── FacultyGroup ──────────────────────────────────────────── */
function FacultyGroup({ title, items, onSelect }: {
  title?: string; items: Faculty[];
  onSelect: (f: Faculty) => void;
}) {
  if (items.length === 0) return null;
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
        {items.map(f => (
          <button key={f.id} onClick={() => onSelect(f)}
            className="w-full text-left bg-white border border-[#E2E8F0] hover:border-[#3C91E6] hover:shadow-md rounded-xl px-5 py-4 transition-all duration-150 group shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2.5 mb-1">
                  <span className="font-bold text-[#1E3A5F] text-base truncate">{f.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full font-semibold flex-shrink-0 bg-[#EFF6FF] text-[#3C91E6] border border-[#BFDBFE]">
                    {f.employment_status === 'Permanent' ? 'Regular' : 'Part-time'}
                  </span>
                </div>
                <div className="text-sm text-[#64748B] flex items-center gap-2">
                  <span>{f.employee_id}</span><span>·</span><span>{f.position}</span>
                </div>
              </div>
              <div className="flex items-center gap-2.5 flex-shrink-0">
                <div className="text-right">
                  <div className="text-xs text-[#94A3B8]">Remaining Load</div>
                  <div className={`text-base font-bold ${f.remaining_regular_load > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                    {f.remaining_regular_load} {f.employment_status === 'Permanent' ? 'units' : 'hrs'}
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-[#94A3B8] group-hover:text-[#3C91E6] transition" />
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── LoadSection ───────────────────────────────────────────── */
function LoadSection({ title, icon, rows, accentClass, borderClass, selLoadKey, onSelect, alwaysShow, emptyMessage }: {
  title: string; icon: ReactNode;
  rows: LoadRow[]; accentClass: string; borderClass: string;
  selLoadKey: string | undefined;
  onSelect: (row: LoadRow) => void;
  alwaysShow?: boolean;
  emptyMessage?: string;
}) {
  if (rows.length === 0 && !alwaysShow) return null;
  return (
    <div className="px-3 pt-4 pb-2">
      <div className="flex items-center gap-2 mb-2.5">
        {icon}
        <span className={`text-xs font-bold uppercase tracking-widest ${accentClass}`}>{title}</span>
        {rows.length > 0 && (
          <span className="ml-auto text-xs text-[#64748B] font-semibold">{rows.length}</span>
        )}
      </div>
      <div className={`rounded-xl border ${borderClass} bg-white overflow-hidden flex flex-col shadow-sm`} style={{ maxHeight: 440 }}>
        {rows.length === 0 ? (
          <div className="px-4 py-5 text-sm text-[#94A3B8] italic text-center">
            {emptyMessage ?? 'No subjects assigned.'}
          </div>
        ) : (
        <>
        <div className="grid grid-cols-[1fr_auto] text-xs font-bold text-[#64748B] uppercase tracking-wide px-4 py-2 bg-[#F8FAFC] border-b border-[#E2E8F0] flex-shrink-0 sticky top-0 z-10">
          <span>Subject</span><span>Hrs</span>
        </div>
        <div className="overflow-y-auto flex-1 overscroll-contain">
        {rows.map((row, i) => {
          const isActive     = selLoadKey === row.key;
          const isLec        = row.component === 'lec';
          const prevRow      = rows[i - 1];
          const isNewSubject = !prevRow
            || prevRow.load.id !== row.load.id
            || prevRow.component !== row.component
            || prevRow.isSplitPortion !== row.isSplitPortion;
          return (
            <button
              key={row.key}
              onClick={() => onSelect(row)}
              className={[
                'w-full text-left px-4 py-3 border-b border-[#F1F5F9] last:border-0 transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3C91E6]/40 focus-visible:ring-inset',
                isNewSubject && i > 0 ? 'border-t border-[#E2E8F0]' : '',
                isActive
                  ? `bg-[#EFF6FF] border-l-[3px] ${isLec ? 'border-l-[#3C91E6]' : 'border-l-amber-500'}`
                  : 'hover:bg-[#F8FAFC]',
              ].join(' ')}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    {isLec
                      ? <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-[#EFF6FF] text-[#3C91E6] border border-[#BFDBFE] flex-shrink-0 flex items-center gap-1">
                          <BookOpen className="w-3 h-3" /> Lecture
                        </span>
                      : <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 flex-shrink-0 flex items-center gap-1">
                          <Monitor className="w-3 h-3" /> Laboratory
                        </span>
                    }
                    {row.splitLabel && (
                      <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 border ${
                        row.splitLabel === 'Overload'
                          ? 'bg-red-50 text-red-600 border-red-200'
                          : 'bg-slate-50 text-slate-500 border-slate-200'
                      }`}>{row.splitLabel}</span>
                    )}
                  </div>
                  <div className="text-sm font-bold text-[#1E3A5F] mb-0.5">{row.load.subject_code}</div>
                  {isNewSubject && (
                    <div className="text-xs text-[#64748B] truncate leading-tight mb-1.5">
                      {row.load.subject_name}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs text-[#64748B] bg-[#F1F5F9] px-2 py-0.5 rounded-full border border-[#E2E8F0]">
                      {row.load.block_name}
                    </span>
                    <StatusBadge status={row.isScheduled ? 'Scheduled' : row.load.schedule_status} />
                  </div>
                </div>
                <div className="flex-shrink-0 text-right min-w-[44px]">
                  <div className={`text-sm font-bold tabular-nums leading-tight ${isLec ? 'text-[#3C91E6]' : 'text-amber-600'}`}>
                    {row.displayHours}h
                  </div>
                  <div className="text-xs text-[#94A3B8] tabular-nums mt-0.5">
                    {toNum(row.displayUnits).toFixed(1)}u
                  </div>
                </div>
              </div>
            </button>
          );
        })}
        </div>
        </>
        )}
      </div>
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

  const [semester, setSemester]     = useState('1st Semester');
  const [schoolYear, setSchoolYear] = useState(currentAcademicYear);
  const [view, setView]                   = useState<AppView>('faculty');
  const [facultyList, setFacultyList]     = useState<Faculty[]>([]);
  const [facultyLoading, setFacultyLoading] = useState(false);
  const [selFaculty, setSelFaculty]       = useState<Faculty | null>(null);
  const [workload, setWorkload]           = useState<WorkloadSummary | null>(null);
  const [selLoad, setSelLoad]             = useState<LoadRow | null>(null);
  const [rooms, setRooms]                 = useState<Room[]>([]);
  const [facultySearch, setFacultySearch] = useState('');
  const [fetchingW, setFetchingW]         = useState(false);
  const [sessions, setSessions]       = useState<SessionItem[]>([]);
  const [manualCount, setManualCount] = useState(1);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState('');
  const [saving, setSaving]           = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    msId: number; subjectCode: string; blockName: string; component: 'lec' | 'lab';
  } | null>(null);
  const [deleting, setDeleting]         = useState(false);
  const [deleteError, setDeleteError]   = useState('');
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

  useEffect(() => {
    fetch('/api/rooms?status=Active')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setRooms(d.rooms || []); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setFacultyLoading(true);
    fetch('/api/faculty')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setFacultyList(d.faculty || d || []); })
      .catch(() => {})
      .finally(() => setFacultyLoading(false));
  }, []);

  const fetchWorkload = useCallback(() => {
    if (!selFaculty) return;
    setFetchingW(true);
    const qs = new URLSearchParams({ semester, academic_year: schoolYear }).toString();
    fetch(`/api/workload/${selFaculty.id}?${qs}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || data.error) { setWorkload(null); return; }
        setWorkload(data);
      })
      .catch(() => setWorkload(null))
      .finally(() => setFetchingW(false));
  }, [selFaculty, semester, schoolYear]);

  useEffect(() => { fetchWorkload(); }, [fetchWorkload]);

  useEffect(() => {
    setSelLoad(null); setSessions([]); setManualCount(1);
    setError(''); setSuccess(''); setSessionConflicts([]); setConflictsVerified(false);
  }, [semester, schoolYear]);

  function selectLoad(row: LoadRow) {
    setSelLoad(row); setError(''); setSuccess('');
    setSessionConflicts([]); setConflictsVerified(false);
    setSessions([]); setManualCount(1);
  }

  useEffect(() => {
    if (!selLoad) return;
    const comp        = selLoad.component;
    const compU       = toNum(selLoad.componentUnits);
    const compHrs     = toNum(selLoad.componentHours);
    const uPerSession = parseFloat((compU   / manualCount).toFixed(4));
    const hPerSession = parseFloat((compHrs / manualCount).toFixed(4));
    setSessions(Array.from({ length: manualCount }, () => ({
      id: uid(), day: '', start_time: '07:00',
      units: uPerSession, hours: hPerSession,
      end_time: addMinutes('07:00', Math.round(hPerSession * 60)),
      type: comp, room_id: '',
    })));
    setConflictsVerified(false); setSessionConflicts([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualCount, selLoad]);

  function updateSession(id: string, key: string, val: string | number) {
    setSessions(prev => prev.map(s => {
      if (s.id !== id) return s;
      const updated = { ...s, [key]: val };
      if (key === 'start_time') {
        updated.end_time = addMinutes(String(val), Math.round(toNum(updated.hours) * 60));
      }
      return updated;
    }));
    if (key === 'day' || key === 'start_time' || key === 'room_id') {
      setConflictsVerified(false); setSessionConflicts([]);
    }
  }

  function addSession() {
    if (!selLoad) return;
    const comp        = selLoad.component;
    const newCount    = sessions.length + 1;
    const uPerSession = parseFloat((toNum(selLoad.componentUnits) / newCount).toFixed(4));
    const hPerSession = parseFloat((toNum(selLoad.componentHours) / newCount).toFixed(4));
    setSessions(prev => [
      ...prev.map(s => ({ ...s, units: uPerSession, hours: hPerSession, end_time: addMinutes(s.start_time, Math.round(hPerSession * 60)) })),
      { id: uid(), day: '', start_time: '07:00', units: uPerSession, hours: hPerSession, end_time: addMinutes('07:00', Math.round(hPerSession * 60)), type: comp, room_id: '' },
    ]);
    setSessionConflicts([]); setConflictsVerified(false);
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
  const canSave           = isComplete && allDaysSet && sessions.length > 0 && !saving && !hasConflicts;

  async function runConflictCheck() {
    if (!selLoad || sessions.length === 0) return;
    setCheckingConflicts(true);
    const found: ConflictInfo[] = [];
    for (let i = 0; i < sessions.length; i++) {
      const a = sessions[i];
      if (!a.day) continue;
      const aStart = timeToMinutes(a.start_time);
      const aEnd   = timeToMinutes(a.end_time);
      for (let j = 0; j < i; j++) {
        const b = sessions[j];
        if (b.day !== a.day) continue;
        const bStart = timeToMinutes(b.start_time);
        const bEnd   = timeToMinutes(b.end_time);
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
        const sEnd   = timeToMinutes(normTime(sib.end_time));
        if (aStart < sEnd && aEnd > sStart) {
          const sibLabel = (sib.type || 'lec') === 'lab' ? 'Laboratory' : 'Lecture';
          const st = normTime(sib.start_time);
          const et = normTime(sib.end_time);
          found.push({
            sessionId: a.id,
            type: 'instructor',
            message: `Overlaps ${selLoad.load.subject_code} ${sibLabel} on ${a.day} (${fmt12(st)}–${fmt12(et)}). Same instructor cannot teach two sessions at once.`,
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
    window.setTimeout(() => setShowTimetable(false), 200);
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
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setError(msg); toast.error(msg); return;
      }
      const data = await res.json();
      setSuccess(`Schedule saved for ${selLoad.load.subject_code} (${selLoad.label}) — Block ${selLoad.load.block_name}`);
      toast.success(`Schedule saved for ${selLoad.load.subject_code} — Block ${selLoad.load.block_name}.`);
      setSelLoad(null); setSessions([]); fetchWorkload();
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
      toast.delete('Schedule deleted successfully.');
      setDeleteTarget(null); fetchWorkload();
    } catch { setDeleteError('Connection error. Please try again.'); }
    finally { setDeleting(false); }
  }

  const lectureRooms = rooms.filter(r => !LAB_ROOM_TYPES.includes(r.room_type));
  const labRooms     = rooms.filter(r =>  LAB_ROOM_TYPES.includes(r.room_type));
  const activeRooms  = selLoad?.component === 'lab' ? labRooms : lectureRooms;
  const showFacultySkeleton = useMinLoading(
    facultyLoading,
    facultyList.length === 0 ? PAGE_SKELETON_MIN_MS : 0,
  );
  const showWorkloadSkeleton = useMinLoading(fetchingW, workload == null ? PAGE_SKELETON_MIN_MS : 0);

  /* ══════════════════════════════════════════
     VIEW: FACULTY
     ══════════════════════════════════════════ */
  if (view === 'faculty') {
    const filtered = facultyList.filter(f =>
      f.name.toLowerCase().includes(facultySearch.toLowerCase()) ||
      f.employee_id.toLowerCase().includes(facultySearch.toLowerCase())
    );
    return (
      <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-[#1E3A5F]">Schedule Classes</h1>
        </div>
        <div className="w-full min-w-0">
          <div className="flex items-end gap-5 mb-6 flex-wrap">
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold text-[#64748B] uppercase tracking-widest">Semester</label>
              <div className="bg-[#F8FAFC] border border-[#3C91E6] ring-1 ring-[#3C91E6]/30 text-[#1E3A5F] rounded-xl px-4 py-3 text-sm font-semibold min-w-[200px] shadow-sm cursor-default select-none">
                {semester || '—'}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-xs font-bold text-[#64748B] uppercase tracking-widest">School Year</label>
              <div className="bg-[#F8FAFC] border border-[#3C91E6] ring-1 ring-[#3C91E6]/30 text-[#1E3A5F] rounded-xl px-4 py-3 text-sm font-semibold min-w-[170px] shadow-sm cursor-default select-none">
                {schoolYear || '—'}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 mb-6">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
              <input value={facultySearch} onChange={e => setFacultySearch(e.target.value)}
                placeholder="Search faculty…"
                className="w-full bg-white border border-[#E2E8F0] rounded-xl pl-9 pr-4 py-2.5 text-sm text-[#1E3A5F] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/40 focus:border-[#3C91E6] shadow-sm transition-colors" />
            </div>
          </div>
          <PageLoadTransition
            showSkeleton={showFacultySkeleton}
            skeleton={<ListSkeleton rows={6} />}
          >
            <>
              <FacultyGroup
                title="Faculty"
                items={filtered}
                onSelect={f => { setSelFaculty(f); setView('schedule'); setSelLoad(null); setSessions([]); }}
              />
              {filtered.length === 0 && (
                <div className="text-center py-16 text-[#94A3B8] text-sm">No faculty found.</div>
              )}
            </>
          </PageLoadTransition>
        </div>
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
  const pendingRows   = allRows.filter(r => !r.isOverloadComponent && !r.isScheduled);
  const overloadRows  = allRows.filter(r =>  r.isOverloadComponent && !r.isScheduled);
  const scheduledRows = allRows.filter(r => r.isScheduled);

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

  return (
    <div className="flex flex-col max-w-7xl mx-auto w-full min-w-0 p-4 sm:p-6" style={{ minHeight: '100vh' }}>

      {/* ── Header / Breadcrumb ─────────────────────── */}
      <div className="flex-shrink-0 bg-white border border-[#E2E8F0] rounded-2xl px-4 sm:px-6 py-3 shadow-sm mb-4">
        <div className="flex items-center justify-between gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <button type="button" onClick={() => setView('faculty')} className="text-[#64748B] hover:text-[#1E3A5F] transition">
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-1.5 text-sm text-[#64748B] min-w-0">
              <span onClick={() => setView('faculty')} className="text-[#3C91E6] hover:text-[#2563EB] cursor-pointer font-medium">
                Faculty
              </span>
              <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="text-[#1E3A5F] font-semibold truncate">{selFaculty?.name}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {selFaculty && (
              <div className="hidden sm:flex items-center gap-2 text-sm mr-1">
                <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-[#EFF6FF] text-[#3C91E6] border border-[#BFDBFE]">
                  {selFaculty.employment_status}
                </span>
                <span className="text-[#475569] text-sm">{selFaculty.position}</span>
              </div>
            )}
            <button
              type="button"
              onClick={openTimetable}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm font-semibold text-[#3C91E6] hover:text-[#2E7DD1] hover:bg-[#EFF6FF] border border-[#E2E8F0] hover:border-[#BFDBFE] transition-colors"
            >
              <CalendarDays className="w-4 h-4" />
              View Timetable
            </button>
            <button
              type="button"
              onClick={fetchWorkload}
              title="Refresh"
              className="p-1.5 rounded-lg hover:bg-[#F1F5F9] text-[#64748B] hover:text-[#1E3A5F] transition border border-transparent hover:border-[#E2E8F0]"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Semester selector strip */}
        <div className="flex items-center gap-3 mt-3 px-3 py-2.5 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex-wrap">
          <div className="flex items-center gap-1.5">
            <CalendarDays className="w-4 h-4 text-[#3C91E6] flex-shrink-0" />
            <span className="text-sm font-semibold text-[#3C91E6]">Viewing:</span>
          </div>
          <span className="text-sm font-bold text-[#3C91E6]">{semester || '—'} · {schoolYear || '—'}</span>
        </div>
      </div>

      {/* ── Dashboard Body ──────────────────────────── */}
      <div className="flex flex-1 min-w-0 overflow-x-auto border border-[#E2E8F0] rounded-2xl bg-white shadow-sm" style={{ minHeight: 0 }}>

        {/* ── LEFT: Load List ─────────────────────── */}
        <div className="w-72 sm:w-80 flex-shrink-0 border-r border-[#E2E8F0] bg-[#F8FAFC] flex flex-col overflow-hidden">
          <div className="flex-shrink-0 px-4 py-4 border-b border-[#E2E8F0] bg-white">
            <h2 className="text-sm font-bold text-[#1E3A5F] uppercase tracking-widest mb-1">Assigned Subjects</h2>
            {workload && (
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <span className="text-xs text-[#64748B] bg-[#F1F5F9] border border-[#E2E8F0] px-2 py-0.5 rounded-full">{pendingRows.length} pending</span>
                {overloadRows.length > 0 && <span className="text-xs text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">{overloadRows.length} overload</span>}
                <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">{scheduledRows.length} done</span>
              </div>
            )}
            <div className="flex items-center gap-4 mt-2.5">
              <span className="flex items-center gap-1.5 text-xs text-[#3C91E6] font-semibold">
                <BookOpen className="w-3.5 h-3.5" /> Lecture
              </span>
              <span className="flex items-center gap-1.5 text-xs text-amber-600 font-semibold">
                <Monitor className="w-3.5 h-3.5" /> Laboratory
              </span>
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
                  title="Pending Schedule"
                  icon={<Clock className="w-3.5 h-3.5 text-amber-500" />}
                  rows={pendingRows}
                  accentClass="text-amber-600"
                  borderClass="border-[#E2E8F0]"
                  selLoadKey={selLoad?.key}
                  onSelect={selectLoad}
                />
                <LoadSection
                  title="Overload"
                  icon={<TrendingUp className="w-3.5 h-3.5 text-red-500" />}
                  rows={overloadRows}
                  accentClass="text-red-600"
                  borderClass="border-red-200"
                  selLoadKey={selLoad?.key}
                  onSelect={selectLoad}
                  alwaysShow
                  emptyMessage="No overload subjects."
                />
                {praise.length > 0 && (
                  <div className="px-3 pt-3 pb-1">
                    <div className="flex items-center gap-1.5 mb-2">
                      <Star className="w-3.5 h-3.5 text-amber-500" />
                      <span className="text-[10px] font-bold text-amber-600 uppercase tracking-widest">Praise</span>
                    </div>
                    <div className="rounded-xl border border-amber-200 bg-white overflow-hidden flex flex-col max-h-[420px] shadow-sm">
                      <div className="text-[10px] font-bold text-[#64748B] uppercase px-3 py-1.5 bg-[#F8FAFC] border-b border-[#E2E8F0] flex-shrink-0 sticky top-0 z-10">Task</div>
                      <div className="overflow-y-auto flex-1 overscroll-contain">
                        {praise.map(p => (
                          <div key={p.id} className="px-3 py-2.5 border-b border-[#F1F5F9] last:border-0">
                            <div className="text-xs font-semibold text-[#1E3A5F]">{p.task_type}</div>
                            <div className="text-[11px] text-[#64748B] mt-0.5">{p.units} units</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                <LoadSection
                  title="Scheduled"
                  icon={<CheckCircle className="w-3.5 h-3.5 text-emerald-600" />}
                  rows={scheduledRows}
                  accentClass="text-emerald-700"
                  borderClass="border-emerald-200"
                  selLoadKey={selLoad?.key}
                  onSelect={selectLoad}
                />
                {loads.length === 0 && !fetchingW && (
                  <div className="flex flex-col items-center justify-center py-14 px-4 text-center">
                    <p className="text-sm text-[#64748B]">No subjects assigned yet.</p>
                  </div>
                )}
              </>
            </PageLoadTransition>
          </div>
        </div>

        {/* ── CENTER: Scheduling Panel ─────────────── */}
        <div className="flex-1 overflow-y-auto flex flex-col bg-[#F8FAFC]">
          {!selLoad ? (
            <div className="flex flex-col items-center justify-center flex-1 text-center px-8 py-20">
              <h3 className="text-lg font-semibold text-[#1E3A5F]">No subject selected.</h3>
            </div>
          ) : (
            <div className="p-5 space-y-4 max-w-3xl">

              {/* Subject header */}
              <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden shadow-sm">
                <div className={`px-5 py-3 border-b border-[#E2E8F0] flex items-center justify-between gap-3 ${
                  selLoad.component === 'lec' ? 'border-l-[3px] border-l-[#3C91E6]' : 'border-l-[3px] border-l-amber-500'
                }`}>
                  <div className="flex items-center gap-2.5">
                    {selLoad.component === 'lec'
                      ? <div className="w-8 h-8 rounded-lg bg-[#EFF6FF] flex items-center justify-center flex-shrink-0"><BookOpen className="w-4 h-4 text-[#3C91E6]" /></div>
                      : <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center flex-shrink-0"><Monitor className="w-4 h-4 text-amber-600" /></div>
                    }
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-[#1E3A5F]">{selLoad.load.subject_code}</span>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${
                          selLoad.component === 'lec'
                            ? 'bg-[#EFF6FF] text-[#3C91E6] border-[#BFDBFE]'
                            : 'bg-amber-50 text-amber-700 border-amber-200'
                        }`}>
                          {selLoad.label === 'Lec' ? 'Lecture' : 'Laboratory'}
                        </span>
                      </div>
                      <div className="text-[11px] text-[#64748B] mt-0.5 truncate max-w-[260px]">{selLoad.load.subject_name}</div>
                    </div>
                  </div>
                  {selLoad.load.lecture_hours > 0 && selLoad.load.laboratory_hours > 0 && (
                    <div className="flex-shrink-0 bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-1.5 text-[10px] text-[#64748B] leading-relaxed">
                      <div className="flex items-center gap-2">
                        <span className="text-[#3C91E6] font-semibold">Lec {toNum(selLoad.load.lecture_hours)} hr</span>
                        <span className="text-[#CBD5E1]">+</span>
                        <span className="text-amber-600 font-semibold">Lab {toNum(selLoad.load.laboratory_hours)} hr</span>
                        <span className="text-[#94A3B8]">= {toNum(selLoad.load.curriculum_total_hours)} hr total</span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-3 divide-x divide-[#E2E8F0]">
                  {[
                    { label: 'Component Hrs', value: fmtHrs(toNum(selLoad.componentHours)) },
                    { label: 'Sessions',      value: String(sessions.length || '—') },
                    { label: 'Hrs / Session', value: sessions.length > 0 ? fmtHrs(toNum(sessions[0].hours)) : '—' },
                  ].map(({ label, value }) => (
                    <div key={label} className="px-4 py-3 text-center">
                      <div className="text-[11px] text-[#64748B] mb-0.5">{label}</div>
                      <div className="font-bold text-[#1E3A5F] text-sm">{value}</div>
                    </div>
                  ))}
                </div>
                <div className="px-5 py-2.5 bg-[#F8FAFC] border-t border-[#E2E8F0] flex items-center gap-4 text-xs text-[#64748B] flex-wrap">
                  <span><span className="text-[#94A3B8]">Block:</span> <span className="font-semibold text-[#475569]">{selLoad.load.block_name}</span></span>
                  <span><span className="text-[#94A3B8]">Year:</span> <span className="font-semibold text-[#475569]">{selLoad.load.year_level}</span></span>
                  <span><span className="text-[#94A3B8]">Sem:</span> <span className="font-semibold text-[#475569]">{selLoad.load.block_semester}</span></span>
                  <span><span className="text-[#94A3B8]">Program:</span> <span className="font-semibold text-[#475569]">{selLoad.load.program_code}</span></span>
                  <span><span className="text-[#94A3B8]">Units:</span> <span className="font-semibold text-[#475569]">{toNum(selLoad.componentUnits).toFixed(2)}</span></span>
                </div>
              </div>

              {/* Split-component notice */}
              {selLoad.isSplitPortion && (() => {
                const thisComp  = selLoad.label === 'Lec' ? 'Lecture' : 'Laboratory';
                const otherComp = selLoad.label === 'Lec' ? 'Laboratory' : 'Lecture';
                const hasOther  = selLoad.label === 'Lec'
                  ? toNum(selLoad.load.laboratory_hours) > 0
                  : toNum(selLoad.load.lecture_hours) > 0;
                return (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700 flex gap-2 items-start">
                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>
                      <strong>Split {thisComp} component</strong> — the Regular and Overload portions of <strong>this {thisComp}</strong> represent the same class meeting, so they share one schedule. Saving here applies to both portions.
                      {hasOther && <> The <strong>{otherComp}</strong> component is a <strong>completely separate schedule</strong> — it must be scheduled independently.</>}
                    </span>
                  </div>
                );
              })()}

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {error}
                </div>
              )}
              {success && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 px-4 py-3 rounded-xl text-sm flex gap-2">
                  <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {success}
                </div>
              )}

              {/* Session count control */}
              <div className="bg-white rounded-xl border border-[#E2E8F0] p-4 shadow-sm">
                <div className="flex items-center gap-5">
                  <div>
                    <div className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest mb-1.5">Sessions</div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => setManualCount(c => Math.max(1, c - 1))}
                        className="w-8 h-8 rounded-lg bg-[#F1F5F9] border border-[#E2E8F0] flex items-center justify-center text-[#475569] hover:bg-[#E2E8F0] transition text-lg font-bold">−</button>
                      <span className="w-10 text-center font-bold text-[#1E3A5F]">{sessions.length > 0 ? sessions.length : manualCount}</span>
                      <button onClick={() => setManualCount(c => c + 1)}
                        className="w-8 h-8 rounded-lg bg-[#F1F5F9] border border-[#E2E8F0] flex items-center justify-center text-[#475569] hover:bg-[#E2E8F0] transition text-lg font-bold">+</button>
                    </div>
                  </div>
                </div>
                <p className="mt-3 text-xs text-[#64748B] bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2">
                  Session duration is always <strong className="text-[#475569]">{toNum(selLoad?.componentHours)} hrs ÷ {sessions.length || manualCount} sessions = {parseFloat((toNum(selLoad?.componentHours) / (sessions.length || manualCount)).toFixed(2))} hr each</strong>. Edit units per session to customize the unit split — units are for validation only and do not affect duration.
                </p>
              </div>

              {/* SESSION TABLE */}
              {sessions.length > 0 && (
                <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden shadow-sm">
                  <div className="px-4 py-2.5 border-b border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between">
                    <span className="text-[11px] font-bold text-[#64748B] uppercase tracking-widest">Session Schedule</span>
                    <span className="text-[10px] text-[#94A3B8] bg-[#F1F5F9] border border-[#E2E8F0] rounded px-2 py-0.5">
                      {toNum(selLoad.componentHours)} hrs ÷ {sessions.length} sessions · units for validation only
                    </span>
                  </div>

                  {unitsExceeded && (
                    <div className="mx-4 mt-3 flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                      Total units ({totalUnitsUsed.toFixed(4)}) exceeds component limit ({totalUnitsReq.toFixed(4)} units). Reduce session units.
                    </div>
                  )}

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-[#F8FAFC] text-[11px] font-semibold text-[#64748B] uppercase tracking-wide border-b border-[#E2E8F0]">
                          <th className="px-4 py-2.5 text-left w-14">Ses.</th>
                          <th className="px-4 py-2.5 text-left w-28">Units <span className="normal-case text-[#94A3B8] font-normal">(editable)</span></th>
                          <th className="px-4 py-2.5 text-left w-24">Hours <span className="normal-case text-[#94A3B8] font-normal">(fixed)</span></th>
                          <th className="px-4 py-2.5 text-left">Day</th>
                          <th className="px-4 py-2.5 text-left">Time</th>
                          <th className="px-4 py-2.5 text-left">Room</th>
                          <th className="px-4 py-2.5 text-center w-12">Del</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F1F5F9]">
                        {sessions.map((sess, i) => {
                          const rowConflicts = sessionConflicts.filter(c => c.sessionId === sess.id);
                          const hasRowConflict = rowConflicts.length > 0;
                          return (
                          <tr key={sess.id} className={`transition ${hasRowConflict ? 'bg-red-50 border-l-[3px] border-l-red-500' : 'hover:bg-[#F8FAFC]'}`}>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1.5">
                                <span className="font-bold text-[#475569]">{i + 1}</span>
                                {hasRowConflict && <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />}
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-col gap-0.5">
                                <input type="number" min="0" step="0.25"
                                  value={parseFloat(String(sess.units)).toFixed(2)}
                                  onChange={e => updateSession(sess.id, 'units', parseFloat(e.target.value) || 0)}
                                  className={`w-24 bg-white border rounded-lg px-2 py-1.5 text-sm font-semibold text-[#1E3A5F] focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/40 focus:border-[#3C91E6] tabular-nums transition-colors
                                    ${unitsExceeded ? 'border-red-400' : 'border-[#CBD5E1]'}`}
                                />
                                <span className="text-[10px] text-[#94A3B8] pl-0.5">units</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-col gap-0.5">
                                <span className="font-semibold tabular-nums text-[#475569]">{parseFloat(String(sess.hours)).toFixed(2)} hr</span>
                                <span className="text-[10px] text-[#94A3B8]">{toNum(selLoad.componentHours)} hrs ÷ {sessions.length}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <select value={sess.day} onChange={e => updateSession(sess.id, 'day', e.target.value)}
                                className="bg-white border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm text-[#1E3A5F] focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/40 focus:border-[#3C91E6] transition-colors">
                                <option value="">— Day —</option>
                                {WEEK_DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                              </select>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2">
                                <select value={sess.start_time} onChange={e => updateSession(sess.id, 'start_time', e.target.value)}
                                  className="bg-white border border-[#CBD5E1] rounded-lg px-3 py-2 text-sm text-[#1E3A5F] focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/40 focus:border-[#3C91E6] transition-colors">
                                  {TIME_SLOTS.map(t => <option key={t} value={t}>{fmt12(t)}</option>)}
                                </select>
                                <span className="text-[#CBD5E1] text-xs">→</span>
                                <span className="text-[#475569] text-xs font-semibold whitespace-nowrap flex items-center gap-1">
                                  <Clock className="w-3 h-3 text-[#94A3B8]" /> {fmt12(sess.end_time)}
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <select value={sess.room_id} onChange={e => updateSession(sess.id, 'room_id', e.target.value)}
                                className={[
                                  'bg-white border rounded-lg px-3 py-2 text-sm text-[#1E3A5F]',
                                  'focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/40 focus:border-[#3C91E6] min-w-[140px] transition-colors',
                                  selLoad.component === 'lab' && !sess.room_id ? 'border-amber-400' : 'border-[#CBD5E1]',
                                ].join(' ')}>
                                <option value="">— Room —</option>
                                {activeRooms.map(r => <option key={r.id} value={String(r.id)}>{r.room_name}</option>)}
                              </select>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <button onClick={() => removeSession(sess.id)}
                                className="w-7 h-7 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 flex items-center justify-center transition mx-auto">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                      {sessions.length > 1 && (
                        <tfoot>
                          <tr className="bg-[#F8FAFC] border-t border-[#E2E8F0] text-[11px] font-semibold text-[#64748B]">
                            <td className="px-4 py-2 text-[#94A3B8]">Total</td>
                            <td className="px-4 py-2">
                              <span className={unitsExceeded ? 'text-red-600' : Math.abs(remainingUnits) < 0.01 ? 'text-emerald-600' : 'text-amber-600'}>
                                {totalUnitsUsed.toFixed(4)} / {totalUnitsReq.toFixed(4)} units
                              </span>
                            </td>
                            <td className="px-4 py-2">
                              <span className={Math.abs(remaining) < 0.01 ? 'text-emerald-600' : 'text-amber-600'}>
                                {totalScheduled.toFixed(2)} / {totalRequired} hrs
                              </span>
                            </td>
                            <td colSpan={4} />
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>

                  <div className="px-4 py-3 border-t border-[#E2E8F0] bg-[#F8FAFC] flex items-center justify-between flex-wrap gap-3">
                    <button onClick={addSession}
                      className="flex items-center gap-1.5 text-sm font-semibold text-[#3C91E6] hover:text-[#2563EB] transition">
                      <Plus className="w-4 h-4" /> Add Session
                    </button>
                    <div className="flex items-center gap-4 text-sm flex-wrap">
                      <div>
                        <span className="text-[#64748B]">Units </span>
                        <span className={`font-bold ${unitsExceeded ? 'text-red-600' : Math.abs(remainingUnits) < 0.01 ? 'text-emerald-600' : 'text-amber-600'}`}>
                          {totalUnitsUsed.toFixed(2)} / {totalUnitsReq.toFixed(2)}
                        </span>
                        {Math.abs(remainingUnits) >= 0.01 && !unitsExceeded && (
                          <span className="text-[#94A3B8] ml-1">({remainingUnits.toFixed(2)} left)</span>
                        )}
                      </div>
                      <div>
                        <span className="text-[#64748B]">Scheduled </span>
                        <span className="font-bold text-[#1E3A5F]">{totalScheduled.toFixed(2)} hrs</span>
                      </div>
                      <div>
                        <span className="text-[#64748B]">Remaining </span>
                        <span className={`font-bold ${remaining > 0.01 ? 'text-amber-600' : remaining < -0.01 ? 'text-red-600' : 'text-emerald-600'}`}>
                          {remaining.toFixed(2)} hr
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[#64748B]">Status </span>
                        {isComplete
                          ? <span className="font-bold text-emerald-600 flex items-center gap-1"><CheckCircle className="w-4 h-4" /> Complete</span>
                          : <span className="font-bold text-amber-600 flex items-center gap-1"><Clock className="w-4 h-4" /> Pending</span>}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {selLoad.isScheduled && (
                <div className="bg-[#EFF6FF] border border-[#BFDBFE] text-[#3C91E6] px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 flex-shrink-0" />
                  Rescheduling {selLoad.label === 'Lab' ? 'Laboratory' : 'Lecture'} — saving will replace the existing {selLoad.label === 'Lab' ? 'Laboratory' : 'Lecture'} schedule only.
                </div>
              )}

              {hasLabRoomMissing && sessions.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 text-amber-700 px-4 py-3 rounded-xl text-sm flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  No room assigned yet. You can assign a room later.
                </div>
              )}

              {sessionConflicts.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2 text-sm font-bold text-red-700">
                    <XCircle className="w-4 h-4 flex-shrink-0" />
                    {uniqueConflictCount} Conflict{uniqueConflictCount !== 1 ? 's' : ''} Detected — resolve before saving
                  </div>
                  {(['instructor', 'room', 'block', 'duplicate'] as ConflictInfo['type'][]).map(type => {
                    const group = sessionConflicts.filter(c => c.type === type);
                    if (group.length === 0) return null;
                    const uniqueInGroup = new Set(group.map(c => c.conflictKey)).size;
                    const cfg = {
                      instructor: { label: 'Instructor Conflict', color: 'text-red-700',    dot: 'bg-red-500' },
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
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin text-[#3C91E6]" /> Checking for conflicts…</>
                    : <><Search className="w-3.5 h-3.5" /> Checking for conflicts… or click &quot;Check Conflicts&quot; below.</>
                  }
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-3 flex-wrap">
                <button onClick={runConflictCheck} disabled={sessions.length === 0 || checkingConflicts}
                  className={[
                    'flex items-center gap-2 px-5 py-3 rounded-xl border text-sm font-semibold transition',
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
                  className="flex items-center gap-2 px-5 py-3 rounded-xl border border-[#E2E8F0] text-sm font-semibold text-[#475569] bg-white hover:bg-[#F8FAFC] disabled:opacity-40 disabled:cursor-not-allowed transition">
                  <RefreshCw className="w-4 h-4" /> Clear All
                </button>

                <button onClick={handleSave} disabled={!canSave || checkingConflicts}
                  className={[
                    'flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-bold text-white transition',
                    !canSave || checkingConflicts ? 'bg-[#CBD5E1] cursor-not-allowed' : 'bg-[#3C91E6] hover:bg-[#2563EB]',
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

      {/* ── Delete Confirmation Modal ──────────────── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          data-modal-root
          onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(''); } }}
          onKeyDown={e => { if (e.key === 'Escape' && !deleting) { setDeleteTarget(null); setDeleteError(''); } }}
          tabIndex={-1} role="presentation">
          <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 px-6 py-5 border-b border-[#E2E8F0]">
              <div className="w-10 h-10 rounded-xl bg-red-50 border border-red-100 flex items-center justify-center flex-shrink-0">
                <Trash2 className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-[#1E3A5F]">
                  Delete {deleteTarget.component === 'lab' ? 'Laboratory' : 'Lecture'} Schedule
                </h3>
                <p className="text-xs text-[#64748B] mt-0.5">
                  Only this component is removed — the other Lecture/Laboratory schedule is kept
                </p>
              </div>
              <button onClick={() => { if (!deleting) { setDeleteTarget(null); setDeleteError(''); } }}
                className="ml-auto p-1.5 rounded-lg hover:bg-[#F8FAFC] text-[#64748B] hover:text-[#1E3A5F] transition">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-[#475569]">
                Are you sure you want to delete the{' '}
                <strong>{deleteTarget.component === 'lab' ? 'Laboratory' : 'Lecture'}</strong>{' '}
                schedule only?
              </p>
              <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#64748B] uppercase tracking-wide">Subject</span>
                  <span className="text-sm font-bold text-[#1E3A5F] font-mono">{deleteTarget.subjectCode}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#64748B] uppercase tracking-wide">Component</span>
                  <span className="text-sm font-semibold text-[#475569]">
                    {deleteTarget.component === 'lab' ? 'Laboratory' : 'Lecture'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[#64748B] uppercase tracking-wide">Block</span>
                  <span className="text-sm font-semibold text-[#475569]">{deleteTarget.blockName}</span>
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
                className="flex-1 px-4 py-2.5 rounded-xl border border-[#E2E8F0] text-sm font-semibold text-[#64748B] hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed transition">
                Cancel
              </button>
              <button onClick={handleDeleteSchedule} disabled={deleting}
                className="flex-1 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-sm font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2">
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
            transition: 'background-color 200ms ease-out',
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
              maxWidth: 'min(1120px, 90vw)',
              maxHeight: '90vh',
              opacity: timetableEntered ? 1 : 0,
              transform: timetableEntered ? 'scale(1)' : 'scale(0.98)',
              transition: 'opacity 200ms ease-out, transform 200ms ease-out',
            }}
          >
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[#E2E8F0] flex-shrink-0">
              <div className="min-w-0">
                <h3 id="weekly-timetable-title" className="text-base font-bold text-[#1E3A5F] flex items-center gap-2">
                  <CalendarDays className="w-4 h-4 text-[#3C91E6] flex-shrink-0" />
                  Weekly Timetable
                </h3>
                <p className="text-xs text-[#475569] mt-1 truncate">
                  {selFaculty?.name} · {semester} · A.Y. {schoolYear}
                  <span className="text-[#64748B]"> · {timetableBlocks.length} session{timetableBlocks.length !== 1 ? 's' : ''}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={closeTimetable}
                aria-label="Close timetable"
                className="p-1.5 rounded-lg hover:bg-[#F8FAFC] text-[#64748B] hover:text-[#1E3A5F] transition flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden bg-[#F8FAFC]">
              <div className="h-full bg-white border-t border-[#E2E8F0]" style={{ maxHeight: 'calc(90vh - 4.75rem)' }}>
                <WeeklyTimetableGrid
                  blocks={timetableBlocks}
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
    </div>
  );
}
