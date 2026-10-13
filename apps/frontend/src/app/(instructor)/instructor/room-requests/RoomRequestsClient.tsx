'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle, XCircle, Plus, X,
  ChevronDown,
  QrCode, Loader2, Trash2, BookOpen, Monitor, Clock, History as HistoryIcon, Inbox,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import BackButton from '@/components/ui/BackButton';
import { createPortal } from 'react-dom';
import { useScrollLock } from '@/hooks/useScrollLock';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { ListSkeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { blockCode } from '@shared/blockCode';
import {
  HOLD_BEFORE_MIN, classTimes, requestWindow, shiftTime, time12, timeMinutes, timeRange12,
  type ClassPart, type ClassTime,
} from '@shared/roomRequestWindow';
import { useRealtime } from '@/context/RealtimeContext';

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface SessionData {
  id?: number;
  day: string;
  start_time: string;
  end_time: string;
  type?: string; // 'lec' | 'lab'
  room_name?: string | null;
}

interface Schedule {
  id: number;
  subject_code: string;
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  /** Major subject with a Lecture and a Laboratory — both stay in one laboratory room */
  one_room?: boolean;
  total_hours: number;
  units: number;
  block_name: string;
  year_level: string;
  semester: string;
  academic_year: string;
  program_code: string;
  program_name: string;
  status: string;
  room_name: string | null;
  sessions: unknown;
}

interface Room {
  id: number;
  room_name: string;
  room_type: string;
  building: string | null;
  capacity: number | null;
}

type RoomGroup = 'lec' | 'lab';
const roomGroupOf = (r: { room_type: string }): RoomGroup => {
  const t = String(r.room_type ?? '').trim().toLowerCase();
  return t === 'laboratory' || t === 'computer lab' ? 'lab' : 'lec';
};
const ROOM_GROUPS: { key: RoomGroup; label: string; Icon: typeof BookOpen; bg: string; fg: string }[] = [
  { key: 'lec', label: 'Lecture', Icon: BookOpen, bg: '#EFF6FF', fg: '#1D5BD6' },
  { key: 'lab', label: 'Laboratory', Icon: Monitor, bg: '#FFFBEB', fg: '#D97706' },
];
const EASE = [0.4, 0, 0.2, 1] as const;

interface RoomRequest {
  id: number;
  master_schedule_id: number | null;
  reason: string;
  status: string;
  admin_notes: string | null;
  auto_notes: string | null;
  confirmation_deadline: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  expired_at: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string | null;
  original_room_name: string | null;
  original_room_type: string | null;
  requested_room_name: string | null;
  requested_room_type: string | null;
  subject_code: string | null;
  subject_name: string | null;
  lecture_hours: number | null;
  laboratory_hours: number | null;
  block_name: string | null;
  year_level: string | null;
  program_code: string | null;
  sessions: unknown;
  /** Today-only request: the date and class time the room is held for ("HH:MM") */
  use_date: string | null;
  use_start: string | null;
  use_end: string | null;
  /** When its QR scan opens (15 minutes before the class) */
  scan_opens_at: string | null;
}

/** A room another faculty's class frees for the chosen class time (Free My Room, or not checked in) */
interface FreedRoom {
  id: number; room_name: string; room_type: string; building: string | null; capacity: number | null;
  freed_by: string | null;
  /** Its class wasn't checked in within 15 minutes: free until this time ("HH:MM") */
  unclaimed_until: string | null;
}

/** Today in Manila, from the server */
interface TodayInfo { date: string; day: string; now: string }

/** One of the faculty's class times today — what a request is made for */
interface TodaySession { part: ClassPart; start: string; end: string; room_name: string | null }
interface TodayClass { key: string; schedule: Schedule; time: ClassTime<TodaySession> }

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function fmt12(t: string): string {
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = mStr || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function normalizeSessions(raw: unknown): SessionData[] {
  if (Array.isArray(raw)) return raw as SessionData[];
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function hasValidSessions(s: { sessions: unknown }): boolean {
  return normalizeSessions(s.sessions).some(ss => ss.day && ss.start_time && ss.end_time);
}

/** Manila "HH:MM" now from this device's clock — ticks every 30 s (null until mounted) */
function useManilaNow(): string | null {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setNow(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Manila' }));
    read();
    const id = setInterval(read, 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** A class's sessions on one weekday, as parts with times */
function sessionsOn(s: Schedule, day: string): TodaySession[] {
  return normalizeSessions(s.sessions)
    .filter(ss => ss.day === day && ss.start_time && ss.end_time)
    .map(ss => ({
      part: sessionTypeLabel(ss.type) === 'Lab' ? 'lab' as const : 'lec' as const,
      start: ss.start_time.slice(0, 5),
      end: ss.end_time.slice(0, 5),
      room_name: ss.room_name ?? null,
    }));
}

/** "Lecture", "Laboratory" or both */
const partsLabel = (parts: ClassPart[]) => parts.map(p => (p === 'lab' ? 'Laboratory' : 'Lecture'));

/** A today-only request's day: "Today" or "Thu, Oct 8" */
function dayLabelOf(date: string, today: string | null): string {
  if (date === today) return 'Today';
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

function sessionTypeLabel(type?: string): string {
  if (!type) return '';
  const t = type.toLowerCase();
  if (t === 'lec' || t === 'lecture') return 'Lec';
  if (t === 'lab' || t === 'laboratory') return 'Lab';
  return type;
}

function formatSessionOption(ss: SessionData): string {
  const type = sessionTypeLabel(ss.type);
  const day = DAY_SHORT[ss.day] ?? ss.day;
  const range = `${fmt12(ss.start_time)}–${fmt12(ss.end_time)}`;
  return type ? `${type} ${day} ${range}` : `${day} ${range}`;
}

function getTypeInfo(lecH: number, labH: number): { label: string; color: string } {
  const lec = parseFloat(String(lecH)) || 0;
  const lab = parseFloat(String(labH)) || 0;
  if (lec > 0 && lab > 0) return { label: 'Lec + Lab', color: 'text-[#7C3AED]' };
  if (lab > 0) return { label: 'Laboratory', color: 'text-[#7C3AED]' };
  return { label: 'Lecture', color: 'text-[#1D5BD6]' };
}

const DAY_SHORT: Record<string, string> = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed',
  Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
};

const INPUT_CLS =
  'w-full bg-[var(--surface-elevated)] border border-[color:var(--border)] text-[color:var(--foreground)] text-base rounded-xl px-4 py-3 min-h-12 focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/30 focus:border-[#1D5BD6]';

const CARD =
  'bg-[var(--surface-elevated)] rounded-2xl border border-[color:var(--border)] shadow-[0_1px_3px_rgba(15,23,42,0.05)]';

const ACTIVE_STATUSES = new Set(['Pending', 'Pending Confirmation', 'In-Use']);
/** Still on: waiting, in use — or a today-only request approved for later today */
const isActiveRequest = (r: RoomRequest) => ACTIVE_STATUSES.has(r.status) || (r.status === 'Approved' && !!r.use_date);

const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-2 min-h-12 px-5 rounded-xl text-base font-bold text-white bg-[#1D5BD6] hover:bg-[#2E7DD1] active:bg-[#2670BD] transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

const BTN_SECONDARY =
  'inline-flex items-center justify-center gap-2 min-h-12 px-4 rounded-xl text-base font-semibold bg-[var(--surface-elevated)] border border-[color:var(--border)] text-[color:var(--foreground-secondary)] hover:bg-[var(--background-secondary)] transition-colors disabled:opacity-40';

/* ─── Countdown hook ─────────────────────────────────────────────────────── */
function useCountdown(deadline: string | null): { label: string; urgent: boolean; expired: boolean } {
  const [state, setState] = useState({ label: '', urgent: false, expired: false });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!deadline) return;

    const tick = () => {
      const diff = new Date(deadline).getTime() - Date.now();
      if (diff <= 0) {
        setState({ label: 'Expired', urgent: true, expired: true });
        if (timerRef.current) clearInterval(timerRef.current);
        return;
      }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setState({
        label: `${m}:${s.toString().padStart(2, '0')} remaining`,
        urgent: diff < 5 * 60_000,
        expired: false,
      });
    };

    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [deadline]);

  return state;
}

/* ─── Status config (light mode) ─────────────────────────────────────────── */
const STATUS_CFG: Record<string, {
  label: string; bg: string; text: string; border: string; dot: string;
}> = {
  'Pending Confirmation': {
    label: 'Pending Confirmation',
    bg: 'bg-[#EFF6FF]',
    text: 'text-[#1D5BD6]',
    border: 'border-[#BFDBFE]',
    dot: 'bg-[#1D5BD6]',
  },
  'In-Use': {
    label: 'In-Use',
    bg: 'bg-[#ECFDF5]',
    text: 'text-[#059669]',
    border: 'border-[#A7F3D0]',
    dot: 'bg-[#059669]',
  },
  Released: {
    label: 'Released',
    bg: 'bg-[#F8FAFC]',
    text: 'text-[#64748B]',
    border: 'border-[#E2E8F0]',
    dot: 'bg-[#94A3B8]',
  },
  Expired: {
    label: 'Expired',
    bg: 'bg-[#F8FAFC]',
    text: 'text-[#64748B]',
    border: 'border-[#E2E8F0]',
    dot: 'bg-[#94A3B8]',
  },
  Approved: {
    label: 'Approved',
    bg: 'bg-[#ECFDF5]',
    text: 'text-[#059669]',
    border: 'border-[#A7F3D0]',
    dot: 'bg-[#059669]',
  },
  Rejected: {
    label: 'Rejected',
    bg: 'bg-[#FEF2F2]',
    text: 'text-[#DC2626]',
    border: 'border-[#FECACA]',
    dot: 'bg-[#DC2626]',
  },
  Pending: {
    label: 'Pending Review',
    bg: 'bg-[#FFFBEB]',
    text: 'text-[#D97706]',
    border: 'border-[#FDE68A]',
    dot: 'bg-[#D97706]',
  },
};

const DEFAULT_CFG = STATUS_CFG.Pending;

/** Centred result popup (error / success) — stays until the user closes it */
function ResultPopup({ type, message, onClose }: { type: 'success' | 'error'; message: string; onClose: () => void }) {
  const reduceMotion = useReducedMotion();
  const ok = type === 'success';
  const tone = ok ? '#16A34A' : '#DC2626';
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          key="result-popup"
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2 }}
        >
          <div className="absolute inset-0 bg-[#0B2A5B]/40 backdrop-blur-sm" aria-hidden />
          <motion.div
            role="alertdialog"
            aria-modal="true"
            initial={reduceMotion ? false : { opacity: 0, scale: 0.9, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.3, ease: [0.4, 0, 0.2, 1] } }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, transition: { duration: 0.18 } }}
            className="relative w-full max-w-sm rounded-2xl bg-white shadow-2xl px-6 pt-8 pb-6 text-center"
          >
            <button type="button" onClick={onClose} aria-label="Close"
              className="absolute top-3 right-3 w-10 h-10 rounded-xl inline-flex items-center justify-center text-[#64748B] hover:text-[#0B2A5B] hover:bg-[#F1F5F9] transition-colors">
              <X className="w-5 h-5" />
            </button>
            <motion.div
              className="mx-auto mb-4 w-16 h-16 rounded-full flex items-center justify-center"
              style={{ backgroundColor: `${tone}14`, color: tone }}
              initial={reduceMotion ? false : { scale: 0.5 }}
              animate={reduceMotion ? { scale: 1 } : { scale: [0.5, 1.12, 1] }}
              transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
            >
              {ok ? <CheckCircle className="w-9 h-9" /> : <XCircle className="w-9 h-9" />}
            </motion.div>
            <p className="text-[17px] font-bold text-[#0B2A5B]">{ok ? 'Done!' : 'Cannot continue'}</p>
            <p className="mt-1.5 text-[15px] text-[#475569] leading-relaxed break-words">{message}</p>
            <motion.button type="button" onClick={onClose} whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="mt-5 w-full h-12 rounded-xl text-[15px] font-semibold transition-colors"
              style={{ backgroundColor: tone, color: '#FFFFFF' }}>
              OK
            </motion.button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TypeBadge({ lecture_hours, laboratory_hours }: { lecture_hours: number | null; laboratory_hours: number | null }) {
  const { label, color } = getTypeInfo(lecture_hours ?? 0, laboratory_hours ?? 0);
  return (
    <span className={`inline-flex items-center text-xs font-semibold px-2.5 py-1 rounded-lg
      bg-[var(--background-secondary)] border border-[color:var(--border)] ${color}`}>
      {label}
    </span>
  );
}

/** True once a today-only request's QR scan has opened (re-checks every 15 s) */
function useScanOpen(opensAt: string | null): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!opensAt) return;
    const at = new Date(opensAt).getTime();
    const check = () => setOpen(Date.now() >= at);
    check();
    const id = setInterval(check, 15_000);
    return () => clearInterval(id);
  }, [opensAt]);
  return open;
}

