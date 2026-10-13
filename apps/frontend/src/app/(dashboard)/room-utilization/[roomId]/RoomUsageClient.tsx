'use client';

/**
 * One room's usage history — opened from "View" on Room Utilization.
 * For a day / week / month: three cards — All classes · Scanned · Not
 * scanned — that also pick what the list below shows (like the cards on
 * Room Utilization; "Rooms with missed scans" opens on Not scanned,
 * ?show=missed), each class with its scan time, and every QR scan at the
 * room (folded away). Counts only, no hours.
 */

import React, { useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useReducedMotion } from 'framer-motion';
import { times12InText } from '@shared/clock12';
import BackButton from '@/components/ui/BackButton';
import CalendarModal from '@/components/ui/CalendarModal';
import CountFilterTabs from '@/components/ui/CountFilterTabs';
import { CardSkeleton, ListSkeleton } from '@/components/ui/skeletons';
import { useSkeletonRefresh } from '@/hooks/useSkeletonRefresh';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { CalendarDays, Check, CheckCircle2, ChevronDown, QrCode, UserRound, XCircle } from 'lucide-react';
import {
  AnimatePresence, AutoHeight, DateButton, EASE, fmt12, fmtDate, motion, rangeLabel, RefreshButton, RoomIcon,
  ROOM_LABEL, ROOM_TONE, roomStatusFor, RowStatusPill, TypePill, useApplyingDate, useUtilization,
  type UtilRow, type View,
} from '@/app/(dashboard)/room-utilization/shared';

type Show = 'all' | 'scanned' | 'missed';
type PeriodView = 'daily' | 'weekly' | 'monthly';

const LABEL = 'block text-sm font-semibold text-[#334155] mb-1.5';
const CARD = 'bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)]';
/** A QR scan's result in plain words */
const SCAN_LABEL: Record<string, string> = { Valid: 'On time', Late: 'Late', Invalid: 'Refused' };

/** Card colours: `bar` (top line, icon, border), `soft` (wash), `strong` (the "Showing" badge — white text stays readable) */
type Tone = { bar: string; soft: string; strong: string };
const TONE: Record<Show, Tone> = {
  all: { bar: '#475569', soft: '#F1F5F9', strong: '#475569' },
  scanned: { bar: '#1D5BD6', soft: '#EFF6FF', strong: '#1D5BD6' },
  missed: { bar: '#F59E0B', soft: '#FFFBEB', strong: '#B45309' },
};

/** A count card that also picks the list below — the chosen one is outlined and says "Showing" */
function Stat({ icon, label, value, tone, active, onClick }: {
  icon: React.ReactNode; label: string; value: number; tone: Tone; active: boolean; onClick: () => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? 'Showing these classes' : `Show ${label.toLowerCase()} classes`}
      whileHover={reduceMotion ? undefined : { y: -2 }}
      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
      className={`qr-stat-tint relative overflow-hidden text-left rounded-2xl border p-4 sm:p-5 flex items-center gap-4 w-full min-w-0 cursor-pointer focus-visible:rounded-2xl! transition-[border-color,box-shadow] duration-300 ${
        active ? 'shadow-[0_10px_24px_-14px_rgba(29,91,214,0.6)]' : 'shadow-[0_2px_8px_-4px_rgba(11,42,91,0.12)]'
      }`}
      style={{
        background: `linear-gradient(135deg, ${tone.soft} 0%, #FFFFFF 72%)`,
        borderColor: active ? tone.bar : `${tone.bar}40`,
        ...(active ? { boxShadow: `0 0 0 3px ${tone.bar}33` } : {}),
      }}
    >
      <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: tone.bar }} aria-hidden="true" />
      <AnimatePresence>
        {active && (
          <motion.span
            key="on"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: 0.25, ease: EASE } }}
            exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.15 } }}
            className="absolute top-3.5 right-3.5 inline-flex items-center gap-1 text-sm font-bold px-2.5 py-0.5 rounded-full"
            style={{ backgroundColor: tone.strong, color: '#FFFFFF' }}
          >
            <Check className="w-3.5 h-3.5" style={{ color: '#FFFFFF' }} /> Showing
          </motion.span>
        )}
      </AnimatePresence>
      <span className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-white shadow-[0_2px_6px_-2px_rgba(11,42,91,0.15)]" style={{ color: tone.bar }}>{icon}</span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-[#334155]">{label}</p>
        <p className="mt-1 text-[30px] font-bold text-[#0B2A5B] leading-none tabular-nums">{value}</p>
      </div>
    </motion.button>
  );
}

/** The list's title for each card */
const LIST_TITLE: Record<Show, string> = { all: 'All classes', scanned: 'Scanned classes', missed: 'Not scanned classes' };

