'use client';

/**
 * Room Monitoring — "What is happening in every room right now?"
 *
 * A live board, one card per room: who is in it now (QR check-in), how much of
 * the class is left, the next class today, and rooms whose class started with
 * no check-in. Refreshes quietly every 30 s. Built on /api/rooms/utilization
 * (today, daily) — the same data behind Room Utilization, which covers the
 * history/report side.
 */

import { useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Clock, DoorOpen, Hourglass, User, AlertTriangle, CheckCircle2 } from 'lucide-react';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { SearchInput } from '@/components/ui/SearchFilter';
import { CardSkeleton } from '@/components/ui/skeletons';
import CountFilterTabs from '@/components/ui/CountFilterTabs';
import {
  fmt12, RefreshButton, RoomIcon, useUtilization,
  type UtilRoom, type UtilRow,
} from '../room-utilization/shared';

/** Live state of a room at this moment */
type LiveStatus = 'In use' | 'Waiting' | 'No check-in' | 'Free';

/* Room identity follows the system-wide room-type colours (Room Management,
   Scheduling): Lecture = blue + book, Laboratory = amber + monitor. */
const TYPE_TONE = {
  lecture: { bar: '#1D5BD6', soft: '#EFF6FF', text: '#1D5BD6', tile: 'bg-[#EFF6FF] text-[#1D5BD6]' },
  lab:     { bar: '#F59E0B', soft: '#FFFBEB', text: '#B45309', tile: 'bg-amber-50 text-amber-600' },
};
const isLabRoom = (type: string | null | undefined) => type === 'Laboratory' || type === 'Computer Lab';

/* Live status shows in the "Now" panel: busy rooms in solid navy, Waiting in
   slate, red only for No check-in. Free rooms use their room-type tint. */
const LIVE_TONE: Record<LiveStatus, { bar: string; soft: string; text: string; label: string; dark?: boolean }> = {
  'In use':      { bar: '#0B2A5B', soft: 'linear-gradient(135deg, #0B2A5B 0%, #1E4FB8 100%)', text: '#FFFFFF', label: 'In use', dark: true },
  Waiting:       { bar: '#64748B', soft: '#EEF2F7', text: '#334155', label: 'Waiting for check-in' },
  'No check-in': { bar: '#DC2626', soft: '#FEF2F2', text: '#B91C1C', label: 'No check-in' },
  Free:          { bar: '#9DB8E8', soft: '#F2F6FD', text: '#1D5BD6', label: 'Available' },
};

const toMin = (hm: string | null) => {
  if (!hm) return -1;
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + (m || 0);
};

interface RoomNow {
  room: UtilRoom;
  status: LiveStatus;
  current: UtilRow | null;
  next: UtilRow | null;
  progress: number;      // 0..1 of the current class elapsed
  minutesLeft: number;
}

function roomNow(room: UtilRoom, rows: UtilRow[], nowMin: number): RoomNow {
  const mine = rows
    .filter(r => r.room_id === room.id && r.start)
    .sort((a, b) => toMin(a.start) - toMin(b.start));
  const current = mine.find(r => toMin(r.start) <= nowMin && nowMin < toMin(r.end)) ?? null;
  const next = mine.find(r => toMin(r.start) > nowMin) ?? null;

  let status: LiveStatus = 'Free';
  if (room.live_status === 'Occupied' || current?.status === 'Occupied') status = 'In use';
  else if (room.live_status === 'Pending' || current?.status === 'Pending') status = 'Waiting';
  else if (current?.status === 'Not Checked') status = 'No check-in';

  const s = toMin(current?.start ?? null);
  const e = toMin(current?.end ?? null);
  const progress = current && e > s ? Math.min(1, Math.max(0, (nowMin - s) / (e - s))) : 0;
  return { room, status, current, next, progress, minutesLeft: current ? Math.max(0, e - nowMin) : 0 };
}

/** "Lab-1" → "Laboratory-1", "Lec 2" → "Lecture 2"; other names unchanged. */
function displayRoomName(name: string) {
  return name
    .replace(/^lab(?![a-z])/i, 'Laboratory')
    .replace(/^lec(?![a-z])/i, 'Lecture');
}

