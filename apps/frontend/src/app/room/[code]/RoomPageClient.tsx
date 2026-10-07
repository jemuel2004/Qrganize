'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle, BookOpen, CalendarClock, CheckCircle2, Clock, Home, Loader2, Monitor, QrCode, ShieldAlert, Timer, Users,
} from 'lucide-react';
import SystemLogo from '@/components/ui/SystemLogo';
import { Skeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { presentScanResult, type ScanResult } from '@/lib/scanResult';

/* ─── Data (GET /api/rooms/by-qr) ─────────────────────────────────────────── */

interface RoomClass {
  ms_id: number; subject_code: string; subject_name: string; block: string;
  faculty_name: string | null; start_time: string; end_time: string; is_mine: boolean;
}
interface RoomInfo {
  room: { id: number; room_name: string; room_type: string; building: string | null; capacity: number | null; qr_code_id: string };
  status:
    | { state: 'Available' }
    | { state: 'Occupied' | 'Pending'; faculty_name: string | null; is_mine: boolean; since: string | null; until: string | null };
  today: RoomClass[];
  now: string;
  day: string;
  viewer: { role: string; faculty_id: number | null };
}

const EASE = [0.4, 0, 0.2, 1] as const;
const WHITE = { color: '#FFFFFF' } as const;
const TZ = 'Asia/Manila';

const isLab = (t: string) => /lab/i.test(t);
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
function clock(t: string): string {
  const min = toMin(t);
  const h = Math.floor(min / 60);
  return `${h % 12 || 12}:${String(min % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
const timeOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : null;

function homeFor(role: string): string {
  if (role === 'instructor') return '/instructor';
  if (role === 'program_chair') return '/dept-chair';
  return '/dashboard';
}

const TONE: Record<string, { box: string; text: string; Icon: React.ElementType }> = {
  success: { box: 'bg-[#ECFDF5] border-[#A7F3D0]', text: 'text-[#047857]', Icon: CheckCircle2 },
  warning: { box: 'bg-[#FFFBEB] border-[#FDE68A]', text: 'text-[#B45309]', Icon: Timer },
  danger:  { box: 'bg-[#FEF2F2] border-[#FECACA]', text: 'text-[#B91C1C]', Icon: ShieldAlert },
  neutral: { box: 'bg-[#F8FAFC] border-[#E2E8F0]', text: 'text-[#334155]', Icon: AlertTriangle },
  info:    { box: 'bg-[#EFF6FF] border-[#BFDBFE]', text: 'text-[#1D5BD6]', Icon: CheckCircle2 },
};

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function RoomPageClient({ code, role }: { code: string | null; role: string }) {
  const reduceMotion = useReducedMotion();
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [notFound, setNotFound] = useState(!code);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!!code);
  const showSkeleton = useMinLoading(loading, LOADING_DELAY);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!code) return;
    if (!quiet) setLoading(true);
    try {
      const res = await fetch(`/api/rooms/by-qr?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
      if (res.status === 401) { window.location.replace(`/login?next=${encodeURIComponent(`/room/${code}`)}`); return; }
      if (res.status === 404) { setNotFound(true); setInfo(null); return; }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.room) throw new Error(data?.error || 'Could not load this room.');
      setInfo(data as RoomInfo);
      setError('');
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : 'Could not load this room.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [code]);

  useEffect(() => { void load(); }, [load]);
  // Status changes as people check in — refresh quietly every 30 s while the page is shown
  useEffect(() => {
    const t = window.setInterval(() => { if (!document.hidden) void load(true); }, 30_000);
    return () => window.clearInterval(t);
  }, [load]);

  /** Check in — the same request and rules as Scan Room QR */
  async function checkIn() {
    if (!info?.viewer.faculty_id) return;
    setChecking(true);
    setResult(null);
    try {
      const res = await fetch('/api/qr/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_code_id: info.room.qr_code_id, faculty_id: info.viewer.faculty_id }),
      });
      const raw = await res.json().catch(() => ({})) as ScanResult & { error?: string };
      setResult({
        ...raw,
        status: raw.status || (res.ok ? 'Invalid' : 'Error'),
        message: raw.message || raw.error || '',
        scan_time: raw.scan_time || '',
      });
    } catch {
      setResult({ status: 'Error', message: '', scan_time: '' });
    } finally {
      setChecking(false);
      void load(true);
    }
  }

  const nowMin = info ? toMin(info.now) : 0;
  const current = info?.today.find(c => toMin(c.start_time) <= nowMin && nowMin < toMin(c.end_time)) ?? null;
  const next = info?.today.find(c => toMin(c.start_time) > nowMin) ?? null;
  const isFaculty = role === 'instructor';
  const checkedInHere = info?.status.state === 'Occupied' && info.status.is_mine;
  const presented = result ? presentScanResult(result) : null;

  return (
    <div className="min-h-dvh bg-[#EEF3FA]">
      <header className="qr-app-header bg-[#12408F]">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
          <Link href={homeFor(role)} className="flex min-w-0 items-center gap-2.5" aria-label="QRganize home">
            <SystemLogo size={40} />
            <span className="truncate text-lg font-bold" style={WHITE}>QRganize</span>
          </Link>
          <Link
            href={homeFor(role)}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-full bg-white/15 hover:bg-white/25 text-[15px] font-semibold transition-colors"
            style={WHITE}
          >
            <Home className="w-4 h-4" /> Home
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-5 sm:py-8 space-y-4">
        {showSkeleton ? (
          <RoomSkeleton />
        ) : notFound ? (
          <motion.section
            initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE } }}
            className="rounded-2xl border border-[#E2E8F0] bg-white px-6 py-12 text-center shadow-sm"
          >
            <QrCode className="mx-auto mb-3 h-12 w-12 text-[#94A3B8]" />
            <h1 className="text-xl font-bold text-[#0B2A5B]">Room not found</h1>
            <p className="mt-1.5 text-[15px] text-[#475569]">This QR code isn&apos;t linked to an active room.</p>
            <Link href={homeFor(role)} className="mt-6 inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-[#1D5BD6] px-6 text-[15px] font-semibold hover:bg-[#164BB5] transition-colors" style={WHITE}>
              <Home className="w-4 h-4" /> Go to QRganize
            </Link>
          </motion.section>
        ) : error || !info ? (
          <section className="rounded-2xl border border-[#FECACA] bg-white px-6 py-10 text-center shadow-sm">
            <p className="text-[15px] font-semibold text-[#B91C1C]">{error || 'Could not load this room.'}</p>
            <button type="button" onClick={() => void load()} className="mt-4 h-11 rounded-xl bg-[#1D5BD6] px-5 text-[15px] font-semibold hover:bg-[#164BB5] transition-colors" style={WHITE}>
              Try again
            </button>
          </section>
        ) : (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.25, ease: EASE } }}
            className="space-y-4"
          >
            {/* ── Room + status ── */}
            <section className="rounded-2xl border border-[#E2E8F0] bg-white p-5 sm:p-6 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                {isLab(info.room.room_type) ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-sm font-bold text-amber-700">
                    <Monitor className="w-4 h-4" /> Laboratory
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[#BFDBFE] bg-[#EFF6FF] px-3 py-1 text-sm font-bold text-[#1D5BD6]">
                    <BookOpen className="w-4 h-4" /> Lecture
                  </span>
                )}
                {info.room.building && <span className="text-sm text-[#64748B]">{info.room.building}</span>}
                {info.room.capacity ? (
                  <span className="inline-flex items-center gap-1 text-sm text-[#64748B]"><Users className="w-4 h-4" /> {info.room.capacity} seats</span>
                ) : null}
              </div>
              <h1 className="mt-2 text-3xl font-bold leading-tight text-[#0B2A5B] break-words">{info.room.room_name}</h1>

              <StatusPanel info={info} />
            </section>

            {/* ── Now / next ── */}
            {(current || next) && (
              <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {current && <ClassCard label="Now" klass={current} highlight />}
                {next && <ClassCard label="Next" klass={next} />}
              </section>
            )}

            {/* ── Actions (what each role may do here) ── */}
            <section className="rounded-2xl border border-[#E2E8F0] bg-white p-5 shadow-sm space-y-3">
              {isFaculty ? (
                <>
                  {checkedInHere ? (
                    <p className="flex items-center gap-2 text-[15px] font-semibold text-[#047857]">
                      <CheckCircle2 className="w-5 h-5" /> You are checked in to this room.
                    </p>
                  ) : (
                    <motion.button
                      type="button"
                      onClick={checkIn}
                      disabled={checking || !info.viewer.faculty_id}
                      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                      className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#1D5BD6] text-[17px] font-bold hover:bg-[#164BB5] transition-colors disabled:opacity-60"
                      style={WHITE}
                    >
                      {checking ? <Loader2 className="w-5 h-5 animate-spin" /> : <QrCode className="w-5 h-5" />}
                      {checking ? 'Checking in…' : 'Check in to this room'}
                    </motion.button>
                  )}
                  <AnimatePresence initial={false}>
                    {presented && (
                      <motion.div
                        key={`${result?.status}-${result?.scan_time}`}
                        initial={reduceMotion ? false : { opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE } }}
                        exit={{ opacity: 0 }}
                        role="status"
                        className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${TONE[presented.tone].box}`}
                      >
                        {(() => { const I = TONE[presented.tone].Icon; return <I className={`w-5 h-5 mt-0.5 flex-shrink-0 ${TONE[presented.tone].text}`} />; })()}
                        <span className="min-w-0">
                          <span className={`block text-[15px] font-bold ${TONE[presented.tone].text}`}>{presented.title}</span>
                          <span className="block text-sm text-[#334155] mt-0.5">{presented.message}</span>
                        </span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <div className="grid grid-cols-2 gap-2.5">
                    <Link href="/instructor/schedule" className="flex h-12 items-center justify-center gap-2 rounded-xl border-2 border-[#CBD5E1] bg-white text-[15px] font-semibold text-[#0B2A5B] hover:border-[#1D5BD6] transition-colors">
                      <CalendarClock className="w-4 h-4" /> My Schedule
                    </Link>
                    <Link href="/instructor/available-rooms" className="flex h-12 items-center justify-center gap-2 rounded-xl border-2 border-[#CBD5E1] bg-white text-[15px] font-semibold text-[#0B2A5B] hover:border-[#1D5BD6] transition-colors">
                      <Clock className="w-4 h-4" /> Request a Room
                    </Link>
                  </div>
                </>
              ) : (
                <Link
                  href={`/room-monitoring?code=${encodeURIComponent(info.room.qr_code_id)}`}
                  className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#1D5BD6] text-[17px] font-bold hover:bg-[#164BB5] transition-colors"
                  style={WHITE}
                >
                  <Monitor className="w-5 h-5" /> Open in Room Monitoring
                </Link>
              )}
            </section>

            {/* ── Today in this room ── */}
            <section className="rounded-2xl border border-[#E2E8F0] bg-white shadow-sm overflow-hidden">
              <h2 className="px-5 py-3 border-b border-[#EEF2F7] bg-[#F6F9FE] text-[13px] font-bold uppercase tracking-[0.08em] text-[#0B2A5B]">
                Today · {info.day}
              </h2>
              {info.today.length === 0 ? (
                <p className="px-5 py-8 text-center text-[15px] text-[#64748B]">No classes in this room today.</p>
              ) : (
                <ul className="divide-y divide-[#EEF2F7]">
                  {info.today.map(c => {
                    const now = c === current;
                    const done = toMin(c.end_time) <= nowMin;
                    return (
                      <li key={`${c.ms_id}-${c.start_time}`} className={`flex items-start gap-3 px-5 py-3.5 ${now ? 'bg-[#EFF6FF]' : ''} ${done ? 'opacity-60' : ''}`}>
                        <span className="w-[92px] flex-shrink-0 text-sm font-semibold tabular-nums text-[#0B2A5B]">
                          {clock(c.start_time)}<span className="block text-xs font-medium text-[#64748B]">to {clock(c.end_time)}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-[15px] font-bold text-[#0B2A5B]">{c.subject_code}</span>
                            {c.block && <span className="rounded-md bg-[#1E4FB8] px-2 py-0.5 text-[12px] font-bold" style={WHITE}>{c.block}</span>}
                            {now && <span className="rounded-full bg-[#1D5BD6] px-2 py-0.5 text-[11px] font-bold" style={WHITE}>Now</span>}
                            {c.is_mine && <span className="rounded-full border border-[#A7F3D0] bg-[#ECFDF5] px-2 py-0.5 text-[11px] font-bold text-[#047857]">Your class</span>}
                          </span>
                          <span className="block text-sm text-[#334155] break-words">{c.subject_name}</span>
                          <span className="block text-sm text-[#64748B]">{c.faculty_name || 'No faculty yet'}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </motion.div>
        )}
      </main>
    </div>
  );
}

/* ─── Bits ───────────────────────────────────────────────────────────────── */

function StatusPanel({ info }: { info: RoomInfo }) {
  const s = info.status;
  if (s.state === 'Available') {
    return (
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-[#A7F3D0] bg-[#ECFDF5] px-4 py-3">
        <span className="h-3 w-3 flex-shrink-0 rounded-full bg-[#10B981]" />
        <span className="text-[17px] font-bold text-[#047857]">Available</span>
      </div>
    );
  }
  const occupied = s.state === 'Occupied';
  const since = timeOf(s.since);
  const until = timeOf(s.until);
  return (
    <div className={`mt-4 flex items-start gap-3 rounded-xl border px-4 py-3 ${occupied ? 'border-[#BFDBFE] bg-[#EFF6FF]' : 'border-[#FDE68A] bg-[#FFFBEB]'}`}>
      <span className={`mt-1.5 h-3 w-3 flex-shrink-0 rounded-full ${occupied ? 'bg-[#1D5BD6]' : 'bg-[#F59E0B]'}`} />
      <span className="min-w-0">
        <span className={`block text-[17px] font-bold ${occupied ? 'text-[#0B2A5B]' : 'text-[#B45309]'}`}>
          {occupied ? 'In use' : 'Reserved — waiting for check-in'}
        </span>
        <span className="block text-sm text-[#334155]">
          {s.is_mine ? 'By you' : s.faculty_name ? `By ${s.faculty_name}` : ''}
          {since ? `${s.is_mine || s.faculty_name ? ' · ' : ''}${occupied ? 'since' : 'reserved at'} ${since}` : ''}
          {until ? ` · until ${until}` : ''}
        </span>
      </span>
    </div>
  );
}

function ClassCard({ label, klass, highlight = false }: { label: string; klass: RoomClass; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${highlight ? 'border-[#BFDBFE] bg-white' : 'border-[#E2E8F0] bg-white'}`}>
      <p className={`text-[13px] font-bold uppercase tracking-[0.08em] ${highlight ? 'text-[#1D5BD6]' : 'text-[#64748B]'}`}>{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-[#0B2A5B]">{clock(klass.start_time)} – {clock(klass.end_time)}</p>
      <p className="mt-1 text-[17px] font-bold text-[#0B2A5B]">{klass.subject_code} {klass.block && <span className="text-[15px] font-semibold text-[#475569]">· {klass.block}</span>}</p>
      <p className="text-sm text-[#334155] break-words">{klass.subject_name}</p>
      <p className="text-sm text-[#64748B]">{klass.is_mine ? 'Your class' : klass.faculty_name || 'No faculty yet'}</p>
    </div>
  );
}

/** Shaped like the room card, the action box and the day's list */
function RoomSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-live="polite" aria-label="Loading room">
      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5 sm:p-6 shadow-sm">
        <Skeleton className="h-7 w-28 rounded-full" />
        <Skeleton className="mt-3 h-9 w-48 rounded-lg" />
        <Skeleton className="mt-4 h-12 w-full rounded-xl" />
      </div>
      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5 shadow-sm">
        <Skeleton className="h-14 w-full rounded-xl" />
      </div>
      <div className="rounded-2xl border border-[#E2E8F0] bg-white p-5 shadow-sm space-y-3">
        {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
      </div>
    </div>
  );
}
