'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useInstructorProfile } from '@/context/InstructorProfileContext';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import { useToast } from '@/context/ToastContext';
import { useNotifications } from '@/context/NotificationContext';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { PageLoadTransition, revealProps } from '@/components/ui/PageLoadTransition';
import { Skeleton } from '@/components/ui/skeletons';
import { RefreshButton } from '@/components/ui/RefreshButton';
import Link from 'next/link';
import {
  CalendarDays, QrCode, ChevronLeft, ChevronRight,
  Users, Building2, DoorOpen, RefreshCw, Loader2, Timer,
  AlertTriangle, XCircle,
  X, CircleDot,
} from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { blockCode } from '@shared/blockCode';

/* ─── Types ──────────────────────────────────────────────────────── */
interface Reservation {
  id: number; room_id: number; status: 'Pending' | 'Occupied';
  reserved_at: string; expires_at: string; occupied_at: string | null;
  room_name: string; room_type: string; building: string | null; capacity: number | null;
}
interface RoomCounts { available: number; pending: number; occupied: number; total: number; }
interface AvailableRoom {
  id: number; room_name: string; room_type: string; building: string | null; capacity: number | null;
}
interface TodaySession {
  id: number; subject_code: string; subject_name: string;
  block_name: string; year_level: string; status: string;
  start_time: string; end_time: string; room_name: string | null;
}
interface DashboardData {
  my_reservation:  Reservation | null;
  room_counts:     RoomCounts;
  available_rooms: AvailableRoom[];
  today_schedule:  TodaySession[];
  stats: { sessions_month: number; expired_month: number };
}

