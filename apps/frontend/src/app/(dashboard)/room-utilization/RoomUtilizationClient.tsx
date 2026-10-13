'use client';

/**
 * Room Utilization — "Are the rooms actually being used as scheduled?"
 * Two parts, switched at the top:
 *
 * Room Usage (date-based)
 *  • Filters: Date (centred calendar) · Room · Refresh, then View
 *    (Daily / Weekly / Monthly) and Room Type buttons
 *  • Daily — "What's happening now?": status cards In use · Available · Not
 *    scanned (each filters the list), then Room Activity across the whole
 *    width (today: classes going on now first). View opens a room's history.
 *  • Weekly / Monthly — "Were the booked rooms used?": a pie of classes
 *    scanned vs. not scanned, and the rooms with missed scans (CheckinSummary)
 *  • "Scanned" = the class's own faculty scanned its room's QR code (the words
 *    the user asked for instead of "checked in")
 *  • Text 15px and up, plain words, counts instead of hours (older users)
 *
 * Room Planning (term-based — its own filters: term, day, time, room type)
 *  • Whether each kind of room (lecture rooms, laboratories, PATHFIT venues)
 *    is enough: rooms needed at once vs. usable rooms, hour by hour; classes
 *    without a suitable room; more rooms now and once every class is
 *    scheduled (an estimate) — schedule-based, not QR (RoomPlanning.tsx)
 */

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useReducedMotion } from 'framer-motion';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import CalendarModal from '@/components/ui/CalendarModal';
import FriendlySelect from '@/components/ui/FriendlySelect';
import CountFilterTabs from '@/components/ui/CountFilterTabs';
import { CardSkeleton, ListSkeleton } from '@/components/ui/skeletons';
import { useSkeletonRefresh } from '@/hooks/useSkeletonRefresh';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import {
  BookOpen, Building2, Check, ChevronRight, DoorClosed, DoorOpen, Eye, Hourglass, Monitor, X,
} from 'lucide-react';
import Pagination from '@/components/ui/Pagination';
import {
  AnimatePresence, AutoHeight, DateButton, EASE, fmt12, fmtDate, motion, rangeLabel, RefreshButton, RoomIcon,
  ROOM_LABEL, ROOM_TONE, roomStatusFor, RowStatusPill, useApplyingDate, useUtilization,
  type RoomStatus, type UtilRow, type View,
} from './shared';
import CheckinSummary, { type MissedRoom } from './CheckinSummary';
import RoomPlanningSection from './RoomPlanning';
import type { RoomPool } from '@shared/roomPlanning';

type CardFilter = 'Occupied' | 'Available' | 'PendingNoScan' | null;
/** The page's two parts: day-to-day room use, and term-based room planning */
type Section = 'usage' | 'planning';
type TypeTab = 'all' | 'Lecture' | 'Laboratory';

/** Label above each filter — 15px, normal case (easy to read) */
const RU_LABEL = 'block text-sm font-semibold text-[#334155] mb-1.5';
const isLab = (type: string) => type === 'Laboratory' || type === 'Computer Lab';

/* ─── Status card ───────────────────────────────────────────────────────── */

