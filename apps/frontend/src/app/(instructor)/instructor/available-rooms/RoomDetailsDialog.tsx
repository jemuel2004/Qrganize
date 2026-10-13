'use client';

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, CheckCircle2, Monitor } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { useRealtime } from '@/context/RealtimeContext';
import { fmt12 } from '@/lib/scheduleTime';
import { releaseDateLabel, type ReleasedRoom } from '@/lib/roomRelease';

/** The room a card shows (Find Available Rooms) */
export interface RoomSummary {
  id: number;
  room_name: string;
  room_type: string;
  building: string | null;
  capacity: number | null;
}

/** A today-only room request for this room (GET …/schedule when the day is today) */
interface RoomReservation {
  faculty_name: string | null;
  subject_code: string | null;
  block: string;
  start_time: string;
  end_time: string;
  status: string;
  is_mine: boolean;
}

interface RoomClass {
  ms_id: number;
  subject_code: string;
  subject_name: string;
  block: string;
  faculty_name: string | null;
  start_time: string;
  end_time: string;
  is_mine: boolean;
  releases: { date: string; reason: string | null }[];
  /** Today: not checked in within 15 minutes of the start — anyone may use the room until it ends */
  unclaimed?: boolean;
}
type Status =
  | { state: 'Available' }
  | { state: 'Pending' | 'Occupied'; faculty_name: string | null; is_mine: boolean; since: string | null; until: string | null };

const WHITE = { color: '#FFFFFF' } as const;

/** ISO timestamp → "7:05 AM" (Manila) */
function clockOf(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
}
/** "Fri, Oct 16" */
const shortDate = (date: string) => releaseDateLabel(date).replace(/, \d{4}$/, '');

/** One line of the day: a class in the room, a room request for today, or the time that was searched for */
type Row =
  | { kind: 'class'; start: string; end: string; c: RoomClass }
  | { kind: 'reserved'; start: string; end: string; r: RoomReservation }
  | { kind: 'slot'; start: string; end: string };

/**
 * A room's details from Find Available Rooms: who is using it right now, and
 * the searched day as a timetable — the classes meeting in it, with the time
 * that was searched for placed among them. Opened from a "free on a date"
 * card it also says when it is free.
 */
