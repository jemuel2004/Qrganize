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
const roomGroupOf = (r: Room): RoomGroup => {
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
}

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
}: {
  req: RoomRequest;
  onDelete: (id: number) => void;
  deleting?: boolean;
}) {
  const [open, setOpen] = useState(false);
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
          {validSessions.length > 0 && (
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
  req, onCancel, emphasize = false,
}: {
  req: RoomRequest;
  onCancel: (id: number) => void;
  emphasize?: boolean;
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
  const canCancel = ['Pending', 'Pending Confirmation'].includes(req.status);
  const isPending = req.status === 'Pending';

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
              {isPendingConf && req.confirmation_deadline && (
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
            <p className="text-xs font-bold uppercase tracking-wide text-[color:var(--foreground-muted)]">Room change</p>
            <p className="mt-1 text-base font-semibold text-[color:var(--foreground)] break-words">
              {req.original_room_name ?? 'No room'}
              <span className="text-[color:var(--foreground-muted)] mx-1.5">→</span>
              <span className="text-[#1D5BD6]">{req.requested_room_name ?? 'N/A'}</span>
            </p>
          </div>
          <div className="rounded-xl bg-[var(--background-secondary)] border border-[color:var(--border)] px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-[color:var(--foreground-muted)]">When</p>
            <p className="mt-1 text-base font-semibold text-[color:var(--foreground)] break-words">
              {validSessions.length > 0
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
              <p className="text-sm font-bold text-[#0B2A5B]">Scan QR code to confirm</p>
              <p className="text-sm text-[#475569] mt-1 leading-relaxed break-words">
                Go to <strong>{req.requested_room_name}</strong> and scan within 15 minutes.
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
            Confirmed — schedule updated to <strong>{req.requested_room_name}</strong>.
          </p>
        )}

        {isApproved && (
          <p className="text-sm text-[#047857] bg-[#ECFDF5] border border-[#A7F3D0] rounded-xl px-4 py-3 leading-relaxed">
            Approved. Room assignment updated.
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
            <div>
              <p className="text-xs font-bold uppercase tracking-wide text-[color:var(--foreground-muted)] mb-1.5">Reason</p>
              <p className="text-sm text-[color:var(--foreground)] leading-relaxed bg-[var(--background-secondary)] rounded-xl px-4 py-3 border border-[color:var(--border)]">
                {req.reason}
              </p>
            </div>
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
  const [requestedRoomId, setRequestedRoomId] = useState('');
  const [reason, setReason] = useState('');
  const [openGroups, setOpenGroups] = useState<Record<RoomGroup, boolean>>({ lec: false, lab: false });
  /** Rooms busy during the selected class's sessions → reason ("CS 413 · Mon 7:00 AM") */
  const [busyRooms, setBusyRooms] = useState<Record<number, string>>({});
  const [checkingRooms, setCheckingRooms] = useState(false);
  const reduceMotion = useReducedMotion();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [reqRes, schedRes, roomsRes] = await Promise.all([
        fetch('/api/instructor/room-requests'),
        fetch('/api/instructor/schedule'),
        fetch('/api/rooms?status=Active'),
      ]);
      if (reqRes.ok) setRequests((await reqRes.json()).requests || []);
      if (schedRes.ok) setSchedules((await schedRes.json()).schedules || []);
      if (roomsRes.ok) setRooms((await roomsRes.json()).rooms || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Arrived from the dashboard's "Request" button (?room=<id>) — open the form with that room picked
  const preselected = useRef(false);
  useEffect(() => {
    if (preselected.current || loading || rooms.length === 0) return;
    preselected.current = true;
    const id = new URLSearchParams(window.location.search).get('room');
    if (!id || !rooms.some(r => String(r.id) === id)) return;
    setRequestedRoomId(id);
    const room = rooms.find(r => String(r.id) === id);
    if (room) setOpenGroups(g => ({ ...g, [roomGroupOf(room)]: true }));
    setShowForm(true);
    window.history.replaceState(null, '', window.location.pathname);
  }, [loading, rooms]);

  const validSchedules = useMemo(
    () => schedules.filter(hasValidSessions),
    [schedules],
  );

  const selectedSchedule = validSchedules.find(s => String(s.id) === selectedScheduleId) ?? null;
  /** Lecture-only subjects may only use lecture rooms (same rule as the server) */
  const lectureOnly = !!selectedSchedule && !(parseFloat(String(selectedSchedule.laboratory_hours)) > 0);

  // Check every room against each of the selected class's sessions
  useEffect(() => {
    if (!selectedSchedule) { setBusyRooms({}); return; }
    const sessions = normalizeSessions(selectedSchedule.sessions).filter(ss => ss.day && ss.start_time && ss.end_time);
    let cancelled = false;
    setCheckingRooms(true);
    Promise.all(sessions.map(ss => {
      const qs = new URLSearchParams({ day: ss.day, start_time: ss.start_time.slice(0, 5), end_time: ss.end_time.slice(0, 5), room_type: 'all', exclude_ms: String(selectedSchedule.id) });
      return fetch(`/api/instructor/available-rooms?${qs}`).then(r => (r.ok ? r.json() : { rooms: [] })).then(d => ({ ss, rooms: (d.rooms ?? []) as { id: number; is_available: boolean; occupancy?: { status: string } | null; schedule_conflict?: { subject_code: string } | null }[] }));
    })).then(results => {
      if (cancelled) return;
      const busy: Record<number, string> = {};
      for (const { ss, rooms: list } of results) {
        for (const r of list) {
          if (r.is_available || busy[r.id]) continue;
          busy[r.id] = r.schedule_conflict
            ? `${r.schedule_conflict.subject_code} · ${ss.day.slice(0, 3)}`
            : r.occupancy?.status === 'Pending' ? 'Reserved now' : 'In use now';
        }
      }
      setBusyRooms(busy);
    }).catch(() => { if (!cancelled) setBusyRooms({}); })
      .finally(() => { if (!cancelled) setCheckingRooms(false); });
    return () => { cancelled = true; };
  }, [selectedSchedule]);
  const assignedButUnscheduled = !loading && schedules.length > 0 && validSchedules.length === 0;
  const hasNoSchedule = !loading && validSchedules.length === 0;
  const showSkeleton = useMinLoading(loading && requests.length === 0, LOADING_DELAY);

  useEffect(() => {
    if (!requestedRoomId) return;
    const r = rooms.find(x => String(x.id) === requestedRoomId);
    if (!r) return;
    if (busyRooms[r.id] || (lectureOnly && roomGroupOf(r) === 'lab')) setRequestedRoomId('');
  }, [busyRooms, lectureOnly, requestedRoomId, rooms]);

  useScrollLock(showForm);
  useEffect(() => {
    if (!showForm) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setShowForm(false); resetForm(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function resetForm() {
    setSelectedScheduleId('');
    setRequestedRoomId('');
    setReason('');
    setOpenGroups({ lec: false, lab: false });
    setError('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSuccess('');

    if (!selectedScheduleId) { setError('Please select a teaching schedule.'); return; }
    if (!requestedRoomId) { setError('Please select a preferred room.'); return; }
    if (reason.trim().length < 10) { setError('Reason must be at least 10 characters.'); return; }

    setSubmitting(true);
    try {
      const res = await fetch('/api/instructor/room-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          master_schedule_id: parseInt(selectedScheduleId),
          requested_room_id: parseInt(requestedRoomId),
          reason: reason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to submit request.');
        return;
      }
      setSuccess(data.message || 'Room request submitted. Scan the QR code within 15 minutes to confirm.');
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

  const activeConfirmation = requests.find(r => r.status === 'Pending Confirmation');
  const activeRequests = useMemo(
    () => requests.filter(r => ACTIVE_STATUSES.has(r.status)),
    [requests],
  );
  const pastRequests = useMemo(
    () => requests.filter(r => !ACTIVE_STATUSES.has(r.status)),
    [requests],
  );
  const canCreate = !hasNoSchedule && !activeConfirmation;

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
                  <p className="text-base font-bold text-[#0B2A5B]">Scan QR code to confirm</p>
                  {activeConfirmation.confirmation_deadline && (
                    <CountdownBadge deadline={activeConfirmation.confirmation_deadline} />
                  )}
                </div>
                <p className="text-sm text-[#475569] leading-relaxed break-words">
                  Go to <span className="font-semibold text-[#0B2A5B]">{activeConfirmation.requested_room_name}</span> and scan its QR code.
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
                      <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.8)' }}>Choose a class and preferred room.</p>
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
                    <label className="block text-sm font-semibold text-[color:var(--foreground)] mb-2">Teaching Schedule</label>
                    <div className="space-y-2 max-h-72 lg:max-h-[560px] overflow-y-auto pr-0.5">
                      {validSchedules.map(s => {
                        const selected = selectedScheduleId === String(s.id);
                        const sessions = normalizeSessions(s.sessions).filter(ss => ss.day && ss.start_time && ss.end_time);
                        return (
                          <button
                            key={s.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => { setSelectedScheduleId(String(s.id)); setRequestedRoomId(''); }}
                            className={`w-full text-left rounded-xl border px-4 py-3.5 min-w-0 min-h-12 transition-colors ${
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
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-base font-semibold text-[color:var(--foreground)] break-words leading-snug">
                                    {s.subject_code} — {s.subject_name}
                                  </p>
                                  {selected && <span className="flex-shrink-0 text-sm font-semibold text-[#1D5BD6]">Selected</span>}
                                </div>
                                <p className="text-sm text-[color:var(--foreground-muted)] mt-1 break-words">
                                  Block {s.block_name} · {s.year_level}
                                  {s.room_name ? ` · Current room: ${s.room_name}` : ''}
                                </p>
                                <div className="mt-1.5 flex flex-col gap-1">
                                  {sessions.map((ss, i) => (
                                    <span key={i} className="text-sm text-[#1D5BD6] break-words">
                                      {formatSessionOption(ss)}
                                      {ss.room_name && ss.room_name !== s.room_name ? ` · ${ss.room_name}` : ''}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Right column: room · reason · submit */}
                  <div className="min-w-0 space-y-5">
                  <div className="min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <label className="block text-sm font-semibold text-[color:var(--foreground)]">Preferred Room</label>
                      {checkingRooms && <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#1D5BD6]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking rooms…</span>}
                    </div>
                    {!selectedSchedule && <p className="mb-2 text-sm text-[color:var(--foreground-muted)]">Pick a class first to see which rooms are free.</p>}
                    {selectedSchedule?.room_name && (
                      <div className="mb-3 rounded-xl border border-[color:var(--border)] bg-[var(--background-secondary)] px-4 py-3">
                        <p className="text-xs font-semibold text-[color:var(--foreground-muted)]">Current room</p>
                        <p className="text-sm font-semibold text-[color:var(--foreground)] mt-0.5">{selectedSchedule.room_name}</p>
                      </div>
                    )}
                    <div className="space-y-2">
                      {ROOM_GROUPS.map(({ key, label, Icon, bg, fg }) => {
                        const list = rooms.filter(r => roomGroupOf(r) === key);
                        if (list.length === 0) return null;
                        const locked = key === 'lab' && lectureOnly;
                        const open = openGroups[key] && !locked;
                        const picked = list.find(r => requestedRoomId === String(r.id));
                        return (
                          <div key={key} className="rounded-xl border border-[color:var(--border)] bg-[var(--surface-elevated)] overflow-hidden">
                            <motion.button
                              type="button"
                              onClick={() => { if (!locked) setOpenGroups(g => ({ ...g, [key]: !g[key] })); }}
                              whileTap={reduceMotion || locked ? undefined : { scale: 0.99 }}
                              aria-expanded={open}
                              aria-disabled={locked}
                              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${locked ? 'opacity-55 cursor-not-allowed' : 'hover:bg-[var(--background-secondary)]'}`}
                            >
                              <span className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: bg, color: fg }}>
                                <Icon className="w-4 h-4" />
                              </span>
                              <span className="flex-1 min-w-0">
                                <span className="block text-sm font-semibold text-[color:var(--foreground)]">{label}</span>
                                {locked
                                  ? <span className="block text-xs font-medium text-[color:var(--foreground-muted)]">Not allowed for a lecture subject</span>
                                  : picked && <span className="block text-xs font-medium truncate" style={{ color: fg }}>{picked.room_name}</span>}
                              </span>
                              <motion.span
                                animate={{ rotate: open ? 180 : 0 }}
                                transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }}
                                className="text-[color:var(--foreground-muted)]"
                              >
                                <ChevronDown className="w-4 h-4" />
                              </motion.span>
                            </motion.button>
                            <AnimatePresence initial={false}>
                              {open && (
                                <motion.div
                                  key="rooms"
                                  initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1, transition: { duration: 0.35, ease: EASE } }}
                                  exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0, transition: { duration: 0.28, ease: EASE } }}
                                  className="overflow-hidden"
                                >
                                  <div className="grid grid-cols-2 gap-2 p-3 pt-1 max-h-72 overflow-y-auto">
                                    {list.map(r => {
                                      const selected = requestedRoomId === String(r.id);
                                      const busy = busyRooms[r.id];
                                      const disabled = !!busy || !selectedSchedule;
                                      return (
                                        <button
                                          key={r.id}
                                          type="button"
                                          disabled={disabled}
                                          onClick={() => setRequestedRoomId(String(r.id))}
                                          title={busy ? `Occupied — ${busy}` : undefined}
                                          className={`relative overflow-hidden text-left rounded-xl border-2 pl-4 pr-3 py-3 min-w-0 min-h-12 transition-all ${disabled ? 'cursor-not-allowed' : 'active:scale-[0.98]'}`}
                                          style={busy
                                            ? { borderColor: '#E2E8F0', backgroundColor: '#F8FAFC' }
                                            : selected
                                              ? { borderColor: fg, backgroundColor: bg, boxShadow: `0 6px 16px -10px ${fg}` }
                                              : { borderColor: `${fg}33`, backgroundColor: '#FFFFFF', opacity: selectedSchedule ? 1 : 0.6 }}
                                        >
                                          <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: busy ? '#CBD5E1' : fg }} />
                                          <p className={`text-sm font-bold break-words ${busy ? 'line-through' : ''}`} style={{ color: busy ? '#94A3B8' : selected ? fg : '#0B2A5B' }}>{r.room_name}</p>
                                          {busy
                                            ? <p className="text-xs font-semibold text-[#DC2626] mt-0.5 break-words">Occupied · {busy}</p>
                                            : <p className="text-xs text-[color:var(--foreground-muted)] mt-0.5 break-words">
                                                {[r.building, r.capacity ? `${r.capacity} seats` : null].filter(Boolean).join(' · ')}
                                              </p>}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-sm font-semibold text-[color:var(--foreground)]">Reason</label>
                      <span className={`text-xs tabular-nums ${
                        reason.trim().length > 0 && reason.trim().length < 10
                          ? 'text-[#DC2626]'
                          : reason.trim().length >= 10
                            ? 'text-[#059669]'
                            : 'text-[color:var(--foreground-muted)]'
                      }`}>
                        {reason.trim().length}/10 min
                      </span>
                    </div>
                    <textarea
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      required
                      rows={3}
                      placeholder="Why do you need a different room?"
                      className={`${INPUT_CLS} resize-none`}
                    />
                  </div>

                  <div className="flex flex-col-reverse sm:flex-row gap-2.5">
                    <button
                      type="submit"
                      disabled={submitting || !selectedScheduleId || !requestedRoomId || reason.trim().length < 10}
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
                    className="qr-stat-tint relative overflow-hidden text-left rounded-2xl border-2 px-4 sm:px-5 py-4 flex items-center gap-3 sm:gap-4 transition-[border-color,box-shadow] duration-300"
                    style={{
                      background: `linear-gradient(135deg, ${t.tone}${on ? '1F' : '0D'} 0%, #FFFFFF 75%)`,
                      borderColor: on ? t.tone : `${t.tone}33`,
                      boxShadow: on ? `0 12px 26px -16px ${t.tone}` : undefined,
                    }}
                  >
                    {on && <motion.span layoutId="rr-view-bar" className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: t.tone }} transition={{ duration: reduceMotion ? 0 : 0.35, ease: EASE }} />}
                    <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: on ? t.tone : `${t.tone}14`, color: on ? '#FFFFFF' : t.tone }}>
                      <t.Icon className="w-5 h-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-bold text-[#0B2A5B]">{t.label}</span>
                      <span className="hidden sm:block text-xs text-[#64748B]">{t.sub}</span>
                    </span>
                    <span className="text-2xl font-bold tabular-nums" style={{ color: t.tone }}>{t.count}</span>
                    <motion.span animate={{ rotate: on ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.3 }} style={{ color: on ? t.tone : '#94A3B8' }} aria-hidden>
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
                          ? 'Need a different room for a class? Start a new request.'
                          : hasNoSchedule
                            ? 'A teaching schedule is required first.'
                            : 'Complete your QR confirmation before creating another request.'}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {activeRequests.map(req => (
                        <RequestCard key={req.id} req={req} onCancel={handleCancel} emphasize />
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
                      <HistoryRow key={req.id} req={req} onDelete={handleDeleteHistory} deleting={deletingId === req.id} />
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