function fmtLeft(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} hr${m ? ` ${m} min` : ''} left` : `${m} min left`;
}

/* ─── Room card ─────────────────────────────────────────────────────────── */

function RoomCard({ info, index }: { info: RoomNow; index: number }) {
  const reduceMotion = useReducedMotion();
  const { room, current, next } = info;
  const lab = isLabRoom(room.room_type);
  const type = lab ? TYPE_TONE.lab : TYPE_TONE.lecture;
  // Free rooms take their room-type tint; other states their status colour
  const tone = info.status === 'Free'
    ? { ...LIVE_TONE.Free, bar: type.bar, soft: type.soft, text: type.text }
    : LIVE_TONE[info.status];
  const cls = current ?? null;
  // Text colours inside the "Now" panel (white on the navy In-use panel)
  const ink = tone.dark
    ? { strong: '#FFFFFF', body: '#DCE6F7', track: 'rgba(255,255,255,0.22)', fill: '#FFFFFF' }
    : { strong: '#0B2A5B', body: '#334155', track: 'rgba(255,255,255,0.8)', fill: tone.bar };

  return (
    <motion.div
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1], delay: reduceMotion ? 0 : Math.min(index, 12) * 0.03 }}
      whileHover={reduceMotion ? undefined : { y: -3 }}
      className={`relative rounded-2xl border bg-white overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.05)] hover:shadow-[0_14px_28px_-16px_rgba(11,42,91,0.45)] transition-shadow ${
        info.status === 'No check-in' ? 'qr-flag-pulse border-red-300'
          : info.status === 'In use' ? 'border-[#9DB8E8]'
          : 'border-[#E2E8F0]'
      }`}
    >
      <div className="h-1.5" style={{ backgroundColor: type.bar }} />
      <div className="p-4">
        {/* Room — spelled out ("Lab-1" → "Laboratory-1"), with the room-type icon tile */}
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${type.tile}`}>
            <RoomIcon type={lab ? 'Laboratory' : 'Lecture'} className="w-[18px] h-[18px]" />
          </span>
          <div className="text-lg font-bold text-[#0B2A5B] truncate">{displayRoomName(room.room_name)}</div>
        </div>

        {/* Now */}
        <div className="mt-4 rounded-xl px-3.5 py-3" style={{ background: tone.soft }}>
          {cls ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-[15px]" style={{ color: ink.strong }}>{cls.subject_code}</span>
                {cls.component && (
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                    cls.component.toLowerCase().startsWith('lab')
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]'
                  }`}>
                    {cls.component.toLowerCase().startsWith('lab') ? 'Laboratory' : 'Lecture'}
                  </span>
                )}
                {cls.block && (
                  <span
                    className="text-[11px] font-bold px-2 py-0.5 rounded-md"
                    style={tone.dark ? { backgroundColor: 'rgba(255,255,255,0.18)', color: '#FFFFFF' } : { backgroundColor: '#1E4FB8', color: '#FFFFFF' }}
                  >
                    {cls.block}
                  </span>
                )}
              </div>
              {cls.subject_name && <div className="text-sm mt-0.5 truncate" style={{ color: ink.body }}>{cls.subject_name}</div>}
              <div className="mt-2 flex items-center justify-between gap-2 text-sm">
                <span className="inline-flex items-center gap-1.5 min-w-0" style={{ color: ink.body }}>
                  <User className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">{cls.faculty_name ?? 'No instructor'}</span>
                </span>
                <span className="inline-flex items-center gap-1 font-semibold whitespace-nowrap" style={{ color: ink.strong }}>
                  <Clock className="w-3.5 h-3.5" /> {fmt12(cls.start)}–{fmt12(cls.end)}
                </span>
              </div>
              {/* Time used / left */}
              <div className="mt-2.5">
                <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: ink.track }}>
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: ink.fill }}
                    initial={reduceMotion ? false : { width: 0 }}
                    animate={{ width: `${Math.round(info.progress * 100)}%` }}
                    transition={{ duration: reduceMotion ? 0 : 0.6, ease: [0.16, 1, 0.3, 1] }}
                  />
                </div>
                <div className="mt-1 text-xs font-semibold" style={{ color: tone.dark ? ink.body : tone.text }}>
                  {info.status === 'No check-in'
                    ? 'Class started — instructor has not scanned the room QR'
                    : info.status === 'Waiting'
                      ? 'Class started — waiting for the instructor to scan'
                      : fmtLeft(info.minutesLeft)}
                </div>
              </div>
            </>
          ) : info.status === 'In use' ? (
            <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: tone.text }}>
              <CheckCircle2 className="w-4 h-4" />
              In use{room.live_faculty ? ` by ${room.live_faculty}` : ''} (no class scheduled now)
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: tone.text }}>
              <DoorOpen className="w-4 h-4" /> Free right now
            </div>
          )}
        </div>

        {/* Next class today (only when there is one) */}
        {next && (
          <div className="mt-3 flex items-center gap-1.5 text-sm text-[#64748B] min-w-0">
            <Hourglass className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="truncate">
              Next: <span className="font-semibold text-[#0B2A5B]">{next.subject_code}</span>
              {next.block ? ` · ${next.block}` : ''} at <span className="font-semibold text-[#0B2A5B]">{fmt12(next.start)}</span>
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────── */

/** No separate No check-in filter — those rooms show first under All, with a written warning above. */
type Filter = 'all' | Exclude<LiveStatus, 'No check-in'>;

export default function RoomMonitoringClient() {
  const { data, loading, error, reload } = useUtilization('', 'daily', undefined, 30_000);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const rooms = useMemo(() => {
    if (!data) return [] as RoomNow[];
    const nowMin = toMin(data.now);
    return data.rooms.map(r => roomNow(r, data.activity, nowMin));
  }, [data]);

  const searched = rooms.filter(r => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [r.room.room_name, displayRoomName(r.room.room_name), r.room.room_type, r.room.building, r.current?.subject_code, r.current?.faculty_name, r.current?.block]
      .some(v => (v ?? '').toLowerCase().includes(q));
  });
  const count = (s: LiveStatus) => searched.filter(r => r.status === s).length;
  // Problems first, then in use, then free; by name within each
  const ORDER: Record<LiveStatus, number> = { 'No check-in': 0, Waiting: 1, 'In use': 2, Free: 3 };
  const shown = searched
    .filter(r => filter === 'all' || r.status === filter)
    .sort((a, b) => ORDER[a.status] - ORDER[b.status]
      || a.room.room_name.localeCompare(b.room.room_name, undefined, { numeric: true }));

  const noCheckIn = count('No check-in');

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <div className="mb-2 flex items-center justify-between gap-4">
        <BackButton />
        <RefreshButton onRefresh={reload} loading={loading} />
      </div>
      <div className="mt-4 sm:mt-7 mb-8">
        <WatermarkTitle>Room Monitoring</WatermarkTitle>
      </div>

      {/* Live strip */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#E2E8F0] bg-white px-5 py-3.5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="relative flex w-3 h-3">
            <span className="absolute inline-flex w-full h-full rounded-full bg-[#1D5BD6] opacity-50 animate-ping" />
            <span className="relative inline-flex w-3 h-3 rounded-full bg-[#1D5BD6]" />
          </span>
          <div>
            <div className="text-base font-bold text-[#0B2A5B]">
              Live — {data ? fmt12(data.now) : '…'}
            </div>
            <div className="text-xs text-[#64748B]">
              {data?.term.semester ? `${data.term.semester} · A.Y. ${data.term.school_year} · ` : ''}Updates every 30 seconds
            </div>
          </div>
        </div>
        <div className="w-full sm:w-72">
          <SearchInput value={search} onChange={setSearch} placeholder="Search room, subject, faculty…" />
        </div>
      </div>

      {/* Written warning, not only colour */}
      <AnimatePresence initial={false}>
        {noCheckIn > 0 && (
          <motion.div
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mb-5 flex items-start gap-3 rounded-xl border-2 border-red-300 border-l-[6px] border-l-red-600 bg-red-50 px-4 py-3">
              <AlertTriangle className="w-5 h-5 flex-shrink-0 text-red-600 mt-0.5" />
              <p className="text-sm text-red-800">
                <strong>{noCheckIn} room{noCheckIn !== 1 ? 's have' : ' has'} a class in progress with no check-in.</strong>{' '}
                The instructor has not scanned the room QR code — they may be absent or in a different room.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <CountFilterTabs
        className="mb-5"
        label="Filter rooms by status"
        layoutId="room-monitoring-filter"
        value={filter}
        onChange={setFilter}
        options={[
          { key: 'all', label: 'All rooms', count: searched.length, color: '#0B2A5B' },
          { key: 'In use', label: 'In use', count: count('In use'), color: '#0B2A5B', dot: '#0B2A5B' },
          { key: 'Free', label: 'Available', count: count('Free'), color: '#1E4FB8', dot: LIVE_TONE.Free.bar },
          { key: 'Waiting', label: 'Waiting', count: count('Waiting'), color: LIVE_TONE.Waiting.bar, dot: LIVE_TONE.Waiting.bar },
        ]}
      />

      {error && (
        <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {!data && loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4" role="status" aria-label="Loading rooms">
          {Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} className="min-h-[220px]" />)}
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-2xl border border-[#E2E8F0] bg-white px-6 py-14 text-center text-sm font-semibold text-[#64748B]">
          {rooms.length === 0 ? 'No rooms yet — add them in Room Management.' : 'No rooms match this filter.'}
        </div>
      ) : (
        <motion.div layout className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          <AnimatePresence mode="popLayout" initial={false}>
            {shown.map((info, i) => <RoomCard key={info.room.id} info={info} index={i} />)}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}
