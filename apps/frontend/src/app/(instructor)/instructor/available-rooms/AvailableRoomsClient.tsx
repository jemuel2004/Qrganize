'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, CheckCircle2, AlertTriangle, Loader2,
  Users, Monitor, BookOpen, CalendarDays, Building2, ArrowRight, ChevronDown, Check,
} from 'lucide-react';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import BackButton from '@/components/ui/BackButton';
import SimpleTimePicker, { type TimeSuggestion } from '@/components/ui/SimpleTimePicker';
import AnchoredPopover from '@/components/ui/AnchoredPopover';
import { dayTone } from '@/lib/dayTones';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { FiltersSkeleton, ListSkeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { useRealtime } from '@/context/RealtimeContext';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { releaseDateLabel, type ReleasedRoom } from '@/lib/roomRelease';
import RoomDetailsDialog, { type RoomSummary } from './RoomDetailsDialog';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** How long the room is needed — like a class's hours in Scheduling (minutes) */
const LENGTHS = [
  { min: 60, label: '1 hr' },
  { min: 90, label: '1½ hrs' },
  { min: 120, label: '2 hrs' },
  { min: 180, label: '3 hrs' },
];
const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const toHM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Today's weekday in Manila (the school's time); Sunday has no classes, so Monday */
function todayClassDay(): string {
  const d = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Manila' });
  return DAYS.includes(d) ? d : 'Monday';
}
/** Today in Manila: its weekday and date (room requests are for today only) */
function manilaToday(): { day: string; date: string } {
  const now = new Date();
  return {
    day: now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Manila' }),
    date: now.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }),
  };
}
const ROOM_TYPES = [
  { value: 'all',        label: 'All Types',  color: '#0B2A5B', Icon: Building2 },
  { value: 'Lecture',    label: 'Lecture',    color: '#1D5BD6', Icon: BookOpen },
  { value: 'Laboratory', label: 'Laboratory', color: '#D97706', Icon: Monitor },
];

/** One of the faculty's own class times on the chosen day (GET /api/instructor/my-classes) */
interface MyClass {
  ms_id: number;
  subject_code: string;
  subject_name: string;
  block: string;
  start_time: string;
  end_time: string;
  room_name: string | null;
  /** The parts of the subject meeting then — a Lecture followed by its Laboratory is one class time */
  parts: ('lec' | 'lab')[];
}
const partsBadge = (parts: ('lec' | 'lab')[]) => (parts.length > 1 ? 'Lecture + Lab' : parts[0] === 'lab' ? 'Laboratory' : 'Lecture');
const partsShort = (parts: ('lec' | 'lab')[]) => (parts.length > 1 ? 'Lec + Lab' : parts[0] === 'lab' ? 'Lab' : 'Lec');