function StatCard({ icon, label, value, total, pct, tone, active, onClick }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; total: string; pct: number;
  tone: { bar: string; soft: string; text: string }; active?: boolean; onClick?: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const Tag = onClick ? motion.button : motion.div;
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      title={onClick ? (active ? 'Show every room again' : `Show only rooms that are ${label.toLowerCase()} in Room Activity`) : undefined}
      whileHover={onClick && !reduceMotion ? { y: -2 } : undefined}
      whileTap={onClick && !reduceMotion ? { scale: 0.98 } : undefined}
      className={`qr-stat-tint relative overflow-hidden text-left rounded-2xl border p-5 w-full min-w-0 transition-[border-color,box-shadow] duration-300 ${
        active ? 'shadow-[0_10px_24px_-14px_rgba(29,91,214,0.6)]' : 'shadow-[0_2px_8px_-4px_rgba(11,42,91,0.12)]'
      } ${onClick ? 'cursor-pointer' : ''}`}
      // A light wash of the status colour so the card stands off the white page
      style={{
        background: `linear-gradient(135deg, ${tone.soft} 0%, #FFFFFF 72%)`,
        borderColor: active ? tone.bar : `${tone.bar}40`,
        ...(active ? { boxShadow: `0 0 0 3px ${tone.bar}33` } : {}),
      }}
    >
      <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: tone.bar }} aria-hidden="true" />
      {/* Chosen as the Room Activity filter */}
      <AnimatePresence>
        {active && (
          <motion.span
            key="on"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: 0.25, ease: EASE } }}
            exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.15 } }}
            className="absolute top-3.5 right-3.5 inline-flex items-center gap-1 text-sm font-bold px-2.5 py-0.5 rounded-full"
            style={{ backgroundColor: tone.bar, color: '#FFFFFF' }}
          >
            <Check className="w-3.5 h-3.5" style={{ color: '#FFFFFF' }} /> Showing
          </motion.span>
        )}
      </AnimatePresence>
      <div className="flex items-center gap-4">
        <span className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-white shadow-[0_2px_6px_-2px_rgba(11,42,91,0.15)]" style={{ color: tone.bar }}>
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-base font-semibold text-[#334155]">{label}</p>
          <p className="mt-0.5 flex items-baseline gap-1.5 tabular-nums">
            <span className="text-[32px] font-bold leading-none text-[#0B2A5B]">{value}</span>
            <span className="text-[15px] font-medium text-[#64748B]">{total}</span>
          </p>
        </div>
      </div>
      {/* The share of rooms as a bar — the number above already says it, so no % */}
      <div className="mt-4 h-2 rounded-full bg-[#EEF2F8] overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: tone.bar }}
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.6, ease: EASE }}
        />
      </div>
    </Tag>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────── */

