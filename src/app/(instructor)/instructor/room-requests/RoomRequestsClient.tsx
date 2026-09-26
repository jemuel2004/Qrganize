'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle, XCircle, RefreshCw, Plus, X,
  ChevronDown, AlertTriangle,
  QrCode, Loader2, Trash2,
} from 'lucide-react';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import BackButton from '@/client/components/ui/BackButton';
import { ListSkeleton } from '@/client/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';

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

function Alert({
  type, children, onDismiss,
}: { type: 'success' | 'error' | 'info'; children: React.ReactNode; onDismiss?: () => void }) {
  const cfg = {
    success: 'bg-[#ECFDF5] border-[#A7F3D0] text-[#059669]',
    error: 'bg-[#FEF2F2] border-[#FECACA] text-[#DC2626]',
    info: 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1D5BD6]',
  }[type];
  const Icon = { success: CheckCircle, error: XCircle, info: AlertTriangle }[type];
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${cfg}`}>
      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span className="flex-1 leading-relaxed min-w-0 break-words">{children}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="min-h-11 min-w-11 -mr-1 -mt-1 inline-flex items-center justify-center opacity-50 hover:opacity-100 flex-shrink-0 transition-opacity"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [selectedScheduleId, setSelectedScheduleId] = useState('');
  const [requestedRoomId, setRequestedRoomId] = useState('');
  const [reason, setReason] = useState('');

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

  const validSchedules = useMemo(
    () => schedules.filter(hasValidSessions),
    [schedules],
  );

  const selectedSchedule = validSchedules.find(s => String(s.id) === selectedScheduleId) ?? null;
  const lectureRooms = useMemo(
    () => rooms.filter(r => {
      const t = String(r.room_type ?? '').trim().toLowerCase();
      return t !== 'laboratory' && t !== 'computer lab';
    }),
    [rooms],
  );
  const assignedButUnscheduled = !loading && schedules.length > 0 && validSchedules.length === 0;
  const hasNoSchedule = !loading && validSchedules.length === 0;
  const showSkeleton = useMinLoading(loading && requests.length === 0, LOADING_DELAY);

  function resetForm() {
    setSelectedScheduleId('');
    setRequestedRoomId('');
    setReason('');
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
      <div className="w-full max-w-4xl mx-auto space-y-5 min-w-0">

        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <BackButton />
            <h1 className="text-2xl font-bold text-[color:var(--foreground)] tracking-tight">
              Room Requests
            </h1>
            <p className="mt-1 text-sm text-[color:var(--foreground-muted)] leading-relaxed">
              Request a lecture room change and confirm with a QR scan within 15 minutes.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 w-full sm:w-auto">
            <button
              type="button"
              onClick={loadData}
              disabled={loading}
              className={`${BTN_SECONDARY} flex-1 sm:flex-none`}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {canCreate && (
              <button
                type="button"
                onClick={() => { setShowForm(v => !v); setError(''); setSuccess(''); }}
                disabled={loading}
                className={`${BTN_PRIMARY} flex-1 sm:flex-none`}
              >
                {showForm ? <X className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                {showForm ? 'Close' : 'New Request'}
              </button>
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

        {success && <Alert type="success" onDismiss={() => setSuccess('')}>{success}</Alert>}
        {error && !showForm && <Alert type="error" onDismiss={() => setError('')}>{error}</Alert>}

        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={<ListSkeleton rows={6} />}
        >
        {!showSkeleton && (
          <>
            {hasNoSchedule && (
              <EmptyScheduleState assignedButUnscheduled={assignedButUnscheduled} />
            )}

            {!hasNoSchedule && showForm && (
              <div className={`${CARD} overflow-hidden min-w-0`}>
                <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-[color:var(--border)]">
                  <div className="min-w-0">
                    <p className="text-base font-bold text-[color:var(--foreground)]">New Room Request</p>
                    <p className="text-sm text-[color:var(--foreground-muted)] mt-0.5">
                      Choose a class and preferred room.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setShowForm(false); resetForm(); }}
                    className="min-h-11 min-w-11 rounded-xl flex items-center justify-center text-[color:var(--foreground-muted)]
                      hover:bg-[var(--background-secondary)] transition-colors flex-shrink-0"
                    aria-label="Close form"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="p-5 space-y-5">
                  {error && <Alert type="error" onDismiss={() => setError('')}>{error}</Alert>}

                  <div className="min-w-0">
                    <label className="block text-sm font-semibold text-[color:var(--foreground)] mb-2">Teaching Schedule</label>
                    <div className="space-y-2 max-h-72 overflow-y-auto pr-0.5">
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

                  <div className="min-w-0">
                    <label className="block text-sm font-semibold text-[color:var(--foreground)] mb-2">Preferred Room</label>
                    {selectedSchedule?.room_name && (
                      <div className="mb-3 rounded-xl border border-[color:var(--border)] bg-[var(--background-secondary)] px-4 py-3">
                        <p className="text-xs font-semibold text-[color:var(--foreground-muted)]">Current room</p>
                        <p className="text-sm font-semibold text-[color:var(--foreground)] mt-0.5">{selectedSchedule.room_name}</p>
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-y-auto">
                      {lectureRooms.map(r => {
                        const selected = requestedRoomId === String(r.id);
                        return (
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => setRequestedRoomId(String(r.id))}
                            className={`text-left rounded-xl border px-4 py-3.5 min-w-0 min-h-12 transition-colors ${
                              selected
                                ? 'border-[#1D5BD6] bg-[#EFF6FF] ring-2 ring-[#1D5BD6]/20'
                                : 'border-[color:var(--border)] bg-[var(--surface-elevated)] hover:bg-[var(--background-secondary)]'
                            }`}
                          >
                            <p className="text-sm font-semibold text-[color:var(--foreground)] break-words">{r.room_name}</p>
                            <p className="text-xs text-[color:var(--foreground-muted)] mt-0.5 break-words">
                              {r.room_type}
                              {r.building ? ` · ${r.building}` : ''}
                              {r.capacity ? ` · ${r.capacity} seats` : ''}
                            </p>
                          </button>
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
                </form>
              </div>
            )}

            <section className="space-y-3" aria-labelledby="active-heading">
              <h2 id="active-heading" className="text-base font-bold text-[color:var(--foreground)]">
                Active
                {activeRequests.length > 0 && (
                  <span className="ml-2 font-medium text-[color:var(--foreground-muted)]">
                    ({activeRequests.length})
                  </span>
                )}
              </h2>

              {activeRequests.length === 0 ? (
                <div className={`${CARD} px-5 py-7 text-center`}>
                  <p className="text-sm font-semibold text-[color:var(--foreground)]">No active requests</p>
                  <p className="text-sm text-[color:var(--foreground-muted)] mt-1">
                    {canCreate
                      ? 'Use New Request when you need a different room.'
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
              )}
            </section>

            <section className="space-y-3 pb-1" aria-labelledby="history-heading">
              <div className={`${CARD} overflow-hidden`}>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <h2 id="history-heading" className="text-sm font-bold text-[color:var(--foreground)]">
                    History
                    {pastRequests.length > 0 && (
                      <span className="ml-1.5 font-medium text-[color:var(--foreground-muted)]">
                        ({pastRequests.length})
                      </span>
                    )}
                  </h2>
                  {pastRequests.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setHistoryOpen(v => !v)}
                      aria-expanded={historyOpen}
                      className="inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg text-sm font-medium
                        text-[color:var(--foreground-muted)] hover:text-[color:var(--foreground)]
                        hover:bg-[var(--background-secondary)] transition-colors"
                    >
                      {historyOpen ? 'Hide' : 'Show'}
                      <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${historyOpen ? 'rotate-180' : ''}`} />
                    </button>
                  ) : (
                    <span className="text-sm text-[color:var(--foreground-muted)]">None</span>
                  )}
                </div>

                {historyOpen && pastRequests.length > 0 && (
                  <div className="border-t border-[color:var(--border)]">
                    {pastRequests.map(req => (
                      <HistoryRow
                        key={req.id}
                        req={req}
                        onDelete={handleDeleteHistory}
                        deleting={deletingId === req.id}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          </>
        )}
        </PageLoadTransition>
      </div>
    </div>
  );
}