export default function RoomDetailsDialog({
  room, day, slot, freeOn, onClose, onRequest, requestNote, reservationsToday = false,
}: {
  /** null = closed */
  room: RoomSummary | null;
  day: string;
  /** The time that was searched for ('HH:MM'), shown in its place among the classes */
  slot?: { start: string; end: string } | null;
  /** Opened from a room made available on a date */
  freeOn?: ReleasedRoom | null;
  onClose: () => void;
  /** Rooms that can be requested (free today at the searched time) */
  onRequest?: () => void;
  /** Shown instead of the request button (e.g. a day other than today) */
  requestNote?: string | null;
  /** The day is today: today's room requests for the room are shown too */
  reservationsToday?: boolean;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [classes, setClasses] = useState<RoomClass[] | null>(null);
  const [reservations, setReservations] = useState<RoomReservation[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!room) return;
    const res = await fetch(`/api/instructor/rooms/${room.id}/schedule?day=${encodeURIComponent(day)}`, { cache: 'no-store', signal });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Could not load this room.');
    setStatus(d.status ?? null);
    setClasses(Array.isArray(d.classes) ? d.classes : []);
    setReservations(Array.isArray(d.reservations) ? d.reservations : []);
    setError('');
  }, [room, day]);

  useEffect(() => {
    if (!room) return;
    setStatus(null); setClasses(null); setReservations([]); setError('');
    const ctrl = new AbortController();
    load(ctrl.signal).catch(err => { if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load this room.'); });
    return () => ctrl.abort();
  }, [room, load]);

  // Someone checks in, reserves the room or a class moves while it is open — it updates quietly
  useRealtime(['occupancy', 'schedule', 'rooms', 'room-requests'], () => load().catch(() => {}), { enabled: !!room && classes !== null });

  const lab = room?.room_type === 'Laboratory';
  const sub = room ? [room.room_type, room.building, room.capacity ? `${room.capacity} seats` : null].filter(Boolean).join(' · ') : '';
  // The day in time order, with the searched time in its place
  // Today's reserved class times count among the day's classes
  const classCount = (classes?.length ?? 0) + (reservationsToday ? reservations.length : 0);
  const rows: Row[] = [
    ...(classes ?? []).map(c => ({ kind: 'class' as const, start: c.start_time, end: c.end_time, c })),
    ...(reservationsToday ? reservations : []).map(r => ({ kind: 'reserved' as const, start: r.start_time, end: r.end_time, r })),
    ...(slot ? [{ kind: 'slot' as const, start: slot.start, end: slot.end }] : []),
  ].sort((a, b) => a.start.localeCompare(b.start) || (a.kind === 'slot' ? 1 : b.kind === 'slot' ? -1 : 0));

  return (
    <Modal
      open={!!room}
      onClose={onClose}
      title={room?.room_name ?? ''}
      subtitle={sub}
      icon={lab ? Monitor : BookOpen}
      size="sm"
      footer={
        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2.5">
          {!onRequest && requestNote && (
            <p className="sm:mr-auto text-[14px] text-[color:var(--foreground-muted)] text-center sm:text-left">{requestNote}</p>
          )}
          <button type="button" onClick={onClose} className="min-h-12 px-5 rounded-xl text-base font-semibold bg-[var(--surface-elevated)] border border-[color:var(--border)] text-[color:var(--foreground-secondary)] hover:bg-[var(--background-secondary)] transition-colors">
            Close
          </button>
          {onRequest && (
            <button type="button" onClick={onRequest} className="min-h-12 px-5 rounded-xl text-base font-bold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors" style={WHITE}>
              Request This Room
            </button>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[15px] text-red-700">{error}</div>
        )}

        {/* Right now — one coloured line */}
        {!status ? (
          <div className="h-12 rounded-xl bg-[var(--background-secondary)] animate-pulse" />
        ) : status.state === 'Available' ? (
          <p className="flex items-center gap-2.5 rounded-xl border border-[#A7F3D0] bg-[#ECFDF5] px-4 py-3 text-[15px] font-bold text-[#047857]">
            <span className="w-2.5 h-2.5 rounded-full bg-[#10B981] flex-shrink-0" aria-hidden="true" /> Not in use right now
          </p>
        ) : (
          <p className={`flex items-center gap-2.5 rounded-xl border px-4 py-3 text-[15px] ${
            status.state === 'Occupied' ? 'border-[#BFDBFE] bg-[#EFF6FF] text-[#0B2A5B]' : 'border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]'
          }`}>
            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${status.state === 'Occupied' ? 'bg-[#1D5BD6]' : 'bg-[#F59E0B]'}`} aria-hidden="true" />
            <span>
              <span className="font-bold">{status.state === 'Occupied' ? 'In use now' : 'Reserved now'}</span>
              {' · '}{status.is_mine ? 'by you' : status.faculty_name || 'another faculty'}
              {clockOf(status.since) && <span className="opacity-75">, since {clockOf(status.since)}</span>}
            </span>
          </p>
        )}

        {freeOn && (
          <p className="rounded-xl border border-[#A7F3D0] bg-[#ECFDF5] px-4 py-3 text-[14px] text-[#065F46]">
            <span className="block text-[15px] font-bold text-[#047857]">Free only on {shortDate(freeOn.date)}</span>
            {freeOn.released_by ?? 'Its faculty'} made it available{freeOn.reason ? ` (${freeOn.reason})` : ''}. Scan the room&apos;s QR code then to use it.
          </p>
        )}

        {/* The searched day as a timetable */}
        <section>
          <h3 className="text-[15px] font-bold text-[color:var(--foreground)] mb-2">
            {day}
            {classes && <span className="font-medium text-[color:var(--foreground-muted)]"> · {classCount === 0 ? 'no classes' : `${classCount} class${classCount === 1 ? '' : 'es'}`}</span>}
          </h3>
          {!classes ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map(i => <div key={i} className="h-[58px] rounded-xl bg-[var(--background-secondary)] animate-pulse" />)}
            </div>
          ) : (
            <ul className="rounded-xl border border-[color:var(--border)] overflow-hidden divide-y divide-[color:var(--border)]">
              {rows.map(row => row.kind === 'reserved' ? (
                // Asked for today by a faculty member (room request)
                <li key={`r-${row.start}-${row.r.subject_code}`} className="flex gap-4 px-4 py-2.5 bg-[#FFFBEB]">
                  <span className="w-[86px] flex-shrink-0 leading-tight tabular-nums">
                    <span className="block text-[15px] font-bold text-[#92400E]">{fmt12(row.start)}</span>
                    <span className="block text-[13px] text-[#92400E]/80">to {fmt12(row.end)}</span>
                  </span>
                  <span className="min-w-0 leading-tight">
                    <span className="block text-[15px] font-semibold text-[#92400E]">
                      Reserved today{row.r.subject_code ? <span className="font-normal"> · {row.r.subject_code}{row.r.block ? ` ${row.r.block}` : ''}</span> : null}
                    </span>
                    <span className="mt-0.5 block text-[14px] text-[#92400E]/90">{row.r.is_mine ? 'By you' : row.r.faculty_name || 'Another faculty'}</span>
                  </span>
                </li>
              ) : row.kind === 'slot' ? (
                // The time that was searched for
                <li key="slot" className="flex gap-4 px-4 py-2.5 bg-[#ECFDF5]">
                  <span className="w-[86px] flex-shrink-0 leading-tight tabular-nums">
                    <span className="block text-[15px] font-bold text-[#047857]">{fmt12(row.start)}</span>
                    <span className="block text-[13px] text-[#047857]/80">to {fmt12(row.end)}</span>
                  </span>
                  <span className="min-w-0 self-center inline-flex items-center gap-1.5 text-[15px] font-bold text-[#047857]">
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> Free for you
                  </span>
                </li>
              ) : (
                <li key={`${row.c.ms_id}-${row.start}`} className="flex gap-4 px-4 py-2.5" title={`${row.c.subject_code} ${row.c.subject_name}`}>
                  <span className="w-[86px] flex-shrink-0 leading-tight tabular-nums">
                    <span className="block text-[15px] font-bold text-[color:var(--foreground)]">{fmt12(row.start)}</span>
                    <span className="block text-[13px] text-[color:var(--foreground-muted)]">to {fmt12(row.end)}</span>
                  </span>
                  <span className="min-w-0 leading-tight">
                    <span className="block text-[15px] font-semibold text-[color:var(--foreground)]">
                      {row.c.subject_code} <span className="font-normal text-[color:var(--foreground-muted)]">· {row.c.block}</span>
                    </span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[14px] text-[color:var(--foreground-secondary)]">{row.c.is_mine ? 'Your class' : row.c.faculty_name || 'No faculty yet'}</span>
                      {row.c.releases.slice(0, 2).map(r => (
                        <span key={r.date} className="text-[12px] font-semibold px-2 py-px rounded-md border bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]">
                          Free {shortDate(r.date)}
                        </span>
                      ))}
                      {row.c.releases.length > 2 && <span className="text-[12px] font-semibold text-[#047857]">+{row.c.releases.length - 2} more</span>}
                      {row.c.unclaimed && !row.c.is_mine && (
                        <span className="text-[12px] font-semibold px-2 py-px rounded-md border bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]">
                          Free now · not scanned
                        </span>
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
