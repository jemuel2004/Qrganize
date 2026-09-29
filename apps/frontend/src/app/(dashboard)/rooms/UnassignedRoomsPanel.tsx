'use client';

/**
 * "Classes Without a Room" — a summary card for Room Management that opens a
 * centred pop-up listing faculty whose scheduled classes (day + time set) still
 * have no room, with the rooms of the right type that are free in each slot.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, BookOpen, CheckCircle2, ChevronRight, Clock, DoorOpen, Monitor, Search, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';

interface Session {
  id: number; day: string; start_time: string; end_time: string; type: string; ms_id: number;
  subject_code: string; subject_name: string; program_code: string | null; year_level: string | null; block_name: string | null;
  free_rooms: string[];
}
interface FacultyGroup { faculty_id: number | null; faculty_name: string; employee_id: string | null; sessions: Session[] }
interface Data { faculty: FacultyGroup[]; total_sessions: number; no_room_available: number }

const EASE = [0.4, 0, 0.2, 1] as const;
const fmt12 = (t: string) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const block = (s: Session) => [s.program_code, `${String(s.year_level ?? '').match(/\d+/)?.[0] ?? ''}${s.block_name ?? ''}`].filter(Boolean).join(' ');

export default function UnassignedRoomsPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const reduceMotion = useReducedMotion();
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<FacultyGroup | null>(null); // faculty window
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    fetch('/api/rooms/unassigned', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setData(d); })
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.faculty ?? []).filter(f => !q || f.faculty_name.toLowerCase().includes(q)
      || f.sessions.some(s => s.subject_code.toLowerCase().includes(q)));
  }, [data, search]);

  const total = data?.total_sessions ?? 0;
  const facultyCount = data?.faculty.length ?? 0;
  const blocked = data?.no_room_available ?? 0;
  const hasIssues = total > 0;
  const tone = hasIssues ? '#EA580C' : '#059669';

  return (
    <>
      {/* ── Summary card ── */}
      <motion.button
        type="button"
        onClick={() => { setOpen(true); load(); }}
        disabled={!data}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } }}
        whileHover={reduceMotion ? undefined : { y: -3, boxShadow: `0 16px 30px -18px ${tone}` }}
        whileTap={reduceMotion ? undefined : { scale: 0.99 }}
        className="qr-stat-tint relative overflow-hidden w-full text-left rounded-2xl border-2 px-5 py-4 flex items-center gap-4 disabled:cursor-wait"
        style={{ background: `linear-gradient(135deg, ${tone}14 0%, #FFFFFF 70%)`, borderColor: `${tone}40` }}
      >
        <span className="relative w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: tone, color: '#FFFFFF' }}>
          {hasIssues ? <DoorOpen className="w-6 h-6" /> : <CheckCircle2 className="w-6 h-6" />}
          {hasIssues && !reduceMotion && (
            <motion.span aria-hidden className="absolute inset-0 rounded-2xl"
              animate={{ boxShadow: [`0 0 0 0 ${tone}66`, `0 0 0 10px ${tone}00`] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-bold text-[#0B2A5B]">Classes Without a Room</span>
          <span className="block text-sm text-[#64748B] mt-0.5">
            {!data ? 'Checking…'
              : hasIssues
                ? <>{facultyCount} faculty · {total} {total === 1 ? 'class' : 'classes'} scheduled but not yet given a room{blocked > 0 && <> · <b className="text-[#DC2626]">{blocked} with no free room</b></>}</>
                : 'Every scheduled class has a room.'}
          </span>
        </span>
        <span className="text-3xl font-bold tabular-nums" style={{ color: tone }}>{data ? total : '–'}</span>
        <ChevronRight className="w-5 h-5 flex-shrink-0" style={{ color: tone }} />
      </motion.button>

      {/* ── Pop-up ── */}
      <Modal open={open} onClose={() => setOpen(false)} title="Classes Without a Room" subtitle="Scheduled classes that still need a room" icon={DoorOpen} size="lg">
        {!data ? null : total === 0 ? (
          <div className="py-10 flex flex-col items-center text-center">
            <CheckCircle2 className="w-12 h-12 text-[#10B981] mb-3" />
            <p className="font-semibold text-[#0B2A5B]">All set</p>
            <p className="text-sm text-[#64748B] mt-1">Every scheduled class already has a room.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              {[
                ['Faculty', facultyCount, '#1D5BD6'],
                ['Classes', total, '#EA580C'],
                ['No free room', blocked, '#DC2626'],
              ].map(([k, v, c]) => (
                <div key={String(k)} className="rounded-xl border px-4 py-3" style={{ borderColor: `${c}33`, backgroundColor: `${c}0D` }}>
                  <p className="text-xs font-semibold text-[#64748B]">{k}</p>
                  <p className="text-2xl font-bold tabular-nums" style={{ color: String(c) }}>{v}</p>
                </div>
              ))}
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search faculty or subject"
                className="w-full h-11 rounded-xl border border-[#D6E0EF] bg-white pl-9 pr-9 text-sm text-[#0B2A5B] focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/25 focus:border-[#1D5BD6]" />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#94A3B8] hover:text-[#0B2A5B]">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <ul className="space-y-2.5">
              {list.map((f, i) => {
                const key = String(f.faculty_id ?? 'none');
                const stuck = f.sessions.filter(x => x.free_rooms.length === 0).length;
                return (
                  <motion.li key={key}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 8) * 0.04 } }}>
                    <motion.button type="button" onClick={() => setPicked(f)}
                      whileHover={reduceMotion ? undefined : { y: -2, boxShadow: '0 12px 24px -16px rgba(29,91,214,0.6)' }}
                      whileTap={reduceMotion ? undefined : { scale: 0.99 }}
                      className="group w-full flex items-center gap-3 px-4 py-3 text-left rounded-2xl border border-[#E3E9F3] bg-white hover:border-[#BFD3F5] transition-colors">
                      <span className="w-10 h-10 rounded-full bg-[#EFF6FF] text-[#1D5BD6] text-xs font-bold flex items-center justify-center flex-shrink-0">
                        {f.faculty_name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-bold text-[#0B2A5B] truncate">{f.faculty_name}</span>
                        <span className="block text-xs text-[#64748B]">
                          {f.employee_id ? `${f.employee_id} · ` : ''}{f.sessions.length} {f.sessions.length === 1 ? 'class' : 'classes'} without a room
                        </span>
                      </span>
                      {stuck > 0 && (
                        <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-[#FEF2F2] text-[#B91C1C] whitespace-nowrap">{stuck} no free room</span>
                      )}
                      <ChevronRight className="w-5 h-5 text-[#1D5BD6] transition-transform group-hover:translate-x-0.5" />
                    </motion.button>
                  </motion.li>
                );
              })}
              {list.length === 0 && <li className="py-8 text-center text-sm text-[#94A3B8]">No match.</li>}
            </ul>
          </div>
        )}
      </Modal>

      {/* ── One faculty member's classes, in its own centred window ── */}
      <Modal open={!!picked} onClose={() => setPicked(null)}
        title={picked?.faculty_name ?? ''}
        subtitle={picked ? `${picked.employee_id ? `${picked.employee_id} · ` : ''}${picked.sessions.length} ${picked.sessions.length === 1 ? 'class' : 'classes'} without a room` : undefined}
        icon={DoorOpen} size="lg">
        {picked && (
          <div className="space-y-3">
            <ul className="space-y-2.5">
              {picked.sessions.map((x, i) => {
                const lab = x.type === 'lab';
                const none = x.free_rooms.length === 0;
                return (
                  <motion.li key={x.id}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 8) * 0.05 } }}
                    className="rounded-xl border px-4 py-3"
                    style={none ? { borderColor: '#FECACA', backgroundColor: '#FFF5F5' } : { borderColor: '#E3E9F3', backgroundColor: '#FFFFFF' }}>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#0B2A5B]">
                        <Clock className="w-4 h-4 text-[#1D5BD6]" /> {x.day} · {fmt12(x.start_time)}–{fmt12(x.end_time)}
                      </span>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold"
                        style={lab ? { backgroundColor: '#FFFBEB', color: '#B45309' } : { backgroundColor: '#EFF6FF', color: '#1D5BD6' }}>
                        {lab ? <Monitor className="w-3 h-3" /> : <BookOpen className="w-3 h-3" />}{lab ? 'Lab' : 'Lecture'}
                      </span>
                    </div>
                    <p className="mt-1 text-sm"><b className="text-[#0B2A5B]">{x.subject_code}</b> <span className="text-[#475569]">{x.subject_name}</span> <span className="text-xs text-[#94A3B8]">· {block(x)}</span></p>
                    <div className="mt-2 text-xs">
                      {none ? (
                        <span className="inline-flex items-center gap-1.5 font-semibold text-[#B91C1C]">
                          <AlertTriangle className="w-3.5 h-3.5" /> No {lab ? 'laboratory' : 'lecture'} room is free at this time — move the class to another time.
                        </span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-[#047857] mr-0.5">Free now:</span>
                          {x.free_rooms.map(r => (
                            <span key={r} className="px-2 py-0.5 rounded-md font-semibold border"
                              style={lab ? { backgroundColor: '#FFFBEB', color: '#B45309', borderColor: '#FDE68A' } : { backgroundColor: '#EFF6FF', color: '#1D5BD6', borderColor: '#BFDBFE' }}>{r}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.li>
                );
              })}
            </ul>
            {picked.faculty_id && (
              <div className="pt-1 text-right">
                <Link href={`/faculty-schedules?facultyId=${picked.faculty_id}`}
                  className="group inline-flex items-center gap-1.5 h-10 px-4 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors"
                  style={{ color: '#FFFFFF' }}>
                  Open schedule <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
