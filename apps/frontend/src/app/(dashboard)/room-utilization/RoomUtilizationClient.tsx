'use client';

/**
 * Room Utilization — "Are the rooms actually being used as scheduled?"
 *
 *  • Filters: Date (centred calendar), View (Daily / Weekly / Monthly),
 *    Room, Room Type, Refresh
 *  • Status cards: Occupied · Available · Pending / No Scan · Overall
 *    Utilization — the first three filter the Room Activity list
 *  • Room Activity: scheduled vs. actual (QR check-in) per class; Expand
 *    gives it the full width; View opens a room's own usage-history page
 *  • Utilization Summary: hours used per room — foldable
 */

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useReducedMotion } from 'framer-motion';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import CalendarModal from '@/components/ui/CalendarModal';
import { FilterSelect } from '@/components/ui/SearchFilter';
import { ListSkeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import {
  ChevronDown, ChevronLeft, ChevronRight, DoorClosed, DoorOpen, Eye, Hourglass,
  Maximize2, Minimize2, PieChart,
} from 'lucide-react';
import {
  AnimatePresence, AutoHeight, DateButton, EASE, fmt12, fmtDate, hrs, motion, rangeLabel, RefreshButton, RoomIcon,
  ROOM_TONE, roomStatusFor, RowStatusPill, useApplyingDate, useUtilization, WHITE,
  type RoomStatus, type UtilRow, type View,
} from './shared';

type CardFilter = 'Occupied' | 'Available' | 'PendingNoScan' | null;

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
      whileHover={onClick && !reduceMotion ? { y: -2 } : undefined}
      whileTap={onClick && !reduceMotion ? { scale: 0.98 } : undefined}
      className={`qr-stat-tint relative overflow-hidden text-left rounded-2xl border p-4 w-full min-w-0 transition-[border-color,box-shadow] duration-300 ${
        active ? 'shadow-[0_10px_24px_-14px_rgba(29,91,214,0.6)]' : 'shadow-[0_2px_8px_-4px_rgba(11,42,91,0.12)]'
      } ${onClick ? 'cursor-pointer' : ''}`}
      // A light wash of the status colour so the card stands off the white page
      style={{
        background: `linear-gradient(135deg, ${tone.soft} 0%, #FFFFFF 72%)`,
        borderColor: active ? tone.bar : `${tone.bar}40`,
        ...(active ? { boxShadow: `0 0 0 3px ${tone.soft}` } : {}),
      }}
    >
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: tone.bar }} aria-hidden="true" />
      <div className="flex items-start gap-3">
        <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 bg-white shadow-[0_2px_6px_-2px_rgba(11,42,91,0.15)]" style={{ color: tone.bar }}>
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[#475569]">{label}</p>
          <p className="text-2xl font-bold text-[#0B2A5B] leading-tight tabular-nums">{value}</p>
          <p className="text-xs text-[#94A3B8]">{total}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-[#EEF2F8] overflow-hidden">
          <motion.div
            className="h-full rounded-full"
            style={{ backgroundColor: tone.bar }}
            initial={false}
            animate={{ width: `${pct}%` }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.6, ease: EASE }}
          />
        </div>
        <span className="text-xs font-semibold text-[#64748B] tabular-nums w-9 text-right">{pct}%</span>
      </div>
    </Tag>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────────── */

export default function RoomUtilizationClient() {
  const reduceMotion = useReducedMotion();
  const [date, setDate] = useState('');            // '' = today (server clock)
  const [view, setView] = useState<View>('daily');
  const [roomFilter, setRoomFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [card, setCard] = useState<CardFilter>(null);
  const [calOpen, setCalOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [page, setPage] = useState(0);

  const { data, loading, error, reload } = useUtilization(date, view);
  const [applying, startApplying, applied] = useApplyingDate(loading, () => setCalOpen(false));
  const showSkeleton = useMinLoading(loading && !data, PAGE_SKELETON_MIN_MS);

  const liveDay = !!data && data.view === 'daily' && data.date === data.today;

  const rooms = useMemo(() => (data?.rooms ?? [])
    .filter(r => !roomFilter || String(r.id) === roomFilter)
    .filter(r => !typeFilter || r.room_type === typeFilter || (typeFilter === 'Laboratory' && r.room_type === 'Computer Lab')),
  [data, roomFilter, typeFilter]);

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
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, rooms, statusOf, card]);

  const pageSize = expanded ? 20 : 8;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageRows = rows.slice(safePage * pageSize, safePage * pageSize + pageSize);

  /* Utilization summary per room */
  const summary = useMemo(() => rooms.map(r => {
    const mine = (data?.activity ?? []).filter(a => a.room_id === r.id);
    const used = mine.reduce((s, a) => s + a.hours_used, 0);
    const sched = mine.reduce((s, a) => s + a.hours_scheduled, 0);
    const p = sched > 0 ? Math.min(100, Math.round((used / sched) * 100)) : used > 0 ? 100 : 0;
    return { room: r, used, sched, pct: p, status: statusOf.get(r.id) ?? 'Available' };
  }).sort((a, b) => b.used - a.used || a.room.room_name.localeCompare(b.room.room_name, undefined, { numeric: true })),
  [rooms, data, statusOf]);

  const resetPage = () => setPage(0);
  const toggleCard = (c: CardFilter) => { setCard(cur => (cur === c ? null : c)); resetPage(); };
  const viewQs = (roomId: number) => `/room-utilization/${roomId}?${new URLSearchParams({ date: data?.date ?? '', view })}`;

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
                className="inline-flex items-center gap-2 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1"
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

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] p-4 sm:p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-4 items-end">
          <div>
            <DateButton label={data ? rangeLabel(view, data.date, data.range) : '…'} onClick={() => setCalOpen(true)} />
          </div>
          <div>
            <FilterSelect value={view} onChange={v => { setView(v as View); resetPage(); }} label="View" className="qr-ms-field">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </FilterSelect>
          </div>
          <div>
            <FilterSelect value={roomFilter} onChange={v => { setRoomFilter(v); resetPage(); }} label="Room" className="qr-ms-field">
              <option value="">All Rooms</option>
              {(data?.rooms ?? []).map(r => <option key={r.id} value={r.id}>{r.room_name}</option>)}
            </FilterSelect>
          </div>
          <div>
            <FilterSelect value={typeFilter} onChange={v => { setTypeFilter(v); resetPage(); }} label="Room Type" className="qr-ms-field">
              <option value="">All</option>
              <option value="Lecture">Lecture</option>
              <option value="Laboratory">Laboratory</option>
            </FilterSelect>
          </div>
          <RefreshButton onRefresh={reload} loading={loading} />
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>

      <PageLoadTransition showSkeleton={showSkeleton} skeleton={<ListSkeleton rows={8} />}>
        {/* Status cards — click to list just those rooms */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <StatCard icon={<DoorClosed className="w-5 h-5" />} label="Occupied Rooms" value={counts.Occupied}
            total={`of ${total} rooms`} pct={pct(counts.Occupied)} tone={ROOM_TONE.Occupied}
            active={card === 'Occupied'} onClick={() => toggleCard('Occupied')} />
          <StatCard icon={<DoorOpen className="w-5 h-5" />} label="Available Rooms" value={counts.Available}
            total={`of ${total} rooms`} pct={pct(counts.Available)} tone={ROOM_TONE.Available}
            active={card === 'Available'} onClick={() => toggleCard('Available')} />
          <StatCard icon={<Hourglass className="w-5 h-5" />} label="Pending / No Scan" value={counts.Pending + counts['No Scan']}
            total={`of ${total} rooms`} pct={pct(counts.Pending + counts['No Scan'])} tone={ROOM_TONE.Pending}
            active={card === 'PendingNoScan'} onClick={() => toggleCard('PendingNoScan')} />
          <StatCard icon={<PieChart className="w-5 h-5" />} label="Overall Utilization" value={`${pct(counts.Occupied)}%`}
            total={`(${counts.Occupied} of ${total} rooms)`} pct={pct(counts.Occupied)}
            tone={{ bar: '#12408F', soft: '#EAF1FC', text: '#12408F' }} />
        </div>

        <div className={`mt-5 grid gap-5 items-start ${expanded ? 'grid-cols-1' : 'grid-cols-1 xl:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]'}`}>
          {/* ── Room Activity ── */}
          <motion.section layout transition={reduceMotion ? { duration: 0 } : { duration: 0.5, ease: EASE }}
            className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] overflow-hidden min-w-0">
            <motion.div layout="position" className="flex items-center gap-3 px-5 py-4 border-b border-[#EEF2F8]">
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-bold text-[#0B2A5B]">Room Activity</h2>
                {card && (
                  <button type="button" onClick={() => toggleCard(card)} className="mt-0.5 text-xs font-semibold text-[#1D5BD6] hover:underline">
                    {card === 'PendingNoScan' ? 'Pending / No Scan' : card} only ✕
                  </button>
                )}
              </div>
              <motion.button
                type="button"
                onClick={() => { setExpanded(e => !e); resetPage(); }}
                whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                aria-pressed={expanded}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-[#BFDBFE] text-[13px] font-semibold text-[#1D5BD6] bg-white hover:bg-[#EFF6FF] transition-colors"
              >
                {expanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                {expanded ? 'Collapse' : 'Expand'}
              </motion.button>
            </motion.div>

            <AutoHeight>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={`${card}|${roomFilter}|${typeFilter}|${data?.date}|${view}|${safePage}|${expanded}`}
                  initial={reduceMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: 0.3, ease: EASE } }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transition: { duration: 0.2, ease: EASE } }}
                >
                  {pageRows.length === 0 ? (
                    <div className="px-5 py-14 text-center">
                      <p className="text-sm font-semibold text-[#0B2A5B]">
                        No classes scheduled {view === 'daily' && data ? `on ${fmtDate(data.date, { weekday: 'long' })}` : 'in this period'}
                      </p>
                      {data?.next_class_date && (
                        <motion.button
                          type="button"
                          onClick={() => { setDate(data.next_class_date!); setView('daily'); resetPage(); }}
                          whileHover={reduceMotion ? undefined : { y: -1 }}
                          whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                          className="mt-3 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg border border-[#BFDBFE] bg-white text-[13px] font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors"
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
                            <tr className="bg-[#F8FAFC] border-b border-[#EEF2F8] text-left text-[12px] font-semibold text-[#475569]">
                              <th className="px-5 py-3">Room</th>
                              <th className="px-3 py-3">Schedule</th>
                              <th className="px-3 py-3">Faculty</th>
                              <th className="px-3 py-3">QR Scan</th>
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
                                    <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
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
                                        {view !== 'daily' && <span className="text-[#64748B]">{fmtDate(r.date, { weekday: 'short', month: 'short', day: 'numeric' })} · </span>}
                                        {fmt12(r.start)}{r.end ? ` – ${fmt12(r.end)}` : ''}
                                      </p>
                                      <p className="text-xs text-[#64748B] truncate max-w-[220px]">
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
                                      <p className={`text-xs ${r.late ? 'text-amber-600' : 'text-emerald-600'}`}>● {r.late ? 'Late' : 'Scanned'}</p>
                                    </>
                                  ) : (
                                    <>
                                      <p className="text-[#94A3B8]">—</p>
                                    </>
                                  )}
                                </td>
                                <td className="px-3 py-3">
                                  {r.placeholder
                                    ? <span className="inline-flex text-[11px] font-semibold px-2.5 py-0.5 rounded-full border" style={{ backgroundColor: ROOM_TONE[statusOf.get(r.room_id) ?? 'Available'].soft, color: ROOM_TONE[statusOf.get(r.room_id) ?? 'Available'].text, borderColor: ROOM_TONE[statusOf.get(r.room_id) ?? 'Available'].bar + '55' }}>{statusOf.get(r.room_id)}</span>
                                    : <RowStatusPill status={r.status} />}
                                </td>
                                <td className="px-5 py-3 text-right">
                                  <Link href={viewQs(r.room_id)}
                                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[#D6E0EF] text-[13px] font-semibold text-[#0B2A5B] hover:border-[#9DB8E8] hover:text-[#1D5BD6] hover:bg-[#F8FBFF] transition-colors">
                                    <Eye className="w-3.5 h-3.5" /> View
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
                                <p className="text-xs text-[#64748B] mt-0.5">
                                  {r.placeholder ? 'No classes' : `${view !== 'daily' ? fmtDate(r.date, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' : ''}${fmt12(r.start)}${r.end ? ` – ${fmt12(r.end)}` : ''}`}
                                </p>
                                {!r.placeholder && <p className="text-xs text-[#64748B]">{r.subject_code ? `${r.subject_code} · ${r.block}` : 'Walk-in'} · {r.faculty_name || '—'}</p>}
                                <p className="text-xs mt-1 text-[#475569]">QR: {r.scan_time ? `${fmt12(r.scan_time)}${r.late ? ' (late)' : ''}` : '—'}</p>
                              </div>
                              <div className="flex flex-col items-end gap-2">
                                {!r.placeholder && <RowStatusPill status={r.status} />}
                                <Link href={viewQs(r.room_id)} className="text-[13px] font-semibold text-[#1D5BD6]">View</Link>
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

            {/* Footer + pagination */}
            {pages > 1 && (
            <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-[#EEF2F8] text-[13px] text-[#64748B]">
              <span>{`${safePage * pageSize + 1}–${Math.min(rows.length, (safePage + 1) * pageSize)} of ${rows.length}`}</span>
              {(
                <div className="flex items-center gap-1">
                  <button type="button" disabled={safePage === 0} onClick={() => setPage(p => p - 1)} aria-label="Previous page"
                    className="w-8 h-8 rounded-lg border border-[#D6E0EF] flex items-center justify-center disabled:opacity-40 hover:bg-[#F8FBFF]"><ChevronLeft className="w-4 h-4" /></button>
                  {Array.from({ length: pages }, (_, i) => i).slice(Math.max(0, safePage - 2), Math.max(0, safePage - 2) + 5).map(i => (
                    <button key={i} type="button" onClick={() => setPage(i)}
                      className={`w-8 h-8 rounded-lg text-[13px] font-semibold transition-colors ${i === safePage ? 'bg-[#1D5BD6]' : 'border border-[#D6E0EF] text-[#0B2A5B] hover:bg-[#F8FBFF]'}`}
                      style={i === safePage ? WHITE : undefined}>{i + 1}</button>
                  ))}
                  <button type="button" disabled={safePage >= pages - 1} onClick={() => setPage(p => p + 1)} aria-label="Next page"
                    className="w-8 h-8 rounded-lg border border-[#D6E0EF] flex items-center justify-center disabled:opacity-40 hover:bg-[#F8FBFF]"><ChevronRight className="w-4 h-4" /></button>
                </div>
              )}
            </div>
            )}
          </motion.section>

          {/* ── Utilization Summary (foldable) ── */}
          <AnimatePresence initial={false}>
            {!expanded && (
              <motion.section
                key="summary"
                initial={reduceMotion ? false : { opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0, transition: { duration: 0.45, ease: EASE, delay: reduceMotion ? 0 : 0.15 } }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 16, transition: { duration: 0.25, ease: EASE } }}
                className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] overflow-hidden min-w-0"
              >
                <button
                  type="button"
                  onClick={() => setSummaryOpen(o => !o)}
                  aria-expanded={summaryOpen}
                  className={`w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-[#F8FBFF] transition-colors border-b ${summaryOpen ? 'border-[#EEF2F8]' : 'border-transparent'}`}
                >
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[15px] font-bold text-[#0B2A5B]">Room Utilization Summary</h2>
                  </div>
                  <motion.span animate={{ rotate: summaryOpen ? 180 : 0 }} transition={{ duration: 0.4, ease: EASE }}
                    className="w-8 h-8 rounded-full border border-[#D6E0EF] flex items-center justify-center text-[#1D5BD6]">
                    <ChevronDown className="w-4 h-4" />
                  </motion.span>
                </button>
                <AnimatePresence initial={false}>
                  {summaryOpen && (
                    <motion.div
                      key="body"
                      initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1, transition: { duration: 0.45, ease: EASE } }}
                      exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0, transition: { duration: 0.35, ease: EASE } }}
                      className="overflow-hidden"
                    >
                      <ul className="px-5 py-3 space-y-3.5 max-h-[460px] overflow-y-auto">
                        {summary.map(s => (
                          <li key={s.room.id}>
                            <div className="flex items-baseline justify-between gap-2">
                              <Link href={viewQs(s.room.id)} className="text-sm font-semibold text-[#0B2A5B] hover:text-[#1D5BD6] truncate">{s.room.room_name}</Link>
                              <span className="text-xs font-semibold text-[#0B2A5B] tabular-nums whitespace-nowrap">
                                {hrs(s.used)} <span className="text-[#94A3B8] font-medium">({s.pct}%)</span>
                              </span>
                            </div>
                            <div className="mt-1.5 h-2 rounded-full bg-[#EEF2F8] overflow-hidden">
                              <motion.div
                                className="h-full rounded-full"
                                style={{ backgroundColor: ROOM_TONE[s.status].bar }}
                                initial={false}
                                animate={{ width: `${Math.max(s.pct, s.used > 0 ? 4 : 0)}%` }}
                                transition={reduceMotion ? { duration: 0 } : { duration: 0.6, ease: EASE }}
                              />
                            </div>
                          </li>
                        ))}
                        {summary.length === 0 && <li className="text-sm text-[#94A3B8] py-6 text-center">No rooms.</li>}
                      </ul>
                      <div className="px-5 pb-4">
                        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-[#64748B] pt-3 border-t border-[#F1F5F9]">
                          {(['Occupied', 'Available', 'Pending', 'No Scan'] as RoomStatus[]).map(s => (
                            <span key={s} className="inline-flex items-center gap-1.5">
                              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: ROOM_TONE[s].bar }} /> {s}
                            </span>
                          ))}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.section>
            )}
          </AnimatePresence>
        </div>
      </PageLoadTransition>


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
