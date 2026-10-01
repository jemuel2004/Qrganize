'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, CheckCircle2, XCircle, AlertTriangle, Loader2,
  Users, Monitor, BookOpen, CalendarDays, Building2, ArrowRight, ChevronDown, Check,
} from 'lucide-react';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import BackButton from '@/components/ui/BackButton';
import SimpleTimePicker from '@/components/ui/SimpleTimePicker';
import AnchoredPopover from '@/components/ui/AnchoredPopover';
import { dayTone } from '@/lib/dayTones';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { FiltersSkeleton, ListSkeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { useRealtime } from '@/context/RealtimeContext';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ROOM_TYPES = [
  { value: 'all',        label: 'All Types',  color: '#0B2A5B', Icon: Building2 },
  { value: 'Lecture',    label: 'Lecture',    color: '#1D5BD6', Icon: BookOpen },
  { value: 'Laboratory', label: 'Laboratory', color: '#D97706', Icon: Monitor },
];

interface ConflictInfo {
  subject_code: string; subject_name: string;
  block_name: string; year_level: string; program_code: string;
  faculty_name: string | null; start_time: string; end_time: string;
}
interface OccupancyInfo { status: string; faculty_name: string; }
interface Room {
  id: number; room_name: string; room_type: string;
  capacity: number; building: string | null;
  is_available: boolean;
  occupancy: OccupancyInfo | null;
  schedule_conflict: ConflictInfo | null;
}

function fmt12(t: string): string {
  const [hStr, mStr] = t.split(':');
  const h = parseInt(hStr);
  return `${h > 12 ? h - 12 : h === 0 ? 12 : h}:${mStr} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** Day picker: one button; the six days (timetable colours) open in a small pop-up */
function DayPickerButton({ value, onChange }: { value: string; onChange: (d: string) => void }) {
  const reduceMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const tone = dayTone(value);
  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`w-full h-12 px-4 rounded-xl border bg-white flex items-center gap-2.5 text-left transition-colors ${
          open ? 'border-[#1D5BD6] ring-2 ring-[#1D5BD6]/15' : 'border-[#D6E0EF] hover:border-[#9DB8E8]'
        }`}
      >
        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: tone.bar }} />
        <span className="flex-1 text-[15px] font-semibold text-[#0B2A5B]">{value}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.25 }} className="text-[#64748B]">
          <ChevronDown className="w-4 h-4" />
        </motion.span>
      </motion.button>
      <AnchoredPopover open={open} onClose={close} anchorRef={triggerRef} panelRef={panelRef} width={260} maxHeight={380} label="Day"
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
        <div className="p-2">
          {DAYS.map(d => {
            const t = dayTone(d);
            const on = d === value;
            return (
              <button
                key={d}
                type="button"
                onClick={() => { onChange(d); setOpen(false); }}
                className="w-full flex items-center gap-3 px-3 h-11 rounded-lg text-[15px] font-semibold transition-colors hover:bg-[#F4F7FC]"
                style={on ? { backgroundColor: t.bg, color: t.text } : { color: '#0B2A5B' }}
              >
                <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.bar }} />
                {d}
                {on && <Check className="w-4 h-4 ml-auto" />}
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </>
  );
}

export default function AvailableRoomsClient() {
  const [day,       setDay]       = useState('Monday');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime,   setEndTime]   = useState('09:00');
  const [roomType,  setRoomType]  = useState('all');
  const [searchId,  setSearchId]  = useState(0); // replays the card entry animation per search
  /** The filters the rooms on screen belong to (the summary chip shows these) */
  const [shownFor,  setShownFor]  = useState({ day: '', start: '', end: '' });
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [rooms,     setRooms]     = useState<Room[] | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [searched,  setSearched]  = useState(false);
  const [booting,   setBooting]   = useState(true);
  useEffect(() => { setBooting(false); }, []);
  const showSkeleton = useMinLoading(booting || (loading && !rooms), LOADING_DELAY);
  /** Query of the rooms on screen — live updates re-run it */
  const shownQuery = useRef('');

  const handleSearch = useCallback(async () => {
    if (!day || !startTime || !endTime) return;
    if (startTime >= endTime) {
      setError('End time must be after start time.');
      return;
    }
    setLoading(true);
    setError(null);
    setSearched(true);
    const started = Date.now();
    try {
      const params = new URLSearchParams({ day, start_time: startTime, end_time: endTime, room_type: roomType });
      const res = await fetch(`/api/instructor/available-rooms?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error ${res.status}`);
      }
      const json = await res.json();
      await new Promise(r => setTimeout(r, Math.max(0, 650 - (Date.now() - started))));
      setRooms(json.rooms ?? []);
      setShownFor({ day, start: startTime, end: endTime });
      setSearchId(n => n + 1);
      shownQuery.current = params.toString();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [day, startTime, endTime, roomType]);

  // After a search, changing the day, time or room type re-runs it (with the
  // loading card) so the rooms shown always match the filters. Short delay so
  // a start change that also moves the end time triggers only one search.
  const filterKey = `${day}|${startTime}|${endTime}|${roomType}`;
  const lastKey = useRef(filterKey);
  useEffect(() => {
    if (lastKey.current === filterKey) return;
    lastKey.current = filterKey;
    if (!searched) return;
    const id = window.setTimeout(() => { handleSearch(); }, 200);
    return () => window.clearTimeout(id);
  }, [filterKey, searched, handleSearch]);

  // Live updates: rooms taken, freed or rescheduled elsewhere — the results on
  // screen re-check quietly (no loading card, no replayed animation)
  useRealtime(['occupancy', 'schedule', 'rooms', 'room-requests'], () => {
    const query = shownQuery.current;
    if (!query) return;
    return fetch(`/api/instructor/available-rooms?${query}`)
      .then(r => (r.ok ? r.json() : null))
      .then(json => { if (json && shownQuery.current === query && Array.isArray(json.rooms)) setRooms(json.rooms); })
      .catch(() => {});
  }, { enabled: !loading });

  const available   = rooms?.filter(r => r.is_available)   ?? [];
  const unavailable = rooms?.filter(r => !r.is_available)  ?? [];

  return (
    <div className="min-h-full p-4 sm:p-6 lg:p-8 overflow-x-hidden min-w-0">
      <div className="lg:max-w-6xl lg:mx-auto">
      {/* ── Header ────────────────────────────────────────────────── */}
      <div className="mb-6">
        <BackButton />
        <div className="mt-2 lg:mt-5">
          <WatermarkTitle>Find Available Rooms</WatermarkTitle>
        </div>
      </div>

      {/* ── Filter panel ──────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-4 sm:p-6 mb-5 min-w-0">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 bg-[#EFF6FF] rounded-lg flex items-center justify-center">
            <Search className="w-3.5 h-3.5 text-[#1D5BD6]" />
          </div>
          <span className="font-semibold text-[#0B2A5B] text-sm">Search Filters</span>
        </div>

        {/* One calm row: Day · From · To · Room type · Search */}
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-[1fr_1fr_1fr_auto_auto] gap-4 items-end">
          <div>
            <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">Day</label>
            <DayPickerButton value={day} onChange={setDay} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">From</label>
            <SimpleTimePicker label="From" value={startTime} onChange={v => {
              setStartTime(v);
              // keep the end after the start (default: one hour later)
              if (endTime <= v) { const [h, m] = v.split(':').map(Number); setEndTime(`${String(Math.min(21, h + 1)).padStart(2, '0')}:${String(h + 1 > 21 ? 0 : m).padStart(2, '0')}`); }
            }} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">To</label>
            <SimpleTimePicker label="To" value={endTime} onChange={setEndTime} after={startTime} />
          </div>
          <div className="sm:col-span-2 lg:col-span-1">
            <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">Room Type</label>
            <div className="flex h-12 p-1 rounded-xl bg-[#F1F5F9] border border-[#E2E8F0]" role="radiogroup" aria-label="Room type">
              {ROOM_TYPES.map(rt => {
                const on = roomType === rt.value;
                return (
                  <button
                    key={rt.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setRoomType(rt.value)}
                    className={`relative flex-1 px-3 rounded-lg text-[14px] font-semibold inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors ${on ? '' : 'text-[#475569] hover:text-[#0B2A5B]'}`}
                    style={on ? { color: '#FFFFFF' } : undefined}
                  >
                    {on && (
                      <motion.span layoutId="room-type-pill" className="absolute inset-0 rounded-lg shadow-sm" style={{ backgroundColor: rt.color }}
                        transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.4, 0, 0.2, 1] }} />
                    )}
                    <rt.Icon className="relative w-4 h-4" style={on ? undefined : { color: rt.color }} />
                    <span className="relative">{rt.value === 'all' ? 'All' : rt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <motion.button
            type="button"
            onClick={handleSearch}
            disabled={loading}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            className="sm:col-span-1 inline-flex items-center justify-center gap-2 w-full lg:w-auto h-12 bg-[#1D5BD6] hover:bg-[#164BB5] disabled:cursor-wait font-semibold px-6 rounded-xl text-[15px] transition-colors shadow-lg shadow-[#1D5BD6]/25"
            style={{ color: '#FFFFFF' }}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            {loading ? 'Searching…' : 'Search'}
          </motion.button>
        </div>
      </div>

      <AnimatePresence>
        {loading && (
          <motion.div
            key="searching"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.25 } }}
            exit={{ opacity: 0, transition: { duration: 0.25 } }}
            className="fixed inset-x-0 bottom-0 top-[72px] z-30 flex items-center justify-center"
            style={{ backgroundColor: 'rgba(11, 42, 91, 0.08)' }}
            role="status" aria-live="polite"
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, scale: 0.94, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.3, ease: [0.4, 0, 0.2, 1] } }}
              className="flex items-center gap-3 px-6 py-4 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl"
            >
              <span className="w-6 h-6 border-[3px] border-[#1D5BD6]/25 border-t-[#1D5BD6] rounded-full animate-spin" aria-hidden />
              <span className="text-[15px] font-semibold text-[#0B2A5B]">Searching rooms…</span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Error ─────────────────────────────────────────────────── */}
      {error && (
        <div className="bg-white border border-[#FECACA] text-[#DC2626] rounded-2xl px-4 py-3 mb-5 flex items-center gap-3 text-sm shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <PageLoadTransition
        showSkeleton={showSkeleton}
        skeleton={
          <div className="space-y-4">
            <FiltersSkeleton fields={3} />
            <ListSkeleton rows={6} />
          </div>
        }
      >
      {/* ── Initial state (no search yet) ─────────────────────────── */}
      {!searched && (
        <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] px-6 py-10 text-center">
          <p className="text-[#64748B] text-sm">No rooms to display.</p>
        </div>
      )}

      {/* ── Results ───────────────────────────────────────────────── */}
      {rooms && (
        <>
          <div className="flex flex-wrap gap-2.5 mb-5">
            <div className="inline-flex items-center gap-1.5 bg-[#ECFDF5] border border-[#A7F3D0] rounded-xl px-3.5 py-2">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#059669]" />
              <span className="text-[#065F46] font-semibold text-sm">{available.length} Available</span>
            </div>
            <div className="inline-flex items-center gap-1.5 bg-[#FEF2F2] border border-[#FECACA] rounded-xl px-3.5 py-2">
              <XCircle className="w-3.5 h-3.5 text-[#DC2626]" />
              <span className="text-[#991B1B] font-semibold text-sm">{unavailable.length} Unavailable</span>
            </div>
            <div className="inline-flex items-center gap-1.5 bg-white border border-[#E2E8F0] rounded-xl px-3.5 py-2 min-w-0">
              <CalendarDays className="w-3.5 h-3.5 text-[#1D5BD6] flex-shrink-0" />
              <span className="text-[#475569] font-medium text-sm break-words">
                {shownFor.day} · {fmt12(shownFor.start)} – {fmt12(shownFor.end)}
              </span>
            </div>
          </div>

          {rooms.length === 0 ? (
            <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] px-6 py-10 flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-[#94A3B8]" />
              </div>
              <div>
                <p className="text-[#0B2A5B] font-semibold text-base mb-1">No rooms found</p>
                <p className="text-[#64748B] text-sm">No active rooms match your filter. Try a different room type.</p>
              </div>
            </div>
          ) : (
            <div key={searchId} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {available.map((room, i) => (
                <motion.button
                  type="button"
                  key={room.id}
                  onClick={() => router.push(`/instructor/room-requests?room=${room.id}`)}
                  title={`Request ${room.room_name}`}
                  initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1], delay: reduceMotion ? 0 : Math.min(i, 9) * 0.05 } }}
                  whileHover={reduceMotion ? undefined : { y: -3, boxShadow: `0 16px 30px -18px ${room.room_type === 'Laboratory' ? '#D97706' : '#1D5BD6'}` }}
                  whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                  className="group text-left bg-white border border-[#E2E8F0] hover:border-[#BFD3F5] rounded-2xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-colors cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${room.room_type === 'Laboratory' ? 'bg-[#FFFBEB] border-[#FDE68A]' : 'bg-[#EFF6FF] border-[#BFDBFE]'}`}>
                        {room.room_type === 'Laboratory'
                          ? <Monitor className="w-4 h-4 text-[#D97706]" />
                          : <BookOpen className="w-4 h-4 text-[#1D5BD6]" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-base font-bold text-[#0B2A5B] leading-tight break-words">{room.room_name}</p>
                        <p className={`text-xs font-semibold mt-0.5 ${room.room_type === 'Laboratory' ? 'text-[#D97706]' : 'text-[#1D5BD6]'}`}>{room.room_type}</p>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#059669] bg-[#ECFDF5] border border-[#A7F3D0] px-2.5 py-1 rounded-lg flex-shrink-0">
                      <CheckCircle2 className="w-3 h-3" /> Available
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#64748B]">
                    {room.building && (
                      <span className="inline-flex items-center gap-1">
                        <Building2 className="w-3.5 h-3.5 text-[#94A3B8]" /> {room.building}
                      </span>
                    )}
                    {room.capacity > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Users className="w-3.5 h-3.5 text-[#94A3B8]" /> Capacity: {room.capacity}
                      </span>
                    )}
                    <span className="ml-auto inline-flex items-center gap-1 text-[13px] font-semibold text-[#1D5BD6] opacity-70 group-hover:opacity-100 transition-opacity">
                      Request <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </motion.button>
              ))}

              {unavailable.map((room, i) => (
                <motion.div
                  key={room.id}
                  initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1], delay: reduceMotion ? 0 : Math.min(available.length + i, 9) * 0.05 } }}
                  className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-9 h-9 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] flex items-center justify-center flex-shrink-0">
                        {room.room_type === 'Laboratory'
                          ? <Monitor className="w-4 h-4 text-[#94A3B8]" />
                          : <BookOpen className="w-4 h-4 text-[#94A3B8]" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-base font-bold text-[#475569] leading-tight break-words">{room.room_name}</p>
                        <p className="text-xs text-[#94A3B8] font-semibold mt-0.5">{room.room_type}</p>
                      </div>
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#DC2626] bg-[#FEF2F2] border border-[#FECACA] px-2.5 py-1 rounded-lg flex-shrink-0">
                      <XCircle className="w-3 h-3" /> Unavailable
                    </span>
                  </div>

                  {room.occupancy && (
                    <div className="mt-2 flex items-start gap-2 bg-[#FEF2F2] border border-[#FECACA] rounded-xl px-3 py-2">
                      <AlertTriangle className="w-3.5 h-3.5 text-[#DC2626] flex-shrink-0 mt-0.5" />
                      <div className="text-xs text-[#991B1B]">
                        <span className="font-semibold">
                          {room.occupancy.status === 'Occupied' ? 'Currently Occupied' : 'Reserved'}
                        </span>
                        {room.occupancy.faculty_name && (
                          <span className="text-[#B91C1C]"> by {room.occupancy.faculty_name}</span>
                        )}
                      </div>
                    </div>
                  )}
                  {room.schedule_conflict && (
                    <div className="mt-2 flex items-start gap-2 bg-[#FFFBEB] border border-[#FDE68A] rounded-xl px-3 py-2 min-w-0">
                      <CalendarDays className="w-3.5 h-3.5 text-[#D97706] flex-shrink-0 mt-0.5" />
                      <div className="text-xs text-[#92400E] min-w-0">
                        <span className="font-semibold">Scheduled class</span>
                        <span className="break-words">
                          {' '}— {room.schedule_conflict.subject_code}: {room.schedule_conflict.program_code} {room.schedule_conflict.year_level}{room.schedule_conflict.block_name}
                        </span>
                        <div className="text-[#A16207] mt-0.5 break-words">
                          {fmt12(room.schedule_conflict.start_time)} – {fmt12(room.schedule_conflict.end_time)}
                          {room.schedule_conflict.faculty_name && ` · ${room.schedule_conflict.faculty_name}`}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-[#64748B]">
                    {room.building && (
                      <span className="inline-flex items-center gap-1">
                        <Building2 className="w-3.5 h-3.5 text-[#94A3B8]" /> {room.building}
                      </span>
                    )}
                    {room.capacity > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Users className="w-3.5 h-3.5 text-[#94A3B8]" /> Capacity: {room.capacity}
                      </span>
                    )}
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </>
      )}
      </PageLoadTransition>
      </div>
    </div>
  );
}
