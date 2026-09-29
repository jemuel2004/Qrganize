'use client';

import { useCallback, useEffect, useState } from 'react';
import { useInstructorProfile } from '@/context/InstructorProfileContext';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useToast } from '@/context/ToastContext';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { Skeleton } from '@/components/ui/skeletons';
import Link from 'next/link';
import {
  CalendarDays, QrCode, ChevronRight,
  Users, Building2, DoorOpen, RefreshCw, Loader2, Timer,
  AlertTriangle, XCircle, Search,
  X, CircleDot,
} from 'lucide-react';
import Modal from '@/components/ui/Modal';

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
function todayName() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' });
}
function nowHHMM() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
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

/* ─── Shared room row (Available Rooms + Find results) ───────────── */
function RoomRow({
  room,
  action,
}: {
  room: AvailableRoom;
  action?: React.ReactNode;
}) {
  const meta = [
    room.building,
    room.capacity != null ? `${room.capacity} seats` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex items-center gap-3 px-5 py-3.5 border-b border-white/5 last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-semibold text-white truncate">{room.room_name}</p>
          <TypeBadge type={room.room_type} />
        </div>
        <p className="text-xs text-slate-400 mt-1 truncate">
          {meta || 'Capacity N/A'}
        </p>
      </div>
      {action ? <div className="flex-shrink-0">{action}</div> : null}
    </div>
  );
}

/* ─── Compact header used by the three dashboard cards ───────────── */
function DashHeader({
  icon: Icon,
  title,
  sub,
  action,
}: {
  icon: React.ElementType;
  title: string;
  sub?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-white/10">
      <div className="flex items-start gap-3 min-w-0">
        <div className="w-9 h-9 rounded-lg bg-[#12408F]/15 flex items-center justify-center flex-shrink-0">
          <Icon className="w-[18px] h-[18px] text-[#1D5BD6]" />
        </div>
        <div className="min-w-0 pt-0.5">
          <h2 className="text-[15px] font-semibold text-white leading-5">{title}</h2>
          {sub && <p className="text-xs text-slate-300 mt-1 leading-4">{sub}</p>}
        </div>
      </div>
      {action ? <div className="flex-shrink-0 whitespace-nowrap pt-0.5">{action}</div> : null}
    </div>
  );
}

