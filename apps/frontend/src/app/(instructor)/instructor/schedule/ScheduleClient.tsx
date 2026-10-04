'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { PageLoadTransition, revealProps } from '@/components/ui/PageLoadTransition';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { dayTone } from '@/lib/dayTones';
import { WEEK_DAYS, daysCode, daysKey, daysLabel, parseDays, type WeekDay } from '@shared/dayCombination';
import { blockCode } from '@shared/blockCode';
import { Skeleton } from '@/components/ui/skeletons';
import { useToast } from '@/context/ToastContext';
import {
  CalendarDays, MapPin, Users, Clock,
  QrCode, CheckCircle2, AlertTriangle, XCircle, Timer,
  Hourglass, ShieldCheck,
} from 'lucide-react';

interface SessionData {
  day: string;
  start_time: string;
  end_time: string;
  room_name: string | null;
  room_id: number | null;
}
interface Schedule {
  master_schedule_id: number;
  subject_code: string;
  subject_name: string;
  total_hours: number;
  units: number;
  lecture_hours: number;
  laboratory_hours: number;
  block_name: string;
  year_level: string;
  semester: string;
  academic_year: string;
  program_code: string;
  program_name: string;
  status: string;
  room_name: string | null;
  day_pattern: string | null;
  start_time: string | null;
  end_time: string | null;
  sessions: SessionData[] | null;
}
interface RoomOccupancy { status: string; is_self: boolean; }

/* ── Scan Availability Logic ─────────────────────────────────────────────── */
type ScanStatus =
  | 'no-room'
  | 'not-today'
  | 'not-yet'
  | 'available'
  | 'in-use-self'
  | 'in-use-other'
  | 'pending-confirmation'
  | 'approved'
  | 'expired';

function getScanStatus(
  sess: SessionData,
  now: Date,
  todayName: string,
  occupancy: Record<number, RoomOccupancy>,
  requests: Record<number, string>,
  msId: number,
): ScanStatus {
  if (!sess.room_id) return 'no-room';
  if (sess.day !== todayName) return 'not-today';

  const [sh, sm] = sess.start_time.split(':').map(Number);
  const [eh, em] = sess.end_time.split(':').map(Number);
  const startMins  = sh * 60 + sm;
  const endMins    = eh * 60 + em;
  const nowMins    = now.getHours() * 60 + now.getMinutes();
  const windowMins = 15;

  if (nowMins > endMins) return 'expired';
  if (nowMins < startMins - windowMins) return 'not-yet';

  /* Within the scan window — check pending requests first */
  const reqStatus = requests[msId];
  if (reqStatus === 'Pending Confirmation') return 'pending-confirmation';
  if (reqStatus === 'Approved') return 'approved';

  /* Check room occupancy */
  const occ = occupancy[sess.room_id];
  if (occ) {
    return occ.is_self ? 'in-use-self' : 'in-use-other';
  }

  return 'available';
}

interface BadgeConfig {
  label: string;
  icon: React.ReactNode;
  classes: string;
  pulse?: boolean;
}