interface Room {
  id: number; room_name: string; room_type: string;
  capacity: number; building: string | null;
  is_available: boolean;
  /** Today: its weekly class then was made available for today by its faculty — or wasn't
   *  checked in within 15 minutes (`unclaimed`), so it is free until `until` */
  freed?: { faculty_name: string | null; reason: string | null; unclaimed?: true; until?: string } | null;
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
  // The day starts on today; the start time stays empty until the faculty picks it.
  // Like Scheduling, only the start is picked — the end follows from the length.
  const [day,       setDay]       = useState(todayClassDay);
  const [startTime, setStartTime] = useState('');
  const [length,    setLength]    = useState(LENGTHS[0].min);
  const endTime = startTime ? toHM(toMin(startTime) + length) : '';
  /** The faculty's own classes on the chosen day — offered first in the Time picker */
  const [myClasses, setMyClasses] = useState<MyClass[]>([]);
  const loadMyClasses = useCallback((forDay: string, signal?: AbortSignal) =>
    fetch(`/api/instructor/my-classes?day=${encodeURIComponent(forDay)}`, { cache: 'no-store', signal })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && Array.isArray(d.classes)) setMyClasses(d.classes); })
      .catch(() => {}), []);
  useEffect(() => {
    const ctrl = new AbortController();
    setMyClasses([]);
    void loadMyClasses(day, ctrl.signal);
    return () => ctrl.abort();
  }, [day, loadMyClasses]);
  const suggestions: TimeSuggestion[] = myClasses.map(c => ({
    key: `${c.ms_id}-${c.start_time}`,
    start: c.start_time,
    end: c.end_time,
    title: `${c.subject_code} · ${c.block}`,
    detail: c.room_name ?? 'No room yet',
    warn: !c.room_name,
    badge: partsBadge(c.parts),
    badgeTone: c.parts.includes('lab') ? 'amber' : 'blue',
    short: `${c.subject_code} ${partsShort(c.parts)}`,
  }));
  /** The class the chosen time belongs to (when one of the faculty's classes was picked) */
  const pickedClass = startTime
    ? myClasses.find(c => c.start_time === startTime && toMin(c.end_time) - toMin(c.start_time) === length) ?? null
    : null;
  const [roomType,  setRoomType]  = useState('all');
  const [searchId,  setSearchId]  = useState(0); // replays the card entry animation per search
  /** The filters the rooms on screen belong to (the summary chip shows these); today = the day searched is today */
  const [shownFor,  setShownFor]  = useState({ day: '', start: '', end: '', today: false });
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [rooms,     setRooms]     = useState<Room[] | null>(null);
  /** Taken every week at this time, but its faculty made it available on a date */
  const [released,  setReleased]  = useState<ReleasedRoom[]>([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [searched,  setSearched]  = useState(false);
  const [booting,   setBooting]   = useState(true);
  useEffect(() => { setBooting(false); }, []);
  const showSkeleton = useMinLoading(booting || (loading && !rooms), LOADING_DELAY);
  /** Query of the rooms on screen — live updates re-run it */
  const shownQuery = useRef('');

  const handleSearch = useCallback(async () => {
    if (!day) return;
    if (!startTime) {
      setError('Choose a start time first.');
      return;
    }
    setLoading(true);
    setError(null);
    setSearched(true);
    const started = Date.now();
    try {
      const params = new URLSearchParams({ day, start_time: startTime, end_time: endTime, room_type: roomType });
      // Today: rooms freed for today count as free, reserved ones as taken — and can be requested
      const now = manilaToday();
      const isToday = day === now.day;
      if (isToday) params.set('date', now.date);
      const res = await fetch(`/api/instructor/available-rooms?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error ${res.status}`);
      }
      const json = await res.json();
      await new Promise(r => setTimeout(r, Math.max(0, 650 - (Date.now() - started))));
      setRooms(json.rooms ?? []);
      setReleased(Array.isArray(json.released) ? json.released : []);
      setShownFor({ day, start: startTime, end: endTime, today: isToday });
      setSearchId(n => n + 1);
      shownQuery.current = params.toString();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [day, startTime, endTime, roomType]);

  // Searches by itself once a start time is picked, and again whenever the day,
  // time, length or room type changes (short delay: quick taps search once)
  const filterKey = `${day}|${startTime}|${endTime}|${roomType}`;
  const lastKey = useRef(filterKey);
  useEffect(() => {
    if (lastKey.current === filterKey) return;
    lastKey.current = filterKey;
    if (!startTime) return;
    const id = window.setTimeout(() => { handleSearch(); }, 200);
    return () => window.clearTimeout(id);
  }, [filterKey, startTime, handleSearch]);

  // Live updates: rooms taken, freed or rescheduled elsewhere, and what changes with the
  // clock (a freed time opening, 15 minutes without a scan, the last 30 minutes — the
  // server's room clock announces those) — the results on screen re-check quietly
  // (no loading card, no replayed animation)
  const recheck = () => {
    // A class moved or added: the Time picker's own classes follow too
    void loadMyClasses(day);
    const query = shownQuery.current;
    if (!query) return;
    return fetch(`/api/instructor/available-rooms?${query}`)
      .then(r => (r.ok ? r.json() : null))
      .then(json => {
        if (!json || shownQuery.current !== query || !Array.isArray(json.rooms)) return;
        setRooms(json.rooms);
        setReleased(Array.isArray(json.released) ? json.released : []);
      })
      .catch(() => {});
  };
  useRealtime(['occupancy', 'schedule', 'rooms', 'room-requests'], recheck, { enabled: !loading });
  // Fallback while the server sleeps (no announcements then)
  useVisibilityAwareInterval(() => { if (!loading) void recheck(); }, 60_000);

  // Faculty only see rooms they can use — taken rooms are left out. Rooms free
  // only on a date (their faculty used "Free My Room") come first, so they are seen.
  const available = rooms?.filter(r => r.is_available) ?? [];
  const cards: { key: string; room: RoomSummary; free: ReleasedRoom | null; freed: Room['freed'] }[] = [
    ...released.map(r => ({
      key: `d-${r.room_id}-${r.date}-${r.start_time}`,
      room: { id: r.room_id, room_name: r.room_name, room_type: r.room_type, building: r.building, capacity: r.capacity },
      free: r,
      freed: null,
    })),
    ...available.map(r => ({ key: `w-${r.id}`, room: r, free: null, freed: r.freed ?? null })),
  ];
  /** The room whose details are open (with its free date, or who freed it today, when it is one of those) */
  const [details, setDetails] = useState<{ room: RoomSummary; free: ReleasedRoom | null; freed: Room['freed'] } | null>(null);

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

        {/* One calm row: Day · Time (start + how long, like Scheduling) · Room type · Search */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1fr_1.3fr_auto_auto] gap-4 items-end">
          <div>
            <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">Day</label>
            <DayPickerButton value={day} onChange={setDay} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">Time</label>
            <SimpleTimePicker
              label="Time"
              placeholder="Select time"
              value={startTime}
              onChange={v => { setStartTime(v); setError(null); }}
              lengths={LENGTHS}
              length={length}
              onLengthChange={setLength}
              suggestions={suggestions}
              suggestionsLabel={`Your classes on ${day}`}
            />
          </div>
          <div>
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
              <span className="text-[#065F46] font-semibold text-sm">{cards.length} Available</span>
            </div>
            <div className="inline-flex items-center gap-1.5 bg-white border border-[#E2E8F0] rounded-xl px-3.5 py-2 min-w-0">
              <CalendarDays className="w-3.5 h-3.5 text-[#1D5BD6] flex-shrink-0" />
              <span className="text-[#475569] font-medium text-sm break-words">
                {shownFor.day} · {fmt12(shownFor.start)} – {fmt12(shownFor.end)}
              </span>
            </div>
          </div>

          {cards.length === 0 ? (
            <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] px-6 py-10 flex flex-col items-center gap-3 text-center">
              <div className="w-12 h-12 rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-[#94A3B8]" />
              </div>
              <div>
                <p className="text-[#0B2A5B] font-semibold text-base mb-1">No free rooms</p>
                <p className="text-[#64748B] text-sm">
                  {rooms.length === 0
                    ? 'No active rooms match your filter. Try a different room type.'
                    : 'Every room is taken at this time. Try another time or room type.'}
                </p>
              </div>
            </div>
          ) : (
            <div key={searchId} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {cards.map((card, i) => {
                const { room } = card;
                const lab = room.room_type === 'Laboratory';
                return (
                  <motion.button
                    type="button"
                    key={card.key}
                    // Opens the room's details: who is using it now and whose classes meet there
                    onClick={() => setDetails({ room, free: card.free, freed: card.freed })}
                    title={`View ${room.room_name}`}
                    initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.4, 0, 0.2, 1], delay: reduceMotion ? 0 : Math.min(i, 9) * 0.05 } }}
                    whileHover={reduceMotion ? undefined : { y: -3, boxShadow: `0 16px 30px -18px ${lab ? '#D97706' : '#1D5BD6'}` }}
                    whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                    className={`group text-left bg-white border rounded-2xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-colors cursor-pointer ${
                      card.free ? 'border-[#A7F3D0] hover:border-[#6EE7B7]' : 'border-[#E2E8F0] hover:border-[#BFD3F5]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className={`w-9 h-9 rounded-xl border flex items-center justify-center flex-shrink-0 ${lab ? 'bg-[#FFFBEB] border-[#FDE68A]' : 'bg-[#EFF6FF] border-[#BFDBFE]'}`}>
                          {lab ? <Monitor className="w-4 h-4 text-[#D97706]" /> : <BookOpen className="w-4 h-4 text-[#1D5BD6]" />}
                        </div>
                        <div className="min-w-0">
                          <p className="text-base font-bold text-[#0B2A5B] leading-tight break-words">{room.room_name}</p>
                          <p className={`text-xs font-semibold mt-0.5 ${lab ? 'text-[#D97706]' : 'text-[#1D5BD6]'}`}>{room.room_type}</p>
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#059669] bg-[#ECFDF5] border border-[#A7F3D0] px-2.5 py-1 rounded-lg flex-shrink-0">
                        <CheckCircle2 className="w-3 h-3" /> {card.free ? `Free ${releaseDateLabel(card.free.date).replace(/, \d{4}$/, '')}` : 'Available'}
                      </span>
                    </div>
                    {/* Free only on that date: its class time there */}
                    {card.free && (
                      <p className="-mt-1 mb-2.5 text-[13px] font-semibold tabular-nums text-[#047857]">
                        Only {releaseDateLabel(card.free.date).replace(/, \d{4}$/, '')} · {fmt12(card.free.start_time)} – {fmt12(card.free.end_time)}
                      </p>
                    )}
                    {/* Free today because its faculty made it available, or nobody checked in for its class */}
                    {!card.free && card.freed && (
                      <p className="-mt-1 mb-2.5 text-[13px] font-semibold text-[#047857] break-words">
                        {card.freed.unclaimed && card.freed.until
                          ? `Free until ${fmt12(card.freed.until)} · not scanned`
                          : `Freed today by ${card.freed.faculty_name ?? 'its faculty'}`}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#64748B]">
                      {room.building && (
                        <span className="inline-flex items-center gap-1">
                          <Building2 className="w-3.5 h-3.5 text-[#94A3B8]" /> {room.building}
                        </span>
                      )}
                      {(room.capacity ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Users className="w-3.5 h-3.5 text-[#94A3B8]" /> Capacity: {room.capacity}
                        </span>
                      )}
                      <span className="ml-auto inline-flex items-center gap-1 text-[13px] font-semibold text-[#1D5BD6] opacity-70 group-hover:opacity-100 transition-opacity">
                        View details <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                      </span>
                    </div>
                  </motion.button>
                );
              })}
            </div>
          )}
        </>
      )}
      </PageLoadTransition>
      </div>

      <RoomDetailsDialog
        room={details?.room ?? null}
        day={shownFor.day}
        // The searched time (or, for a room free on a date, its free time) shown among the day's classes
        slot={details ? (details.free ? { start: details.free.start_time, end: details.free.end_time } : { start: shownFor.start, end: shownFor.end }) : null}
        freeOn={details?.free ?? null}
        onClose={() => setDetails(null)}
        // Room requests are for today only, and only for a room another faculty's class
        // frees for this time (Free My Room, or not checked in within 15 minutes) — with
        // the class picked in Time, so the request form opens on it. A room free on a
        // later date only can't be requested.
        onRequest={details && !details.free && details.freed && shownFor.today
          ? () => router.push(`/instructor/room-requests?room=${details.room.id}${pickedClass ? `&ms=${pickedClass.ms_id}&at=${pickedClass.start_time}` : ''}`)
          : undefined}
        requestNote={!details || details.free ? null
          : !shownFor.today ? 'Room requests are for today’s classes only.'
          : !details.freed ? 'Only rooms freed today can be requested — with Free My Room, or when a class isn’t scanned.'
          : null}
        reservationsToday={shownFor.today}
      />
    </div>
  );
}
