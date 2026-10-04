'use client';

/**
 * "Lec + Lab in Two Rooms" — a Room Management card for Major classes whose
 * Lecture and Laboratory still use two rooms (saved before the one-room rule,
 * e.g. by the Excel workload import). It opens the list of those classes with
 * the one laboratory each can move into; one button moves them all. Only rooms
 * change — days and times stay — and a room is only used where no other class
 * is in it then (checked again when saving). Hidden when there is nothing to fix.
 */

import { useCallback, useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, ArrowRight, ChevronRight, DoorOpen, Loader2, Wand2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { useRealtime } from '@/context/RealtimeContext';
import { useToast } from '@/context/ToastContext';

interface SplitClass {
  ms_id: number;
  subject_code: string; subject_name: string;
  program_code: string | null; year_level: string | null; block_name: string | null;
  faculty_name: string;
  /** Rooms now, e.g. "Lec: Lab 2", "Lab: Lab 4" */
  rooms: string[];
  /** The one laboratory it moves into — its Lab's room, its Lecture's room, or another free lab */
  room: { id: number; name: string; from: 'lab' | 'lec' | 'other' } | null;
  note: string | null;
}
interface Data { classes: SplitClass[]; movable: number }

const EASE = [0.4, 0, 0.2, 1] as const;
const WHITE = { color: '#FFFFFF' } as const;
const TONE = '#EA580C';
const classes = (n: number) => `${n} ${n === 1 ? 'class' : 'classes'}`;
const block = (c: SplitClass) => [c.program_code, `${String(c.year_level ?? '').match(/\d+/)?.[0] ?? ''}${c.block_name ?? ''}`].filter(Boolean).join(' ');
const FROM: Record<NonNullable<SplitClass['room']>['from'], string> = {
  lab: "its Laboratory's room", lec: "its Lecture's room", other: 'a free laboratory',
};

export default function SplitMajorRoomsPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const reduceMotion = useReducedMotion();
  const toast = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => fetch('/api/rooms/one-room', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then((d: Data | null) => { if (d) setData(d); })
    .catch(() => {}), []);
  useEffect(() => { load(); }, [load, refreshKey]);
  // Live updates: a class was rescheduled or moved elsewhere
  useRealtime(['schedule', 'rooms'], load);

  async function moveAll() {
    setBusy(true);
    try {
      const res = await fetch('/api/rooms/one-room', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(d.error || 'Could not move the classes.'); return; }
      const moved = (d.moved ?? []).length as number;
      const left = (d.left ?? []).length as number;
      if (moved) toast.success(`${classes(moved)} now use${moved === 1 ? 's' : ''} one room for Lecture and Laboratory.`);
      if (left) toast.warning(`${classes(left)} still use${left === 1 ? 's' : ''} two rooms — see the list for why.`);
      setConfirm(false);
      await load();
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const total = data?.classes.length ?? 0;
  if (!data || total === 0) return null;
  const movable = data.movable;

  return (
    <>
      {/* ── Summary card ── */}
      <motion.button
        type="button"
        onClick={() => { setOpen(true); load(); }}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE } }}
        whileHover={reduceMotion ? undefined : { y: -3, boxShadow: `0 16px 30px -18px ${TONE}` }}
        whileTap={reduceMotion ? undefined : { scale: 0.99 }}
        className="qr-stat-tint relative overflow-hidden w-full text-left rounded-2xl border-2 px-5 py-4 flex items-center gap-4"
        style={{ background: `linear-gradient(135deg, ${TONE}14 0%, #FFFFFF 70%)`, borderColor: `${TONE}40` }}
      >
        <span className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: TONE, color: '#FFFFFF' }}>
          <DoorOpen className="w-6 h-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-bold text-[#0B2A5B]">Lec + Lab in Two Rooms</span>
          <span className="block text-sm text-[#64748B] mt-0.5">
            Major {total === 1 ? 'class' : 'classes'} whose Lecture and Laboratory must share one room
          </span>
        </span>
        <span className="text-3xl font-bold tabular-nums" style={{ color: TONE }}>{total}</span>
        <ChevronRight className="w-5 h-5 flex-shrink-0" style={{ color: TONE }} />
      </motion.button>

      {/* ── Pop-up: each class and its one room ── */}
      <Modal open={open} onClose={() => setOpen(false)} title="Lec + Lab in Two Rooms"
        subtitle="Major classes whose Lecture and Laboratory use different rooms" icon={DoorOpen} size="lg">
        <div className="space-y-4">
          {movable > 0 && (
            <div className="rounded-xl border border-[#BFD3F5] bg-[#F5F9FF] px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
              <span className="w-10 h-10 rounded-xl bg-white border border-[#D6E3F8] flex items-center justify-center flex-shrink-0 text-[#1D5BD6]">
                <Wand2 className="w-5 h-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold text-[#0B2A5B]">Put each class in one room</p>
                <p className="text-[13px] text-[#475569]">Only the room changes — days and times stay. A lab is used only where no other class is in it then.</p>
              </div>
              <motion.button
                type="button"
                onClick={() => setConfirm(true)}
                disabled={busy}
                whileTap={reduceMotion || busy ? undefined : { scale: 0.96 }}
                className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl text-sm font-bold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                style={WHITE}
              >
                <Wand2 className="w-4 h-4" style={WHITE} /> Move {classes(movable)}
              </motion.button>
            </div>
          )}

          <ul className="space-y-2.5">
            {data.classes.map((c, i) => (
              <motion.li key={c.ms_id}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 8) * 0.04 } }}
                className="rounded-xl border px-4 py-3"
                style={c.room ? { borderColor: '#E3E9F3', backgroundColor: '#FFFFFF' } : { borderColor: '#FECACA', backgroundColor: '#FFF5F5' }}>
                <p className="text-sm">
                  <b className="text-[15px] text-[#0B2A5B]">{c.subject_code}</b> <span className="text-[#475569]">{c.subject_name}</span>
                  <span className="text-[#94A3B8]"> · {block(c)}</span>
                </p>
                <p className="text-xs text-[#64748B] mt-0.5">{c.faculty_name}</p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {c.rooms.map(r => (
                    <span key={r} className="px-2.5 py-1 rounded-lg text-[13px] font-semibold border"
                      style={r.startsWith('Lab:') ? { backgroundColor: '#FFFBEB', borderColor: '#FDE68A', color: '#B45309' } : { backgroundColor: '#EFF6FF', borderColor: '#BFDBFE', color: '#1D5BD6' }}>
                      {r}
                    </span>
                  ))}
                  {c.room ? (
                    <>
                      <ArrowRight className="w-4 h-4 text-[#1D5BD6]" aria-label="moves to" />
                      <span className="px-2.5 py-1 rounded-lg text-[13px] font-bold bg-[#1D5BD6]" style={WHITE}>{c.room.name}</span>
                      <span className="text-xs text-[#64748B]">{FROM[c.room.from]}</span>
                    </>
                  ) : (
                    <span className="inline-flex items-start gap-1.5 text-[13px] font-semibold text-[#B91C1C]">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {c.note}
                    </span>
                  )}
                </div>
              </motion.li>
            ))}
          </ul>
        </div>
      </Modal>

      {/* ── Confirm ── */}
      <Modal open={confirm} onClose={() => { if (!busy) setConfirm(false); }} title="Put each class in one room?" icon={Wand2} size="sm"
        footer={
          <div className="flex gap-3">
            <motion.button type="button" onClick={() => setConfirm(false)} disabled={busy}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="flex-1 border border-[#E2E8F0] text-[#64748B] py-2.5 rounded-xl text-sm font-semibold hover:bg-[#F8FAFC] transition disabled:opacity-50">
              Cancel
            </motion.button>
            <motion.button type="button" onClick={moveAll} disabled={busy}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold bg-[#1D5BD6] hover:bg-[#164BB5] transition disabled:opacity-60 flex items-center justify-center gap-2"
              style={WHITE}>
              {busy ? <><Loader2 className="w-4 h-4 animate-spin" style={WHITE} /> Moving…</> : 'Move classes'}
            </motion.button>
          </div>
        }>
        <div className="space-y-3 text-[15px] text-[#334155]">
          <p><b className="text-[#0B2A5B]">{classes(movable)}</b> will each use one laboratory for its Lecture and Laboratory.</p>
          <ul className="list-disc pl-5 space-y-1 text-sm text-[#475569]">
            <li>Only the room changes — days and times stay as they are.</li>
            <li>Each class keeps a room it already uses when it can, else gets a free laboratory.</li>
            <li>No room is double-booked; nothing is saved if one would be.</li>
          </ul>
          {total - movable > 0 && (
            <p className="flex items-start gap-2 text-sm font-semibold text-[#B45309]">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {classes(total - movable)} will stay as {total - movable === 1 ? 'it is' : 'they are'} — see the list.
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
