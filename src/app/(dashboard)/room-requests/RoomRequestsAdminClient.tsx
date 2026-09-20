'use client';

import { useEffect, useRef, useState } from 'react';
import { useToast } from '@/client/context/ToastContext';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { ListSkeleton } from '@/client/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';
import {
  DoorOpen, Check, X, RefreshCw, CheckCircle, XCircle, Clock,
  ArrowRight, User, BookOpen, Building2, MessageSquare, CalendarDays,
  QrCode, Timer, Zap, AlertTriangle,
} from 'lucide-react';

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface RoomRequest {
  id: number;
  faculty_name: string;
  subject_code: string | null;
  subject_name: string | null;
  block_name: string | null;
  year_level: string | null;
  program_code: string | null;
  original_room_name: string | null;
  requested_room_name: string | null;
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
}

type Filter = 'All' | 'Pending Confirmation' | 'In-Use' | 'Expired' | 'Rejected' | 'Approved';

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ─── Countdown hook ─────────────────────────────────────────────────────── */
function useCountdown(deadline: string | null) {
  const [label, setLabel]   = useState('');
  const [urgent, setUrgent] = useState(false);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!deadline) return;
    const tick = () => {
      const diff = new Date(deadline).getTime() - Date.now();
      if (diff <= 0) {
        setLabel('Window closed');
        setUrgent(true);
        if (ref.current) clearInterval(ref.current);
        return;
      }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setLabel(`${m}:${s.toString().padStart(2, '0')} remaining`);
      setUrgent(diff < 5 * 60_000);
    };
    tick();
    ref.current = setInterval(tick, 1000);
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [deadline]);

  return { label, urgent };
}

/* ─── Status config ──────────────────────────────────────────────────────── */
const STATUS_CFG: Record<string, {
  badge: string; dot: string; icon: React.ReactNode;
}> = {
  'Pending Confirmation': {
    badge: 'bg-blue-50 text-[#3C91E6] border border-blue-200',
    dot:   'bg-[#3C91E6]',
    icon:  <QrCode className="w-3.5 h-3.5" />,
  },
  'In-Use': {
    badge: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    dot:   'bg-emerald-500',
    icon:  <Zap className="w-3.5 h-3.5" />,
  },
  Expired: {
    badge: 'bg-[#F1F5F9] text-[#64748B] border border-[#E2E8F0]',
    dot:   'bg-[#94A3B8]',
    icon:  <Timer className="w-3.5 h-3.5" />,
  },
  Approved: {
    badge: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
    dot:   'bg-emerald-500',
    icon:  <CheckCircle className="w-3.5 h-3.5" />,
  },
  Rejected: {
    badge: 'bg-red-50 text-red-600 border border-red-200',
    dot:   'bg-red-500',
    icon:  <XCircle className="w-3.5 h-3.5" />,
  },
  Pending: {
    badge: 'bg-amber-50 text-amber-700 border border-amber-200',
    dot:   'bg-amber-400',
    icon:  <Clock className="w-3.5 h-3.5" />,
  },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CFG[status] ?? {
    badge: 'bg-[#F1F5F9] text-[#64748B] border border-[#E2E8F0]',
    dot: 'bg-[#94A3B8]',
    icon: <Clock className="w-3.5 h-3.5" />,
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${cfg.badge}`}>
      {cfg.icon} {status}
    </span>
  );
}

/* ─── Countdown badge ────────────────────────────────────────────────────── */
function CountdownBadge({ deadline }: { deadline: string }) {
  const { label, urgent } = useCountdown(deadline);
  if (!label) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full
      ${urgent
        ? 'bg-red-50 text-red-600 border border-red-200 animate-pulse'
        : 'bg-blue-50 text-[#3C91E6] border border-blue-200'
      }`}>
      <Timer className="w-3 h-3" /> {label}
    </span>
  );
}

/* ─── Summary card ───────────────────────────────────────────────────────── */
interface SummaryCardProps {
  label: string; count: number; active: boolean; onClick: () => void;
  accentBg: string; accentText: string; accentBorder: string;
  icon: React.ReactNode; description: string;
}

