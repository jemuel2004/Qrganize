'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { RefreshButton } from '@/app/(dashboard)/room-utilization/shared';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { dayTone } from '@/lib/dayTones';
import { TableSkeleton } from '@/components/ui/skeletons';
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

const WEEKDAY_OPTIONS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;

interface DayClassItem {
  master_schedule_id: number;
  subject_code: string;
  subject_name: string;
  block_name: string;
  year_level: string;
  program_code: string;
  lecture_hours: number;
  laboratory_hours: number;
  session: SessionData;
}

function typeLabel(lecH: number, labH: number): string {
  if (lecH > 0 && labH > 0) return 'Lec + Lab';
  if (labH > 0) return 'Lab';
  return 'Lecture';
}

function buildSelectableDays(schedules: Schedule[]): string[] {
  const days: string[] = [...WEEKDAY_OPTIONS];
  let hasSaturday = false;
  let hasSunday = false;
  for (const s of schedules) {
    for (const sess of s.sessions ?? []) {
      if (sess.day === 'Saturday') hasSaturday = true;
      if (sess.day === 'Sunday') hasSunday = true;
    }
  }
  if (hasSaturday) days.push('Saturday');
  if (hasSunday) days.push('Sunday');
  return days;
}

function DayClassRow({
  item,
  showScanBadges,
  now,
  todayName,
  occupancy,
  requests,
}: {
  item: DayClassItem;
  showScanBadges: boolean;
  now: Date;
  todayName: string;
  occupancy: Record<number, RoomOccupancy>;
  requests: Record<number, string>;
}) {
  const sess = item.session;
  const lecH = parseFloat(String(item.lecture_hours)) || 0;
  const labH = parseFloat(String(item.laboratory_hours)) || 0;

  return (
    <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] px-5 py-4">
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#0B2A5B] flex-shrink-0 tabular-nums">
          <Clock className="w-4 h-4 text-[#1D5BD6]" />
          {fmt12(sess.start_time)} – {fmt12(sess.end_time)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-[#0F172A] text-base">{item.subject_code}</span>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md border bg-[#F8FAFC] text-[#475569] border-[#E2E8F0]">
              {typeLabel(lecH, labH)}
            </span>
          </div>
          <p className="text-sm text-[#0F172A] font-medium mt-0.5">{item.subject_name}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-[#475569]">
            <span className="flex items-center gap-1.5">
              <Users className="w-3 h-3 text-[#1D5BD6]" />
              {item.program_code} • {item.year_level} • Block {item.block_name}
            </span>
            {sess.room_name ? (
              <span className="flex items-center gap-1.5">
                <MapPin className="w-3 h-3 text-[#1D5BD6]" />
                {sess.room_name}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[#B45309] font-medium">
                <MapPin className="w-3 h-3" /> No room assigned
              </span>
            )}
          </div>
          {showScanBadges && (
            <div className="mt-3">
              <ScanAvailabilityBadge
                sess={sess}
                now={now}
                todayName={todayName}
                occupancy={occupancy}
                requests={requests}
                msId={item.master_schedule_id}
              />
            </div>
          )}
        </div>
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
  const [selectedDay, setSelectedDay] = useState(() =>
    new Date().toLocaleDateString('en-US', { weekday: 'long' })
  );
  // The class list stays folded until the day card is clicked
  const [listOpen, setListOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  const load = useCallback((silent = false) => {
    if (!silent) { setLoading(true); setError(''); }
    return fetch('/api/instructor/my-schedule')
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(d => {
        setSchedules(d.schedules || []);
        setOccupancy(d.room_occupancy ?? {});
        setRequests(d.room_requests ?? {});
        setNow(new Date());
      })
      .catch(() => { if (!silent) setError('Failed to load schedule. Please try again.'); })
      .finally(() => { if (!silent) setLoading(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live updates: a class assigned, scheduled or moved to another room, a room
  // taken or freed, a request decided — the schedule reloads quietly
  useRealtime(['schedule', 'workload', 'rooms', 'occupancy', 'room-requests', 'term'], () => load(true), { enabled: !loading });
  // Fallback for time-based changes (the current class, live room status)
  useVisibilityAwareInterval(() => load(true), 60_000);

  const showSkeleton = useMinLoading(loading && schedules.length === 0 && !error, PAGE_SKELETON_MIN_MS);

  const todayName = now.toLocaleDateString('en-US', { weekday: 'long' });
  const selectableDays = useMemo(() => buildSelectableDays(schedules), [schedules]);

  useEffect(() => {
    if (selectableDays.length > 0 && !selectableDays.includes(selectedDay)) {
      setSelectedDay(todayName);
    }
  }, [selectableDays, selectedDay, todayName]);

  const dayClasses = useMemo(() => {
    const items: DayClassItem[] = [];
    for (const s of schedules) {
      for (const sess of s.sessions ?? []) {
        if (sess.day !== selectedDay) continue;
        items.push({
          master_schedule_id: s.master_schedule_id,
          subject_code: s.subject_code,
          subject_name: s.subject_name,
          block_name: s.block_name,
          year_level: s.year_level,
          program_code: s.program_code,
          lecture_hours: s.lecture_hours,
          laboratory_hours: s.laboratory_hours,
          session: sess,
        });
      }
    }
    return items.sort((a, b) => a.session.start_time.localeCompare(b.session.start_time));
  }, [schedules, selectedDay]);

  /** Classes per day — shown on each day button */
  const countByDay = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of schedules) for (const sess of s.sessions ?? []) m[sess.day] = (m[sess.day] ?? 0) + 1;
    return m;
  }, [schedules]);
  const tone = dayTone(selectedDay);

  const isViewingToday = selectedDay === todayName;
  const availableCount = isViewingToday
    ? dayClasses.filter(item =>
        getScanStatus(item.session, now, todayName, occupancy, requests, item.master_schedule_id) === 'available'
      ).length
    : 0;

  const classCountLabel = isViewingToday
    ? "Today's Classes"
    : `${selectedDay} Classes`;

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
          <RefreshButton onRefresh={() => load()} loading={loading} />
        </div>
      </div>

      {error && (
        <div className="bg-white border border-[#FECACA] text-[#DC2626] px-4 py-3 rounded-2xl text-sm mb-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          {error}
        </div>
      )}

      {!loading && schedules.length > 0 && (
        <div
          className="grid grid-cols-3 sm:grid-cols-[repeat(var(--day-cols),minmax(0,1fr))] gap-x-2 gap-y-3 sm:gap-3 mb-5 pt-2"
          style={{ ['--day-cols' as string]: Math.max(5, selectableDays.length) }}
        >
          {selectableDays.map(day => {
            const active = day === selectedDay;
            const isToday = day === todayName;
            const t = dayTone(day);
            const n = countByDay[day] ?? 0;
            return (
              <motion.button
                key={day}
                type="button"
                onClick={() => { if (day !== selectedDay) { setSelectedDay(day); setListOpen(false); } }}
                whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                whileHover={reduceMotion || active ? undefined : { y: -2 }}
                animate={{
                  backgroundColor: active ? t.bar : t.bg,
                  borderColor: active ? t.bar : t.border,
                  color: active ? '#FFFFFF' : t.text,
                }}
                transition={{ duration: reduceMotion ? 0 : 0.25 }}
                aria-label={`${day}, ${n} class${n !== 1 ? 'es' : ''}${isToday ? ', today' : ''}`}
                className="relative inline-flex items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-3 h-12 rounded-xl text-[15px] font-bold border-2 w-full min-w-0"
              >
                {/* Phones: short names so name + count always fit on one line */}
                <span className="sm:hidden">{day.slice(0, 3)}</span>
                <span className="hidden sm:inline truncate">{day}</span>
                <span
                  className="min-w-6 h-6 px-1.5 rounded-full text-[12px] font-bold inline-flex items-center justify-center tabular-nums"
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
      )}

      {!loading && schedules.length > 0 && (
        <div className={`grid gap-4 mb-5 ${isViewingToday ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
          <div className="bg-white rounded-2xl border-2 shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden self-start" style={{ borderColor: tone.border }}>
            <button
              type="button"
              onClick={() => dayClasses.length > 0 && setListOpen(o => !o)}
              aria-expanded={listOpen}
              className={`w-full p-5 lg:px-6 lg:py-6 flex items-center gap-3.5 text-left transition-[background-color,transform] duration-200 ${dayClasses.length > 0 ? 'hover:bg-[#F8FAFC] active:scale-[0.995] cursor-pointer' : 'cursor-default'}`}
            >
              <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: tone.bg }}>
                <CalendarDays className="w-5 h-5" style={{ color: tone.bar }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold uppercase tracking-wide mb-1" style={{ color: tone.text }}>
                  {classCountLabel}
                </div>
                <div className="text-2xl font-bold tabular-nums leading-none text-[#0B2A5B]">
                  {dayClasses.length}
                </div>
              </div>
              {dayClasses.length === 0 && (
                <span className="text-[14px] text-[#94A3B8]">No classes this day</span>
              )}
              {dayClasses.length > 0 && (
                <span className="inline-flex items-center gap-1.5 text-[14px] font-semibold" style={{ color: tone.text }}>
                  {listOpen ? 'Hide' : 'View classes'}
                  <motion.span animate={{ rotate: listOpen ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.3 }}>
                    <ChevronDown className="w-5 h-5" />
                  </motion.span>
                </span>
              )}
            </button>
            <AnimatePresence initial={false}>
              {listOpen && dayClasses.length > 0 && (
                <motion.div
                  key="list"
                  initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1, transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1] } }}
                  exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0, transition: { duration: 0.28, ease: [0.4, 0, 0.2, 1] } }}
                  className="overflow-hidden"
                >
                  <div className="border-t border-[#EEF2F8] p-4 space-y-3" style={{ backgroundColor: tone.col }}>
                    {dayClasses.map((item, i) => (
                      <DayClassRow
                        key={`${item.master_schedule_id}-${item.session.start_time}-${item.session.end_time}-${i}`}
                        item={item}
                        showScanBadges={isViewingToday}
                        now={now}
                        todayName={todayName}
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
          </div>
          {isViewingToday && (
            <div className="bg-white rounded-2xl border-2 border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-5 lg:px-6 lg:py-6 flex items-center gap-3.5 self-start">
              <div className="w-10 h-10 rounded-xl bg-[#EFF6FF] flex items-center justify-center flex-shrink-0">
                <QrCode className="w-5 h-5 text-[#1D5BD6]" />
              </div>
              <div>
                <div className="text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1">
                  Scan Available
                </div>
                <div className="text-2xl font-bold tabular-nums leading-none text-[#0B2A5B]">
                  {availableCount}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <PageLoadTransition
        showSkeleton={showSkeleton}
        skeleton={<TableSkeleton rows={6} cols={4} />}
      >
      {schedules.length === 0 ? (
        <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-12 flex flex-col items-center gap-4 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center">
            <CalendarDays className="w-7 h-7 text-[#1D5BD6]" />
          </div>
          <div>
            <p className="text-[#0B2A5B] font-bold text-lg mb-1">No subjects assigned yet</p>
            <p className="text-[#64748B] text-sm max-w-sm">
              Your schedule will appear here once the administrator assigns you subjects.
            </p>
          </div>
        </div>
      ) : null}
      </PageLoadTransition>
      </div>
    </div>
  );
}
