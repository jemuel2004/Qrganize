'use client';

/**
 * One room's usage history — opened from "View" on Room Utilization.
 * Scheduled vs. actual QR check-in for the room over a day / week / month,
 * plus its raw QR scan logs.
 */

import React, { useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useReducedMotion } from 'framer-motion';
import BackButton from '@/client/components/ui/BackButton';
import CalendarModal from '@/client/components/ui/CalendarModal';
import { FilterSelect } from '@/components/ui/SearchFilter';
import { ListSkeleton } from '@/client/components/ui/skeletons';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/client/hooks/useMinLoading';
import { CheckCircle2, Clock, QrCode, Users, XCircle } from 'lucide-react';
import {
  AnimatePresence, DateButton, EASE, fmt12, fmtDate, hrs, motion, rangeLabel, RefreshButton, RoomIcon, ROOM_TONE,
  roomStatusFor, RowStatusPill, TypePill, useApplyingDate, useUtilization, type View,
} from '../shared';

function Stat({ icon, label, value, sub, tone }: {
  icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; tone: { bar: string; soft: string };
}) {
  return (
    <div
      className="qr-stat-tint relative overflow-hidden rounded-2xl border shadow-[0_2px_8px_-4px_rgba(11,42,91,0.12)] p-4 flex items-start gap-3 min-w-0"
      style={{ background: `linear-gradient(135deg, ${tone.soft} 0%, #FFFFFF 72%)`, borderColor: `${tone.bar}40` }}
    >
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ backgroundColor: tone.bar }} aria-hidden="true" />
      <span className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-white shadow-[0_2px_6px_-2px_rgba(11,42,91,0.15)]" style={{ color: tone.bar }}>{icon}</span>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-[#475569]">{label}</p>
        <p className="text-2xl font-bold text-[#0B2A5B] leading-tight tabular-nums">{value}</p>
        {sub && <p className="text-xs text-[#94A3B8]">{sub}</p>}
      </div>
    </div>
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
  const [view, setView] = useState<View>(rawView === 'weekly' || rawView === 'monthly' ? rawView : 'daily');
  const [calOpen, setCalOpen] = useState(false);

  const { data, loading, error, reload } = useUtilization(date, view, roomId);
  const [applying, startApplying, applied] = useApplyingDate(loading, () => setCalOpen(false));
  const showSkeleton = useMinLoading(loading && !data, PAGE_SKELETON_MIN_MS);

  // Keep the URL in step so refresh / back returns to the same period
  const sync = (d: string, v: View) => router.replace(`/room-utilization/${roomId}?${new URLSearchParams({ date: d, view: v })}`, { scroll: false });

  const room = data?.rooms[0];
  const rows = useMemo(() => data?.activity ?? [], [data]);
  const liveDay = !!data && data.view === 'daily' && data.date === data.today;
  const status = room ? roomStatusFor(room, rows, liveDay) : 'Available';

  const scheduled = rows.filter(r => r.subject_code);
  const used = rows.filter(r => r.status === 'Completed' || r.status === 'Occupied' || r.status === 'Walk-in').length;
  const missed = rows.filter(r => r.status === 'Not Checked').length;
  const usedH = rows.reduce((s, r) => s + r.hours_used, 0);
  const schedH = rows.reduce((s, r) => s + r.hours_scheduled, 0);
  const usedPct = schedH > 0 ? Math.min(100, Math.round((usedH / schedH) * 100)) : usedH > 0 ? 100 : 0;

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0 space-y-5">
      <BackButton />

      <PageLoadTransition showSkeleton={showSkeleton} skeleton={<ListSkeleton rows={8} />}>
        {!room ? (
          <div className="bg-white rounded-2xl border border-[#E3E9F3] p-12 text-center text-sm text-[#94A3B8]">
            {error || 'Room not found or inactive.'}
          </div>
        ) : (
          <div className="space-y-5">
            {/* Room header + period controls */}
            <div className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] p-4 sm:p-5">
              <div className="flex flex-col lg:flex-row lg:items-end gap-4">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <span className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${room.room_type === 'Lecture' ? 'bg-[#EFF6FF] text-[#1D5BD6]' : 'bg-amber-50 text-amber-600'}`}>
                    <RoomIcon type={room.room_type} className="w-6 h-6" />
                  </span>
                  <div className="min-w-0">
                    <h1 className="text-2xl font-bold text-[#0B2A5B] leading-tight truncate">{room.room_name}</h1>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <TypePill type={room.room_type} />
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-0.5 rounded-full border"
                        style={{ backgroundColor: ROOM_TONE[status].soft, color: ROOM_TONE[status].text, borderColor: ROOM_TONE[status].bar + '55' }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ROOM_TONE[status].bar }} /> {status}
                        {liveDay && room.live_faculty && status === 'Occupied' ? ` · ${room.live_faculty}` : ''}
                      </span>
                      {room.capacity ? <span className="text-xs text-[#64748B] inline-flex items-center gap-1"><Users className="w-3.5 h-3.5" /> {room.capacity}</span> : null}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_160px_auto] gap-3 lg:w-[560px]">
                  <DateButton label={data ? rangeLabel(view, data.date, data.range) : '…'} onClick={() => setCalOpen(true)} />
                  <FilterSelect value={view} onChange={v => { setView(v as View); sync(data?.date ?? date, v as View); }} label="View" className="qr-ms-field">
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </FilterSelect>
                  <RefreshButton onRefresh={reload} loading={loading} className="px-4" />
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              <Stat icon={<Clock className="w-5 h-5" />} label="Scheduled Classes" value={scheduled.length} tone={{ bar: '#1D5BD6', soft: '#EFF6FF' }} />
              <Stat icon={<CheckCircle2 className="w-5 h-5" />} label="Checked In" value={used} tone={{ bar: '#10B981', soft: '#ECFDF5' }} />
              <Stat icon={<XCircle className="w-5 h-5" />} label="Not Checked" value={missed} tone={{ bar: '#EF4444', soft: '#FEF2F2' }} />
              <Stat icon={<QrCode className="w-5 h-5" />} label="Hours Used" value={`${usedPct}%`} sub={`${hrs(usedH)} of ${hrs(schedH)} scheduled`} tone={{ bar: '#12408F', soft: '#EAF1FC' }} />
            </div>

            {/* Scheduled vs actual */}
            <section className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[#EEF2F8]">
                <h2 className="text-[15px] font-bold text-[#0B2A5B]">Scheduled vs. Actual Usage</h2>
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={`${data?.date}|${view}`}
                  initial={reduceMotion ? false : { opacity: 0 }} animate={{ opacity: 1, transition: { duration: 0.3, ease: EASE } }}
                  exit={{ opacity: 0, transition: { duration: 0.2 } }}>
                  {rows.length === 0 ? (
                    <p className="px-5 py-12 text-center text-sm text-[#94A3B8]">No classes or check-ins in this period.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm min-w-[720px]">
                        <thead>
                          <tr className="bg-[#F8FAFC] border-b border-[#EEF2F8] text-left text-[12px] font-semibold text-[#475569]">
                            <th className="px-5 py-3">Date</th>
                            <th className="px-3 py-3">Schedule</th>
                            <th className="px-3 py-3">Subject</th>
                            <th className="px-3 py-3">Instructor</th>
                            <th className="px-3 py-3">QR Scan</th>
                            <th className="px-3 py-3">Hours</th>
                            <th className="px-5 py-3">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <motion.tr key={r.key}
                              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                              animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 12) * 0.035 } }}
                              className="border-b border-[#F1F5F9] last:border-0 hover:bg-[#F8FBFF]">
                              <td className="px-5 py-3 whitespace-nowrap text-[#334155]">{fmtDate(r.date, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                              <td className="px-3 py-3 whitespace-nowrap font-medium text-[#0B2A5B]">{fmt12(r.start)}{r.end ? ` – ${fmt12(r.end)}` : ''}</td>
                              <td className="px-3 py-3">
                                {r.subject_code
                                  ? <><p className="font-medium text-[#0B2A5B]">{r.subject_code}{r.component === 'lab' ? ' Lab' : ''}</p><p className="text-xs text-[#64748B]">{r.block}</p></>
                                  : <span className="text-[#64748B]">Walk-in</span>}
                              </td>
                              <td className="px-3 py-3 text-[#334155] whitespace-nowrap">{r.faculty_name || '—'}</td>
                              <td className="px-3 py-3 whitespace-nowrap">
                                {r.scan_time
                                  ? <span className="font-semibold text-[#0B2A5B]">{fmt12(r.scan_time)} <span className={`text-xs ${r.late ? 'text-amber-600' : 'text-emerald-600'}`}>{r.late ? 'Late' : 'On time'}</span></span>
                                  : <span className="text-[#94A3B8]">—</span>}
                              </td>
                              <td className="px-3 py-3 whitespace-nowrap text-[#334155] tabular-nums">
                                {r.hours_scheduled ? `${Math.round(r.hours_used * 10) / 10} / ${Math.round(r.hours_scheduled * 10) / 10}` : hrs(r.hours_used)}
                              </td>
                              <td className="px-5 py-3"><RowStatusPill status={r.status} /></td>
                            </motion.tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </section>

            {/* QR scan logs */}
            <section className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] overflow-hidden">
              <div className="px-5 py-4 border-b border-[#EEF2F8]">
                <h2 className="text-[15px] font-bold text-[#0B2A5B]">QR Scan Logs</h2>
              </div>
              {(data?.logs ?? []).length === 0 ? (
                <p className="px-5 py-10 text-center text-sm text-[#94A3B8]">No QR scans in this period.</p>
              ) : (
                <ul className="divide-y divide-[#F1F5F9] max-h-[420px] overflow-y-auto">
                  {data!.logs.map(l => {
                    const ok = l.status === 'Valid';
                    const late = l.status === 'Late';
                    return (
                      <li key={l.id} className="flex items-start gap-3 px-5 py-3">
                        <span className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${ok ? 'bg-emerald-50 text-emerald-600' : late ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-500'}`}>
                          <QrCode className="w-4 h-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-[#0B2A5B]">
                            {l.faculty_name || 'Unknown'} <span className="font-normal text-[#64748B]">· {fmtDate(l.scan_date, { weekday: 'short', month: 'short', day: 'numeric' })}, {fmt12(l.scan_hm)}</span>
                          </p>
                          {l.notes && <p className="text-xs text-[#64748B] mt-0.5">{l.notes}</p>}
                        </div>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${
                          ok ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : late ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-red-50 text-red-600 border-red-200'
                        }`}>{l.status}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
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
