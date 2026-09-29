'use client';

/**
 * Room Requests — "Who requested to use a room, and was it approved?"
 *
 *  • Pending / Approved / Rejected — pick which requests to list (history)
 *  • Lecture Rooms | Laboratory Rooms — side-by-side scrolling lists:
 *    Faculty · Status · More
 *  • More → request details (instructor, room, date, time, purpose,
 *    requested at) with Approve / Reject — loading, then a ✓ / ✕ animation
 *    (the instructor is notified by the server)
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useToast } from '@/context/ToastContext';
import Modal from '@/components/ui/Modal';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { ListSkeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { ArrowRight, BookOpen, Check, ChevronDown, Clock, Monitor, X, XCircle } from 'lucide-react';
import { RefreshButton } from '@/app/(dashboard)/room-utilization/shared';

/* ─── Types ──────────────────────────────────────────────────────────────── */

interface RoomRequest {
  id: number;
  faculty_name: string;
  subject_code: string | null;
  block_name: string | null;
  year_level: string | null;
  program_code: string | null;
  original_room_name: string | null;
  requested_room_name: string | null;
  requested_room_type: string | null;
  reason: string | null;
  status: string;
  admin_notes: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  expired_at: string | null;
  created_at: string;
  use_session: { day: string; start_time: string; end_time: string } | null;
}

type Group = 'Pending' | 'Approved' | 'Rejected';

/* Status → group. Approving a request puts it straight "In-Use". */
function groupOf(status: string): Group {
  if (status === 'Pending' || status === 'Pending Confirmation') return 'Pending';
  if (status === 'Approved' || status === 'In-Use') return 'Approved';
  return 'Rejected'; // Rejected, Expired
}

const EASE = [0.45, 0, 0.55, 1] as const;
const WHITE = { color: '#FFFFFF' } as const;

const GROUP_TONE: Record<Group, { bar: string; soft: string; text: string; border: string }> = {
  Pending: { bar: '#F59E0B', soft: '#FFFBEB', text: '#B45309', border: '#FDE68A' },
  Approved: { bar: '#10B981', soft: '#ECFDF5', text: '#047857', border: '#A7F3D0' },
  Rejected: { bar: '#EF4444', soft: '#FEF2F2', text: '#B91C1C', border: '#FECACA' },
};

const isLab = (t: string | null) => t === 'Laboratory' || t === 'Computer Lab';

