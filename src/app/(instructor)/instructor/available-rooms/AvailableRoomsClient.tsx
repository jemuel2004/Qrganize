'use client';

import React, { useState, useCallback, useEffect } from 'react';
import {
  Search, CheckCircle2, XCircle, AlertTriangle, Loader2,
  Users, Monitor, BookOpen, CalendarDays, Building2,
} from 'lucide-react';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import BackButton from '@/client/components/ui/BackButton';
import { FiltersSkeleton, ListSkeleton } from '@/client/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ROOM_TYPES = [
  { value: 'all',        label: 'All Types' },
  { value: 'Lecture',    label: 'Lecture' },
  { value: 'Laboratory', label: 'Laboratory' },
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

const inputClass =
  'w-full bg-white border border-[#E2E8F0] text-[#0B2A5B] text-sm font-medium rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/30 focus:border-[#1D5BD6]';

export default function AvailableRoomsClient() {
  const [day,       setDay]       = useState('Monday');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime,   setEndTime]   = useState('09:00');
  const [roomType,  setRoomType]  = useState('all');
  const [rooms,     setRooms]     = useState<Room[] | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [searched,  setSearched]  = useState(false);
  const [booting,   setBooting]   = useState(true);
  useEffect(() => { setBooting(false); }, []);
  const showSkeleton = useMinLoading(booting || (loading && !rooms), LOADING_DELAY);

  const handleSearch = useCallback(async () => {
    if (!day || !startTime || !endTime) return;
    if (startTime >= endTime) {
      setError('End time must be after start time.');
      return;
    }
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const params = new URLSearchParams({ day, start_time: startTime, end_time: endTime, room_type: roomType });
      const res = await fetch(`/api/instructor/available-rooms?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Error ${res.status}`);
      }
      const json = await res.json();
      setRooms(json.rooms ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [day, startTime, endTime, roomType]);

  const available   = rooms?.filter(r => r.is_available)   ?? [];
  const unavailable = rooms?.filter(r => !r.is_available)  ?? [];

  return (
    <div className="min-h-full bg-[#F8FAFC] p-4 sm:p-6 lg:p-8 overflow-x-hidden min-w-0">
      {/* ── Header ────────────────────────────────────────────────── */}
      <div className="mb-6">
        <BackButton />
        <h1 className="text-2xl font-bold text-[#0B2A5B]">Find Available Rooms</h1>
      </div>

      {/* ── Filter panel ──────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-4 sm:p-6 mb-5 min-w-0">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 bg-[#EFF6FF] rounded-lg flex items-center justify-center">
            <Search className="w-3.5 h-3.5 text-[#1D5BD6]" />
          </div>
          <span className="font-semibold text-[#0B2A5B] text-sm">Search Filters</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
          <div>
            <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">
              Day of Week
            </label>
            <select value={day} onChange={e => setDay(e.target.value)} className={inputClass}>
              {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">
              From
            </label>
            <input
              type="time"
              value={startTime}
              onChange={e => setStartTime(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">
              To
            </label>
            <input
              type="time"
              value={endTime}
              onChange={e => setEndTime(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#64748B] uppercase tracking-wide mb-1.5">
              Room Type
            </label>
            <div className="flex flex-wrap gap-1.5">
              {ROOM_TYPES.map(rt => (
                <button
                  key={rt.value}
                  type="button"
                  onClick={() => setRoomType(rt.value)}
                  className={`flex-1 min-w-[5.5rem] min-h-11 px-2 py-2.5 rounded-xl text-xs font-semibold transition-colors border ${
                    roomType === rt.value
                      ? 'bg-[#1D5BD6] text-white border-[#1D5BD6] shadow-sm'
                      : 'bg-white text-[#0B2A5B] border-[#E2E8F0] hover:bg-[#F8FAFC] active:bg-[#F1F5F9]'
                  }`}
                >
                  {rt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={handleSearch}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 w-full sm:w-auto min-h-11 bg-[#1D5BD6] hover:bg-[#2E7DD1] active:bg-[#2670BD] disabled:opacity-50 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-colors shadow-sm"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {loading ? 'Searching…' : 'Search Rooms'}
        </button>
      </div>

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
                {day} · {fmt12(startTime)} – {fmt12(endTime)}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {available.map(room => (
                <div
                  key={room.id}
                  className="bg-white border border-[#E2E8F0] rounded-2xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-9 h-9 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center flex-shrink-0">
                        {room.room_type === 'Laboratory'
                          ? <Monitor className="w-4 h-4 text-[#1D5BD6]" />
                          : <BookOpen className="w-4 h-4 text-[#1D5BD6]" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-base font-bold text-[#0B2A5B] leading-tight break-words">{room.room_name}</p>
                        <p className="text-xs text-[#1D5BD6] font-semibold mt-0.5">{room.room_type}</p>
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
                  </div>
                </div>
              ))}

              {unavailable.map(room => (
                <div
                  key={room.id}
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
                </div>
              ))}
            </div>
          )}
        </>
      )}
      </PageLoadTransition>
    </div>
  );
}