/* ─── Helpers ────────────────────────────────────────────────────── */
function fmt12(t: string): string {
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = mStr || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}
function sessionMins(t: string) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function isOngoing(sess: TodaySession) {
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  return sessionMins(sess.start_time) <= nowM && nowM < sessionMins(sess.end_time);
}
function isUpcoming(sess: TodaySession) {
  return sessionMins(sess.start_time) > new Date().getHours() * 60 + new Date().getMinutes();
}
function greeting(h: number) {
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/* ─── Live clock (isolated — no parent re-render) ────────────────── */
function LiveClock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const update = () =>
      setTime(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono text-2xl font-bold tabular-nums text-white">{time || '--:--:--'}</span>;
}

/* ─── Countdown ──────────────────────────────────────────────────── */
function Countdown({ expiresAt, onExpired }: { expiresAt: string; onExpired: () => void }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
    setSecs(remaining);
    if (remaining <= 0) { onExpired(); return; }
    const t = setInterval(() => {
      setSecs(s => { if (s <= 1) { onExpired(); clearInterval(t); return 0; } return s - 1; });
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onExpired]);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const urgent = secs < 120;
  return (
    <span className={`font-mono font-black tabular-nums text-3xl leading-none ${urgent ? 'text-red-300 animate-pulse' : 'text-white'}`}>
      {m}:{String(s).padStart(2, '0')}
    </span>
  );
}

/* ─── Room type badge — quiet chip, not a button ─────────────────── */
function TypeBadge({ type }: { type: string }) {
  const isLab = type === 'Laboratory' || type === 'Computer Lab';
  return (
    <span className={`inline-flex items-center flex-shrink-0 text-[11px] font-medium leading-none px-1.5 py-[3px] rounded-md ${
      isLab
        ? 'bg-[#12408F]/10 text-[#12408F]'
        : 'bg-slate-500/10 text-slate-300'
    }`}>
      {type}
    </span>
  );
}

/* ─── Available Rooms: 5 per page, slides on every 5 s ────────────── */
const ROOMS_PER_PAGE = 5;
const ROOM_ROW_PX = 68;
const SLIDE_MS = 5_000;
/** More pages than this show "3 / 12" instead of dots */
const MAX_DOTS = 8;

function RoomRow({ room }: { room: AvailableRoom }) {
  const meta = [
    room.building,
    room.capacity != null ? `${room.capacity} seats` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex items-center gap-3 px-5 border-b border-white/5 last:border-b-0" style={{ height: ROOM_ROW_PX }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{room.room_name}</p>
          <TypeBadge type={room.room_type} />
        </div>
        <p className="text-xs text-slate-400 mt-1 truncate">
          {meta || 'Capacity N/A'}
        </p>
      </div>
      <Link
        href={`/instructor/room-requests?room=${room.id}`}
        draggable={false}
        className="flex-shrink-0 h-9 min-w-[5rem] px-3 rounded-lg border border-[#1D5BD6]/35 text-[#1D5BD6] text-[13px] font-semibold hover:bg-[#1D5BD6]/10 active:scale-95 transition-all duration-200 inline-flex items-center justify-center"
      >
        Request
      </Link>
    </div>
  );
}

/**
 * Pages of rooms that slide on by themselves. A finger or the mouse on the
 * list holds the page; letting go starts it moving again. Swipe or the
 * arrows / dots change the page by hand.
 */
function RoomsCarousel({ rooms }: { rooms: AvailableRoom[] }) {
  const reduceMotion = useReducedMotion();
  const pageCount = Math.max(1, Math.ceil(rooms.length / ROOMS_PER_PAGE));
  const [page, setPage] = useState(0);
  const [dir, setDir] = useState(1);
  const [held, setHeld] = useState(false);
  const [hover, setHover] = useState(false);
  const paused = held || hover;
  // Live updates can shorten the list — stay on the last page that still exists
  const current = Math.min(page, pageCount - 1);
  const barRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<Animation | null>(null);
  const dragged = useRef(false);

  const go = useCallback((step: number) => {
    setDir(step >= 0 ? 1 : -1);
    setPage(p => (Math.min(p, pageCount - 1) + step + pageCount) % pageCount);
  }, [pageCount]);
  const goTo = (i: number) => {
    if (i === current) return;
    setDir(i > current ? 1 : -1);
    setPage(i);
  };

  // The blue line under the header fills over 5 s, then the next page slides in.
  // Holding the list pauses it where it is; letting go carries on from there.
  useEffect(() => {
    const el = barRef.current;
    if (!el || pageCount < 2 || typeof el.animate !== 'function') return;
    const a = el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: SLIDE_MS, easing: 'linear', fill: 'forwards' });
    a.onfinish = () => go(1);
    timerRef.current = a;
    return () => { a.onfinish = null; a.cancel(); timerRef.current = null; };
  }, [current, pageCount, go]);
  useEffect(() => {
    const a = timerRef.current;
    if (!a) return;
    if (paused) a.pause();
    else if (a.playState === 'paused') a.play();
  }, [paused, current, pageCount]);

  // Let go anywhere (even after dragging off the card) and the slides carry on.
  // Lifting the finger (touchend), not pointercancel: a long press or a page
  // scroll cancels the pointer while the finger is still down.
  useEffect(() => {
    if (!held) return;
    const release = () => setHeld(false);
    const events = ['pointerup', 'touchend', 'touchcancel', 'blur'] as const;
    for (const e of events) window.addEventListener(e, release);
    return () => { for (const e of events) window.removeEventListener(e, release); };
  }, [held]);

  const shown = rooms.slice(current * ROOMS_PER_PAGE, current * ROOMS_PER_PAGE + ROOMS_PER_PAGE);
  const offset = reduceMotion ? 0 : '100%';

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="Available rooms"
      // Capture phase: the swipe handler below takes the bubbling pointerdown
      onPointerDownCapture={() => { setHeld(true); dragged.current = false; }}
      onTouchStartCapture={() => setHeld(true)}
      onPointerEnter={e => { if (e.pointerType === 'mouse') setHover(true); }}
      onPointerLeave={e => { if (e.pointerType === 'mouse') setHover(false); }}
      // Holding a finger on the list pauses it — no long-press menu or text selection
      onContextMenu={e => e.preventDefault()}
      className="flex flex-col min-w-0 select-none [-webkit-touch-callout:none]"
    >
      <div className="h-[3px] bg-white/5 overflow-hidden" aria-hidden>
        <div ref={barRef} className="h-full origin-left" style={{ backgroundColor: '#1D5BD6', transform: 'scaleX(0)', opacity: pageCount > 1 ? 1 : 0 }} />
      </div>
      <div className="relative overflow-hidden" style={{ height: ROOMS_PER_PAGE * ROOM_ROW_PX }}>
        <AnimatePresence initial={false} custom={dir}>
          <motion.div
            key={current}
            custom={dir}
            variants={{
              enter: (d: number) => ({ x: d > 0 ? offset : reduceMotion ? 0 : '-100%', opacity: reduceMotion ? 0 : 1 }),
              center: { x: 0, opacity: 1 },
              exit: (d: number) => ({ x: d > 0 ? (reduceMotion ? 0 : '-100%') : offset, opacity: reduceMotion ? 0 : 1 }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: reduceMotion ? 0.2 : 0.5, ease: [0.4, 0, 0.2, 1] }}
            drag={pageCount > 1 ? 'x' : false}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.25}
            onDragStart={() => { dragged.current = true; }}
            onDragEnd={(_, info) => {
              if (info.offset.x < -50 || info.velocity.x < -400) go(1);
              else if (info.offset.x > 50 || info.velocity.x > 400) go(-1);
            }}
            // A swipe that ends on a Request button must not open it
            onClickCapture={e => { if (dragged.current) { e.preventDefault(); e.stopPropagation(); } }}
            className="absolute inset-0"
          >
            {shown.map(room => <RoomRow key={room.id} room={room} />)}
          </motion.div>
        </AnimatePresence>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-t border-white/10">
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous rooms"
            className="h-10 w-10 inline-flex items-center justify-center rounded-full text-[#1D5BD6] hover:bg-[#1D5BD6]/10 active:scale-90 transition-all"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          {pageCount <= MAX_DOTS ? (
            <div className="flex items-center">
              {Array.from({ length: pageCount }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => goTo(i)}
                  aria-label={`Rooms page ${i + 1} of ${pageCount}`}
                  aria-current={i === current ? 'true' : undefined}
                  className="h-8 px-1 inline-flex items-center justify-center"
                >
                  <motion.span
                    className="block h-2 rounded-full"
                    animate={{ width: i === current ? 22 : 8, backgroundColor: i === current ? '#1D5BD6' : '#CBD5E1' }}
                    transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.4, 0, 0.2, 1] }}
                  />
                </button>
              ))}
            </div>
          ) : (
            <span className="text-sm font-semibold tabular-nums text-slate-300">{current + 1} / {pageCount}</span>
          )}
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next rooms"
            className="h-10 w-10 inline-flex items-center justify-center rounded-full text-[#1D5BD6] hover:bg-[#1D5BD6]/10 active:scale-90 transition-all"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ─── Compact header used by the three dashboard cards ───────────── */