const POLL_MS = 30_000;
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/* ─── Main component ─────────────────────────────────────────────── */
export default function InstructorDashboard() {
  const { name, facultyId } = useInstructorProfile();
  const toast = useToast();
  const [data, setData]                   = useState<DashboardData | null>(null);
  const [loading, setLoading]             = useState(true);
  const [loadError, setLoadError]         = useState(false);
  const [nowHour, setNowHour]             = useState(new Date().getHours());
  const [dateStr, setDateStr]             = useState('');

  const [findTime, setFindTime]         = useState(nowHHMM);
  const [findDay, setFindDay]           = useState(todayName);
  const [findResults, setFindResults]   = useState<AvailableRoom[] | null>(null);
  const [findLoading, setFindLoading]   = useState(false);
  const [findError, setFindError]       = useState<string | null>(null);
  const [findSearched, setFindSearched] = useState(false);

  const [releasing, setReleasing]   = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [reserveErr, setReserveErr] = useState<string | null>(null);
  const [gmailVerified, setGmailVerified] = useState<boolean | null>(null);
  const [hideGmailNotice, setHideGmailNotice] = useState(true); // hidden until we confirm unverified
  const [userEmail, setUserEmail] = useState('');

  useEffect(() => {
    const d = new Date();
    setNowHour(d.getHours());
    setDateStr(d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
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
      .catch(() => {});
  }, []);


  const load = useCallback(async (silent = false) => {
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
    } catch {
      if (!silent) setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useVisibilityAwareInterval(() => load(true), POLL_MS);

  const showSkeleton = useMinLoading(loading && !data, PAGE_SKELETON_MIN_MS);

  async function handleFind(e: React.FormEvent) {
    e.preventDefault();
    setFindLoading(true); setFindError(null); setFindSearched(true);
    try {
      const url = `/api/instructor/rooms/find?time=${encodeURIComponent(findTime)}&day=${encodeURIComponent(findDay)}`;
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) { setFindError(json.error || 'Search failed.'); setFindResults([]); return; }
      setFindResults(json.rooms || []);
    } catch {
      setFindError('Connection error. Please try again.');
      setFindResults([]);
    } finally { setFindLoading(false); }
  }

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

  const today          = todayName();
  const sessions       = data?.today_schedule ?? [];
  const availableRooms = data?.available_rooms ?? [];
  const nextSess       = sessions.find(isUpcoming) ?? null;
  const currSess       = sessions.find(isOngoing) ?? null;

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

          {/* Right — clock + refresh */}
          <div className="flex items-center gap-4">
            <div className="text-right">
              <LiveClock />
              <p className="text-xs font-semibold mt-1 uppercase tracking-wider" style={{ color: '#C7D6EA' }}>
                Live
              </p>
            </div>
            <button
              onClick={() => load()} disabled={loading}
              className="p-2 rounded-xl hover:bg-white/15 transition-colors"
              title="Refresh dashboard"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} style={{ color: '#DCE7F5' }} />
            </button>
          </div>
        </div>
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
              <Skeleton className="h-16 rounded-xl" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-5">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="rounded-2xl border border-white/10 bg-[#111827] p-4 space-y-3 overflow-hidden min-h-[16rem]">
                  <Skeleton className="h-5 w-40 rounded" />
                  <Skeleton className="h-3 w-24 rounded" />
                  <Skeleton className="h-40 w-full rounded-xl" />
                </div>
              ))}
            </div>
          </div>
        }
        className="flex flex-col gap-5"
      >
      {/* ══ ACTIVE SESSION CARD ════════════════════════════════════════ */}
      {data?.my_reservation ? (
        <div className={[
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
        </div>
      ) : data ? (
        <div className="bg-[#111827] border border-dashed border-white/10 rounded-2xl px-4 sm:px-6 py-4 flex flex-wrap sm:flex-nowrap items-center gap-4">
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
        </div>
      ) : null}

      {/* ══ MAIN 3-COLUMN BODY ═════════════════════════════════════════ */}
      {data ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-5 items-start">

          {/* ── Col 1: Available Rooms ───────────────────────────────── */}
          <div className="bg-[#111827] rounded-2xl border border-white/10 flex flex-col min-w-0 overflow-hidden max-h-[min(28rem,calc(100dvh-14rem))] xl:max-h-[min(36rem,calc(100dvh-16rem))]">
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
              <div className="flex flex-col items-center justify-center flex-1 px-6 py-10 text-center">
                <Building2 className="w-7 h-7 text-slate-600 mb-2" />
                <p className="text-sm font-medium text-white">No rooms are currently available.</p>
                <p className="text-xs text-slate-500 mt-1 max-w-[16rem]">Rooms in use or reserved will reappear here when they are free.</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0" style={{ scrollbarWidth: 'thin' }}>
                {availableRooms.map(room => (
                  <RoomRow
                    key={room.id}
                    room={room}
                    action={
                      <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-md">
                        Available
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </div>

          {/* ── Col 2: Class Schedule ────────────────────────────────── */}
          <div className="bg-[#111827] rounded-2xl border border-white/10 flex flex-col min-w-0 overflow-hidden max-h-[min(28rem,calc(100dvh-14rem))] xl:max-h-[min(36rem,calc(100dvh-16rem))]">
            <DashHeader
              icon={CalendarDays}
              title="Class Schedule"
              sub={`Today — ${today} · ${sessions.length} class${sessions.length !== 1 ? 'es' : ''} scheduled`}
              action={
                <Link href="/instructor/schedule"
                  className="inline-flex items-center gap-0.5 text-sm font-semibold text-[#1D5BD6] hover:text-[#12408F] transition-colors">
                  Full schedule <ChevronRight className="w-4 h-4" />
                </Link>
              }
            />

            {(currSess || nextSess) && (
              <div className="mx-5 mt-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-[#1D5BD6]">
                  {currSess ? 'Ongoing now' : 'Next class'}
                </p>
                <p className="text-sm font-semibold text-white mt-1 truncate">
                  {(currSess ?? nextSess)!.subject_code}
                </p>
                <p className="text-sm text-slate-200 truncate">
                  {(currSess ?? nextSess)!.subject_name}
                </p>
                <p className="text-xs text-slate-300 mt-1.5">
                  {fmt12((currSess ?? nextSess)!.start_time)} – {fmt12((currSess ?? nextSess)!.end_time)}
                  {(currSess ?? nextSess)!.room_name ? ` · ${(currSess ?? nextSess)!.room_name}` : ' · No room assigned'}
                  {` · Block ${(currSess ?? nextSess)!.block_name}`}
                </p>
              </div>
            )}

            {sessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center flex-1 px-6 py-10 text-center">
                <CalendarDays className="w-8 h-8 text-slate-600 mb-2" />
                <p className="text-sm font-semibold text-white">No classes today</p>
                <p className="text-xs text-slate-500 mt-1">Enjoy your free day.</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 mt-1" style={{ scrollbarWidth: 'thin' }}>
                {sessions.map((sess, i) => {
                  const ongoing  = isOngoing(sess);
                  const upcoming = isUpcoming(sess);
                  const past     = !ongoing && !upcoming;
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
                          {ongoing && (
                            <span className="flex-shrink-0 text-[10px] font-semibold text-[#1D5BD6] bg-[#12408F]/15 px-1.5 py-0.5 rounded-md">
                              Now
                            </span>
                          )}
                        </div>
                        <p className={`text-sm mt-0.5 truncate ${past ? 'text-slate-400' : 'text-slate-200'}`}>
                          {sess.subject_name}
                        </p>
                        <p className={`text-xs mt-1 truncate ${past ? 'text-slate-400' : 'text-slate-300'}`}>
                          Block {sess.block_name}
                          {sess.room_name ? ` · ${sess.room_name}` : ' · No room assigned'}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="px-5 py-3.5 border-t border-white/10 mt-auto">
              <Link href="/instructor/schedule" className="inline-flex items-center gap-1 text-sm font-medium text-[#1D5BD6] hover:text-[#12408F] transition-colors">
                View full semester schedule <ChevronRight className="w-4 h-4" />
              </Link>
            </div>
          </div>

          {/* ── Col 3: Find Available Rooms ──────────────────────────── */}
          <div className="bg-[#111827] rounded-2xl border border-white/10 flex flex-col min-w-0 overflow-hidden md:col-span-2 xl:col-span-1 max-h-[min(28rem,calc(100dvh-14rem))] xl:max-h-[min(36rem,calc(100dvh-16rem))]">
            <DashHeader
              icon={Search}
              title="Find Available Rooms"
              sub="Search conflict-free rooms"
            />

            <div className="p-5 flex flex-col gap-4 flex-1 min-h-0">
              <form onSubmit={handleFind} className="space-y-3 flex-shrink-0">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Time</label>
                    <input
                      type="time" value={findTime} onChange={e => setFindTime(e.target.value)} required
                      className="w-full h-10 bg-[#0f172a] border border-white/10 text-white rounded-lg px-3 text-sm
                        focus:outline-none focus:ring-2 focus:ring-[#12408F]/40 focus:border-[#12408F]/60"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Day</label>
                    <select
                      value={findDay} onChange={e => setFindDay(e.target.value)}
                      className="w-full h-10 bg-[#0f172a] border border-white/10 text-white rounded-lg px-3 text-sm
                        focus:outline-none focus:ring-2 focus:ring-[#12408F]/40 focus:border-[#12408F]/60"
                    >
                      {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                </div>
                <button
                  type="submit" disabled={findLoading}
                  className="w-full h-10 flex items-center justify-center gap-2 bg-[#12408F] hover:bg-[#1D5BD6]
                    disabled:opacity-50 text-white rounded-lg text-sm font-semibold"
                >
                  {findLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  {findLoading ? 'Searching…' : 'Search Rooms'}
                </button>
              </form>

              {findError && (
                <div className="flex items-center gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3.5 py-2.5">
                  <XCircle className="w-4 h-4 flex-shrink-0" /> {findError}
                </div>
              )}

              {findSearched && !findLoading && findResults !== null && findResults.length > 0 && (
                <div className="flex-shrink-0">
                  <p className="text-sm font-semibold text-white">
                    {findResults.length} room{findResults.length !== 1 ? 's' : ''} available
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {fmt12(findTime)} · {findDay}
                  </p>
                </div>
              )}

              <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 -mx-5" style={{ scrollbarWidth: 'thin' }}>
                {findSearched && !findLoading && findResults !== null ? (
                  findResults.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full min-h-24 px-5 text-center">
                      <p className="text-sm font-medium text-white">No rooms available</p>
                      <p className="text-xs text-slate-500 mt-1">All rooms are occupied at this time.</p>
                    </div>
                  ) : (
                    findResults.map(room => (
                      <RoomRow
                        key={room.id}
                        room={room}
                        action={
                          <Link
                            href={`/instructor/room-requests?room=${room.id}`}
                            className="h-8 min-w-[4.5rem] px-3 rounded-lg border border-[#12408F]/35 text-[#1D5BD6] text-xs font-semibold hover:bg-[#12408F]/10 active:scale-95 transition-all duration-200 inline-flex items-center justify-center"
                          >
                            Request
                          </Link>
                        }
                      />
                    ))
                  )
                ) : !findSearched ? (
                  <div className="flex items-center justify-center h-full min-h-24 px-5 text-center">
                    <p className="text-sm text-slate-500">Choose a time and day, then search.</p>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="px-5 py-3.5 border-t border-white/10 mt-auto">
              <Link href="/instructor/available-rooms" className="inline-flex items-center gap-1 text-sm font-medium text-[#1D5BD6] hover:text-[#12408F] transition-colors">
                Browse all available rooms <ChevronRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
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
