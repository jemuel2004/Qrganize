'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useVisibilityAwareInterval } from '@/client/hooks/useVisibilityAwareInterval';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/client/hooks/useMinLoading';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { TableSkeleton } from '@/client/components/ui/skeletons';
import {
  CalendarDays, MapPin, Users, Clock,
  RefreshCw,
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
      return { label: 'Not Yet Available', icon: <Hourglass className="w-3 h-3" />, classes: 'bg-[#EFF6FF] text-[#3C91E6] border-[#BFDBFE]' };
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
        <div className="flex items-center gap-2 text-sm font-semibold text-[#1E3A5F] flex-shrink-0 tabular-nums">
          <Clock className="w-4 h-4 text-[#3C91E6]" />
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
              <Users className="w-3 h-3 text-[#3C91E6]" />
              {item.program_code} • {item.year_level} • Block {item.block_name}
            </span>
            {sess.room_name ? (
              <span className="flex items-center gap-1.5">
                <MapPin className="w-3 h-3 text-[#3C91E6]" />
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

  const load = useCallback((silent = false) => {
    if (!silent) { setLoading(true); setError(''); }
    fetch('/api/instructor/my-schedule')
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

  useVisibilityAwareInterval(() => load(true), 30_000);

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
    <div className="min-h-full bg-[#F8FAFC] p-6 lg:p-8">

      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[#1E3A5F]">My Schedule</h1>
          <p className="text-[#64748B] text-sm mt-1">
            View your classes for the selected day.
          </p>
        </div>
        <button
          type="button"
          onClick={() => load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl text-sm font-semibold text-[#64748B] hover:text-[#1E3A5F] hover:bg-white border border-[#E2E8F0] transition-colors disabled:opacity-50 flex-shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-white border border-[#FECACA] text-[#DC2626] px-4 py-3 rounded-2xl text-sm mb-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          {error}
        </div>
      )}

      {!loading && schedules.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-5">
          {selectableDays.map(day => {
            const active = day === selectedDay;
            const isToday = day === todayName;
            return (
              <button
                key={day}
                type="button"
                onClick={() => setSelectedDay(day)}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold border transition-colors ${
                  active
                    ? 'bg-[#3C91E6] text-white border-[#3C91E6] shadow-sm'
                    : 'bg-white text-[#64748B] border-[#E2E8F0] hover:text-[#1E3A5F] hover:border-[#CBD5E1]'
                }`}
              >
                {day}
                {isToday && !active && (
                  <span className="text-[10px] font-bold uppercase tracking-wide text-[#3C91E6]">Today</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {!loading && schedules.length > 0 && (
        <div className={`grid gap-4 mb-5 ${isViewingToday ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
          <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-5 flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-[#EFF6FF] flex items-center justify-center flex-shrink-0">
              <CalendarDays className="w-5 h-5 text-[#3C91E6]" />
            </div>
            <div>
              <div className="text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1">
                {classCountLabel}
              </div>
              <div className="text-2xl font-bold tabular-nums leading-none text-[#1E3A5F]">
                {dayClasses.length}
              </div>
            </div>
          </div>
          {isViewingToday && (
            <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-5 flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-[#EFF6FF] flex items-center justify-center flex-shrink-0">
                <QrCode className="w-5 h-5 text-[#3C91E6]" />
              </div>
              <div>
                <div className="text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1">
                  Scan Available
                </div>
                <div className="text-2xl font-bold tabular-nums leading-none text-[#1E3A5F]">
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
            <CalendarDays className="w-7 h-7 text-[#3C91E6]" />
          </div>
          <div>
            <p className="text-[#1E3A5F] font-bold text-lg mb-1">No subjects assigned yet</p>
            <p className="text-[#64748B] text-sm max-w-sm">
              Your schedule will appear here once the administrator assigns you subjects.
            </p>
          </div>
        </div>
      ) : dayClasses.length === 0 ? (
        <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-12 flex flex-col items-center gap-3 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#F8FAFC] border border-[#E2E8F0] flex items-center justify-center">
            <CalendarDays className="w-7 h-7 text-[#94A3B8]" />
          </div>
          <div>
            <p className="text-[#1E3A5F] font-bold text-lg mb-1">
              No classes scheduled for {selectedDay}
            </p>
            <p className="text-[#64748B] text-sm">
              You have no classes scheduled for this day.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
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
          {isViewingToday && dayClasses.length > 0 && (
            <p className="text-xs text-[#475569] text-center pt-2">
              QR scanning becomes available 15 minutes before class start.
            </p>
          )}
        </div>
      )}
      </PageLoadTransition>
    </div>
  );
}
