'use client';

/**
 * "Classes Without a Room" — a summary card for Room Management that opens a
 * centred pop-up listing faculty whose scheduled classes (day + time set) still
 * have no room. Each class lists the rooms it may use that are free in
 * its slot; a room can be set for one class, for one faculty member's classes,
 * or for every class at once ("Assign rooms automatically"). The server only
 * uses a room when no class is booked in it at that time.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, BookOpen, CheckCircle2, ChevronRight, Clock, DoorOpen, Loader2, Monitor, Search, Wand2, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import FriendlySelect from '@/components/ui/FriendlySelect';
import { useRealtime } from '@/context/RealtimeContext';
import { useToast } from '@/context/ToastContext';

interface FreeRoom {
  id: number; name: string;
  /** Why it is offered first: the class's room on other days, the teacher's or the subject's usual room */
  note: 'class' | 'faculty' | 'subject' | null;
}
interface Session {
  id: number; day: string; start_time: string; end_time: string; type: string; ms_id: number;
  subject_code: string; subject_name: string; program_code: string | null; year_level: string | null; block_name: string | null;
  /** Rooms the class may use with no class at this time, best first */
  free_rooms: FreeRoom[];
  /** What "Assign rooms automatically" would give this class (none when only special rooms are free) */
  suggested_room_id: number | null;
}

const NOTE_LABEL: Record<NonNullable<FreeRoom['note']>, string> = {
  class: 'Its room on other days',
  faculty: "This teacher's usual room",
  subject: 'Usual room for this subject',
};
interface FacultyGroup { faculty_id: number | null; faculty_name: string; employee_id: string | null; sessions: Session[] }
interface Data { faculty: FacultyGroup[]; total_sessions: number; no_room_available: number }
interface AssignResult {
  assigned: { session_id: number; subject_code: string; day: string; start_time: string; room_name: string }[];
  skipped: { session_id: number; subject_code: string; day: string; start_time: string; reason: string }[];
}

const EASE = [0.4, 0, 0.2, 1] as const;
const WHITE = { color: '#FFFFFF' } as const;
const fmt12 = (t: string) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const block = (s: Session) => [s.program_code, `${String(s.year_level ?? '').match(/\d+/)?.[0] ?? ''}${s.block_name ?? ''}`].filter(Boolean).join(' ');
const classes = (n: number) => `${n} ${n === 1 ? 'class' : 'classes'}`;
const keyOf = (f: FacultyGroup) => String(f.faculty_id ?? 'none');

/** "Assign rooms automatically" — the one big action, with what it does */
function AutoAssignBar({ count, scope, busy, onClick }: {
  count: number; scope: string; busy: boolean; onClick: () => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="rounded-xl border border-[#BFD3F5] bg-[#F5F9FF] px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
      <span className="w-10 h-10 rounded-xl bg-white border border-[#D6E3F8] flex items-center justify-center flex-shrink-0 text-[#1D5BD6]">
        <Wand2 className="w-5 h-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-bold text-[#0B2A5B]">Assign rooms automatically</p>
        <p className="text-[13px] text-[#475569]">
          Gives {scope} a free room — only rooms with no class at that time, keeping classes in their usual rooms when it can.
        </p>
      </div>
      <motion.button
        type="button"
        onClick={onClick}
        disabled={busy || count === 0}
        whileTap={reduceMotion || busy ? undefined : { scale: 0.96 }}
        className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl text-sm font-bold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        style={WHITE}
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" style={WHITE} /> : <Wand2 className="w-4 h-4" style={WHITE} />}
        {busy ? 'Assigning…' : `Assign ${classes(count)}`}
      </motion.button>
    </div>
  );
}