/** ISO timestamp → "1:15 PM" (Manila) */
function clockOf(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
}

function CountdownBadge({ deadline }: { deadline: string }) {
  const { label, urgent } = useCountdown(deadline);
  if (!label) return null;
  return (
    <span className={`inline-flex items-center text-sm font-bold px-3 py-1.5 rounded-lg border tabular-nums
      ${urgent
        ? 'bg-[#FEF2F2] border-[#FECACA] text-[#DC2626]'
        : 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1D4ED8]'
      }`}>
      {label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CFG[status] ?? DEFAULT_CFG;
  return (
    <span className={`inline-flex items-center gap-2 text-sm font-bold px-3 py-1.5 rounded-lg border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${cfg.dot}`} aria-hidden />
      {cfg.label}
    </span>
  );
}

function HistoryRow({
  req,
  onDelete,
  deleting,
  today,
}: {
  req: RoomRequest;
  onDelete: (id: number) => void;
  deleting?: boolean;
  today: string | null;
}) {
  const [open, setOpen] = useState(false);
  const useDay = dayLabelOf(req.use_date ?? '', today);
  const cfg = STATUS_CFG[req.status] ?? DEFAULT_CFG;
  const validSessions = normalizeSessions(req.sessions).filter(s => s.day && s.start_time && s.end_time);

  return (
    <div className="border-b border-[color:var(--border)] last:border-b-0">
      <div className="flex items-start gap-1 px-2 sm:px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className="flex-1 min-w-0 text-left px-2 py-2 rounded-lg hover:bg-[var(--background-secondary)] transition-colors"
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-md border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} aria-hidden />
                  {cfg.label}
                </span>
                <span className="text-sm font-semibold text-[color:var(--foreground)] break-words">
                  {req.requested_room_name ?? 'Room request'}
                </span>
              </div>
              <p className="text-sm text-[color:var(--foreground-muted)] break-words">
                {req.subject_code ? `${req.subject_code}` : 'No subject'}
                {req.original_room_name ? ` · ${req.original_room_name} → ${req.requested_room_name ?? '—'}` : ''}
                {' · '}
                {fmtDate(req.created_at)}
              </p>
            </div>
            <ChevronDown className={`w-4 h-4 mt-1 flex-shrink-0 text-[color:var(--foreground-muted)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          </div>
        </button>

        <button
          type="button"
          onClick={() => onDelete(req.id)}
          disabled={deleting}
          className="flex-shrink-0 inline-flex items-center justify-center gap-1.5 min-h-10 px-2.5 sm:px-3 rounded-lg text-sm font-semibold
            text-[#B91C1C] hover:bg-[#FEF2F2] transition-colors disabled:opacity-40 mt-0.5"
          title="Delete from history"
        >
          {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          <span className="hidden sm:inline">Delete</span>
        </button>
      </div>

      {open && (
        <div className="px-4 pb-3.5 space-y-2 text-sm text-[color:var(--foreground-muted)]">
          {req.subject_name && (
            <p className="text-[color:var(--foreground-secondary)]">{req.subject_name}</p>
          )}
          {req.use_date && req.use_start && req.use_end ? (
            <p>{useDay} · {timeRange12(req.use_start, req.use_end)}</p>
          ) : validSessions.length > 0 && (
            <p>{validSessions.map(formatSessionOption).join(' · ')}</p>
          )}
          {req.reason && (
            <p className="rounded-lg bg-[var(--background-secondary)] border border-[color:var(--border)] px-3 py-2 text-[color:var(--foreground)] leading-relaxed">
              {req.reason}
            </p>
          )}
          {(req.admin_notes || req.auto_notes) && (
            <p className="leading-relaxed">
              {req.admin_notes || req.auto_notes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyScheduleState({ assignedButUnscheduled }: { assignedButUnscheduled: boolean }) {
  return (
    <div className={`${CARD} py-10 px-6 text-center`}>
      <p className="text-base text-[color:var(--foreground-muted)] mb-5 leading-relaxed max-w-md mx-auto">
        {assignedButUnscheduled
          ? 'No class times are scheduled yet. You need scheduled class times before you can request a room.'
          : 'No teaching schedule is available yet. You need a schedule before you can request a room.'}
      </p>
      <Link href="/instructor/schedule" className={BTN_PRIMARY}>
        View My Schedule
      </Link>
    </div>
  );
}

function RequestCard({
  req, onCancel, emphasize = false, today,
}: {
  req: RoomRequest;
  onCancel: (id: number) => void;
  emphasize?: boolean;
  today: string | null;
}) {
  const [expanded, setExpanded] = useState(emphasize);
  const cfg = STATUS_CFG[req.status] ?? DEFAULT_CFG;
  const validSessions = normalizeSessions(req.sessions).filter(s => s.day && s.start_time && s.end_time);
  const isPendingConf = req.status === 'Pending Confirmation';
  const isInUse = req.status === 'In-Use';
  const isReleased = req.status === 'Released';
  const isExpired = req.status === 'Expired';
  const isRejected = req.status === 'Rejected';
  const isApproved = req.status === 'Approved';
  const isPending = req.status === 'Pending';
  // Today-only request: its class time, and whether its QR scan is open yet
  const timed = !!(req.use_date && req.use_start && req.use_end);
  const useDay = dayLabelOf(req.use_date ?? '', today);
  const when = timed ? timeRange12(req.use_start ?? '', req.use_end ?? '') : '';
  const scanOpen = useScanOpen(req.scan_opens_at);
  const canCancel = ['Pending', 'Pending Confirmation'].includes(req.status) || (isApproved && timed);

  return (
    <article
      className={[
        'relative rounded-2xl border overflow-hidden min-w-0 bg-[var(--surface-elevated)] transition-shadow',
        cfg.border,
        emphasize ? 'shadow-[0_4px_14px_rgba(15,23,42,0.08)]' : 'hover:shadow-[0_2px_8px_rgba(15,23,42,0.06)]',
      ].join(' ')}
    >
      <div className="p-5 sm:p-6 space-y-4 min-w-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={req.status} />
              {isPendingConf && req.confirmation_deadline && (!timed || scanOpen) && (
                <CountdownBadge deadline={req.confirmation_deadline} />
              )}
              {(req.lecture_hours !== null || req.laboratory_hours !== null) && (
                <TypeBadge lecture_hours={req.lecture_hours} laboratory_hours={req.laboratory_hours} />
              )}
            </div>
            <h3 className="text-xl font-bold text-[color:var(--foreground)] break-words leading-snug">
              {req.requested_room_name ?? 'Room request'}
            </h3>
            {req.subject_code && (
              <p className="text-base text-[color:var(--foreground-secondary)] break-words">
                <span className="font-semibold">{req.subject_code}</span>
                {req.subject_name ? ` — ${req.subject_name}` : ''}
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2 flex-shrink-0">
            {canCancel && (
              <button
                type="button"
                onClick={() => onCancel(req.id)}
                className="inline-flex items-center justify-center gap-1.5 min-h-11 px-3.5 rounded-xl text-sm font-semibold
                  text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] hover:bg-[#FEE2E2] transition-colors"
              >
                <X className="w-4 h-4" />
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              aria-expanded={expanded}
              className={BTN_SECONDARY.replace('min-h-12', 'min-h-11').replace('text-base', 'text-sm')}
            >
              {expanded ? 'Less' : 'Details'}
              <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-xl bg-[var(--background-secondary)] border border-[color:var(--border)] px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-[color:var(--foreground-muted)]">{timed ? 'Room for this class' : 'Room change'}</p>
            <p className="mt-1 text-base font-semibold text-[color:var(--foreground)] break-words">
              {req.original_room_name ?? 'No room'}
              <span className="text-[color:var(--foreground-muted)] mx-1.5">→</span>
              <span className="text-[#1D5BD6]">{req.requested_room_name ?? 'N/A'}</span>
            </p>
          </div>
          <div className="rounded-xl bg-[var(--background-secondary)] border border-[color:var(--border)] px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-[color:var(--foreground-muted)]">When</p>
            <p className="mt-1 text-base font-semibold text-[color:var(--foreground)] break-words">
              {timed
                ? `${useDay} · ${when}`
                : validSessions.length > 0
                  ? validSessions.map(formatSessionOption).join(' · ')
                  : fmtDate(req.created_at)}
            </p>
          </div>
        </div>

        {isPending && (
          <p className="text-sm text-[#92400E] bg-[#FFFBEB] border border-[#FDE68A] rounded-xl px-4 py-3 leading-relaxed">
            Pending administrator review.
          </p>
        )}

        {isPendingConf && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-[#EFF6FF] border border-[#BFDBFE] rounded-xl px-4 py-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-[#0B2A5B]">{timed && !scanOpen ? 'Reserved for your class' : 'Scan QR code to confirm'}</p>
              <p className="text-sm text-[#475569] mt-1 leading-relaxed break-words">
                {timed
                  ? <>Scan the QR code at <strong>{req.requested_room_name}</strong> {scanOpen ? 'by' : `from ${time12(shiftTime(req.use_start ?? '', -HOLD_BEFORE_MIN))} to`} <strong>{clockOf(req.confirmation_deadline)}</strong>.</>
                  : <>Go to <strong>{req.requested_room_name}</strong> and scan within 15 minutes.</>}
              </p>
            </div>
            <Link href="/instructor/scan" className={`${BTN_PRIMARY} w-full sm:w-auto`}>
              <QrCode className="w-5 h-5" />
              Scan QR Code
            </Link>
          </div>
        )}

        {isInUse && (
          <p className="text-sm text-[#047857] bg-[#ECFDF5] border border-[#A7F3D0] rounded-xl px-4 py-3 leading-relaxed break-words">
            {timed
              ? <>Confirmed — <strong>{req.requested_room_name}</strong> is yours until {time12(req.use_end ?? '')}.</>
              : <>Confirmed — schedule updated to <strong>{req.requested_room_name}</strong>.</>}
          </p>
        )}

        {isApproved && (
          <p className="text-sm text-[#047857] bg-[#ECFDF5] border border-[#A7F3D0] rounded-xl px-4 py-3 leading-relaxed">
            {timed
              ? <>Approved — <strong>{req.requested_room_name}</strong> is held for you at {when}. No QR scan needed.</>
              : 'Approved. Room assignment updated.'}
          </p>
        )}

        {isExpired && (
          <p className="text-sm text-[color:var(--foreground-muted)] bg-[var(--background-secondary)] border border-[color:var(--border)] rounded-xl px-4 py-3 leading-relaxed break-words">
            {req.auto_notes ?? 'The 15-minute QR window ended. Submit a new request if you still need a room.'}
          </p>
        )}

        {isReleased && (
          <p className="text-sm text-[color:var(--foreground-muted)] bg-[var(--background-secondary)] border border-[color:var(--border)] rounded-xl px-4 py-3 leading-relaxed break-words">
            {req.auto_notes ?? 'This room was released and is available again.'}
          </p>
        )}

        {isRejected && (
          <p className="text-sm text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] rounded-xl px-4 py-3 leading-relaxed break-words">
            {req.auto_notes ?? 'This request was rejected.'}
            {req.admin_notes && <> Admin note: <em>&ldquo;{req.admin_notes}&rdquo;</em></>}
          </p>
        )}

        {expanded && (
          <div className="pt-3 border-t border-[color:var(--border)] space-y-3">
            {req.block_name && (
              <p className="text-sm text-[color:var(--foreground-muted)]">
                Block {req.block_name}{req.year_level ? ` · ${req.year_level}` : ''}
              </p>
            )}
            {req.reason && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-[color:var(--foreground-muted)] mb-1.5">Reason</p>
                <p className="text-sm text-[color:var(--foreground)] leading-relaxed bg-[var(--background-secondary)] rounded-xl px-4 py-3 border border-[color:var(--border)]">
                  {req.reason}
                </p>
              </div>
            )}
            {req.admin_notes && !isRejected && (
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-[color:var(--foreground-muted)] mb-1.5">Admin note</p>
                <p className="text-sm text-[color:var(--foreground)] leading-relaxed bg-[var(--background-secondary)] rounded-xl px-4 py-3 border border-[color:var(--border)]">
                  {req.admin_notes}
                </p>
              </div>
            )}
            <p className="text-sm text-[color:var(--foreground-muted)]">
              Submitted {fmtDate(req.created_at)}
              {req.updated_at && req.updated_at !== req.created_at ? ` · Updated ${fmtDate(req.updated_at)}` : ''}
            </p>
          </div>
        )}
      </div>
    </article>
  );
}

/* ─── Main component ─────────────────────────────────────────────────────── */
export default function RoomRequestsClient() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [requests, setRequests] = useState<RoomRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  // Nothing shown until a card is clicked; clicking the open card again hides it
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [view, setView] = useState<'active' | 'history' | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [selectedScheduleId, setSelectedScheduleId] = useState('');
  /** Which of the class's times today ("HH:MM" start) */
  const [selectedStart, setSelectedStart] = useState('');
  const [today, setToday] = useState<TodayInfo | null>(null);
  const nowHm = useManilaNow();
  const [requestedRoomId, setRequestedRoomId] = useState('');
  const [reason, setReason] = useState('');
  /** Rooms another faculty freed for the selected class time today (Free My Room) — the only ones that can be asked for; null until checked */
  const [freedRooms, setFreedRooms] = useState<FreedRoom[] | null>(null);
  const [checkingRooms, setCheckingRooms] = useState(false);
  const reduceMotion = useReducedMotion();

  /** silent: live-update refresh — the lists stay on screen */
  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [reqRes, schedRes, roomsRes] = await Promise.all([
        fetch('/api/instructor/room-requests'),
        fetch('/api/instructor/schedule'),
        fetch('/api/rooms?status=Active'),
      ]);
      if (reqRes.ok) {
        const d = await reqRes.json();
        setRequests(d.requests || []);
        if (d.today?.date && d.today?.day) setToday(d.today);
      }
      if (schedRes.ok) setSchedules((await schedRes.json()).schedules || []);
      if (roomsRes.ok) setRooms((await roomsRes.json()).rooms || []);
    } catch { /* connection blip — keep what is on screen */ }
    finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Live updates: a request approved, rejected or expired, a class moved, a room
  // taken or freed — quiet reload. An open request form keeps its picks; the
  // selected class's rooms are re-checked against the new state.
  useRealtime(['room-requests', 'schedule', 'occupancy', 'rooms'], () => loadData(true), { enabled: !loading && !submitting });

  const validSchedules = useMemo(
    () => schedules.filter(hasValidSessions),
    [schedules],
  );

  /** The faculty's class times for the rest of today, in time order — requests are for today only */
  const todayClasses = useMemo<TodayClass[]>(() => {
    if (!today) return [];
    return validSchedules
      .flatMap(s => classTimes(sessionsOn(s, today.day)).map(time => ({ key: `${s.id}-${time.start}`, schedule: s, time })))
      .filter(c => !nowHm || timeMinutes(c.time.end) > timeMinutes(nowHm))
      .sort((a, b) => a.time.start.localeCompare(b.time.start) || a.schedule.subject_code.localeCompare(b.schedule.subject_code));
  }, [validSchedules, today, nowHm]);
  /** Class times today that already have a request (one per class time) */
  const requestedKeys = useMemo(() => new Set(todayClasses
    .filter(c => requests.some(r => isActiveRequest(r) && r.master_schedule_id === c.schedule.id
      && r.use_date === today?.date && r.use_start && r.use_end
      && timeMinutes(r.use_start) < timeMinutes(c.time.end) && timeMinutes(r.use_end) > timeMinutes(c.time.start)))
    .map(c => c.key)), [todayClasses, requests, today]);

  // Arrived from a "Request" button (?room=<id>, and from Find Available Rooms maybe
  // ?ms=<class>&at=<HH:MM> when one of the faculty's class times was picked) — open the form with them picked
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || loading || rooms.length === 0 || !today || !nowHm) return;
    preselected.current = true;
    const params = new URLSearchParams(window.location.search);
    const id = params.get('room');
    if (!id || !rooms.some(r => String(r.id) === id)) return;
    const ms = params.get('ms');
    const at = params.get('at');
    const mine = todayClasses.filter(c => String(c.schedule.id) === ms && !requestedKeys.has(c.key));
    // The class time that starts (or is going on) at that time, else the class's next one
    const pick = (at && mine.find(c => timeMinutes(c.time.start) <= timeMinutes(at) && timeMinutes(at) < timeMinutes(c.time.end))) || mine[0];
    if (pick) { setSelectedScheduleId(String(pick.schedule.id)); setSelectedStart(pick.time.start); }
    setRequestedRoomId(id);
    setShowForm(true);
    window.history.replaceState(null, '', window.location.pathname);
  }, [loading, rooms, today, nowHm, todayClasses, requestedKeys]);

  const selectedClass = todayClasses.find(c => String(c.schedule.id) === selectedScheduleId && c.time.start === selectedStart) ?? null;
  const selectedSchedule = selectedClass?.schedule ?? null;
  /** Lecture-only subjects may only use lecture rooms, laboratory-only subjects
   *  only laboratory rooms, and a Major subject's Lecture + Laboratory share one
   *  laboratory (same rules as the server) */
  const lectureOnly = !!selectedSchedule && !(parseFloat(String(selectedSchedule.laboratory_hours)) > 0);
  const labOnly = !!selectedSchedule && !(parseFloat(String(selectedSchedule.lecture_hours)) > 0);
  const oneRoom = selectedSchedule?.one_room === true;
  /** What each kind of room would hold of the class time: a lecture room only its Lecture part */
  const labWindow = selectedClass ? requestWindow(selectedClass.time.sessions, selectedClass.time.start, 'lab') : null;
  const lecWindow = selectedClass ? requestWindow(selectedClass.time.sessions, selectedClass.time.start, 'lec') : null;
  const lockedGroup: RoomGroup | null = lectureOnly ? 'lab' : labOnly || oneRoom || (selectedClass && !lecWindow) ? 'lec' : null;

  // Which rooms another faculty freed for the selected class time today — and are
  // still free then (no other class, nobody reserved it or holds it)
  const checkMs = selectedClass?.schedule.id ?? 0;
  const todayDate = today?.date ?? '';
  const todayDay = today?.day ?? '';
  const labStart = labWindow?.start ?? '', labEnd = labWindow?.end ?? '';
  const lecStart = lecWindow?.start ?? '', lecEnd = lecWindow?.end ?? '';
  useEffect(() => {
    if (!checkMs || !todayDate || !labStart) { setFreedRooms(null); return; }
    type Checked = {
      id: number; room_name: string; room_type: string; building: string | null; capacity: number | null;
      is_available: boolean;
      freed?: { faculty_name: string | null; unclaimed?: true; until?: string } | null;
    };
    const check = (start: string, end: string) => {
      const qs = new URLSearchParams({ day: todayDay, date: todayDate, start_time: start, end_time: end, room_type: 'all', exclude_ms: String(checkMs) });
      return fetch(`/api/instructor/available-rooms?${qs}`).then(r => (r.ok ? r.json() : { rooms: [] })).then(d => (d.rooms ?? []) as Checked[]);
    };
    let cancelled = false;
    setCheckingRooms(true);
    // A lecture room is checked for the Lecture part only, when that differs
    const lecDiffers = !!lecStart && (lecStart !== labStart || lecEnd !== labEnd);
    Promise.all([check(labStart, labEnd), lecDiffers ? check(lecStart, lecEnd) : null]).then(([forLab, forLec]) => {
      if (cancelled) return;
      const list: FreedRoom[] = [];
      for (const r of forLab) {
        const at = forLec && roomGroupOf(r) === 'lec' ? forLec.find(x => x.id === r.id) ?? r : r;
        if (at.is_available && at.freed) {
          list.push({
            id: r.id, room_name: r.room_name, room_type: r.room_type, building: r.building, capacity: r.capacity,
            freed_by: at.freed.faculty_name, unclaimed_until: at.freed.unclaimed ? at.freed.until ?? null : null,
          });
        }
      }
      setFreedRooms(list);
    }).catch(() => { if (!cancelled) setFreedRooms([]); })
      .finally(() => { if (!cancelled) setCheckingRooms(false); });
    return () => { cancelled = true; };
  }, [checkMs, todayDate, todayDay, labStart, labEnd, lecStart, lecEnd]);
  /** The freed rooms this class can use (subject rules) */
  const usableRooms = (freedRooms ?? []).filter(r => roomGroupOf(r) !== lockedGroup);
  const assignedButUnscheduled = !loading && schedules.length > 0 && validSchedules.length === 0;
  const hasNoSchedule = !loading && validSchedules.length === 0;
  const showSkeleton = useMinLoading(loading && requests.length === 0, LOADING_DELAY);

  // A room that isn't freed for the chosen class time (or not allowed for it) can't stay picked
  useEffect(() => {
    if (!requestedRoomId || !freedRooms || checkingRooms) return;
    const r = freedRooms.find(x => String(x.id) === requestedRoomId);
    if (!r || roomGroupOf(r) === lockedGroup) setRequestedRoomId('');
  }, [freedRooms, checkingRooms, lockedGroup, requestedRoomId]);

  useScrollLock(showForm);
  useEffect(() => {
    if (!showForm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setShowForm(false); resetForm(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function resetForm() {
    setSelectedScheduleId('');
    setSelectedStart('');
    setRequestedRoomId('');
    setReason('');
    setError('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSuccess('');

    if (!selectedScheduleId || !selectedStart) { setError('Please select one of your classes today.'); return; }
    if (!requestedRoomId) { setError('Please select a preferred room.'); return; }

    setSubmitting(true);
    try {
      const res = await fetch('/api/instructor/room-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          master_schedule_id: parseInt(selectedScheduleId),
          start_time: selectedStart,
          requested_room_id: parseInt(requestedRoomId),
          reason: reason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to submit request.');
        return;
      }
      setSuccess(data.message || 'Room request submitted.');
      setShowForm(false);
      resetForm();
      loadData();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel(id: number) {
    const req = requests.find(r => r.id === id);
    const isPendingConf = req?.status === 'Pending Confirmation';
    const msg = isPendingConf
      ? 'Cancel this request? The room reservation will also be released.'
      : 'Cancel this room change request? This cannot be undone.';
    if (!confirm(msg)) return;

    const res = await fetch(`/api/instructor/room-requests/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setSuccess('Request cancelled successfully.');
      loadData();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error || 'Failed to cancel request.');
    }
  }

  async function handleDeleteHistory(id: number) {
    if (!confirm('Delete this request from your history? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/instructor/room-requests/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setRequests(prev => prev.filter(r => r.id !== id));
        setSuccess('Request removed from history.');
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to delete request.');
      }
    } finally {
      setDeletingId(null);
    }
  }

  // The request whose QR scan is open now — or else the next one waiting for its time
  const waiting = requests
    .filter(r => r.status === 'Pending Confirmation')
    .sort((a, b) => (a.use_start ?? '').localeCompare(b.use_start ?? ''));
  const activeConfirmation = waiting.find(r => !r.scan_opens_at || (nowHm && r.use_start && timeMinutes(nowHm) >= timeMinutes(r.use_start) - HOLD_BEFORE_MIN)) ?? waiting[0];
  const confirmationOpen = !!activeConfirmation && (!activeConfirmation.scan_opens_at
    || (!!nowHm && !!activeConfirmation.use_start && timeMinutes(nowHm) >= timeMinutes(activeConfirmation.use_start) - HOLD_BEFORE_MIN));
  const activeRequests = useMemo(
    () => requests.filter(isActiveRequest),
    [requests],
  );
  const pastRequests = useMemo(
    () => requests.filter(r => !isActiveRequest(r)),
    [requests],
  );
  const canCreate = !hasNoSchedule;

  return (
    <div className="w-full min-w-0 bg-[var(--background)] px-4 sm:px-6 lg:px-8 py-6 overflow-x-hidden">
      <div className="w-full max-w-4xl lg:max-w-6xl mx-auto space-y-5 min-w-0">

        <header>
          <BackButton />
          <div className="mt-2 lg:mt-5 mb-4">
            <WatermarkTitle>Room Requests</WatermarkTitle>
          </div>
          <div className="flex items-center justify-end gap-2 w-full">
            {canCreate && (
              <motion.button
                type="button"
                onClick={() => { setShowForm(v => !v); setError(''); setSuccess(''); }}
                disabled={loading}
                whileHover={reduceMotion ? undefined : { y: -2 }}
                whileTap={reduceMotion ? undefined : { scale: 0.95 }}
                className={`${BTN_PRIMARY} flex-1 sm:flex-none`}
              >
                <motion.span animate={{ rotate: showForm ? 90 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }} className="inline-flex">
                  {showForm ? <X className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                </motion.span>
                {showForm ? 'Close' : 'New Request'}
              </motion.button>
            )}
          </div>
        </header>

        {activeConfirmation && (
          <div className={`${CARD} border-[#BFDBFE] bg-[#EFF6FF] p-4 sm:p-5`}>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <p className="text-base font-bold text-[#0B2A5B]">{confirmationOpen ? 'Scan QR code to confirm' : 'Room reserved for later today'}</p>
                  {confirmationOpen && activeConfirmation.confirmation_deadline && (
                    <CountdownBadge deadline={activeConfirmation.confirmation_deadline} />
                  )}
                </div>
                <p className="text-sm text-[#475569] leading-relaxed break-words">
                  {activeConfirmation.use_start && activeConfirmation.use_end ? (
                    <>
                      <span className="font-semibold text-[#0B2A5B]">{activeConfirmation.requested_room_name}</span>
                      {' · '}{activeConfirmation.subject_code} {timeRange12(activeConfirmation.use_start, activeConfirmation.use_end)}.{' '}
                      {confirmationOpen
                        ? <>Scan its QR code by {clockOf(activeConfirmation.confirmation_deadline)}.</>
                        : <>Scan its QR code from {time12(shiftTime(activeConfirmation.use_start, -HOLD_BEFORE_MIN))} to {clockOf(activeConfirmation.confirmation_deadline)}.</>}
                    </>
                  ) : (
                    <>Go to <span className="font-semibold text-[#0B2A5B]">{activeConfirmation.requested_room_name}</span> and scan its QR code.</>
                  )}
                </p>
              </div>
              <Link href="/instructor/scan" className={`${BTN_PRIMARY} w-full sm:w-auto`}>
                <QrCode className="w-5 h-5" /> Scan QR Code
              </Link>
            </div>
          </div>
        )}

        <ResultPopup type="success" message={success} onClose={() => setSuccess('')} />
        <ResultPopup type="error" message={error} onClose={() => setError('')} />

        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={<ListSkeleton rows={6} />}
          className="space-y-4"
        >
        {!showSkeleton && (
          <>
            {hasNoSchedule && (
              <EmptyScheduleState assignedButUnscheduled={assignedButUnscheduled} />
            )}

            {mounted && createPortal(
            <AnimatePresence>
            {!hasNoSchedule && showForm && (
              /* Own window, centred over a dimmed page */
              <motion.div
                key="request-form-overlay"
                className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.25 }}
              >
              <div className="absolute inset-0 bg-[#0B2A5B]/45 backdrop-blur-sm" onClick={() => { setShowForm(false); resetForm(); }} aria-hidden />
              <motion.div
                key="request-form"
                role="dialog"
                aria-modal="true"
                aria-label="New Room Request"
                initial={reduceMotion ? false : { opacity: 0, scale: 0.92, y: 24 }}
                animate={{ opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 320, damping: 28 } }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 16, transition: { duration: 0.2, ease: EASE } }}
                className="relative w-full max-w-5xl max-h-[92vh] flex flex-col rounded-2xl bg-white overflow-hidden shadow-[0_30px_70px_-25px_rgba(11,42,91,0.6)] min-w-0"
              >
                <div className="relative overflow-hidden flex-shrink-0 flex items-center justify-between gap-3 px-5 py-4" style={{ background: 'linear-gradient(120deg, #1D5BD6 0%, #0B2A5B 120%)' }}>
                  <span aria-hidden className="absolute -right-10 -top-14 w-44 h-44 rounded-full bg-white/10" />
                  <div className="relative flex items-center gap-3 min-w-0">
                    <span className="w-11 h-11 rounded-xl bg-white/15 ring-1 ring-white/25 flex items-center justify-center flex-shrink-0">
                      <Plus className="w-5 h-5" style={{ color: '#FFFFFF' }} />
                    </span>
                    <div className="min-w-0">
                      <p className="text-[17px] font-bold" style={{ color: '#FFFFFF' }}>New Room Request</p>
                      <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.8)' }}>For your classes today only.</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setShowForm(false); resetForm(); }}
                    className="relative min-h-11 min-w-11 rounded-xl flex items-center justify-center bg-white/15 hover:bg-white/25 transition-colors flex-shrink-0"
                    style={{ color: '#FFFFFF' }}
                    aria-label="Close form"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-5 grid grid-cols-1 lg:grid-cols-2 gap-5 lg:gap-6 items-start">

                  <div className="min-w-0">
                    <label className="block text-sm font-semibold text-[color:var(--foreground)] mb-2">
                      Your Classes Today{today ? <span className="font-medium text-[color:var(--foreground-muted)]"> · {today.day}</span> : null}
                    </label>
                    {todayClasses.length === 0 ? (
                      <p className="rounded-xl border border-[color:var(--border)] bg-[var(--background-secondary)] px-4 py-4 text-[15px] text-[color:var(--foreground-muted)]">
                        No more classes today. Room requests are for today&apos;s classes only.
                      </p>
                    ) : (
                    <div className="space-y-2 max-h-72 lg:max-h-[560px] overflow-y-auto pr-0.5">
                      {todayClasses.map(({ key, schedule: s, time: t }) => {
                        const selected = selectedScheduleId === String(s.id) && selectedStart === t.start;
                        const requested = requestedKeys.has(key);
                        const block = [s.program_code, blockCode(s.year_level, s.block_name)].filter(Boolean).join(' ');
                        const usual = [...new Set(t.sessions.map(x => x.room_name).filter(Boolean))].join(' / ');
                        return (
                          <button
                            key={key}
                            type="button"
                            aria-pressed={selected}
                            disabled={requested}
                            onClick={() => { setSelectedScheduleId(String(s.id)); setSelectedStart(t.start); setRequestedRoomId(''); }}
                            className={`w-full text-left rounded-xl border px-4 py-3 min-w-0 min-h-12 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                              selected
                                ? 'border-[#1D5BD6] bg-[#EFF6FF] ring-2 ring-[#1D5BD6]/20'
                                : 'border-[color:var(--border)] bg-[var(--surface-elevated)] hover:bg-[var(--background-secondary)]'
                            }`}
                          >
                            <div className="flex items-start gap-3 min-w-0">
                              <span
                                aria-hidden
                                className={`mt-1 w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                                  selected ? 'border-[#1D5BD6] bg-[#1D5BD6]' : 'border-[#CBD5E1]'
                                }`}
                              >
                                {selected && <span className="w-2 h-2 rounded-full bg-white" />}
                              </span>
                              <div className="min-w-0 flex-1">
                                {/* The time today, then its part(s) */}
                                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                  <span className="text-[16px] font-bold tabular-nums text-[color:var(--foreground)]">{timeRange12(t.start, t.end)}</span>
                                  {partsLabel(t.parts).map(label => (
                                    <span key={label} className={`text-[12px] font-semibold px-2 py-0.5 rounded-md border ${
                                      label === 'Laboratory' ? 'bg-[#FFFBEB] text-[#B45309] border-[#FDE68A]' : 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE]'
                                    }`}>
                                      {label}
                                    </span>
                                  ))}
                                  {requested && <span className="text-[12px] font-semibold text-[#047857]">Requested</span>}
                                </div>
                                {/* The subject, then its block and usual room */}
                                <p className="mt-1 text-[15px] leading-snug text-[color:var(--foreground)] break-words">
                                  <span className="font-semibold">{s.subject_code}</span>
                                  <span className="text-[color:var(--foreground-secondary)]"> · {s.subject_name}</span>
                                </p>
                                <p className="mt-0.5 text-[13px] text-[color:var(--foreground-muted)]">
                                  {block}{usual ? ` · Room ${usual}` : ' · No room yet'}
                                </p>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    )}
                  </div>

                  {/* Right column: room · reason · submit */}
                  <div className="min-w-0 space-y-5">
                  <div className="min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <label className="block text-sm font-semibold text-[color:var(--foreground)]">Preferred Room</label>
                      {checkingRooms && <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1D5BD6]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking rooms…</span>}
                    </div>
                    {!selectedClass ? (
                      <p className="text-sm text-[color:var(--foreground-muted)]">Pick a class first to see which rooms are free.</p>
                    ) : freedRooms && !checkingRooms && usableRooms.length === 0 ? (
                      <div className="rounded-xl border border-[color:var(--border)] bg-[var(--background-secondary)] px-4 py-4">
                        <p className="text-[15px] font-semibold text-[color:var(--foreground)]">No room is free for {timeRange12(selectedClass.time.start, selectedClass.time.end)} today.</p>
                        <p className="mt-1 text-sm text-[color:var(--foreground-muted)]">A room shows here when its faculty frees it with Free My Room, or its class isn’t scanned within 15 minutes.</p>
                      </div>
                    ) : (
                      <>
                        {labWindow && lecWindow && (lecWindow.start !== labWindow.start || lecWindow.end !== labWindow.end) && usableRooms.some(r => roomGroupOf(r) === 'lec') && (
                          <p className="mb-2 text-sm text-[color:var(--foreground-muted)]">A lecture room is for the Lecture only ({timeRange12(lecWindow.start, lecWindow.end)}).</p>
                        )}
                        <div role="radiogroup" aria-label="Rooms freed for this class time" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {usableRooms.map(r => {
                            const { label, Icon, bg, fg } = ROOM_GROUPS.find(g => g.key === roomGroupOf(r)) ?? ROOM_GROUPS[0];
                            const selected = requestedRoomId === String(r.id);
                            return (
                              <button
                                key={r.id}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                onClick={() => setRequestedRoomId(String(r.id))}
                                className="relative overflow-hidden text-left rounded-xl border-2 pl-4 pr-3 py-3 min-w-0 min-h-12 transition-all active:scale-[0.98]"
                                style={selected
                                  ? { borderColor: fg, backgroundColor: bg, boxShadow: `0 6px 16px -10px ${fg}` }
                                  : { borderColor: `${fg}33`, backgroundColor: '#FFFFFF' }}
                              >
                                <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: fg }} />
                                <p className="text-[15px] font-bold break-words" style={{ color: selected ? fg : '#0B2A5B' }}>{r.room_name}</p>
                                <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold" style={{ color: fg }}>
                                  <Icon className="w-3.5 h-3.5" aria-hidden /> {label}
                                </p>
                                <p className="mt-0.5 text-xs font-medium text-[#047857] break-words">
                                  {r.unclaimed_until ? `Not scanned · free until ${time12(r.unclaimed_until)}` : `Freed by ${r.freed_by ?? 'its faculty'}`}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>

                  <div>
                    <label htmlFor="room-request-reason" className="block text-sm font-semibold text-[color:var(--foreground)] mb-2">
                      Reason <span className="font-medium text-[color:var(--foreground-muted)]">(optional)</span>
                    </label>
                    <textarea
                      id="room-request-reason"
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      rows={3}
                      placeholder="Why do you need a different room?"
                      className={`${INPUT_CLS} resize-none`}
                    />
                  </div>

                  <div className="flex flex-col-reverse sm:flex-row gap-2.5">
                    <button
                      type="submit"
                      disabled={submitting || !selectedClass || !requestedRoomId}
                      className={`${BTN_PRIMARY} w-full sm:w-auto`}
                    >
                      {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</> : 'Submit Request'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowForm(false); resetForm(); }}
                      className={`${BTN_SECONDARY} w-full sm:w-auto`}
                    >
                      Cancel
                    </button>
                  </div>
                  </div>
                </form>
              </motion.div>
              </motion.div>
            )}
            </AnimatePresence>,
            document.body,
            )}

            {/* Active | History — pick a card, its list shows below */}
            <div className="grid grid-cols-2 gap-3 sm:gap-4" role="tablist" aria-label="Requests">
              {([
                { key: 'active', label: 'Active', sub: 'Waiting or in use', count: activeRequests.length, tone: '#1D5BD6', Icon: Clock },
                { key: 'history', label: 'History', sub: 'Finished requests', count: pastRequests.length, tone: '#0B2A5B', Icon: HistoryIcon },
              ] as const).map(t => {
                const on = view === t.key;
                return (
                  <motion.button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setView(v => (v === t.key ? null : t.key))}
                    aria-expanded={on}
                    whileHover={reduceMotion || on ? undefined : { y: -2 }}
                    whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                    className="qr-stat-tint relative overflow-hidden text-left rounded-2xl border-2 px-3 sm:px-5 py-4 flex items-center gap-2 sm:gap-4 min-w-0 transition-[border-color,box-shadow] duration-300"
                    style={{
                      background: `linear-gradient(135deg, ${t.tone}${on ? '1F' : '0D'} 0%, #FFFFFF 75%)`,
                      borderColor: on ? t.tone : `${t.tone}33`,
                      boxShadow: on ? `0 12px 26px -16px ${t.tone}` : undefined,
                    }}
                  >
                    {on && <motion.span layoutId="rr-view-bar" className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: t.tone }} transition={{ duration: reduceMotion ? 0 : 0.35, ease: EASE }} />}
                    {/* Phones: no icon, so the label always has room for one line */}
                    <span className="hidden sm:flex w-11 h-11 rounded-xl items-center justify-center flex-shrink-0" style={{ backgroundColor: on ? t.tone : `${t.tone}14`, color: on ? '#FFFFFF' : t.tone }}>
                      <t.Icon className="w-5 h-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-bold text-[#0B2A5B] whitespace-nowrap">{t.label}</span>
                      <span className="hidden sm:block text-xs text-[#64748B]">{t.sub}</span>
                    </span>
                    <span className="text-2xl font-bold tabular-nums flex-shrink-0" style={{ color: t.tone }}>{t.count}</span>
                    <motion.span className="flex-shrink-0" animate={{ rotate: on ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.3 }} style={{ color: on ? t.tone : '#94A3B8' }} aria-hidden>
                      <ChevronDown className="w-5 h-5" />
                    </motion.span>
                  </motion.button>
                );
              })}
            </div>

            <AnimatePresence mode="wait" initial={false}>
              {view && (
              <motion.section
                key={view}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE } }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, transition: { duration: 0.18, ease: EASE } }}
                className="pb-1"
              >
                {view === 'active' ? (
                  activeRequests.length === 0 ? (
                    <div className={`${CARD} px-5 py-10 flex flex-col items-center text-center`}>
                      <span className="w-14 h-14 rounded-2xl bg-[#EFF6FF] text-[#1D5BD6] flex items-center justify-center mb-3">
                        <Inbox className="w-7 h-7" />
                      </span>
                      <p className="text-base font-bold text-[#0B2A5B]">No active requests</p>
                      <p className="text-sm text-[#64748B] mt-1 max-w-sm">
                        {canCreate
                          ? 'Need a room for one of your classes today? Start a new request.'
                          : 'A teaching schedule is required first.'}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {activeRequests.map(req => (
                        <RequestCard key={req.id} req={req} onCancel={handleCancel} emphasize today={today?.date ?? null} />
                      ))}
                    </div>
                  )
                ) : pastRequests.length === 0 ? (
                  <div className={`${CARD} px-5 py-10 flex flex-col items-center text-center`}>
                    <span className="w-14 h-14 rounded-2xl bg-[#E8EEF8] text-[#0B2A5B] flex items-center justify-center mb-3">
                      <HistoryIcon className="w-7 h-7" />
                    </span>
                    <p className="text-base font-bold text-[#0B2A5B]">No history yet</p>
                    <p className="text-sm text-[#64748B] mt-1">Approved, rejected and finished requests will appear here.</p>
                  </div>
                ) : (
                  <div className={`${CARD} overflow-hidden`}>
                    {pastRequests.map(req => (
                      <HistoryRow key={req.id} req={req} onDelete={handleDeleteHistory} deleting={deletingId === req.id} today={today?.date ?? null} />
                    ))}
                  </div>
                )}
              </motion.section>
              )}
            </AnimatePresence>
          </>
        )}
        </PageLoadTransition>
      </div>
    </div>
  );
}