function badgeConfig(status: ScanStatus): BadgeConfig | null {
  switch (status) {
    case 'not-today': return null;
    case 'no-room':
      return { label: 'No Room Assigned', icon: <MapPin className="w-3 h-3" />, classes: 'bg-[#F8FAFC] text-[#64748B] border-[#E2E8F0]' };
    case 'not-yet':
      return { label: 'Not Yet Available', icon: <Hourglass className="w-3 h-3" />, classes: 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]' };
    case 'available':
      return { label: 'Available to Scan', icon: <QrCode className="w-3 h-3" />, classes: 'bg-emerald-50 text-emerald-700 border-emerald-200', pulse: true };
    case 'in-use-self':
      return { label: 'Scan Active — In Use', icon: <ShieldCheck className="w-3 h-3" />, classes: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    case 'in-use-other':
      return { label: 'Room Already In Use', icon: <XCircle className="w-3 h-3" />, classes: 'bg-red-50 text-red-700 border-red-200' };
    case 'pending-confirmation':
      return { label: 'Pending Confirmation', icon: <Timer className="w-3 h-3" />, classes: 'bg-amber-50 text-amber-700 border-amber-200', pulse: true };
    case 'approved':
      return { label: 'Room Change Approved', icon: <CheckCircle2 className="w-3 h-3" />, classes: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    case 'expired':
      return { label: 'Scan Window Expired', icon: <AlertTriangle className="w-3 h-3" />, classes: 'bg-[#F8FAFC] text-[#64748B] border-[#E2E8F0]' };
    default: return null;
  }
}

function ScanAvailabilityBadge({
  sess, now, todayName, occupancy, requests, msId,
}: {
  sess: SessionData;
  now: Date;
  todayName: string;
  occupancy: Record<number, RoomOccupancy>;
  requests: Record<number, string>;
  msId: number;
}) {
  const status = getScanStatus(sess, now, todayName, occupancy, requests, msId);
  const cfg = badgeConfig(status);
  if (!cfg) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md border ${cfg.classes} ${cfg.pulse ? 'animate-pulse' : ''}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function fmt12(t: string): string {
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = mStr || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function typeLabel(lecH: number, labH: number): string {
  if (lecH > 0 && labH > 0) return 'Lec + Lab';
  if (labH > 0) return 'Lab';
  return 'Lecture';
}

/** One meeting time of a class inside a day combination (e.g. 7:00–8:30 on Mon and Thu) */
interface ComboSlot { start_time: string; end_time: string; sessions: SessionData[] }

/** A class as it shows under one day combination */
interface ComboClass {
  key: string;
  master_schedule_id: number;
  subject_code: string;
  subject_name: string;
  block_name: string;
  year_level: string;
  program_code: string;
  lecture_hours: number;
  laboratory_hours: number;
  slots: ComboSlot[];
}

/** A day combination this faculty teaches on — the same sets (MTh, TF, W…) as Scheduling */
interface ComboGroup { key: string; days: WeekDay[]; code: string; label: string; classes: ComboClass[] }

const dayIndex = (d: string) => WEEK_DAYS.indexOf(d as WeekDay);

/**
 * Only the day combinations this faculty actually has. Each meeting time of a
 * class counts on the set of days it meets (Mon + Thu at 7:00 → MTh), so a
 * Lecture on TF and its Lab on W show under TF and W.
 */
function buildCombos(schedules: Schedule[]): ComboGroup[] {
  const groups = new Map<string, ComboGroup>();
  const seen = new Set<number>();
  for (const s of schedules) {
    // A class listed twice (e.g. part of it moved to Overload) meets only once
    if (seen.has(s.master_schedule_id)) continue;
    seen.add(s.master_schedule_id);
    const byTime = new Map<string, SessionData[]>();
    for (const sess of s.sessions ?? []) {
      if (!sess.day || !sess.start_time || !sess.end_time) continue;
      const k = `${sess.start_time}|${sess.end_time}`;
      byTime.set(k, [...(byTime.get(k) ?? []), sess]);
    }
    for (const [time, sessions] of byTime) {
      const days = parseDays(sessions.map(x => x.day));
      if (!days) continue;
      const key = daysKey(days);
      const group = groups.get(key) ?? { key, days, code: daysCode(days), label: daysLabel(days), classes: [] };
      groups.set(key, group);
      const [start_time, end_time] = time.split('|');
      const slot = { start_time, end_time, sessions: [...sessions].sort((a, b) => dayIndex(a.day) - dayIndex(b.day)) };
      const existing = group.classes.find(c => c.master_schedule_id === s.master_schedule_id);
      if (existing) existing.slots.push(slot);
      else group.classes.push({
        key: `${s.master_schedule_id}-${key}`,
        master_schedule_id: s.master_schedule_id,
        subject_code: s.subject_code,
        subject_name: s.subject_name,
        block_name: s.block_name,
        year_level: s.year_level,
        program_code: s.program_code,
        lecture_hours: s.lecture_hours,
        laboratory_hours: s.laboratory_hours,
        slots: [slot],
      });
    }
  }
  const first = (c: ComboClass) => c.slots.reduce((m, x) => (x.start_time < m ? x.start_time : m), '99');
  for (const g of groups.values()) {
    for (const c of g.classes) c.slots.sort((a, b) => a.start_time.localeCompare(b.start_time));
    g.classes.sort((a, b) => first(a).localeCompare(first(b)) || a.subject_code.localeCompare(b.subject_code, undefined, { numeric: true }));
  }
  // Week order (MTh, TF, W, …); combinations starting the same day: more days first
  return [...groups.values()].sort((a, b) =>
    dayIndex(a.days[0]) - dayIndex(b.days[0]) || b.days.length - a.days.length || a.key.localeCompare(b.key));
}

function ComboClassRow({
  item,
  todayName,
  showScanBadges,
  now,
  occupancy,
  requests,
}: {
  item: ComboClass;
  todayName: string;
  showScanBadges: boolean;
  now: Date;
  occupancy: Record<number, RoomOccupancy>;
  requests: Record<number, string>;
}) {
  const lecH = parseFloat(String(item.lecture_hours)) || 0;
  const labH = parseFloat(String(item.laboratory_hours)) || 0;
  const sessions = item.slots.flatMap(x => x.sessions);
  const rooms = [...new Set(sessions.map(x => x.room_name).filter((r): r is string => !!r))];
  const todaySessions = showScanBadges ? sessions.filter(x => x.day === todayName) : [];

  return (
    <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] px-4 sm:px-5 py-4 transition-shadow duration-200 hover:shadow-[0_6px_16px_-8px_rgba(11,42,91,0.25)]">
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-5">
        <div className="flex flex-col gap-1 flex-shrink-0">
          {item.slots.map(slot => (
            <div key={`${slot.start_time}-${slot.end_time}`} className="flex items-center gap-2 text-sm font-semibold text-[#0B2A5B] tabular-nums">
              <Clock className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
              {fmt12(slot.start_time)} – {fmt12(slot.end_time)}
            </div>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-[#0F172A] text-base">{item.subject_code}</span>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md border bg-[#F8FAFC] text-[#475569] border-[#E2E8F0]">
              {typeLabel(lecH, labH)}
            </span>
          </div>
          <p className="text-sm text-[#0F172A] font-medium mt-0.5 break-words">{item.subject_name}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-[#475569]">
            <span className="flex items-center gap-1.5">
              <Users className="w-3 h-3 text-[#1D5BD6]" />
              {[item.program_code, blockCode(item.year_level, item.block_name)].filter(Boolean).join(' ')}
            </span>
            {rooms.length > 0 ? (
              <span className="flex items-center gap-1.5">
                <MapPin className="w-3 h-3 text-[#1D5BD6]" />
                {rooms.join(' / ')}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[#B45309] font-medium">
                <MapPin className="w-3 h-3" /> No room assigned
              </span>
            )}
          </div>
          {todaySessions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {todaySessions.map(sess => (
                <ScanAvailabilityBadge
                  key={`${sess.start_time}-${sess.end_time}`}
                  sess={sess}
                  now={now}
                  todayName={todayName}
                  occupancy={occupancy}
                  requests={requests}
                  msId={item.master_schedule_id}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Columns for the combination buttons: up to 3 a row on phones, all in one row from tablets up */
const comboCols = (n: number) => ({
  ['--combo-cols' as string]: Math.min(Math.max(n, 1), 3),
  ['--combo-cols-sm' as string]: Math.min(Math.max(n, 1), 7),
});
const COMBO_GRID = 'grid grid-cols-[repeat(var(--combo-cols),minmax(0,1fr))] sm:grid-cols-[repeat(var(--combo-cols-sm),minmax(0,1fr))] gap-x-2 gap-y-3 sm:gap-3 mb-5 pt-2';

/** Same shape as the page — combination buttons, then the card (with its list when open) */
function ScheduleSkeleton({ days, rows }: { days: number; rows: number }) {
  return (
    <div>
      <div className={COMBO_GRID} style={comboCols(days)}>
        {Array.from({ length: days }, (_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
      </div>
      <div className="bg-white rounded-2xl border-2 border-[#E2E8F0] overflow-hidden mb-5">
        <div className="p-5 lg:px-6 lg:py-6 flex items-center gap-3.5">
          <Skeleton className="w-11 h-11 rounded-xl flex-shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton className="h-3 w-28 rounded" />
            <Skeleton className="h-6 w-10 rounded" />
          </div>
          <Skeleton className="h-4 w-24 rounded" />
        </div>
        {rows > 0 && (
          <div className="border-t border-[#EEF2F8] p-4 space-y-3">
            {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-[144px] sm:h-[110px] rounded-2xl" />)}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main Page Component ─────────────────────────────────────────────────── */
export default function ScheduleClient() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [occupancy, setOccupancy] = useState<Record<number, RoomOccupancy>>({});
  const [requests, setRequests] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(new Date());
  /** The picked day combination ('' = the one with today in it, else the first) */
  const [selectedKey, setSelectedKey] = useState('');
  // The class list stays folded until the card is clicked
  const [listOpen, setListOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const reduceMotion = useReducedMotion();
  const toast = useToast();

  const load = useCallback((silent = false): Promise<boolean> => {
    if (!silent) { setLoading(true); setError(''); }
    return fetch('/api/instructor/my-schedule')
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(d => {
        setSchedules(d.schedules || []);
        setOccupancy(d.room_occupancy ?? {});
        setRequests(d.room_requests ?? {});
        setNow(new Date());
        setError('');
        return true;
      })
      .catch(() => { if (!silent) setError('Failed to load schedule. Please try again.'); return false; })
      .finally(() => { if (!silent) setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live updates: a class assigned, scheduled or moved to another room, a room
  // taken or freed, a request decided — the schedule reloads quietly
  useRealtime(['schedule', 'workload', 'rooms', 'occupancy', 'room-requests', 'term'], () => load(true), { enabled: !loading });
  // Fallback for time-based changes (the current class, live room status)
  useVisibilityAwareInterval(() => load(true), 60_000);

  // Refresh button: the schedule reloads behind the skeleton, then fades back in
  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    const ok = await load(true);
    setRefreshing(false);
    if (!ok) toast.error('Could not refresh your schedule. Check your connection and try again.');
    return ok;
  }, [load, toast]);

  const showSkeleton = useMinLoading((loading && schedules.length === 0 && !error) || refreshing, PAGE_SKELETON_MIN_MS);

  const todayName = now.toLocaleDateString('en-US', { weekday: 'long' });
  const combos = useMemo(() => buildCombos(schedules), [schedules]);
  const hasToday = (c: ComboGroup) => c.days.includes(todayName as WeekDay);
  // A combination that's gone after a live update falls back to today's (or the first)
  const selected = combos.find(c => c.key === selectedKey) ?? combos.find(hasToday) ?? combos[0] ?? null;
  const comboClasses = selected?.classes ?? [];
  const tone = dayTone(selected?.days[0] ?? todayName);

  const isViewingToday = !!selected && hasToday(selected);
  const availableCount = isViewingToday
    ? comboClasses.reduce((n, item) => n + item.slots.flatMap(x => x.sessions).filter(sess =>
        sess.day === todayName
        && getScanStatus(sess, now, todayName, occupancy, requests, item.master_schedule_id) === 'available').length, 0)
    : 0;

  const classCountLabel = isViewingToday
    ? "Today's Classes"
    : `${selected?.label ?? ''} Classes`;

  return (
    <div className="min-h-full p-4 sm:p-6 lg:p-8">
      {/* Desktop: balanced width, centred (phones/tablets unchanged) */}
      <div className="lg:max-w-6xl lg:mx-auto">

      <div className="mb-5">
        <BackButton />
        <div className="mt-2 lg:mt-5 mb-4">
          <WatermarkTitle>My Schedule</WatermarkTitle>
        </div>
        <div className="flex justify-end">
          <RefreshButton overlay={false} onRefresh={refreshAll} loading={refreshing || showSkeleton} />
        </div>
      </div>

      {error && (
        <div className="bg-white border border-[#FECACA] text-[#DC2626] px-4 py-3 rounded-2xl text-sm mb-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          {error}
        </div>
      )}

      <PageLoadTransition
        showSkeleton={showSkeleton}
        skeleton={<ScheduleSkeleton days={Math.max(1, combos.length)} rows={listOpen ? comboClasses.length : 0} />}
      >
      {combos.length > 0 && selected ? (
        <>
          {/* The day combinations this faculty teaches on — the same sets as Scheduling (MTh, TF, W…) */}
          <motion.div {...revealProps(0, reduceMotion)}>
            <div className={COMBO_GRID} style={comboCols(combos.length)}>
              {combos.map(c => {
                const active = c.key === selected.key;
                const isToday = hasToday(c);
                const t = dayTone(c.days[0]);
                const n = c.classes.length;
                return (
                  <motion.button
                    key={c.key}
                    type="button"
                    onClick={() => { if (!active) { setSelectedKey(c.key); setListOpen(false); } }}
                    whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                    whileHover={reduceMotion || active ? undefined : { y: -2 }}
                    animate={{
                      backgroundColor: active ? t.bar : t.bg,
                      borderColor: active ? t.bar : t.border,
                      color: active ? '#FFFFFF' : t.text,
                    }}
                    transition={{ duration: reduceMotion ? 0 : 0.25 }}
                    aria-label={`${c.label}, ${n} class${n !== 1 ? 'es' : ''}${isToday ? ', today' : ''}`}
                    aria-pressed={active}
                    title={c.label}
                    className="relative inline-flex items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-3 h-12 rounded-xl text-[15px] font-bold border-2 w-full min-w-0"
                  >
                    {/* Phones: the short code (MTh) so code + count always fit; wider screens: Mon / Thu */}
                    <span className="sm:hidden truncate">{c.code}</span>
                    <span className="hidden sm:inline truncate">{c.label}</span>
                    <span
                      className="min-w-6 h-6 px-1.5 rounded-full text-[12px] font-bold inline-flex items-center justify-center tabular-nums flex-shrink-0"
                      style={active ? { backgroundColor: 'rgba(255,255,255,0.25)', color: '#FFFFFF' } : { backgroundColor: '#FFFFFF', color: t.text }}
                    >
                      {n}
                    </span>
                    {/* Sits on the top edge, so it never crowds the name or count */}
                    {isToday && (
                      <span
                        className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-1.5 py-px rounded-md text-[10px] font-bold uppercase tracking-wide leading-tight whitespace-nowrap border"
                        style={{ backgroundColor: '#FFFFFF', color: t.text, borderColor: t.border }}
                      >
                        Today
                      </span>
                    )}
                  </motion.button>
                );
              })}
            </div>
          </motion.div>

          {/* One full-width card for every combination, so nothing jumps when it changes */}
          <motion.div
            {...revealProps(1, reduceMotion)}
            className="bg-white rounded-2xl border-2 shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden mb-5 transition-colors duration-300"
            style={{ borderColor: tone.border }}
          >
            <button
              type="button"
              onClick={() => comboClasses.length > 0 && setListOpen(o => !o)}
              aria-expanded={listOpen}
              className={`w-full p-4 sm:p-5 lg:px-6 lg:py-6 flex items-center gap-3 sm:gap-3.5 text-left transition-[background-color,transform] duration-200 ${comboClasses.length > 0 ? 'hover:bg-[#F8FAFC] active:scale-[0.995] cursor-pointer' : 'cursor-default'}`}
            >
              <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors duration-300" style={{ backgroundColor: tone.bg }}>
                <CalendarDays className="w-5 h-5 transition-colors duration-300" style={{ color: tone.bar }} />
              </div>
              {/* Another combination picked: its numbers fade in where the old ones were */}
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={selected.key}
                  initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] } }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, transition: { duration: 0.12 } }}
                  className="flex-1 min-w-0 flex items-center gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-bold uppercase tracking-wide mb-1 leading-snug" style={{ color: tone.text }}>
                      {classCountLabel}
                    </div>
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="text-2xl font-bold tabular-nums leading-none text-[#0B2A5B]">
                        {comboClasses.length}
                      </span>
                      {availableCount > 0 && (
                        <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[13px] font-semibold bg-emerald-50 text-emerald-700 border-emerald-200">
                          <QrCode className="w-4 h-4" /> {availableCount} ready to scan
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold flex-shrink-0" style={{ color: tone.text }}>
                    {listOpen ? 'Hide' : 'View classes'}
                    <motion.span animate={{ rotate: listOpen ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.3 }}>
                      <ChevronDown className="w-5 h-5" />
                    </motion.span>
                  </span>
                </motion.div>
              </AnimatePresence>
            </button>
            <AnimatePresence initial={false}>
              {listOpen && comboClasses.length > 0 && (
                <motion.div
                  key="list"
                  initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1, transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1] } }}
                  exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0, transition: { duration: 0.28, ease: [0.4, 0, 0.2, 1] } }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-[#EEF2F8] p-3 sm:p-4 space-y-3" style={{ backgroundColor: tone.col }}>
                    {comboClasses.map(item => (
                      <ComboClassRow
                        key={item.key}
                        item={item}
                        todayName={todayName}
                        showScanBadges={isViewingToday}
                        now={now}
                        occupancy={occupancy}
                        requests={requests}
                      />
                    ))}
                    {isViewingToday && (
                      <p className="text-xs text-[#475569] text-center pt-1">
                        QR scanning becomes available 15 minutes before class start.
                      </p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </>
      ) : !error ? (
        <motion.div {...revealProps(0, reduceMotion)} className="bg-white border border-[#E2E8F0] rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] px-6 py-12 flex flex-col items-center gap-4 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
            <CalendarDays className="w-7 h-7 text-[#1D5BD6]" />
          </div>
          <div>
            <p className="text-[#0B2A5B] font-bold text-lg mb-1">
              {schedules.length > 0 ? 'No class days and times yet' : 'No subjects assigned yet'}
            </p>
            <p className="text-[#64748B] text-sm max-w-sm">
              {schedules.length > 0
                ? 'Your classes appear here once they are scheduled.'
                : 'Your schedule will appear here once the administrator assigns you subjects.'}
            </p>
          </div>
        </motion.div>
      ) : null}
      </PageLoadTransition>
      </div>
    </div>
  );
}