function DashHeader({
  icon: Icon,
  title,
  action,
  href,
}: {
  icon: React.ElementType;
  title: string;
  action?: React.ReactNode;
  /** The whole header opens this page */
  href?: string;
}) {
  const inner = (
    <>
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-lg bg-[#12408F]/15 flex items-center justify-center flex-shrink-0">
          <Icon className="w-[18px] h-[18px] text-[#1D5BD6]" />
        </div>
        <h2 className="text-[15px] font-semibold text-white leading-5 truncate">{title}</h2>
      </div>
      {action ? <div className="flex-shrink-0 whitespace-nowrap">{action}</div> : null}
      {href ? <ChevronRight className="w-5 h-5 flex-shrink-0 text-[#1D5BD6] transition-transform duration-200 group-hover:translate-x-0.5" /> : null}
    </>
  );
  const box = 'flex items-center justify-between gap-3 px-5 py-4 border-b border-white/10';
  return href ? (
    <Link href={href} aria-label={`Open ${title}`} className={`${box} group hover:bg-white/[0.04] active:bg-white/[0.06] transition-colors`}>
      {inner}
    </Link>
  ) : (
    <div className={box}>{inner}</div>
  );
}

/** Fallback for time-based changes (classes starting / ending) — data changes arrive live. */
const POLL_MS = 60_000;

/* ─── Main component ─────────────────────────────────────────────── */
export default function InstructorDashboard() {
  const { name, facultyId, refresh: refreshProfile } = useInstructorProfile();
  const { refresh: refreshNotifications } = useNotifications();
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const [refreshing, setRefreshing]       = useState(false);
  const [data, setData]                   = useState<DashboardData | null>(null);
  const [loading, setLoading]             = useState(true);
  const [loadError, setLoadError]         = useState(false);
  const [nowHour, setNowHour]             = useState(new Date().getHours());
  const [dateStr, setDateStr]             = useState('');

  const [releasing, setReleasing]   = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [reserveErr, setReserveErr] = useState<string | null>(null);
  const [gmailVerified, setGmailVerified] = useState<boolean | null>(null);
  const [hideGmailNotice, setHideGmailNotice] = useState(true); // hidden until we confirm unverified
  const [userEmail, setUserEmail] = useState('');

  const stampDate = useCallback(() => {
    const d = new Date();
    setNowHour(d.getHours());
    setDateStr(d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
  }, []);
  useEffect(() => { stampDate(); }, [stampDate]);

  // Google verification notice
  const loadAccount = useCallback(() => fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (d?.user && typeof d.user.google_verified === 'boolean') {
          setGmailVerified(d.user.google_verified);
          const email = String(d.user.email ?? '');
          setUserEmail(email);
          if (d.user.google_verified) {
            setHideGmailNotice(true);
          } else {
            // Check if user previously dismissed this notice
            try {
              const key = `qrganize:dismiss-google-notice:${email}`;
              setHideGmailNotice(localStorage.getItem(key) === '1');
            } catch {
              setHideGmailNotice(false);
            }
          }
        }
      })
      .catch(() => {}), []);
  useEffect(() => { loadAccount(); }, [loadAccount]);

  const load = useCallback(async (silent = false): Promise<boolean> => {
    if (!silent) {
      setLoading(true);
      setLoadError(false);
    }
    try {
      const res = await fetch('/api/instructor/dashboard', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const json: DashboardData = await res.json();
      setData(json);
      setLoadError(false);
      return true;
    } catch {
      if (!silent) setLoadError(true);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  // Live updates: classes assigned or moved, rooms taken or freed, requests
  // decided — the dashboard reloads quietly
  useRealtime(['schedule', 'workload', 'occupancy', 'room-requests', 'rooms', 'term'], () => load(true), { enabled: !loading });
  useVisibilityAwareInterval(() => load(true), POLL_MS);

  // Refresh button: everything on the page (and the bell and name above it)
  // is fetched again behind the skeleton, then the cards fade back in
  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    stampDate();
    refreshNotifications();
    const [ok] = await Promise.all([
      load(true),
      loadAccount(),
      refreshProfile(),
    ]);
    setRefreshing(false);
    if (!ok) toast.error('Could not refresh the dashboard. Check your connection and try again.');
    return ok;
  }, [stampDate, refreshNotifications, load, loadAccount, refreshProfile, toast]);

  const showSkeleton = useMinLoading((loading && !data) || refreshing, PAGE_SKELETON_MIN_MS);

  async function confirmReleaseRoom() {
    if (!facultyId || !data?.my_reservation) return;
    setReleasing(true); setReserveErr(null);
    try {
      const res = await fetch('/api/rooms/occupancy', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: data.my_reservation.room_id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setReserveErr(json.error || 'Failed to release room.');
        return;
      }
      setReleaseOpen(false);
      toast.success(`${data.my_reservation.room_name} has been released.`);
      await load(true);
    } catch {
      setReserveErr('Connection error. Please try again.');
    } finally {
      setReleasing(false);
    }
  }

  const sessions       = data?.today_schedule ?? [];
  const availableRooms = data?.available_rooms ?? [];
  // No class on now → the next one gets a "Next" chip
  const nextSess       = sessions.some(isOngoing) ? null : sessions.find(isUpcoming) ?? null;

  return (
    <div className="flex flex-col w-full min-w-0 px-4 sm:px-6 py-6 gap-5">

      {/* ══ HEADER — blue hero matching admin ══════════════════════════ */}
      <div className="bg-[#1D5BD6] rounded-2xl px-4 sm:px-7 py-5 sm:py-6">
        <div className="flex items-center justify-between flex-wrap gap-3 sm:gap-4">

          {/* Left — greeting + date */}
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white break-words">
              {greeting(nowHour)}, {name || 'Faculty'}
            </h1>
            {dateStr && (
              <p className="text-sm font-medium mt-1.5" style={{ color: '#DCE7F5' }}>{dateStr}</p>
            )}
          </div>

          {/* Right — live clock */}
          <div className="sm:text-right">
            <LiveClock />
            <p className="text-xs font-semibold mt-1 uppercase tracking-wider flex items-center gap-1.5 sm:justify-end" style={{ color: '#C7D6EA' }}>
              <span aria-hidden className="w-2 h-2 rounded-full bg-emerald-400" />
              Live
            </p>
          </div>
        </div>
      </div>

      {/* Same Refresh button, colour and place as My Schedule and My Workload */}
      <div className="flex justify-end">
        <RefreshButton overlay={false} onRefresh={refreshAll} loading={refreshing || showSkeleton} />
      </div>

      {gmailVerified === false && !hideGmailNotice && (
        <div className="flex flex-col sm:flex-row items-start gap-3 px-5 py-3.5 rounded-xl border border-white/10 bg-white/[0.06] text-sm text-slate-300">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-red-400" />
          <span className="flex-1 leading-relaxed">
            Your email is not verified yet. You can optionally verify your Google account in{' '}
            <Link href="/instructor/profile" className="underline underline-offset-2 font-semibold text-white hover:text-blue-300">
              Profile Settings
            </Link>
            {' '}to enable Google sign-in and Login OTP.
          </span>
          <button
            type="button"
            onClick={() => {
              setHideGmailNotice(true);
              try {
                if (userEmail) localStorage.setItem(`qrganize:dismiss-google-notice:${userEmail}`, '1');
              } catch { /* localStorage unavailable */ }
            }}
            className="flex-shrink-0 text-xs font-semibold text-slate-400 hover:text-white transition-colors px-2 py-1 rounded-lg hover:bg-white/10"
          >
            Ignore
          </button>
        </div>
      )}

      {/* ══ RESERVE ERROR ══════════════════════════════════════════════ */}
      {reserveErr && (
        <div className="flex items-center gap-3 px-5 py-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-200 font-medium">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1">{reserveErr}</span>
          <button onClick={() => setReserveErr(null)} className="opacity-60 hover:opacity-100 transition-opacity">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ══ ACTIVE SESSION + MAIN BODY ═════════════════════════════════ */}
      <PageLoadTransition
        showSkeleton={showSkeleton}
        skeleton={
          <div className="flex flex-col gap-5">
            <div className="rounded-2xl border border-white/10 bg-[#111827] p-4 overflow-hidden">
              <Skeleton className="h-12 rounded-xl" />
            </div>
            {/* Same shape as the two cards: Available Rooms (5 rows + page dots) · Class Schedule */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-5">
              {[...Array(2)].map((_, i) => (
                <div key={i} className="rounded-2xl border border-white/10 bg-[#111827] overflow-hidden">
                  <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10">
                    <Skeleton className="w-9 h-9 rounded-lg flex-shrink-0" />
                    <Skeleton className="h-4 w-36 rounded" />
                  </div>
                  <div className="p-4 space-y-3" style={{ height: ROOMS_PER_PAGE * ROOM_ROW_PX + 60 }}>
                    {[...Array(ROOMS_PER_PAGE)].map((__, r) => <Skeleton key={r} className="h-[56px] rounded-xl" />)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        }
        className="flex flex-col gap-5"
      >
      {/* ══ ACTIVE SESSION CARD ════════════════════════════════════════ */}
      {data?.my_reservation ? (
        <motion.div {...revealProps(0, reduceMotion)} className={[
          'bg-[#111827] rounded-2xl border-2 px-4 sm:px-6 py-4 sm:py-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 sm:gap-6',
          data.my_reservation.status === 'Pending'
            ? 'border-amber-500/40'
            : 'border-emerald-500/40',
        ].join(' ')}>
          {/* Status icon + info */}
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <div className={`w-11 h-11 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
              data.my_reservation.status === 'Pending' ? 'bg-amber-500/15' : 'bg-emerald-500/15'
            }`}>
              {data.my_reservation.status === 'Pending'
                ? <Timer className="w-5 h-5 sm:w-6 sm:h-6 text-amber-400" />
                : <CircleDot className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400" />}
            </div>
            <div className="min-w-0">
              <p className={`text-xs font-black uppercase tracking-widest mb-0.5 ${
                data.my_reservation.status === 'Pending' ? 'text-amber-400' : 'text-emerald-400'
              }`}>
                {data.my_reservation.status === 'Pending' ? 'Pending QR Confirmation' : 'Active Room Session'}
              </p>
              <p className="text-lg sm:text-xl font-black text-white leading-tight truncate">{data.my_reservation.room_name}</p>
              <div className="flex items-center gap-2 sm:gap-3 mt-1.5 flex-wrap">
                <TypeBadge type={data.my_reservation.room_type} />
                {data.my_reservation.building && (
                  <span className="text-xs text-slate-400 flex items-center gap-1">
                    <Building2 className="w-3.5 h-3.5" /> {data.my_reservation.building}
                  </span>
                )}
                {data.my_reservation.capacity && (
                  <span className="text-xs text-slate-400 flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" /> {data.my_reservation.capacity} seats
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Right: countdown / time + actions */}
          <div className="flex items-center gap-3 sm:gap-5 flex-wrap w-full sm:w-auto">
            {data.my_reservation.status === 'Pending' && (
              <div>
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Scan within</p>
                <Countdown expiresAt={data.my_reservation.expires_at} onExpired={() => load(true)} />
              </div>
            )}
            {data.my_reservation.status === 'Occupied' && data.my_reservation.occupied_at && (
              <div className="text-left sm:text-right">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Session started</p>
                <p className="text-lg sm:text-xl font-black text-white">
                  {new Date(data.my_reservation.occupied_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            )}
            <div className="flex items-center gap-2.5 w-full sm:w-auto">
              {data.my_reservation.status === 'Pending' && (
                <Link href="/instructor/scan"
                  className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 bg-[#1D5BD6] hover:bg-[#12408F] text-white px-4 py-2.5 rounded-xl text-sm font-bold transition-colors shadow-lg shadow-[#1D5BD6]/20 min-h-11">
                  <QrCode className="w-4 h-4" /> Scan QR Now
                </Link>
              )}
              {data.my_reservation.status === 'Occupied' && (
                <button
                  type="button"
                  onClick={() => setReleaseOpen(true)}
                  disabled={releasing}
                  className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-2 border border-white/10 bg-white/5 hover:bg-red-500/10 hover:border-red-500/30 text-slate-300 hover:text-red-300 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 min-h-11"
                >
                  Release Room
                </button>
              )}
            </div>
          </div>
        </motion.div>
      ) : data ? (
        <motion.div {...revealProps(0, reduceMotion)} className="bg-[#111827] border border-dashed border-white/10 rounded-2xl px-4 sm:px-6 py-4 flex flex-wrap sm:flex-nowrap items-center gap-4">
          <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center flex-shrink-0">
            <DoorOpen className="w-5 h-5 text-slate-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold text-white">No Active Room Session</p>
            <p className="text-sm text-slate-400 mt-0.5">Request a room below or scan a QR code at any available room entrance</p>
          </div>
          <Link href="/instructor/scan"
            className="w-full sm:w-auto justify-center flex-shrink-0 flex items-center gap-2 bg-[#1D5BD6] hover:bg-[#12408F] text-white px-4 py-2.5 rounded-xl text-sm font-bold transition-colors shadow-sm shadow-[#1D5BD6]/20">
            <QrCode className="w-4 h-4" /> Scan QR
          </Link>
        </motion.div>
      ) : null}

      {/* ══ MAIN BODY: Available Rooms · Class Schedule ════════════════ */}
      {data ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-5 items-start">

          {/* ── Available Rooms — pages slide on by themselves ───────── */}
          <motion.div {...revealProps(1, reduceMotion)} className="bg-[#111827] rounded-2xl border border-white/10 flex flex-col min-w-0 overflow-hidden">
            <DashHeader
              icon={DoorOpen}
              title="Available Rooms"
              action={
                <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-2 text-xs font-semibold tabular-nums text-slate-300 bg-white/5 rounded-md">
                  {availableRooms.length}
                </span>
              }
            />
            {availableRooms.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
                <Building2 className="w-7 h-7 text-slate-600 mb-2" />
                <p className="text-sm font-medium text-white">No rooms are free right now.</p>
              </div>
            ) : (
              <RoomsCarousel rooms={availableRooms} />
            )}
          </motion.div>

          {/* ── Class Schedule — the header opens My Schedule ────────── */}
          <motion.div {...revealProps(2, reduceMotion)} className="bg-[#111827] rounded-2xl border border-white/10 flex flex-col min-w-0 overflow-hidden">
            <DashHeader icon={CalendarDays} title="Class Schedule" href="/instructor/schedule" />

            {sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
                <CalendarDays className="w-8 h-8 text-slate-600 mb-2" />
                <p className="text-sm font-semibold text-white">No classes today</p>
              </div>
            ) : (
              <div className="overflow-y-auto overflow-x-hidden" style={{ scrollbarWidth: 'thin', maxHeight: ROOMS_PER_PAGE * ROOM_ROW_PX + 60 }}>
                {sessions.map((sess, i) => {
                  const ongoing  = isOngoing(sess);
                  const upcoming = isUpcoming(sess);
                  const past     = !ongoing && !upcoming;
                  const chip     = ongoing ? 'Now' : sess === nextSess ? 'Next' : null;
                  return (
                    <div key={`${sess.id}-${i}`}
                      className={`flex items-start gap-3 px-5 py-3.5 border-b border-white/5 last:border-b-0 ${ongoing ? 'bg-white/[0.03]' : ''}`}>

                      <div className="flex flex-col items-center flex-shrink-0 pt-1.5 w-3">
                        <div className={`w-2 h-2 rounded-full ${
                          ongoing  ? 'bg-[#1D5BD6]' :
                          upcoming ? 'bg-slate-400' :
                          'bg-slate-600'
                        }`} />
                        {i < sessions.length - 1 && (
                          <div className="w-px flex-1 min-h-8 mt-1.5 bg-white/10" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <p className={`text-xs tabular-nums mb-1 ${past ? 'text-slate-400' : 'text-slate-300'}`}>
                          {fmt12(sess.start_time)} – {fmt12(sess.end_time)}
                        </p>
                        <div className="flex items-center gap-2 min-w-0">
                          <p className={`text-sm font-semibold truncate ${past ? 'text-slate-300' : 'text-white'}`}>
                            {sess.subject_code}
                          </p>
                          {chip && (
                            <span className="flex-shrink-0 text-[10px] font-semibold text-[#1D5BD6] bg-[#12408F]/15 px-1.5 py-0.5 rounded-md">
                              {chip}
                            </span>
                          )}
                        </div>
                        <p className={`text-sm mt-0.5 truncate ${past ? 'text-slate-400' : 'text-slate-200'}`}>
                          {sess.subject_name}
                        </p>
                        <p className={`text-xs mt-1 truncate ${past ? 'text-slate-400' : 'text-slate-300'}`}>
                          {blockCode(sess.year_level, sess.block_name)}
                          {sess.room_name ? ` · ${sess.room_name}` : ' · No room assigned'}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </motion.div>
        </div>
      ) : null}

      {/* ══ ERROR / EMPTY STATE ════════════════════════════════════════ */}
      {!data && (
        <div className="flex flex-col items-center justify-center h-60 bg-[#111827] rounded-2xl border border-white/10">
          <AlertTriangle className="w-10 h-10 text-slate-500 mb-3" />
          <p className="text-white font-bold text-base">
            {loadError ? 'Could not load dashboard' : 'Dashboard unavailable'}
          </p>
          <p className="text-slate-400 text-sm mt-1">Check your connection and try again.</p>
          <button onClick={() => load()} className="mt-4 flex items-center gap-2 text-sm text-[#1D5BD6] hover:text-white font-semibold transition-colors">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>
      )}
      </PageLoadTransition>

      <Modal
        open={releaseOpen}
        onClose={() => { if (!releasing) setReleaseOpen(false); }}
        title="Release Room?"
        size="sm"
        footer={
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button
              type="button"
              onClick={() => setReleaseOpen(false)}
              disabled={releasing}
              className="min-h-11 px-4 rounded-xl text-sm font-medium border border-white/10 text-slate-300 hover:bg-white/5 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmReleaseRoom}
              disabled={releasing}
              className="min-h-11 px-4 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-500 text-white disabled:opacity-40 inline-flex items-center justify-center gap-2"
            >
              {releasing ? <><Loader2 className="w-4 h-4 animate-spin" /> Releasing…</> : 'Release Room'}
            </button>
          </div>
        }
      >
        <p className="text-sm text-slate-300 leading-relaxed">
          Are you sure you want to release{' '}
          <span className="font-semibold text-white">{data?.my_reservation?.room_name ?? 'this room'}</span>?
          It will become available for other faculty.
        </p>
      </Modal>

    </div>
  );
}