export default function RoomUtilizationClient({ initialSection = 'usage', initialPool }: {
  initialSection?: Section;
  /** Room Planning opens on this kind of room */
  initialPool?: RoomPool;
}) {
  const reduceMotion = useReducedMotion();
  const [date, setDate] = useState('');            // '' = today (server clock)
  const [view, setView] = useState<View>('daily');
  const [roomFilter, setRoomFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [card, setCard] = useState<CardFilter>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [section, setSection] = useState<Section>(initialSection);

  const { data, loading, error, reload } = useUtilization(date, view);
  const [applying, startApplying, applied] = useApplyingDate(loading, () => setCalOpen(false));
  // Refresh button: the cards and lists reload behind their skeletons (live updates stay quiet)
  const { refreshing, refresh } = useSkeletonRefresh(reload);
  const showSkeleton = useMinLoading((loading && !data) || refreshing, PAGE_SKELETON_MIN_MS);

  const liveDay = !!data && data.view === 'daily' && data.date === data.today;

  const rooms = useMemo(() => (data?.rooms ?? [])
    .filter(r => !roomFilter || String(r.id) === roomFilter)
    .filter(r => !typeFilter || r.room_type === typeFilter || (typeFilter === 'Laboratory' && r.room_type === 'Computer Lab')),
  [data, roomFilter, typeFilter]);

  /* Room Type buttons — every active room, whichever type is chosen */
  const typeCounts = useMemo(() => {
    const all = data?.rooms ?? [];
    return {
      all: all.length,
      Lecture: all.filter(r => r.room_type === 'Lecture').length,
      Laboratory: all.filter(r => isLab(r.room_type)).length,
    };
  }, [data]);
  const typeTab = (typeFilter || 'all') as TypeTab;

  const statusOf = useMemo(() => {
    const m = new Map<number, RoomStatus>();
    for (const r of rooms) m.set(r.id, roomStatusFor(r, data?.activity ?? [], liveDay));
    return m;
  }, [rooms, data, liveDay]);

  const counts = useMemo(() => {
    const c = { Occupied: 0, Available: 0, Pending: 0, 'No Scan': 0 } as Record<RoomStatus, number>;
    statusOf.forEach(s => { c[s] += 1; });
    return c;
  }, [statusOf]);
  const total = rooms.length;
  const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);

  const inCard = (s: RoomStatus) =>
    !card || (card === 'PendingNoScan' ? s === 'Pending' || s === 'No Scan' : s === card);

  /* Activity rows (+ a placeholder row for a filtered room with no classes) */
  const rows = useMemo(() => {
    const roomIds = new Set(rooms.filter(r => inCard(statusOf.get(r.id) ?? 'Available')).map(r => r.id));
    const list: (UtilRow & { placeholder?: boolean })[] = (data?.activity ?? []).filter(a => roomIds.has(a.room_id));
    if (card && (data?.activity.length ?? 0) > 0) {
      for (const r of rooms) {
        if (!roomIds.has(r.id) || list.some(a => a.room_id === r.id)) continue;
        list.push({
          key: `ph-${r.id}`, date: data?.date ?? '', day: '', room_id: r.id, room_name: r.room_name, room_type: r.room_type,
          subject_code: null, subject_name: null, component: null, block: null, faculty_id: null,
          faculty_name: r.live_faculty, start: null, end: null, scan_time: null, late: false,
          status: 'Upcoming', hours_scheduled: 0, hours_used: 0, placeholder: true,
        });
      }
    }
    // Today: classes going on now first, then the ones still to come, then the finished ones
    if (liveDay) {
      const rank = (r: UtilRow & { placeholder?: boolean }) =>
        r.placeholder ? 3 : r.status === 'Occupied' || r.status === 'Pending' ? 0 : r.status === 'Upcoming' ? 1 : 2;
      list.sort((a, b) => rank(a) - rank(b) || (a.start ?? '').localeCompare(b.start ?? '')
        || a.room_name.localeCompare(b.room_name, undefined, { numeric: true }));
    }
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, rooms, statusOf, card, liveDay]);

  const pageSize = 10;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageRows = rows.slice(safePage * pageSize, safePage * pageSize + pageSize);

  /* Weekly / Monthly: booked classes that already started — scanned or not — and
     the rooms with missed scans (walk-ins and classes still to come don't count) */
  const checkins = useMemo(() => {
    const shown = new Set(rooms.map(r => r.id));
    const byRoom = new Map<number, { held: number; missed: number }>();
    let checked = 0;
    let missed = 0;
    for (const a of data?.activity ?? []) {
      if (!shown.has(a.room_id) || !a.subject_code) continue;
      const isIn = a.status === 'Completed' || a.status === 'Occupied';
      const isMissed = a.status === 'Not Checked';
      if (!isIn && !isMissed) continue;
      if (isIn) checked += 1; else missed += 1;
      const m = byRoom.get(a.room_id) ?? { held: 0, missed: 0 };
      m.held += 1;
      if (isMissed) m.missed += 1;
      byRoom.set(a.room_id, m);
    }
    const missedRooms: MissedRoom[] = rooms
      .map(r => ({ room: r, ...(byRoom.get(r.id) ?? { held: 0, missed: 0 }) }))
      .filter(x => x.missed > 0)
      .sort((a, b) => b.missed - a.missed || b.missed / b.held - a.missed / a.held
        || a.room.room_name.localeCompare(b.room.room_name, undefined, { numeric: true }));
    return { checked, missed, missedRooms };
  }, [data, rooms]);

  const resetPage = () => setPage(0);
  const toggleCard = (c: CardFilter) => { setCard(cur => (cur === c ? null : c)); resetPage(); };
  const viewQs = (roomId: number, extra: Record<string, string> = {}) =>
    `/room-utilization/${roomId}?${new URLSearchParams({ date: data?.date ?? '', view, ...extra })}`;
  const daily = view === 'daily';

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0 space-y-5">
      {/* Header — watermark title like the other sections */}
      <div>
        <div className="flex items-center justify-between gap-3">
          <BackButton />
          <AnimatePresence>
            {liveDay && (
              <motion.span
                key="live"
                initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } }}
                exit={{ opacity: 0, transition: { duration: 0.2 } }}
                className="inline-flex items-center gap-2 text-sm font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-3.5 py-1.5"
              >
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" /> Live · {fmt12(data?.now ?? null)}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <div className="mt-4 sm:mt-7 mb-4">
          <WatermarkTitle>Room Utilization</WatermarkTitle>
        </div>
      </div>

      {/* Two parts of the page: rooms in use (date-based) · room planning (term-based) */}
      <CountFilterTabs
        label="Room Utilization section"
        layoutId="room-utilization-section"
        value={section}
        onChange={setSection}
        options={[
          { key: 'usage', label: 'Room Usage', color: '#0B2A5B', icon: <DoorOpen className="w-4 h-4" /> },
          { key: 'planning', label: 'Room Planning', color: '#0B2A5B', icon: <Building2 className="w-4 h-4" /> },
        ]}
      />

      <AnimatePresence mode="wait" initial={false}>
      {section === 'usage' ? (
      <motion.div
        key="usage"
        initial={reduceMotion ? false : { opacity: 0, x: -16 }}
        animate={{ opacity: 1, x: 0, transition: { duration: 0.35, ease: EASE } }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -16, transition: { duration: 0.2, ease: EASE } }}
        className="space-y-5 min-w-0"
      >
      {/* Filters — when (date, view) · which rooms (room, type) */}
      <div className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] p-4 sm:p-5 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-4 items-end">
          <div className="min-w-0">
            <p className={RU_LABEL}>Date</p>
            <DateButton className="!h-12 text-[15px]" label={data ? rangeLabel(view, data.date, data.range) : '…'} onClick={() => setCalOpen(true)} />
          </div>
          <div className="min-w-0">
            <p className={RU_LABEL}>Room</p>
            <FriendlySelect
              value={roomFilter}
              onChange={v => { setRoomFilter(v); resetPage(); }}
              label="Room"
              searchable
              searchPlaceholder="Type a room…"
              minPanelWidth={300}
              options={[
                { value: '', label: 'All Rooms' },
                ...(data?.rooms ?? []).map(r => ({ value: String(r.id), label: r.room_name, hint: r.room_type })),
              ]}
            />
          </div>
          <RefreshButton className="!h-12" overlay={false} onRefresh={refresh} loading={refreshing || showSkeleton} />
        </div>
        <div className="flex flex-col lg:flex-row lg:items-end gap-4 lg:gap-8 pt-4 border-t border-[#EEF2F7]">
          <div className="min-w-0">
            <p className={RU_LABEL}>View</p>
            <CountFilterTabs<View>
              label="View"
              layoutId="room-utilization-view"
              value={view}
              onChange={v => { setView(v); setCard(null); resetPage(); }}
              options={[
                { key: 'daily', label: 'Daily', color: '#0B2A5B' },
                { key: 'weekly', label: 'Weekly', color: '#0B2A5B' },
                { key: 'monthly', label: 'Monthly', color: '#0B2A5B' },
              ]}
            />
          </div>
          <div className="min-w-0">
            <p className={RU_LABEL}>Room Type</p>
            <CountFilterTabs<TypeTab>
              label="Room type"
              layoutId="room-utilization-type"
              value={typeTab}
              onChange={k => { setTypeFilter(k === 'all' ? '' : k); resetPage(); }}
              options={[
                { key: 'all', label: 'All', count: typeCounts.all, color: '#0B2A5B' },
                { key: 'Lecture', label: 'Lecture', count: typeCounts.Lecture, color: '#1D5BD6', icon: <BookOpen className="w-4 h-4" /> },
                { key: 'Laboratory', label: 'Laboratory', count: typeCounts.Laboratory, color: '#B45309', icon: <Monitor className="w-4 h-4" /> },
              ]}
            />
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <PageLoadTransition
        showSkeleton={showSkeleton}
        skeleton={daily ? (
          // Status cards, then the room list — the same shape as the page
          <div className="space-y-5" role="status" aria-label="Loading room utilization">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
              {[0, 1, 2].map(i => <CardSkeleton key={i} className="h-[140px] rounded-2xl" />)}
            </div>
            <ListSkeleton rows={6} />
          </div>
        ) : (
          // The pie card beside the rooms list
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-5" role="status" aria-label="Loading scans">
            <CardSkeleton className="h-[420px] rounded-2xl" />
            <CardSkeleton className="h-[420px] rounded-2xl" />
          </div>
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
        {daily ? (
        <motion.div
          key="day"
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, transition: { duration: 0.25, ease: EASE } }}
          className="space-y-5 min-w-0"
        >
        {/* Status cards — click to list just those rooms */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          <StatCard icon={<DoorClosed className="w-6 h-6" />} label="In use" value={counts.Occupied}
            total={`of ${total}`} pct={pct(counts.Occupied)} tone={ROOM_TONE.Occupied}
            active={card === 'Occupied'} onClick={() => toggleCard('Occupied')} />
          <StatCard icon={<DoorOpen className="w-6 h-6" />} label="Available" value={counts.Available}
            total={`of ${total}`} pct={pct(counts.Available)} tone={ROOM_TONE.Available}
            active={card === 'Available'} onClick={() => toggleCard('Available')} />
          <StatCard icon={<Hourglass className="w-6 h-6" />} label="Not scanned" value={counts.Pending + counts['No Scan']}
            total={`of ${total}`} pct={pct(counts.Pending + counts['No Scan'])} tone={ROOM_TONE.Pending}
            active={card === 'PendingNoScan'} onClick={() => toggleCard('PendingNoScan')} />
        </div>

          {/* ── Room Activity — the whole width ── */}
          <section className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] overflow-hidden min-w-0">
            <div className="flex items-center gap-3 px-5 py-4 border-b border-[#EEF2F8]">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-bold text-[#0B2A5B]">Room Activity</h2>
                {/* The status card being used as a filter — click to show every room again */}
                <AnimatePresence initial={false}>
                  {card && (() => {
                    const tone = ROOM_TONE[card === 'PendingNoScan' ? 'Pending' : card];
                    return (
                      <motion.button
                        key={card}
                        type="button"
                        onClick={() => toggleCard(card)}
                        initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease: EASE } }}
                        exit={{ opacity: 0, transition: { duration: 0.15 } }}
                        whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                        title="Show every room again"
                        className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold"
                        style={{ backgroundColor: tone.soft, color: tone.text, borderColor: `${tone.bar}55` }}
                      >
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: tone.bar }} />
                        {card === 'PendingNoScan' ? 'Not scanned' : ROOM_LABEL[card]} only
                        <X className="w-3.5 h-3.5" />
                      </motion.button>
                    );
                  })()}
                </AnimatePresence>
              </div>
            </div>

            <AutoHeight>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={`${card}|${roomFilter}|${typeFilter}|${data?.date}|${safePage}`}
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: 0.3, ease: EASE } }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transition: { duration: 0.2, ease: EASE } }}
                >
                  {pageRows.length === 0 ? (
                    <div className="px-5 py-14 text-center">
                      <p className="text-base font-semibold text-[#0B2A5B]">
                        No classes scheduled{data ? ` on ${fmtDate(data.date, { weekday: 'long' })}` : ''}
                      </p>
                      {data?.next_class_date && (
                        <motion.button
                          type="button"
                          onClick={() => { setDate(data.next_class_date!); setView('daily'); resetPage(); }}
                          whileHover={reduceMotion ? undefined : { y: -1 }}
                          whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                          className="mt-3 inline-flex items-center gap-1.5 h-11 px-5 rounded-xl border border-[#BFDBFE] bg-white text-sm font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors"
                        >
                          Next class day · {fmtDate(data.next_class_date, { weekday: 'short', month: 'short', day: 'numeric' })}
                          <ChevronRight className="w-4 h-4" />
                        </motion.button>
                      )}
                    </div>
                  ) : (
                    <>
                      {/* Desktop table */}
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-[#F8FAFC] border-b border-[#EEF2F8] text-left text-sm font-semibold text-[#475569] whitespace-nowrap">
                              <th className="px-5 py-3">Room</th>
                              <th className="px-3 py-3">Schedule</th>
                              <th className="px-3 py-3">Faculty</th>
                              <th className="px-3 py-3">Scanned at</th>
                              <th className="px-3 py-3">Status</th>
                              <th className="px-5 py-3 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pageRows.map((r, i) => (
                              <motion.tr
                                key={r.key}
                                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE, delay: reduceMotion ? 0 : 0.05 + i * 0.04 } }}
                                className="border-b border-[#F1F5F9] last:border-0 hover:bg-[#F8FBFF] transition-colors"
                              >
                                <td className="px-5 py-3">
                                  <div className="flex items-center gap-2.5">
                                    <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                                      r.room_type === 'Lecture' ? 'bg-[#EFF6FF] text-[#1D5BD6]' : 'bg-amber-50 text-amber-600'
                                    }`}>
                                      <RoomIcon type={r.room_type} className="w-4 h-4" />
                                    </span>
                                    <span className="font-semibold text-[#0B2A5B] whitespace-nowrap">{r.room_name}</span>
                                  </div>
                                </td>
                                <td className="px-3 py-3">
                                  {r.placeholder ? (
                                    <span className="text-[#94A3B8]">No classes</span>
                                  ) : (
                                    <>
                                      <p className="font-medium text-[#0B2A5B] whitespace-nowrap">
                                        {fmt12(r.start)}{r.end ? ` – ${fmt12(r.end)}` : ''}
                                      </p>
                                      <p className="text-sm text-[#64748B] truncate max-w-[240px]">
                                        {r.subject_code ? `${r.subject_code}${r.component === 'lab' ? ' Lab' : ''} · ${r.block}` : 'Walk-in (no class scheduled)'}
                                      </p>
                                    </>
                                  )}
                                </td>
                                <td className="px-3 py-3 text-[#334155] whitespace-nowrap">{r.faculty_name || '—'}</td>
                                <td className="px-3 py-3">
                                  {r.scan_time ? (
                                    <>
                                      <p className="font-semibold text-[#0B2A5B] tabular-nums">{fmt12(r.scan_time)}</p>
                                      <p className={`text-sm font-medium ${r.late ? 'text-amber-600' : 'text-emerald-600'}`}>● {r.late ? 'Late' : 'On time'}</p>
                                    </>
                                  ) : (
                                    <>
                                      <p className="text-[#94A3B8]">—</p>
                                    </>
                                  )}
                                </td>
                                <td className="px-3 py-3">
                                  {r.placeholder
                                    ? <span className="inline-flex text-sm font-semibold px-3 py-1 rounded-full border whitespace-nowrap" style={{ backgroundColor: ROOM_TONE[statusOf.get(r.room_id) ?? 'Available'].soft, color: ROOM_TONE[statusOf.get(r.room_id) ?? 'Available'].text, borderColor: ROOM_TONE[statusOf.get(r.room_id) ?? 'Available'].bar + '55' }}>{ROOM_LABEL[statusOf.get(r.room_id) ?? 'Available']}</span>
                                    : <RowStatusPill status={r.status} />}
                                </td>
                                <td className="px-5 py-3 text-right">
                                  <Link href={viewQs(r.room_id)}
                                    className="inline-flex items-center gap-1.5 h-10 px-3.5 rounded-lg border border-[#D6E0EF] text-sm font-semibold text-[#0B2A5B] hover:border-[#9DB8E8] hover:text-[#1D5BD6] hover:bg-[#F8FBFF] transition-colors">
                                    <Eye className="w-4 h-4" /> View
                                  </Link>
                                </td>
                              </motion.tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Mobile cards */}
                      <ul className="md:hidden divide-y divide-[#F1F5F9]">
                        {pageRows.map(r => (
                          <li key={r.key} className="p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-semibold text-[#0B2A5B]">{r.room_name}</p>
                                <p className="text-sm text-[#64748B] mt-0.5">
                                  {r.placeholder ? 'No classes' : `${fmt12(r.start)}${r.end ? ` – ${fmt12(r.end)}` : ''}`}
                                </p>
                                {!r.placeholder && <p className="text-sm text-[#64748B]">{r.subject_code ? `${r.subject_code} · ${r.block}` : 'Walk-in'} · {r.faculty_name || '—'}</p>}
                                <p className="text-sm mt-1 text-[#475569]">Scanned at: {r.scan_time ? `${fmt12(r.scan_time)}${r.late ? ' (late)' : ''}` : '—'}</p>
                              </div>
                              <div className="flex flex-col items-end gap-2">
                                {!r.placeholder && <RowStatusPill status={r.status} />}
                                <Link href={viewQs(r.room_id)} className="inline-flex items-center gap-1.5 h-10 px-3.5 rounded-lg border border-[#D6E0EF] text-sm font-semibold text-[#0B2A5B]"><Eye className="w-4 h-4" /> View</Link>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </motion.div>
              </AnimatePresence>
            </AutoHeight>

            {/* Pages — the same large pager as the other lists */}
            <Pagination
              className="px-5 py-4 border-t border-[#EEF2F8]"
              layoutId="room-activity-page"
              page={safePage + 1}
              pageCount={pages}
              onChange={p => setPage(p - 1)}
              total={rows.length}
              pageSize={pageSize}
              noun={rows.length === 1 ? 'class' : 'classes'}
            />
          </section>
        </motion.div>
        ) : (
        <motion.div
          key="period"
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, transition: { duration: 0.25, ease: EASE } }}
          className="min-w-0"
        >
          <CheckinSummary
            key={`${data?.date}|${view}|${roomFilter}|${typeFilter}`}
            checked={checkins.checked}
            missed={checkins.missed}
            rooms={checkins.missedRooms}
            period={view === 'monthly' ? 'month' : 'week'}
            ongoing={!!data && data.range.start <= data.today && data.range.end >= data.today}
            hrefOf={id => viewQs(id, { show: 'missed' })}
          />
        </motion.div>
        )}
        </AnimatePresence>

      </PageLoadTransition>
      </motion.div>
      ) : (
      /* ── Room Planning: the term's schedule — the date / room filters above don't apply ── */
      <motion.div
        key="planning"
        initial={reduceMotion ? false : { opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0, transition: { duration: 0.35, ease: EASE } }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 16, transition: { duration: 0.2, ease: EASE } }}
        className="min-w-0"
      >
        <RoomPlanningSection initialPool={initialPool} />
      </motion.div>
      )}
      </AnimatePresence>


      <CalendarModal
        open={calOpen}
        value={data?.date ?? new Date().toISOString().slice(0, 10)}
        today={data?.today ?? new Date().toISOString().slice(0, 10)}
        highlight={view === 'weekly' ? 'week' : view === 'monthly' ? 'month' : 'day'}
        onClose={() => setCalOpen(false)}
        applying={applying}
        success={applied}
        onApply={d => { setDate(d); resetPage(); startApplying(); }}
      />
    </div>
  );
}