export default function UnassignedRoomsPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const reduceMotion = useReducedMotion();
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [pickedKey, setPickedKey] = useState<string | null>(null); // faculty window
  const [search, setSearch] = useState('');
  /** Room picked on screen per class (falls back to the suggestion) */
  const [choice, setChoice] = useState<Record<number, string>>({});
  /** What is being saved: 'all', 'faculty', or a class id */
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = useCallback(() => fetch('/api/rooms/unassigned', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then((d: Data | null) => { if (d) setData(d); })
    .catch(() => {}), []);
  useEffect(() => { load(); }, [load, refreshKey]);
  // Live updates: classes got a room (or lost one) elsewhere
  useRealtime(['schedule', 'rooms'], load);

  // The faculty window follows the live list, and closes once all their classes have a room
  const picked = useMemo(
    () => (pickedKey ? (data?.faculty ?? []).find(f => keyOf(f) === pickedKey) ?? null : null),
    [data, pickedKey],
  );
  useEffect(() => {
    if (pickedKey && data && !picked) setPickedKey(null);
  }, [pickedKey, data, picked]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.faculty ?? []).filter(f => !q || f.faculty_name.toLowerCase().includes(q)
      || f.sessions.some(s => s.subject_code.toLowerCase().includes(q)));
  }, [data, search]);

  const total = data?.total_sessions ?? 0;
  const facultyCount = data?.faculty.length ?? 0;
  const blocked = data?.no_room_available ?? 0;
  const allSessions = useMemo(() => (data?.faculty ?? []).flatMap(f => f.sessions), [data]);
  const assignable = allSessions.filter(s => s.suggested_room_id != null).length;
  const hasIssues = total > 0;
  const tone = hasIssues ? '#EA580C' : '#059669';

  /** The room picked for a class — the suggestion until another free room is chosen
   *  (a pick that is no longer free falls back to the suggestion; no suggestion = choose one) */
  const roomChoice = (s: Session) => {
    const picked = choice[s.id];
    if (picked && s.free_rooms.some(r => String(r.id) === picked)) return picked;
    return s.suggested_room_id != null ? String(s.suggested_room_id) : '';
  };

  /** Save rooms, then report what happened in plain words */
  async function save(body: Record<string, unknown>, busyKey: string): Promise<AssignResult | null> {
    setBusy(busyKey);
    try {
      const res = await fetch('/api/rooms/unassigned', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Could not set the room.'); await load(); return null; }
      await load();
      return d as AssignResult;
    } catch {
      toast.error('Connection error. Please try again.');
      return null;
    } finally {
      setBusy(null);
    }
  }

  function report(r: AssignResult) {
    if (r.assigned.length === 1) {
      const a = r.assigned[0];
      toast.success(`${a.subject_code} · ${a.day} ${fmt12(a.start_time)} → ${a.room_name}`);
    } else if (r.assigned.length > 1) {
      toast.success(`${classes(r.assigned.length)} got a room.`);
    }
    if (r.skipped.length === 1) {
      const s = r.skipped[0];
      toast.warning(`${s.subject_code} · ${s.day} ${fmt12(s.start_time)} still has no room. ${s.reason}`);
    } else if (r.skipped.length > 1) {
      toast.warning(`${classes(r.skipped.length)} still have no room — no suitable room is free at their time.`);
    }
    if (r.assigned.length === 0 && r.skipped.length === 0) toast.info('Every class already has a room.');
  }

  async function setRoom(s: Session) {
    const roomId = Number(roomChoice(s));
    if (!roomId) return;
    const r = await save({ session_id: s.id, room_id: roomId }, String(s.id));
    if (r) report(r);
  }

  async function assignFaculty(f: FacultyGroup) {
    const r = await save({ auto: true, faculty_id: f.faculty_id }, 'faculty');
    if (r) report(r);
  }

  async function assignAll() {
    const r = await save({ auto: true }, 'all');
    setConfirmAll(false);
    if (r) report(r);
  }

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
                ? <>{facultyCount} faculty · {classes(total)} scheduled but not yet given a room{blocked > 0 && <> · <b className="text-[#DC2626]">{blocked} with no free room</b></>}</>
                : 'Every scheduled class has a room.'}
          </span>
        </span>
        <span className="text-3xl font-bold tabular-nums" style={{ color: tone }}>{data ? total : '–'}</span>
        <ChevronRight className="w-5 h-5 flex-shrink-0" style={{ color: tone }} />
      </motion.button>

      {/* ── Pop-up: every faculty with classes that need a room ── */}
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

            <AutoAssignBar count={assignable} scope="every class" busy={busy === 'all'} onClick={() => setConfirmAll(true)} />

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
                const stuck = f.sessions.filter(x => x.free_rooms.length === 0).length;
                return (
                  <motion.li key={keyOf(f)}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 8) * 0.04 } }}>
                    <motion.button type="button" onClick={() => setPickedKey(keyOf(f))}
                      whileHover={reduceMotion ? undefined : { y: -2, boxShadow: '0 12px 24px -16px rgba(29,91,214,0.6)' }}
                      whileTap={reduceMotion ? undefined : { scale: 0.99 }}
                      className="group w-full flex items-center gap-3 px-4 py-3 text-left rounded-2xl border border-[#E3E9F3] bg-white hover:border-[#BFD3F5] transition-colors">
                      <span className="w-10 h-10 rounded-full bg-[#EFF6FF] text-[#1D5BD6] text-xs font-bold flex items-center justify-center flex-shrink-0">
                        {f.faculty_name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-bold text-[#0B2A5B] truncate">{f.faculty_name}</span>
                        <span className="block text-xs text-[#64748B]">
                          {f.employee_id ? `${f.employee_id} · ` : ''}{classes(f.sessions.length)} without a room
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

      {/* ── Confirm: every class at once ── */}
      <Modal open={confirmAll} onClose={() => { if (busy !== 'all') setConfirmAll(false); }} title="Assign rooms automatically?" icon={Wand2} size="sm"
        footer={
          <div className="flex gap-3">
            <motion.button type="button" onClick={() => setConfirmAll(false)} disabled={busy === 'all'}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="flex-1 border border-[#E2E8F0] text-[#64748B] py-2.5 rounded-xl text-sm font-semibold hover:bg-[#F8FAFC] transition disabled:opacity-50">
              Cancel
            </motion.button>
            <motion.button type="button" onClick={assignAll} disabled={busy === 'all'}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-[#1D5BD6] hover:bg-[#164BB5] transition disabled:opacity-60 flex items-center justify-center gap-2"
              style={WHITE}>
              {busy === 'all' ? <><Loader2 className="w-4 h-4 animate-spin" style={WHITE} /> Assigning…</> : 'Assign rooms'}
            </motion.button>
          </div>
        }>
        <div className="space-y-3 text-[15px] text-[#334155]">
          <p><b className="text-[#0B2A5B]">{classes(assignable)}</b> will each get a free room.</p>
          <ul className="list-disc pl-5 space-y-1 text-sm text-[#475569]">
            <li>Only rooms with no class booked at that time are used.</li>
            <li>Each class first gets the room it uses on other days, then its teacher&apos;s usual room, then its subject&apos;s — whichever is free.</li>
            <li>Lab classes get laboratories. Special rooms such as a gym are left for the classes held there.</li>
          </ul>
          {total - assignable > 0 && (
            <p className="flex items-start gap-2 text-sm font-semibold text-[#B45309]">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {classes(total - assignable)} will stay without a room — no suitable room is free at {total - assignable === 1 ? 'its' : 'their'} time.
            </p>
          )}
        </div>
      </Modal>

      {/* ── One faculty member's classes, in its own centred window ── */}
      <Modal open={!!picked} onClose={() => setPickedKey(null)}
        title={picked?.faculty_name ?? ''}
        subtitle={picked ? `${picked.employee_id ? `${picked.employee_id} · ` : ''}${classes(picked.sessions.length)} without a room` : undefined}
        icon={DoorOpen} size="lg">
        {picked && (() => {
          const canAuto = picked.sessions.filter(s => s.suggested_room_id != null).length;
          return (
          <div className="space-y-4">
            {canAuto > 0 && (
              <AutoAssignBar count={canAuto} scope={picked.sessions.length === 1 ? 'this class' : 'each of these classes'}
                busy={busy === 'faculty'} onClick={() => assignFaculty(picked)} />
            )}

            <ul className="space-y-2.5">
              <AnimatePresence initial={false}>
              {picked.sessions.map((x, i) => {
                const lab = x.type === 'lab';
                const none = x.free_rooms.length === 0;
                const saving = busy === String(x.id);
                return (
                  <motion.li key={x.id} layout
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 8) * 0.05 } }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24, transition: { duration: 0.25, ease: EASE } }}
                    className="rounded-xl border px-4 py-3"
                    style={none ? { borderColor: '#FECACA', backgroundColor: '#FFF5F5' } : { borderColor: '#E3E9F3', backgroundColor: '#FFFFFF' }}>
                    {/* When and what */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="inline-flex items-center gap-1.5 text-[15px] font-bold text-[#0B2A5B]">
                        <Clock className="w-4 h-4 text-[#1D5BD6]" /> {x.day} · {fmt12(x.start_time)} – {fmt12(x.end_time)}
                      </span>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[12px] font-semibold"
                        style={lab ? { backgroundColor: '#FFFBEB', color: '#B45309' } : { backgroundColor: '#EFF6FF', color: '#1D5BD6' }}>
                        {lab ? <Monitor className="w-3.5 h-3.5" /> : <BookOpen className="w-3.5 h-3.5" />}{lab ? 'Laboratory' : 'Lecture'}
                      </span>
                    </div>
                    <p className="mt-1 text-sm">
                      <b className="text-[#0B2A5B]">{x.subject_code}</b> <span className="text-[#475569]">{x.subject_name}</span>
                      <span className="text-xs text-[#94A3B8]"> · {block(x)}</span>
                    </p>

                    {/* The room */}
                    <div className="mt-3 pt-3 border-t border-[#EEF2F7]">
                      {none ? (
                        <span className="inline-flex items-start gap-1.5 text-sm font-semibold text-[#B91C1C]">
                          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> No {lab ? 'laboratory' : 'room'} is free at this time — move the class to another time.
                        </span>
                      ) : (
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
                          <span className="text-xs font-semibold uppercase tracking-wide text-[#475569] sm:w-14">Room</span>
                          <div className="flex-1 min-w-0">
                            <FriendlySelect
                              value={roomChoice(x)}
                              onChange={v => setChoice(c => ({ ...c, [x.id]: v }))}
                              label={`Room for ${x.subject_code} on ${x.day}`}
                              searchable={x.free_rooms.length > 8}
                              searchPlaceholder="Type a room…"
                              placeholder="Choose a room"
                              minPanelWidth={280}
                              options={x.free_rooms.map(r => ({
                                value: String(r.id),
                                label: r.name,
                                hint: [r.id === x.suggested_room_id ? 'Suggested' : '', r.note ? NOTE_LABEL[r.note] : ''].filter(Boolean).join(' · ') || undefined,
                              }))}
                            />
                          </div>
                          <motion.button type="button" onClick={() => setRoom(x)} disabled={!!busy || !roomChoice(x)}
                            whileTap={reduceMotion || busy ? undefined : { scale: 0.96 }}
                            className="inline-flex items-center justify-center gap-1.5 h-12 px-5 rounded-xl text-sm font-bold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                            style={WHITE}>
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" style={WHITE} /> : <CheckCircle2 className="w-4 h-4" style={WHITE} />}
                            {saving ? 'Saving…' : 'Set room'}
                          </motion.button>
                        </div>
                      )}
                    </div>
                  </motion.li>
                );
              })}
              </AnimatePresence>
            </ul>
            {picked.faculty_id && (
              <div className="pt-1 text-right">
                <Link href={`/faculty-schedules?facultyId=${picked.faculty_id}`}
                  className="group inline-flex items-center gap-1.5 h-10 px-4 rounded-xl text-sm font-semibold border border-[#BFDBFE] text-[#1D5BD6] bg-white hover:bg-[#EFF6FF] transition-colors">
                  Open schedule <ChevronRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            )}
          </div>
          );
        })()}
      </Modal>
    </>
  );
}