function fmt12(hm: string | null | undefined) {
  if (!hm) return '—';
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function StatusPill({ status }: { status: string }) {
  const g = groupOf(status);
  const t = GROUP_TONE[g];
  const label = status === 'In-Use' ? 'Approved' : status === 'Pending Confirmation' ? 'Pending' : status;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-0.5 rounded-full border whitespace-nowrap"
      style={{ backgroundColor: t.soft, color: t.text, borderColor: t.border }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: t.bar }} /> {label}
    </span>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function RoomRequestsAdminClient() {
  const toast = useToast();
  const reduceMotion = useReducedMotion();

  const [requests, setRequests] = useState<RoomRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<Group>('Pending');
  // Lecture / Laboratory lists stay folded until their header is clicked
  const [expanded, setExpanded] = useState({ lec: false, lab: false });
  const [open, setOpen] = useState<RoomRequest | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState<'Approved' | 'Rejected' | null>(null);
  const [done, setDone] = useState<'Approved' | 'Rejected' | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/admin/room-requests')
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(r.status === 403 ? 'Your account cannot view room requests.' : d.error || '');
        return d;
      })
      .then(d => setRequests(d.requests ?? []))
      .catch((e: unknown) => toast.error(e instanceof Error && e.message ? e.message : 'Could not load room requests.'))
      .finally(() => setLoading(false));
  }, [toast]);
  useEffect(() => { load(); }, [load]);
  useVisibilityAwareInterval(load, 30_000);

  const showSkeleton = useMinLoading(loading && requests.length === 0, PAGE_SKELETON_MIN_MS);

  const counts = useMemo(() => {
    const c: Record<Group, number> = { Pending: 0, Approved: 0, Rejected: 0 };
    for (const r of requests) c[groupOf(r.status)] += 1;
    return c;
  }, [requests]);
  const inGroup = useMemo(() => requests.filter(r => groupOf(r.status) === group), [requests, group]);

  async function act(status: 'Approved' | 'Rejected') {
    if (!open || acting) return;
    setActing(status);
    const started = performance.now();
    try {
      const res = await fetch(`/api/admin/room-requests/${open.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, admin_notes: note.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      // Keep the loading visible long enough to register
      await new Promise(r => window.setTimeout(r, Math.max(0, 700 - (performance.now() - started))));
      if (!res.ok) { toast.error(data.error || 'Could not update the request.'); return; }
      setDone(status);
      window.setTimeout(() => {
        setDone(null);
        setOpen(null);
        toast.success(status === 'Approved' ? 'Request approved — the faculty was notified.' : 'Request rejected — the faculty was notified.');
        load();
      }, 1300);
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setActing(null);
    }
  }

  const openDetails = (r: RoomRequest) => { setNote(''); setOpen(r); };

  /* One list per room type */
  const renderPanel = (lab: boolean) => {
    const list = inGroup.filter(r => isLab(r.requested_room_type) === lab);
    const title = lab ? 'Laboratory Rooms' : 'Lecture Rooms';
    const key = lab ? 'lab' : 'lec';
    const isOpen = expanded[key];
    const tone = lab ? { bar: '#F59E0B', tile: 'bg-amber-50 text-amber-600' } : { bar: '#1D5BD6', tile: 'bg-[#EFF6FF] text-[#1D5BD6]' };
    return (
      <section className="relative bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] overflow-hidden min-w-0 flex flex-col">
        <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: tone.bar }} aria-hidden="true" />
        <motion.button
          type="button"
          onClick={() => setExpanded(e => ({ ...e, [key]: !e[key] }))}
          whileTap={reduceMotion ? undefined : { scale: 0.995 }}
          aria-expanded={isOpen}
          className={`w-full flex items-center gap-3 px-5 pt-5 pb-4 text-left hover:bg-[#F8FBFF] transition-colors ${isOpen ? 'border-b border-[#EEF2F8]' : ''}`}
        >
          <span className={`w-9 h-9 rounded-lg flex items-center justify-center ${tone.tile}`}>
            {lab ? <Monitor className="w-[18px] h-[18px]" /> : <BookOpen className="w-[18px] h-[18px]" />}
          </span>
          <h2 className="flex-1 text-[15px] font-bold text-[#0B2A5B]">{title}</h2>
          <span className="text-xs font-bold tabular-nums px-2.5 py-0.5 rounded-full bg-[#F1F5F9] text-[#475569]">{list.length}</span>
          <motion.span
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }}
            className="text-[#64748B]"
          >
            <ChevronDown className="w-4 h-4" />
          </motion.span>
        </motion.button>

        <AnimatePresence initial={false}>
          {isOpen && (
            <motion.div
              key="list"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1, transition: { duration: 0.38, ease: EASE } }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0, transition: { duration: 0.3, ease: EASE } }}
              className="overflow-hidden"
            >
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 px-5 py-2.5 bg-[#F8FAFC] border-b border-[#EEF2F8] text-[12px] font-semibold text-[#475569]">
                <span>Faculty</span><span>Status</span><span className="w-[84px]" />
              </div>

              {/* Scrolls inside the panel */}
              <div className="max-h-[440px] overflow-y-auto overscroll-contain">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.ul
                    key={group}
                    initial={reduceMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1, transition: { duration: 0.3, ease: EASE } }}
                    exit={{ opacity: 0, transition: { duration: 0.2 } }}
                    className="divide-y divide-[#F1F5F9]"
                  >
                    {list.length === 0 ? (
                      <li className="px-5 py-12 text-center text-sm text-[#94A3B8]">No {group.toLowerCase()} requests.</li>
                    ) : list.map((r, i) => (
                      <motion.li
                        key={r.id}
                        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 10) * 0.045 } }}
                        className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 px-5 py-3 hover:bg-[#F8FBFF] transition-colors"
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-sm text-[#0B2A5B] truncate">{r.faculty_name}</p>
                          <p className="text-xs text-[#64748B] truncate">
                            {r.requested_room_name ?? '—'} · {fmtDate(r.created_at)}
                          </p>
                        </div>
                        <StatusPill status={r.status} />
                        <motion.button
                          type="button"
                          onClick={() => openDetails(r)}
                          whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                          className="group w-[84px] inline-flex items-center justify-center gap-1 h-8 rounded-lg border border-[#D6E0EF] text-[13px] font-semibold text-[#0B2A5B] hover:border-[#9DB8E8] hover:text-[#1D5BD6] hover:bg-[#F8FBFF] transition-colors"
                        >
                          More <ArrowRight className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
                        </motion.button>
                      </motion.li>
                    ))}
                  </motion.ul>
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    );
  };

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0 space-y-5">
      <div>
        <BackButton />
        <div className="mt-4 sm:mt-7 mb-4">
          <WatermarkTitle>Room Requests</WatermarkTitle>
        </div>
      </div>

      {/* Pending · Approved · Rejected  +  Refresh */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="grid grid-cols-3 gap-3 flex-1" role="tablist" aria-label="Request status">
          {(['Pending', 'Approved', 'Rejected'] as Group[]).map(g => {
            const on = g === group;
            const t = GROUP_TONE[g];
            const Icon = g === 'Pending' ? Clock : g === 'Approved' ? Check : XCircle;
            return (
              <motion.button
                key={g}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => { setGroup(g); setExpanded({ lec: false, lab: false }); }}
                whileHover={reduceMotion || on ? undefined : { y: -2 }}
                whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                // Selected card glows like a ring light in its own colour (softly breathing)
                animate={on
                  ? {
                      boxShadow: reduceMotion
                        ? `0 0 0 2px ${t.bar}55, 0 0 18px 2px ${t.bar}55`
                        : [
                            `0 0 0 2px ${t.bar}40, 0 0 14px 1px ${t.bar}40`,
                            `0 0 0 3px ${t.bar}66, 0 0 26px 5px ${t.bar}66`,
                            `0 0 0 2px ${t.bar}40, 0 0 14px 1px ${t.bar}40`,
                          ],
                    }
                  : { boxShadow: '0 2px 8px -4px rgba(11,42,91,0.12)' }}
                transition={on && !reduceMotion
                  ? { boxShadow: { duration: 2.4, ease: 'easeInOut', repeat: Infinity } }
                  : { boxShadow: { duration: 0.4, ease: EASE } }}
                className="qr-stat-tint relative overflow-hidden text-left rounded-2xl border px-3 sm:px-4 py-3 flex items-center gap-3 transition-[border-color] duration-300"
                style={{
                  background: `linear-gradient(135deg, ${t.soft} 0%, #FFFFFF 72%)`,
                  borderColor: on ? `${t.bar}80` : `${t.bar}33`,
                }}
              >
                <span className="hidden sm:flex w-9 h-9 rounded-xl items-center justify-center bg-white shadow-[0_2px_6px_-2px_rgba(11,42,91,0.15)]" style={{ color: t.bar }}>
                  <Icon className="w-[18px] h-[18px]" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-[#475569]">{g}</span>
                  <span className="block text-xl font-bold text-[#0B2A5B] leading-tight tabular-nums">{counts[g]}</span>
                </span>
              </motion.button>
            );
          })}
        </div>
        <RefreshButton onRefresh={load} loading={loading} />
      </div>

      <PageLoadTransition showSkeleton={showSkeleton} skeleton={<ListSkeleton rows={8} />}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
          {renderPanel(false)}
          {renderPanel(true)}
        </div>
      </PageLoadTransition>

      {/* ── Request details ─────────────────────────────────────────── */}
      <Modal open={!!open} onClose={() => { if (!acting && !done) setOpen(null); }} title="Room Request" size="sm">
        {done && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl">
              <svg width="72" height="72" viewBox="0 0 52 52" aria-hidden="true">
                <circle className="save-success-circle" cx="26" cy="26" r="24" fill="none" stroke={done === 'Approved' ? '#22C55E' : '#EF4444'} strokeWidth="3" />
                {done === 'Approved'
                  ? <path className="save-success-check" fill="none" stroke="#22C55E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" d="M14.5 27 22 34.5 38 17" />
                  : <>
                      <path className="save-success-check" fill="none" stroke="#EF4444" strokeWidth="3.5" strokeLinecap="round" d="M18 18 34 34" />
                      <path className="save-success-check" fill="none" stroke="#EF4444" strokeWidth="3.5" strokeLinecap="round" d="M34 18 18 34" style={{ animationDelay: '0.45s' }} />
                    </>}
              </svg>
              <p className="text-base font-semibold text-[#0B2A5B]">{done === 'Approved' ? 'Request approved!' : 'Request rejected'}</p>
            </div>
          </div>
        )}

        {open && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-lg font-bold text-[#0B2A5B] truncate">{open.faculty_name}</p>
              <StatusPill status={open.status} />
            </div>

            <dl className="rounded-xl border border-[#E3E9F3] divide-y divide-[#F1F5F9] text-sm">
              {([
                ['Room', `${open.requested_room_name ?? '—'}${open.original_room_name && open.original_room_name !== open.requested_room_name ? `  (from ${open.original_room_name})` : ''}`],
                ['Date', `${open.use_session?.day ? `${open.use_session.day}, ` : ''}${fmtDate(open.created_at)}`],
                ['Time', open.use_session ? `${fmt12(open.use_session.start_time)} – ${fmt12(open.use_session.end_time)}` : '—'],
                ['Class', open.subject_code ? `${open.subject_code} · ${[open.program_code, `${String(open.year_level ?? '').match(/\d+/)?.[0] ?? ''}${open.block_name ?? ''}`].filter(Boolean).join(' ')}` : '—'],
                ['Purpose', open.reason || '—'],
                ['Requested', fmtDateTime(open.created_at)],
                ...(open.admin_notes ? [['Note', open.admin_notes] as const] : []),
              ] as const).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 px-4 py-2.5">
                  <dt className="text-[#64748B] font-medium">{k}</dt>
                  <dd className="text-[#0B2A5B] font-semibold break-words">{v}</dd>
                </div>
              ))}
            </dl>

            {groupOf(open.status) === 'Pending' && (
              <>
                <input
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Note to faculty (optional)"
                  maxLength={300}
                  className="w-full h-11 px-3.5 rounded-xl border border-[#D6E0EF] bg-[#F4F7FC] text-sm text-[#0B2A5B] placeholder:text-[#94A3B8] outline-none"
                />
                <div className="grid grid-cols-2 gap-3">
                  <motion.button
                    type="button"
                    onClick={() => act('Rejected')}
                    disabled={!!acting}
                    whileTap={reduceMotion || acting ? undefined : { scale: 0.97 }}
                    className="h-11 inline-flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-white text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors disabled:opacity-60"
                  >
                    {acting === 'Rejected'
                      ? <><span className="w-4 h-4 border-2 border-red-200 border-t-red-600 rounded-full animate-spin" /> Rejecting…</>
                      : <><X className="w-4 h-4" /> Reject</>}
                  </motion.button>
                  <motion.button
                    type="button"
                    onClick={() => act('Approved')}
                    disabled={!!acting}
                    whileTap={reduceMotion || acting ? undefined : { scale: 0.97 }}
                    className="h-11 inline-flex items-center justify-center gap-2 rounded-xl bg-[#1D5BD6] hover:bg-[#164BB5] text-sm font-semibold transition-colors disabled:opacity-60"
                    style={WHITE}
                  >
                    {acting === 'Approved'
                      ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Approving…</>
                      : <><Check className="w-4 h-4" style={WHITE} /> Approve</>}
                  </motion.button>
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