/** Scan time, with "Late" when it was */
function CheckedIn({ r }: { r: UtilRow }) {
  if (!r.scan_time) return <span className="text-[#94A3B8]">—</span>;
  return (
    <span className="font-semibold text-[#0B2A5B] tabular-nums whitespace-nowrap">
      {fmt12(r.scan_time)}{r.late && <span className="ml-1.5 font-semibold text-amber-600">Late</span>}
    </span>
  );
}

export default function RoomUsageClient() {
  const reduceMotion = useReducedMotion();
  const router = useRouter();
  const params = useParams<{ roomId: string }>();
  const search = useSearchParams();
  const roomId = Number.parseInt(params.roomId, 10) || 0;
  const [date, setDate] = useState(search.get('date') ?? '');
  const rawView = search.get('view');
  const [view, setView] = useState<PeriodView>(rawView === 'weekly' || rawView === 'monthly' ? rawView : 'daily');
  const [show, setShow] = useState<Show>(() => {
    const s = search.get('show');
    return s === 'missed' || s === 'scanned' ? s : 'all';
  });
  const [logsOpen, setLogsOpen] = useState(false);
  const [calOpen, setCalOpen] = useState(false);

  const { data, loading, error, reload } = useUtilization(date, view, roomId);
  const [applying, startApplying, applied] = useApplyingDate(loading, () => setCalOpen(false));
  const showSkeleton = useMinLoading(loading && !data, PAGE_SKELETON_MIN_MS);
  // Refresh: the room header stays; the figures and lists below reload behind skeletons
  const { refreshing, refresh } = useSkeletonRefresh(reload);
  const bodySkeleton = useMinLoading(refreshing, PAGE_SKELETON_MIN_MS);

  // Keep the URL in step so refresh / back returns to the same period and list
  const sync = (d: string, v: View, s: Show = show) =>
    router.replace(`/room-utilization/${roomId}?${new URLSearchParams({ date: d, view: v, ...(s !== 'all' ? { show: s } : {}) })}`, { scroll: false });

  const room = data?.rooms[0];
  const rows = useMemo(() => data?.activity ?? [], [data]);
  const liveDay = !!data && data.view === 'daily' && data.date === data.today;
  const status = room ? roomStatusFor(room, rows, liveDay) : 'Available';

  // Booked classes that already started: scanned or not (walk-ins and classes still to come are only in All)
  const scannedRows = useMemo(() => rows.filter(r => r.subject_code && (r.status === 'Completed' || r.status === 'Occupied')), [rows]);
  const missedRows = useMemo(() => rows.filter(r => r.subject_code && r.status === 'Not Checked'), [rows]);
  const list = show === 'missed' ? missedRows : show === 'scanned' ? scannedRows : rows;
  // A card picks the list; clicking the chosen Scanned / Not scanned card again shows all classes
  const pick = (s: Show) => {
    const nextShow: Show = s === show ? 'all' : s;
    setShow(nextShow);
    sync(data?.date ?? date, view, nextShow);
  };

  const oneDay = view === 'daily';

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0 space-y-5">
      <BackButton />

      <PageLoadTransition showSkeleton={showSkeleton} skeleton={<ListSkeleton rows={8} />}>
        {!room ? (
          <div className={`${CARD} p-12 text-center text-[15px] text-[#64748B]`}>
            {error || 'Room not found or inactive.'}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Room header + period controls */}
            <div className={`${CARD} p-4 sm:p-5`}>
              <div className="flex items-center gap-3">
                <span className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${room.room_type === 'Lecture' ? 'bg-[#EFF6FF] text-[#1D5BD6]' : 'bg-amber-50 text-amber-600'}`}>
                  <RoomIcon type={room.room_type} className="w-6 h-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <h1 className="text-2xl font-bold text-[#0B2A5B] leading-tight truncate">{room.room_name}</h1>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <TypePill type={room.room_type} />
                    {/* Right now (today only) */}
                    {liveDay && (
                      <span className="inline-flex items-center gap-1.5 text-sm font-semibold px-3 py-0.5 rounded-full border"
                        style={{ backgroundColor: ROOM_TONE[status].soft, color: ROOM_TONE[status].text, borderColor: ROOM_TONE[status].bar + '55' }}>
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: ROOM_TONE[status].bar }} /> {ROOM_LABEL[status]}
                      </span>
                    )}
                  </div>
                </div>
                <RefreshButton overlay={false} onRefresh={refresh} loading={refreshing || bodySkeleton} className="!h-12 flex-shrink-0" />
              </div>
              {/* Who is using it now — its own line under the name, so a long name never crowds the chips */}
              {liveDay && status === 'Occupied' && room.live_faculty && (
                <p className="mt-3 sm:pl-[60px] flex items-start gap-2 text-[15px] text-[#475569]">
                  <UserRound className="w-4 h-4 mt-[3px] flex-shrink-0 text-[#94A3B8]" aria-hidden="true" />
                  <span className="min-w-0 break-words">Used by <span className="font-semibold text-[#0B2A5B]">{room.live_faculty}</span></span>
                </p>
              )}
              <div className="mt-4 pt-4 border-t border-[#EEF2F7] flex flex-col lg:flex-row lg:items-end gap-4 lg:gap-8">
                <div className="min-w-0">
                  <p className={LABEL}>View</p>
                  <CountFilterTabs<PeriodView>
                    label="View"
                    layoutId="room-usage-view"
                    value={view}
                    onChange={v => { setView(v); sync(data?.date ?? date, v); }}
                    options={[
                      { key: 'daily', label: 'Daily', color: '#0B2A5B' },
                      { key: 'weekly', label: 'Weekly', color: '#0B2A5B' },
                      { key: 'monthly', label: 'Monthly', color: '#0B2A5B' },
                    ]}
                  />
                </div>
                <div className="min-w-0 w-full lg:w-[360px]">
                  <p className={LABEL}>Date</p>
                  <DateButton className="!h-12 text-[15px]" label={data ? rangeLabel(view, data.date, data.range) : '…'} onClick={() => setCalOpen(true)} />
                </div>
              </div>
            </div>

            <PageLoadTransition
              showSkeleton={bodySkeleton}
              skeleton={
                <div className="space-y-5" role="status" aria-label="Refreshing room usage">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
                    {[0, 1, 2].map(i => <CardSkeleton key={i} className="h-[100px] rounded-2xl" />)}
                  </div>
                  <ListSkeleton rows={6} />
                </div>
              }
            >
            <div className="space-y-5">
            {/* The cards pick the list below */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4" role="group" aria-label="Show classes">
              <Stat icon={<CalendarDays className="w-6 h-6" />} label="All classes" value={rows.length} tone={TONE.all}
                active={show === 'all'} onClick={() => pick('all')} />
              <Stat icon={<CheckCircle2 className="w-6 h-6" />} label="Scanned" value={scannedRows.length} tone={TONE.scanned}
                active={show === 'scanned'} onClick={() => pick('scanned')} />
              <Stat icon={<XCircle className="w-6 h-6" />} label="Not scanned" value={missedRows.length} tone={TONE.missed}
                active={show === 'missed'} onClick={() => pick('missed')} />
            </div>

            {/* Each class */}
            <section className={`${CARD} overflow-hidden`}>
              <div className="px-5 py-4 border-b border-[#EEF2F8]">
                <h2 className="text-lg font-bold text-[#0B2A5B]">{LIST_TITLE[show]}</h2>
              </div>
              <AutoHeight>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div key={`${data?.date}|${view}|${show}`}
                    initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.3, ease: EASE } }}
                    exit={{ opacity: 0, transition: { duration: 0.2 } }}>
                    {list.length === 0 ? (
                      show === 'missed' ? (
                        <div className="px-5 py-12 flex flex-col items-center text-center">
                          <span className="w-14 h-14 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center"><CheckCircle2 className="w-7 h-7" /></span>
                          <p className="mt-3 text-lg font-bold text-[#0B2A5B]">No missed scans</p>
                        </div>
                      ) : (
                        <p className="px-5 py-12 text-center text-[15px] text-[#64748B]">
                          {show === 'scanned' ? 'No scanned classes in this period.' : 'No classes or scans in this period.'}
                        </p>
                      )
                    ) : (
                      <>
                        {/* Desktop table */}
                        <div className="hidden md:block overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-[#F8FAFC] border-b border-[#EEF2F8] text-left text-sm font-semibold text-[#475569] whitespace-nowrap">
                                {!oneDay && <th className="px-5 py-3">Date</th>}
                                <th className={`${oneDay ? 'px-5' : 'px-3'} py-3`}>Time</th>
                                <th className="px-3 py-3">Class</th>
                                <th className="px-3 py-3">Faculty</th>
                                <th className="px-3 py-3">Scanned at</th>
                                <th className="px-5 py-3">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {list.map((r, i) => (
                                <motion.tr key={r.key}
                                  initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                                  animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 12) * 0.035 } }}
                                  className="border-b border-[#F1F5F9] last:border-0 hover:bg-[#F8FBFF]">
                                  {!oneDay && <td className="px-5 py-3 whitespace-nowrap text-[#334155]">{fmtDate(r.date, { weekday: 'short', month: 'short', day: 'numeric' })}</td>}
                                  <td className={`${oneDay ? 'px-5' : 'px-3'} py-3 whitespace-nowrap font-medium text-[#0B2A5B]`}>{fmt12(r.start)}{r.end ? ` – ${fmt12(r.end)}` : ''}</td>
                                  <td className="px-3 py-3">
                                    {r.subject_code
                                      ? <><p className="font-medium text-[#0B2A5B]">{r.subject_code}{r.component === 'lab' ? ' Lab' : ''}</p><p className="text-sm text-[#64748B]">{r.block}</p></>
                                      : <span className="text-[#64748B]">Walk-in</span>}
                                  </td>
                                  <td className="px-3 py-3 text-[#334155] whitespace-nowrap">{r.faculty_name || '—'}</td>
                                  <td className="px-3 py-3"><CheckedIn r={r} /></td>
                                  <td className="px-5 py-3"><RowStatusPill status={r.status} /></td>
                                </motion.tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Phone cards */}
                        <ul className="md:hidden divide-y divide-[#F1F5F9]">
                          {list.map(r => (
                            <li key={r.key} className="p-4 flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <p className="font-semibold text-[#0B2A5B]">
                                  {!oneDay && <span className="text-[#64748B] font-medium">{fmtDate(r.date, { weekday: 'short', month: 'short', day: 'numeric' })} · </span>}
                                  {fmt12(r.start)}{r.end ? ` – ${fmt12(r.end)}` : ''}
                                </p>
                                <p className="text-sm text-[#64748B] mt-0.5">
                                  {r.subject_code ? `${r.subject_code}${r.component === 'lab' ? ' Lab' : ''} · ${r.block}` : 'Walk-in'} · {r.faculty_name || '—'}
                                </p>
                                <p className="text-sm mt-1 text-[#475569]">Scanned at: <CheckedIn r={r} /></p>
                              </div>
                              <RowStatusPill status={r.status} />
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </motion.div>
                </AnimatePresence>
              </AutoHeight>
            </section>

            {/* Every QR scan at the room (refused ones too) — folded away */}
            <section className={`${CARD} overflow-hidden`}>
              <button
                type="button"
                onClick={() => setLogsOpen(o => !o)}
                aria-expanded={logsOpen}
                className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-[#F8FBFF] transition-colors"
              >
                <span className="flex-1 min-w-0 text-lg font-bold text-[#0B2A5B]">Every QR scan</span>
                <span className="text-[15px] font-semibold text-[#64748B] tabular-nums">{data?.logs.length ?? 0}</span>
                <motion.span animate={{ rotate: logsOpen ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.4, ease: EASE }}
                  className="w-9 h-9 rounded-full border border-[#D6E0EF] flex items-center justify-center text-[#1D5BD6]">
                  <ChevronDown className="w-4 h-4" />
                </motion.span>
              </button>
              <AnimatePresence initial={false}>
                {logsOpen && (
                  <motion.div
                    key="logs"
                    initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1, transition: { duration: 0.45, ease: EASE } }}
                    exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0, transition: { duration: 0.35, ease: EASE } }}
                    className="overflow-hidden border-t border-[#EEF2F8]"
                  >
                    {(data?.logs ?? []).length === 0 ? (
                      <p className="px-5 py-10 text-center text-[15px] text-[#64748B]">No QR scans in this period.</p>
                    ) : (
                      <ul className="divide-y divide-[#F1F5F9] max-h-[420px] overflow-y-auto">
                        {data!.logs.map(l => {
                          const ok = l.status === 'Valid';
                          const late = l.status === 'Late';
                          return (
                            <li key={l.id} className="flex items-start gap-3 px-5 py-3">
                              <span className={`mt-0.5 w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${ok ? 'bg-emerald-50 text-emerald-600' : late ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-500'}`}>
                                <QrCode className="w-4 h-4" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="text-[15px] font-semibold text-[#0B2A5B]">
                                  {l.faculty_name || 'Unknown'} <span className="font-normal text-[#64748B]">· {fmtDate(l.scan_date, { weekday: 'short', month: 'short', day: 'numeric' })}, {fmt12(l.scan_hm)}</span>
                                </p>
                                {l.notes && <p className="text-sm text-[#64748B] mt-0.5">{times12InText(l.notes)}</p>}
                              </div>
                              <span className={`text-sm font-semibold px-3 py-0.5 rounded-full border whitespace-nowrap ${
                                ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : late ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-red-50 text-red-600 border-red-200'
                              }`}>{SCAN_LABEL[l.status] ?? l.status}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </section>
            </div>
            </PageLoadTransition>
          </div>
        )}
      </PageLoadTransition>

      <CalendarModal
        open={calOpen}
        value={data?.date ?? new Date().toISOString().slice(0, 10)}
        today={data?.today ?? new Date().toISOString().slice(0, 10)}
        highlight={view === 'weekly' ? 'week' : view === 'monthly' ? 'month' : 'day'}
        onClose={() => setCalOpen(false)}
        applying={applying}
        success={applied}
        onApply={d => { setDate(d); sync(d, view); startApplying(); }}
      />
    </div>
  );
}