function SummaryCard({ label, count, active, onClick, accentBg, accentText, accentBorder, icon, description }: SummaryCardProps) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex flex-col items-start gap-3 p-5 rounded-2xl border text-left transition-all duration-200 w-full group',
        active
          ? `${accentBorder} bg-white shadow-md ring-1 ${accentBorder.replace('border-', 'ring-')}`
          : 'border-[#E2E8F0] bg-white shadow-sm hover:shadow-md hover:border-[#CBD5E1]',
      ].join(' ')}
    >
      {/* Icon badge */}
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${active ? accentBg : 'bg-[#F8FAFC]'} transition-colors`}>
        <span className={active ? accentText : 'text-[#94A3B8]'}>{icon}</span>
      </div>

      {/* Count */}
      <div>
        <p className={`text-4xl font-extrabold leading-none tabular-nums ${active ? accentText : 'text-[#1E3A5F]'}`}>
          {count}
        </p>
        <p className="text-sm font-bold text-[#1E3A5F] mt-2 leading-tight">{label}</p>
        <p className="text-xs text-[#94A3B8] mt-0.5">{description}</p>
      </div>
    </button>
  );
}

/* ─── Request card ───────────────────────────────────────────────────────── */
function RequestCard({
  req, onAction, actionId, notes, onNoteChange,
}: {
  req: RoomRequest;
  onAction: (id: number, status: 'Approved' | 'Rejected') => void;
  actionId: number | null;
  notes: Record<number, string>;
  onNoteChange: (id: number, val: string) => void;
}) {
  const isPendingConf = req.status === 'Pending Confirmation';
  const isInUse       = req.status === 'In-Use';
  const isExpired     = req.status === 'Expired';

  const accentColor =
    isPendingConf              ? 'bg-[#3C91E6]' :
    isInUse                    ? 'bg-emerald-500' :
    isExpired                  ? 'bg-[#CBD5E1]' :
    req.status === 'Approved'  ? 'bg-emerald-500' :
    req.status === 'Rejected'  ? 'bg-red-400' :
    'bg-amber-400';

  return (
    <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm overflow-hidden">
      {/* Color accent top bar */}
      <div className={`h-1 w-full ${accentColor}`} />

      <div className="p-6">
        {/* Row 1 — faculty + badge + date */}
        <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Avatar */}
            <div className="w-10 h-10 rounded-full bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center flex-shrink-0">
              <User className="w-4.5 h-4.5 text-[#3C91E6]" />
            </div>
            <div>
              <p className="text-base font-bold text-[#1E3A5F] leading-tight">{req.faculty_name}</p>
              <p className="text-xs font-medium text-[#94A3B8]">Instructor</p>
            </div>
            <StatusBadge status={req.status} />
            {isPendingConf && req.confirmation_deadline && (
              <CountdownBadge deadline={req.confirmation_deadline} />
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-[#94A3B8]">
            <CalendarDays className="w-3.5 h-3.5" />
            {formatDate(req.created_at)}
          </div>
        </div>

        {/* Row 2 — subject */}
        {req.subject_code && (
          <div className="flex items-start gap-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 mb-3">
            <BookOpen className="w-4 h-4 text-[#64748B] flex-shrink-0 mt-0.5" />
            <p className="text-sm text-[#475569]">
              <span className="font-bold text-[#1E3A5F]">{req.subject_code}</span>
              {req.subject_name  && <span className="text-[#475569]"> — {req.subject_name}</span>}
              {req.block_name    && <span className="text-[#64748B]"> &nbsp;·&nbsp; Block <strong className="text-[#1E3A5F]">{req.block_name}</strong></span>}
              {req.program_code  && <span className="text-[#94A3B8]"> &nbsp;·&nbsp; {req.program_code}</span>}
            </p>
          </div>
        )}

        {/* Row 3 — room arrow */}
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <div className="flex items-center gap-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 min-w-[180px] flex-1">
            <Building2 className="w-4 h-4 text-[#94A3B8] flex-shrink-0" />
            <div>
              <p className="text-[10px] text-[#94A3B8] uppercase tracking-widest font-semibold">Current Room</p>
              <p className="text-sm font-bold text-[#1E3A5F] mt-0.5">
                {req.original_room_name || <span className="text-[#CBD5E1] font-medium italic">Not assigned</span>}
              </p>
            </div>
          </div>

          <ArrowRight className="w-5 h-5 text-[#3C91E6] flex-shrink-0" />

          <div className="flex items-center gap-3 bg-[#EFF6FF] border border-[#BFDBFE] rounded-xl px-4 py-3 min-w-[180px] flex-1">
            <Building2 className="w-4 h-4 text-[#3C91E6] flex-shrink-0" />
            <div>
              <p className="text-[10px] text-[#3C91E6] uppercase tracking-widest font-semibold">Requested Room</p>
              <p className="text-sm font-bold text-[#1E3A5F] mt-0.5">
                {req.requested_room_name ?? 'N/A'}
              </p>
            </div>
          </div>
        </div>

        {/* Row 4 — reason */}
        <div className="flex items-start gap-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 mb-3">
          <MessageSquare className="w-4 h-4 text-[#64748B] flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-[10px] text-[#94A3B8] uppercase tracking-widest font-semibold mb-1">Reason</p>
            <p className="text-sm text-[#475569] leading-relaxed">&quot;{req.reason}&quot;</p>
          </div>
        </div>

        {/* Status info — In-Use */}
        {isInUse && (
          <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-3">
            <Zap className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm font-medium text-emerald-700">
              Room is occupied{req.requested_room_name ? <> — schedule updated to <strong>{req.requested_room_name}</strong></> : null}. QR scan is not required.
            </p>
          </div>
        )}

        {/* Status info — Expired */}
        {isExpired && (
          <div className="flex items-start gap-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 mb-3">
            <Timer className="w-4 h-4 text-[#94A3B8] flex-shrink-0 mt-0.5" />
            <p className="text-sm text-[#64748B]">
              {req.auto_notes ?? 'QR scan window expired — room returned to available.'}
            </p>
          </div>
        )}

        {/* Status info — Pending Confirmation */}
        {isPendingConf && (
          <div className="flex items-start gap-3 bg-[#EFF6FF] border border-[#BFDBFE] rounded-xl px-4 py-3 mb-3">
            <QrCode className="w-4 h-4 text-[#3C91E6] flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-[#1E3A5F]">Waiting for QR scan confirmation</p>
              <p className="text-xs text-[#64748B] mt-0.5">
                The instructor must scan the QR code at <strong>{req.requested_room_name}</strong> within the countdown window.
                You may override this by approving or rejecting below.
              </p>
            </div>
          </div>
        )}

        {/* Admin note (resolved) */}
        {!isPendingConf && req.status !== 'Pending' && req.admin_notes && (
          <div className="flex items-start gap-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 mb-3">
            <CheckCircle className="w-4 h-4 text-[#64748B] flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[10px] text-[#94A3B8] uppercase tracking-widest font-semibold mb-1">Admin Note</p>
              <p className="text-sm text-[#475569] leading-relaxed">{req.admin_notes}</p>
            </div>
          </div>
        )}

        {/* Auto notes */}
        {req.auto_notes && !isExpired && (
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-700">{req.auto_notes}</p>
          </div>
        )}

        {/* Action area */}
        {(isPendingConf || req.status === 'Pending') && (
          <div className="mt-4 pt-5 border-t border-[#E2E8F0]">
            <p className="text-sm font-bold text-[#1E3A5F] mb-0.5">Admin Note</p>
            <p className="text-xs text-[#64748B] mb-3">
              {isPendingConf
                ? 'Override the auto-flow — approve to apply room immediately, or reject to cancel.'
                : 'Optional — this note will be visible to the instructor.'}
            </p>
            <div className={`rounded-xl transition-all duration-200 mb-4 ${
              notes[req.id]
                ? 'bg-slate-50 focus-within:shadow-[0_2px_10px_rgba(0,0,0,0.06)]'
                : 'bg-[#F8FAFC] hover:bg-slate-50/80 focus-within:bg-white focus-within:shadow-[0_2px_10px_rgba(0,0,0,0.06)]'
            }`}>
              <textarea
                value={notes[req.id] || ''}
                onChange={e => onNoteChange(req.id, e.target.value)}
                placeholder="Write a note explaining your decision (optional)..."
                rows={3}
                className="w-full bg-transparent border-0 outline-none text-sm text-[#1E3A5F] placeholder:text-[#CBD5E1] font-medium resize-none px-4 py-3"
              />
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => onAction(req.id, 'Approved')}
                disabled={actionId === req.id}
                className="flex-1 flex items-center justify-center gap-2
                  bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800
                  disabled:opacity-50 disabled:cursor-not-allowed
                  text-white py-3 px-5 rounded-xl text-sm font-bold
                  transition-all shadow-sm"
              >
                <Check className="w-4 h-4" />
                {actionId === req.id ? 'Processing…' : isPendingConf ? 'Force Approve' : 'Approve Request'}
              </button>
              <button
                onClick={() => onAction(req.id, 'Rejected')}
                disabled={actionId === req.id}
                className="flex-1 flex items-center justify-center gap-2
                  bg-white border border-red-300 text-red-600
                  hover:bg-red-50 hover:border-red-400 active:bg-red-100
                  disabled:opacity-50 disabled:cursor-not-allowed
                  py-3 px-5 rounded-xl text-sm font-bold
                  transition-all"
              >
                <X className="w-4 h-4" />
                {actionId === req.id ? 'Processing…' : 'Reject'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────────────────────── */
export default function RoomRequestsAdminClient() {
  const toast = useToast();
  const [requests, setRequests] = useState<RoomRequest[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [actionId, setActionId] = useState<number | null>(null);
  const [notes,    setNotes]    = useState<Record<number, string>>({});
  const [filter,   setFilter]   = useState<Filter>('Pending Confirmation');
  const [error,    setError]    = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/room-requests');
      if (res.ok) setRequests((await res.json()).requests || []);
      else setError('Failed to load requests. Please try refreshing.');
    } catch {
      setError('Connection error. Please check your network and try again.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleAction(id: number, status: 'Approved' | 'Rejected') {
    setActionId(id);
    try {
      const res = await fetch(`/api/admin/room-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, admin_notes: notes[id] || null }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error || 'Action failed. Please try again.');
        return;
      }
      toast.success(status === 'Approved' ? 'Room request approved.' : 'Room request rejected.');
      setNotes(prev => { const n = { ...prev }; delete n[id]; return n; });
      load();
    } finally {
      setActionId(null);
    }
  }

  const counts = {
    All:                    requests.length,
    'Pending Confirmation': requests.filter(r => r.status === 'Pending Confirmation').length,
    'In-Use':               requests.filter(r => r.status === 'In-Use').length,
    Expired:                requests.filter(r => r.status === 'Expired').length,
    Rejected:               requests.filter(r => r.status === 'Rejected').length,
    Approved:               requests.filter(r => r.status === 'Approved').length,
  };

  const filtered = filter === 'All' ? requests :
    filter === 'Rejected' ? requests.filter(r => r.status === 'Rejected') :
    requests.filter(r => r.status === filter);

  const filterLabel = filter === 'All' ? 'All Requests' : `${filter} Requests`;
  const showSkeleton = useMinLoading(loading && requests.length === 0, LOADING_DELAY);

  return (
    <div className="min-h-full bg-[#F8FAFC]">
      <div className="max-w-5xl mx-auto px-6 md:px-8 py-8">

        {/* ── Header ── */}
        <div className="flex items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-[#1E3A5F] tracking-tight">Room Change Requests</h1>
            <p className="text-sm text-[#64748B] mt-0.5">Monitor auto-confirmed requests and override when needed</p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold
              bg-white border border-[#E2E8F0] text-[#1E3A5F] shadow-sm
              hover:bg-[#F8FAFC] hover:border-[#CBD5E1] disabled:opacity-50 disabled:cursor-not-allowed
              transition-all duration-150 flex-shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[#3C91E6]' : 'text-[#64748B]'}`} />
            Refresh
          </button>
        </div>

        {/* ── Error banner ── */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-5 py-4 rounded-xl text-sm font-semibold mb-6 flex items-center gap-3">
            <XCircle className="w-4 h-4 flex-shrink-0 text-red-500" /> {error}
          </div>
        )}

        {/* ── Summary cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          <SummaryCard
            label="Pending QR"
            count={counts['Pending Confirmation']}
            active={filter === 'Pending Confirmation'}
            onClick={() => setFilter('Pending Confirmation')}
            accentBg="bg-[#EFF6FF]"
            accentText="text-[#3C91E6]"
            accentBorder="border-[#93C5FD]"
            icon={<QrCode className="w-5 h-5" />}
            description="Awaiting QR scan"
          />
          <SummaryCard
            label="In-Use"
            count={counts['In-Use']}
            active={filter === 'In-Use'}
            onClick={() => setFilter('In-Use')}
            accentBg="bg-emerald-50"
            accentText="text-emerald-600"
            accentBorder="border-emerald-300"
            icon={<Zap className="w-5 h-5" />}
            description="QR confirmed, active"
          />
          <SummaryCard
            label="Expired"
            count={counts.Expired}
            active={filter === 'Expired'}
            onClick={() => setFilter('Expired')}
            accentBg="bg-[#F1F5F9]"
            accentText="text-[#64748B]"
            accentBorder="border-[#CBD5E1]"
            icon={<Timer className="w-5 h-5" />}
            description="QR window missed"
          />
          <SummaryCard
            label="Rejected"
            count={counts.Rejected}
            active={filter === 'Rejected'}
            onClick={() => setFilter('Rejected')}
            accentBg="bg-red-50"
            accentText="text-red-500"
            accentBorder="border-red-300"
            icon={<XCircle className="w-5 h-5" />}
            description="Rejected requests"
          />
          <SummaryCard
            label="Approved"
            count={counts.Approved}
            active={filter === 'Approved'}
            onClick={() => setFilter('Approved')}
            accentBg="bg-emerald-50"
            accentText="text-emerald-600"
            accentBorder="border-emerald-300"
            icon={<CheckCircle className="w-5 h-5" />}
            description="Admin-approved"
          />
          <SummaryCard
            label="All Requests"
            count={counts.All}
            active={filter === 'All'}
            onClick={() => setFilter('All')}
            accentBg="bg-[#EFF6FF]"
            accentText="text-[#3C91E6]"
            accentBorder="border-[#93C5FD]"
            icon={<DoorOpen className="w-5 h-5" />}
            description="Total requests"
          />
        </div>

        {/* ── Section heading ── */}
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-base font-bold text-[#1E3A5F]">{filterLabel}</h2>
          <span className="text-xs font-semibold text-[#94A3B8] bg-[#F1F5F9] px-2.5 py-0.5 rounded-full">
            {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
          </span>
        </div>

        {/* ── Content ── */}
        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={<ListSkeleton rows={6} />}
        >
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center bg-white rounded-2xl border border-[#E2E8F0] shadow-sm">
            <div className="w-16 h-16 rounded-2xl bg-[#F1F5F9] flex items-center justify-center mb-4">
              <DoorOpen className="w-8 h-8 text-[#CBD5E1]" />
            </div>
            <p className="text-base font-bold text-[#1E3A5F] mb-1">
              No {filter !== 'All' ? filter.toLowerCase() + ' ' : ''}room change requests
            </p>
            <p className="text-sm text-[#94A3B8] max-w-sm leading-relaxed">
              {filter === 'Pending Confirmation'
                ? 'No requests are currently waiting for QR scan confirmation.'
                : filter === 'In-Use'
                ? 'No rooms are currently confirmed via room requests.'
                : filter === 'Expired'
                ? 'No requests have expired without QR confirmation.'
                : filter === 'Rejected'
                ? 'No requests have been rejected.'
                : 'No room change requests have been submitted yet.'}
            </p>
          </div>

        ) : (
          <div className="space-y-4">
            {filtered.map(req => (
              <RequestCard
                key={req.id}
                req={req}
                onAction={handleAction}
                actionId={actionId}
                notes={notes}
                onNoteChange={(id, val) => setNotes(prev => ({ ...prev, [id]: val }))}
              />
            ))}
          </div>
        )}
        </PageLoadTransition>
      </div>
    </div>
  );
}
