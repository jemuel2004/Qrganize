'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { PageLoadTransition, revealProps } from '@/components/ui/PageLoadTransition';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { motion, useReducedMotion } from 'framer-motion';
import { WEEK_DAYS, daysLabel, normalizeDay, parseDays } from '@shared/dayCombination';
import { blockCode } from '@shared/blockCode';
import { clock12, clockRange12 } from '@shared/clock12';
import { useToast } from '@/context/ToastContext';
import Modal from '@/components/ui/Modal';
import Link from 'next/link';
import { CalendarDays, MapPin, Users, Clock, QrCode, DoorOpen, Loader2 } from 'lucide-react';
import ReleaseClassroomDialog from './ReleaseClassroomDialog';
import WeekCalendar, { WeekCalendarSkeleton, minutesOf, type CalendarEvent, type CalendarFlag } from './WeekCalendar';
import { RELEASE_STATE, releaseDateLabel, type RoomRelease } from '@/lib/roomRelease';

interface SessionData {
  day: string;
  start_time: string;
  end_time: string;
  room_name: string | null;
  room_id: number | null;
  /** 'lec' | 'lab' (missing on older servers) */
  type?: string | null;
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
/** Today's QR scan for one class time ("<class id>|HH:MM" of its start) */
interface TodayScan { status: 'Valid' | 'Late'; at: string }
/** QR scanning opens this many minutes before a class starts */
const SCAN_EARLY_MIN = 15;

/* ── Scan Availability Logic ─────────────────────────────────────────────── */
type ScanStatus =
  | 'released'
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
  releasedToday = false,
): ScanStatus {
  if (!sess.room_id) return 'no-room';
  if (sess.day !== todayName) return 'not-today';
  if (releasedToday) return 'released';

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

/** A class time today, as the class details show it — scan words like the admin side */
type TodayState = 'scan-now' | 'waiting' | 'scanned' | 'late' | 'not-scanned' | 'opens' | 'in-use-other' | 'released' | 'no-room';

interface TodayRow { state: TodayState; label: string; cls: string; pulse?: boolean }

/** "HH:MM" minus some minutes → "12:45 PM" */
function minus12(t: string, mins: number): string {
  const [h, m] = t.split(':').map(Number);
  return clock12((h * 60 + m - mins + 1440) % 1440);
}

function todayRow(
  sess: SessionData, nowMins: number, occupancy: Record<number, RoomOccupancy>,
  requests: Record<number, string>, msId: number, releasedToday: boolean,
  scan: TodayScan | undefined,
): TodayRow {
  const GREEN = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  const GREY = 'bg-[#F8FAFC] text-[#64748B] border-[#E2E8F0]';
  if (releasedToday) return { state: 'released', label: 'Free for others today', cls: GREEN };
  if (!sess.room_id) return { state: 'no-room', label: 'No room assigned', cls: GREY };
  if (scan) {
    return scan.status === 'Late'
      ? { state: 'late', label: `Late scan · ${clock12(scan.at)}`, cls: 'bg-amber-50 text-amber-700 border-amber-200' }
      : { state: 'scanned', label: `Scanned · ${clock12(scan.at)}`, cls: GREEN };
  }
  const start = minutesOf(sess.start_time);
  const end = minutesOf(sess.end_time);
  if (nowMins < start - SCAN_EARLY_MIN) return { state: 'opens', label: `Scan opens ${minus12(sess.start_time, SCAN_EARLY_MIN)}`, cls: 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]' };
  if (nowMins > end) return { state: 'not-scanned', label: 'Not scanned', cls: GREY };
  const occ = occupancy[sess.room_id];
  if (occ?.is_self) return { state: 'scanned', label: 'Scanned', cls: GREEN };
  if (requests[msId] === 'Pending Confirmation') return { state: 'waiting', label: 'Waiting for scan', cls: 'bg-amber-50 text-amber-700 border-amber-200', pulse: true };
  if (occ) return { state: 'in-use-other', label: 'Room in use', cls: 'bg-red-50 text-red-700 border-red-200' };
  return { state: 'scan-now', label: 'Scan now', cls: GREEN, pulse: true };
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

/** A meeting on the calendar, with what it came from (for the scan status and details) */
interface Meeting { event: CalendarEvent; sess: SessionData; sched: Schedule }

/** Every session of every class as a calendar meeting; a class listed twice (part moved to Overload) counts once */
function buildMeetings(schedules: Schedule[]): Meeting[] {
  const seen = new Set<number>();
  const out: Meeting[] = [];
  for (const s of schedules) {
    if (seen.has(s.master_schedule_id)) continue;
    seen.add(s.master_schedule_id);
    // "Lec" / "Lab" only matters for a subject that has both parts
    const twoParts = (parseFloat(String(s.lecture_hours)) || 0) > 0 && (parseFloat(String(s.laboratory_hours)) || 0) > 0;
    for (const sess of s.sessions ?? []) {
      const day = normalizeDay(sess.day ?? '');
      if (!day || !sess.start_time || !sess.end_time) continue;
      out.push({
        sess,
        sched: s,
        event: {
          key: `${s.master_schedule_id}-${day}-${sess.start_time}`,
          msId: s.master_schedule_id,
          day,
          startMin: minutesOf(sess.start_time),
          endMin: minutesOf(sess.end_time),
          subject_code: s.subject_code,
          subject_name: s.subject_name,
          blockLabel: [s.program_code, blockCode(s.year_level, s.block_name)].filter(Boolean).join(' '),
          room_name: sess.room_name,
          part: twoParts ? (sess.type === 'lab' ? 'lab' : sess.type === 'lec' ? 'lec' : null) : null,
        },
      });
    }
  }
  return out;
}

/** A class's meetings in the week, same time + part on several days as one line: "Mon / Thu · 8:30 AM – 10:00 AM" */
function meetingLines(meetings: Meeting[]) {
  const groups = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const k = `${m.sess.start_time}|${m.sess.end_time}|${m.event.part ?? ''}|${m.sess.room_name ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  return [...groups.values()]
    .map(ms => ({
      key: ms[0].event.key,
      days: daysLabel(parseDays(ms.map(m => m.event.day)) ?? []),
      firstDay: Math.min(...ms.map(m => WEEK_DAYS.indexOf(m.event.day))),
      time: clockRange12(ms[0].event.startMin, ms[0].event.endMin),
      start: ms[0].event.startMin,
      part: ms[0].event.part,
      room: ms[0].sess.room_name,
    }))
    .sort((x, y) => x.firstDay - y.firstDay || x.start - y.start);
}

/* ── Main Page Component ─────────────────────────────────────────────────── */
export default function ScheduleClient() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [occupancy, setOccupancy] = useState<Record<number, RoomOccupancy>>({});
  const [requests, setRequests] = useState<Record<number, string>>({});
  const [todayScans, setTodayScans] = useState<Record<string, TodayScan>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [now, setNow] = useState(new Date());
  /** The class whose details are open (from a block on the calendar) */
  const [openMsId, setOpenMsId] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Classrooms this faculty made available on a date (not ended yet) */
  const [releases, setReleases] = useState<RoomRelease[]>([]);
  const [releaseToday, setReleaseToday] = useState('');
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [takingBack, setTakingBack] = useState<number | null>(null);
  const reduceMotion = useReducedMotion();
  const toast = useToast();

  const load = useCallback((silent = false): Promise<boolean> => {
    if (!silent) { setLoading(true); setError(''); }
    return Promise.all([
      fetch('/api/instructor/my-schedule').then(r => r.ok ? r.json() : Promise.reject(r)),
      // The released classrooms list never blocks the schedule itself
      fetch('/api/instructor/room-releases', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([d, rel]) => {
        setSchedules(d.schedules || []);
        setOccupancy(d.room_occupancy ?? {});
        setRequests(d.room_requests ?? {});
        setTodayScans(d.today_scans ?? {});
        if (rel) {
          setReleases(Array.isArray(rel.releases) ? rel.releases : []);
          setReleaseToday(String(rel.today ?? ''));
        }
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
  // The class details' scan status and Scan QR Code button follow the clock
  useVisibilityAwareInterval(() => setNow(new Date()), 30_000);

  // Refresh button: the schedule reloads behind the skeleton, then fades back in
  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    const ok = await load(true);
    setRefreshing(false);
    if (!ok) toast.error('Could not refresh your schedule. Check your connection and try again.');
    return ok;
  }, [load, toast]);

  const showSkeleton = useMinLoading((loading && schedules.length === 0 && !error) || refreshing, PAGE_SKELETON_MIN_MS);

  // Take back a classroom made available (only before its class time starts)
  const takeBack = useCallback(async (r: RoomRelease) => {
    setTakingBack(r.id);
    try {
      const res = await fetch(`/api/instructor/room-releases/${r.id}`, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Could not take the classroom back. Please try again.'); return; }
      toast.success(`${r.room_name ?? 'Your classroom'} is yours again on ${releaseDateLabel(r.date)}.`);
      await load(true);
    } catch {
      toast.error('Unable to reach the server. Please check your connection.');
    } finally {
      setTakingBack(null);
    }
  }, [load, toast]);

  const todayName = now.toLocaleDateString('en-US', { weekday: 'long' });
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const meetings = useMemo(() => buildMeetings(schedules), [schedules]);
  const events = useMemo(() => meetings.map(m => m.event), [meetings]);
  const meetingByKey = useMemo(() => new Map(meetings.map(m => [m.event.key, m])), [meetings]);
  /** Classroom made available today for this meeting */
  const releasedToday = (msId: number, sess: SessionData) => releases.some(r =>
    r.master_schedule_id === msId && r.date === releaseToday && r.day === sess.day && r.start_time === sess.start_time.slice(0, 5));
  const statusOf = (m: Meeting) =>
    getScanStatus(m.sess, now, todayName, occupancy, requests, m.event.msId, releasedToday(m.event.msId, m.sess));
  /** Today's blocks say when to scan; the rest is in the details */
  const flagOf = (e: CalendarEvent): CalendarFlag => {
    const m = meetingByKey.get(e.key);
    if (!m || e.day !== todayName) return null;
    const st = statusOf(m);
    return st === 'available' ? 'scan' : st === 'in-use-self' ? 'in-use' : st === 'released' ? 'released' : null;
  };
  const hasClassesToday = events.some(e => e.day === todayName);

  /* Class details */
  const openMeetings = openMsId == null ? [] : meetings.filter(m => m.event.msId === openMsId);
  const openClass = openMeetings[0]?.sched ?? null;
  const openRooms = [...new Set(openMeetings.map(m => m.sess.room_name).filter((r): r is string => !!r))];
  const openToday = openMeetings
    .filter(m => m.event.day === todayName)
    .sort((a, b) => a.event.startMin - b.event.startMin)
    .map(m => ({
      m,
      row: todayRow(m.sess, nowMin, occupancy, requests, m.event.msId, releasedToday(m.event.msId, m.sess),
        todayScans[`${m.event.msId}|${m.sess.start_time.slice(0, 5)}`]),
    }));
  // A class time open for scanning now (and not scanned yet): straight to the QR scanner
  const canScanNow = openToday.some(t => t.row.state === 'scan-now' || t.row.state === 'waiting');
  const openReleases = openMsId == null ? [] : releases.filter(r => r.master_schedule_id === openMsId && r.date !== releaseToday);

  return (
    <div className="min-h-full p-4 sm:p-6 lg:p-8">
      {/* Desktop: balanced width, centred (phones/tablets unchanged) */}
      <div className="lg:max-w-6xl lg:mx-auto">

      <div className="mb-5">
        <BackButton />
        <div className="mt-2 lg:mt-5 mb-4">
          <WatermarkTitle>My Schedule</WatermarkTitle>
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
          {/* Away on official business: free the classroom for one date */}
          <motion.button
            type="button"
            onClick={() => setReleaseOpen(true)}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl border-2 border-[#1D5BD6] bg-white text-[15px] font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors w-full sm:w-auto"
          >
            <DoorOpen className="w-5 h-5" /> Free My Room
          </motion.button>
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
        skeleton={<WeekCalendarSkeleton />}
      >
      {releases.length > 0 && (
        <motion.section
          {...revealProps(0, reduceMotion)}
          aria-label="Rooms you freed"
          className="bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden mb-5"
        >
          <div className="flex items-center gap-3 px-4 sm:px-5 py-3.5 border-b border-[#EEF2F8]">
            <span className="w-10 h-10 rounded-xl bg-[#ECFDF5] flex items-center justify-center flex-shrink-0">
              <DoorOpen className="w-5 h-5 text-[#047857]" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[16px] font-bold text-[#0B2A5B] leading-tight">Rooms You Freed</h2>
              <p className="text-[13px] text-[#64748B]">Only on these dates — your regular classroom stays yours.</p>
            </div>
          </div>
          <ul className="divide-y divide-[#EEF2F8]">
            {releases.map(r => {
              const st = RELEASE_STATE[r.state];
              return (
                <li key={r.id} className="px-4 sm:px-5 py-3.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-bold text-[#0B2A5B]">
                      {releaseDateLabel(r.date)}
                      <span className="font-semibold tabular-nums text-[#334155]"> · {fmt12(r.start_time)} – {fmt12(r.end_time)}</span>
                    </p>
                    <p className="text-[14px] text-[#334155] break-words">
                      <span className="font-semibold">{r.room_name ?? 'Classroom'}</span>
                      {' · '}{r.subject_code} {[r.program_code, blockCode(r.year_level, r.block_name)].filter(Boolean).join(' ')}
                    </p>
                    {(r.reason || r.taken_by || r.reserved_by) && (
                      <p className="text-[13px] text-[#64748B] break-words">
                        {[
                          r.reason,
                          r.taken_by ? `Using it now: ${r.taken_by}` : r.state === 'reserved' && r.reserved_by ? `Reserved by ${r.reserved_by}` : null,
                        ].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`inline-flex items-center text-[12px] font-semibold px-2.5 py-1 rounded-md border ${st.cls}`}>{st.label}</span>
                    {r.state === 'upcoming' && (
                      <button
                        type="button"
                        onClick={() => takeBack(r)}
                        disabled={takingBack !== null}
                        className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg border border-[#CBD5E1] text-[13px] font-semibold text-[#0B2A5B] hover:border-[#1D5BD6] hover:text-[#1D5BD6] transition-colors disabled:opacity-50"
                      >
                        {takingBack === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                        Take back
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </motion.section>
      )}

      {events.length > 0 ? (
        <motion.div {...revealProps(0, reduceMotion)} className="mb-5">
          <WeekCalendar
            events={events}
            todayName={todayName}
            nowMin={nowMin}
            flagOf={flagOf}
            onOpen={e => setOpenMsId(e.msId)}
          />
          {hasClassesToday && (
            <p className="mt-3 text-[14px] text-[#475569] text-center">
              Tap a class for its details. QR scanning opens 15 minutes before class starts.
            </p>
          )}
        </motion.div>
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

      <Modal
        open={openClass != null}
        onClose={() => setOpenMsId(null)}
        title={openClass?.subject_code ?? ''}
        subtitle={openClass?.subject_name}
        icon={CalendarDays}
        size="sm"
        footer={
          // A class time open for scanning now: the scanner is one tap away, always in sight
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setOpenMsId(null)}
              className="min-h-12 px-6 rounded-xl text-base font-semibold bg-[var(--surface-elevated)] border border-[color:var(--border)] text-[color:var(--foreground-secondary)] hover:bg-[var(--background-secondary)] transition-colors"
            >
              Close
            </button>
            {canScanNow && (
              <motion.div whileTap={reduceMotion ? undefined : { scale: 0.98 }}>
                <Link
                  href="/instructor/scan"
                  className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#1D5BD6] px-6 text-base font-bold hover:bg-[#164BB5] transition-colors"
                  style={{ color: '#FFFFFF' }}
                >
                  <QrCode className="w-5 h-5" aria-hidden /> Scan QR Code
                </Link>
              </motion.div>
            )}
          </div>
        }
      >
        {openClass && (
          <div className="space-y-4">
            {/* Block and room — two clear labels, like Room Monitoring */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-[#1E4FB8] px-3 py-1.5 text-[15px] font-bold leading-none" style={{ color: '#FFFFFF' }}>
                <Users className="w-4 h-4" aria-hidden />
                <span className="sr-only">Block </span>
                {[openClass.program_code, blockCode(openClass.year_level, openClass.block_name)].filter(Boolean).join(' ')}
              </span>
              {openRooms.length > 0 ? (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] px-3 py-1.5 text-[15px] leading-none text-[#0B2A5B]">
                  <MapPin className="w-4 h-4 text-[#1D5BD6]" aria-hidden />
                  <span className="font-medium text-[#475569]">Room</span>{' '}
                  <span className="font-bold">{openRooms.join(' / ')}</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] px-3 py-1.5 text-[15px] font-semibold leading-none text-[#B45309]">
                  <MapPin className="w-4 h-4" aria-hidden /> No room assigned
                </span>
              )}
            </div>

            {openToday.length > 0 && (
              <div>
                <h3 className="text-[15px] font-bold text-[color:var(--foreground)] mb-2">Today</h3>
                {/* One row per class time today: its time and part, then its scan status */}
                <ul className="rounded-xl border border-[color:var(--border)] overflow-hidden divide-y divide-[color:var(--border)]">
                  {openToday.map(({ m, row }) => (
                    <li key={m.event.key} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 sm:gap-3 px-4 py-3">
                      <span className="min-w-0 leading-snug">
                        <span className="block text-[15px] font-bold text-[color:var(--foreground)] tabular-nums">
                          {clockRange12(m.event.startMin, m.event.endMin)}
                        </span>
                        {m.event.part && (
                          <span className="block text-[14px] text-[color:var(--foreground-muted)]">
                            {m.event.part === 'lab' ? 'Laboratory' : 'Lecture'}
                          </span>
                        )}
                      </span>
                      <span className={`self-start sm:self-auto inline-flex items-center text-[14px] font-semibold px-2.5 py-1 rounded-md border whitespace-nowrap ${row.cls} ${row.pulse && !reduceMotion ? 'animate-pulse' : ''}`}>
                        {row.label}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <h3 className="text-[15px] font-bold text-[color:var(--foreground)] mb-2">Class times</h3>
              <ul className="rounded-xl border border-[color:var(--border)] overflow-hidden divide-y divide-[color:var(--border)]">
                {meetingLines(openMeetings).map(l => (
                  <li key={l.key} className="flex items-start gap-3 px-4 py-3">
                    <Clock className="w-5 h-5 text-[#1D5BD6] flex-shrink-0 mt-0.5" aria-hidden />
                    <span className="min-w-0 leading-snug">
                      <span className="block text-[15px] font-bold text-[color:var(--foreground)] tabular-nums">{l.time}</span>
                      <span className="block text-[14px] text-[color:var(--foreground-muted)]">
                        {[l.days, l.part === 'lab' ? 'Laboratory' : l.part === 'lec' ? 'Lecture' : null, l.room].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {openReleases.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {openReleases.map(r => (
                  <span key={r.id} className={`inline-flex items-center gap-1.5 text-[14px] font-semibold px-2.5 py-1 rounded-md border ${RELEASE_STATE.upcoming.cls}`}>
                    <DoorOpen className="w-4 h-4" /> Free for others · {releaseDateLabel(r.date)}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>

      <ReleaseClassroomDialog
        open={releaseOpen}
        onClose={() => setReleaseOpen(false)}
        onChanged={() => { void load(true); }}
      />
    </div>
  );
}
