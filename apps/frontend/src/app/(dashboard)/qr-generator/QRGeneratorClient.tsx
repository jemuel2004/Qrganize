'use client';

/**
 * QR Generator — "What QR belongs to each room?"
 * Each active room shows its QR status (Generated / Not Generated). Generate a
 * missing QR, preview it with the QR ID it is linked to, download, print one
 * or all, and regenerate when a printed copy is lost or compromised.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  BookOpen, CheckCircle2, Copy, Download, Loader2, Monitor, Printer, QrCode, RotateCcw, Search, Sparkles, X,
} from 'lucide-react';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import Modal from '@/components/ui/Modal';
import { CardSkeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import { useToast } from '@/context/ToastContext';
import { downloadQR, printRooms, type RoomQR } from './qrReport';

type TypeTab = 'All' | 'Lecture' | 'Laboratory';

const EASE = [0.4, 0, 0.2, 1] as const;
const WHITE = { color: '#FFFFFF' } as const;
const isLab = (t: string) => t === 'Laboratory' || t === 'Computer Lab';
const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

/* ─── Small pieces ───────────────────────────────────────────────────────── */

/** Only the missing state is flagged — a visible QR already says "generated" */
function MissingPill() {
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />Not Generated</span>;
}

/** Big colour-coded tabs — every tab is visibly coloured; the chosen one is solid */
function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: { key: T; label: string; count?: number; icon?: React.ElementType; color: string }[];
  onChange: (v: T) => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="flex flex-wrap gap-2.5" role="tablist">
      {options.map(o => {
        const on = o.key === value;
        return (
          <motion.button
            key={o.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.key)}
            whileHover={reduceMotion || on ? undefined : { y: -2 }}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            animate={{
              backgroundColor: on ? o.color : `${o.color}14`,
              borderColor: on ? o.color : `${o.color}59`,
              color: on ? '#FFFFFF' : o.color,
              boxShadow: on ? `0 10px 22px -10px ${o.color}` : '0 0 0 rgba(0,0,0,0)',
            }}
            transition={{ duration: reduceMotion ? 0 : 0.25, ease: EASE }}
            className="flex-shrink-0 inline-flex items-center gap-2.5 px-5 h-12 rounded-2xl border-2 text-[15px] font-bold"
          >
            {o.icon && <o.icon className="w-5 h-5" />}
            {o.label}
            {o.count != null && (
              <span
                className="min-w-7 h-7 px-2 rounded-full text-[13px] font-bold inline-flex items-center justify-center"
                style={on ? { backgroundColor: 'rgba(255,255,255,0.25)', color: '#FFFFFF' } : { backgroundColor: '#FFFFFF', color: o.color }}
              >
                {o.count}
              </span>
            )}
          </motion.button>
        );
      })}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function QRGeneratorPage() {
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const [rooms, setRooms] = useState<RoomQR[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [type, setType] = useState<TypeTab>('All');
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [busy, setBusy] = useState<number | 'all' | null>(null); // room being generated / 'all'
  const [success, setSuccess] = useState<string | null>(null);   // overlay text in the preview
  const [saved, setSaved] = useState<number | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/rooms/qr-codes', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setRooms((await res.json()).rooms || []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => { if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, [load]);

  const preview = rooms.find(r => r.id === previewId) ?? null;
  const counts = useMemo(() => ({
    missing: rooms.filter(r => !r.generated).length,
    lec: rooms.filter(r => !isLab(r.room_type)).length,
    lab: rooms.filter(r => isLab(r.room_type)).length,
  }), [rooms]);

  const filtered = rooms.filter(r => {
    if (type === 'Lecture' && isLab(r.room_type)) return false;
    if (type === 'Laboratory' && !isLab(r.room_type)) return false;
    const q = search.trim().toLowerCase();
    return !q || [r.room_name, r.room_type, r.building ?? '', r.qr_code_id ?? ''].some(v => v.toLowerCase().includes(q));
  });
  const printable = filtered.filter(r => r.generated);
  const showSkeleton = useMinLoading(loading && rooms.length === 0 && !loadError, PAGE_SKELETON_MIN_MS);

  /** Generate (or regenerate) one room, or all missing */
  const generate = async (target: number | 'all') => {
    setBusy(target);
    try {
      const res = await fetch('/api/rooms/qr-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target === 'all' ? { all_missing: true } : { room_id: target }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Failed to generate QR code.'); return false; }
      const updates = new Map<number, Partial<RoomQR>>((data.rooms as (Partial<RoomQR> & { id: number })[]).map(u => [u.id, u]));
      setRooms(prev => prev.map(r => (updates.has(r.id) ? { ...r, ...updates.get(r.id) } : r)));
      if (target === 'all') toast.success(`${updates.size} QR code${updates.size === 1 ? '' : 's'} generated.`);
      return true;
    } catch {
      toast.error('Connection error. Please try again.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const generateOne = async (room: RoomQR) => {
    if (await generate(room.id)) {
      setPreviewId(room.id);
      flash('QR generated!');
    }
  };

  const regenerate = async () => {
    if (!preview) return;
    if (await generate(preview.id)) {
      setConfirmRegen(false);
      flash('QR regenerated!');
    }
  };

  const flash = (text: string) => {
    setSuccess(text);
    setTimeout(() => setSuccess(null), 1300);
  };

  const handleDownload = (room: RoomQR) => {
    downloadQR(room);
    setSaved(room.id);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(null), 1800);
  };

  const copyId = (id: string) =>
    navigator.clipboard.writeText(id).then(() => toast.success('QR ID copied.'), () => toast.error('Could not copy the QR ID.'));

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0 space-y-5">
      <div>
        <BackButton />
        <div className="mt-4 sm:mt-7 mb-4">
          <WatermarkTitle>QR Generator</WatermarkTitle>
        </div>

        {/* Room type · search · actions */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <Segmented value={type} onChange={setType} options={[
            { key: 'All', label: 'All Rooms', count: rooms.length, icon: QrCode, color: '#0B2A5B' },
            { key: 'Lecture', label: 'Lecture', count: counts.lec, icon: BookOpen, color: '#1D5BD6' },
            { key: 'Laboratory', label: 'Laboratory', count: counts.lab, icon: Monitor, color: '#D97706' },
          ]} />
          <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
            <div className="relative w-full sm:w-60">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#94A3B8]" />
              <input
                type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search room or QR ID"
                className="w-full h-10 bg-white border border-[#D6E0EF] rounded-xl pl-9 pr-8 text-sm text-[#0B2A5B] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/25 focus:border-[#1D5BD6]"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-[#94A3B8] hover:text-[#0B2A5B]">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <AnimatePresence initial={false}>
              {counts.missing > 0 && (
                <motion.button
                  key="gen-all"
                  type="button"
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                  onClick={() => generate('all')}
                  disabled={busy !== null}
                  className="h-10 inline-flex items-center gap-2 px-4 rounded-xl text-sm font-semibold bg-amber-500 hover:bg-amber-600 transition-colors disabled:opacity-60"
                  style={WHITE}
                >
                  {busy === 'all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  Generate Missing ({counts.missing})
                </motion.button>
              )}
            </AnimatePresence>
            <motion.button
              type="button"
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              onClick={() => printRooms(printable, 'QRganize — Room QR Codes')}
              disabled={printable.length === 0}
              className="h-10 inline-flex items-center gap-2 px-4 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors disabled:opacity-40"
              style={WHITE}
            >
              <Printer className="w-4 h-4" /> Print All ({printable.length})
            </motion.button>
          </div>
        </div>
      </div>

      {loadError && !loading && (
        <p className="py-10 text-center text-sm text-[#64748B]">
          Unable to load QR codes. <button type="button" onClick={load} className="font-semibold text-[#1D5BD6] hover:underline">Try again</button>
        </p>
      )}

      <PageLoadTransition
        showSkeleton={showSkeleton}
        skeleton={
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {Array.from({ length: 10 }, (_, i) => <CardSkeleton key={i} className="h-72" />)}
          </div>
        }
      >
        {!loadError && (filtered.length === 0 ? (
          <div className="py-20 text-center">
            <QrCode className="w-10 h-10 text-[#CBD5E1] mx-auto mb-3" />
            <p className="font-semibold text-[#0B2A5B]">No rooms found</p>
          </div>
        ) : (
          <motion.div layout={!reduceMotion} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            <AnimatePresence mode="popLayout" initial={false}>
              {filtered.map(room => (
                <motion.div
                  key={room.id}
                  layout={!reduceMotion}
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1, transition: { duration: 0.3, ease: EASE } }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
                  whileHover={reduceMotion ? undefined : { y: -3 }}
                  className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] hover:shadow-[0_12px_28px_-16px_rgba(11,42,91,0.35)] transition-shadow overflow-hidden flex flex-col"
                >
                  {/* QR / placeholder */}
                  <button
                    type="button"
                    onClick={() => (room.generated ? setPreviewId(room.id) : generateOne(room))}
                    disabled={busy !== null && !room.generated}
                    className="p-4 pb-3 block w-full group"
                    title={room.generated ? 'Preview QR' : 'Generate QR'}
                  >
                    <div className={`aspect-square rounded-xl flex items-center justify-center transition-colors qr-keep-light ${
                      room.generated
                        ? 'bg-[#F8FAFC] border border-[#E2E8F0] group-hover:bg-[#EFF6FF] group-hover:border-[#BFDBFE]'
                        : 'border-2 border-dashed border-[#D6E0EF] bg-[#FAFBFD] group-hover:border-amber-300 group-hover:bg-amber-50/40'
                    }`}>
                      <AnimatePresence mode="wait" initial={false}>
                        {room.generated && room.qr_data_url ? (
                          <motion.img
                            key={room.qr_code_id}
                            src={room.qr_data_url}
                            alt={`QR code for ${room.room_name}`}
                            initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
                            animate={{ opacity: 1, scale: 1, transition: { duration: 0.4, ease: EASE } }}
                            className="w-[82%] aspect-square object-contain"
                          />
                        ) : busy === room.id || busy === 'all' ? (
                          <Loader2 key="busy" className="w-8 h-8 text-[#1D5BD6] animate-spin" />
                        ) : (
                          <span key="empty" className="flex flex-col items-center gap-1.5 text-[#94A3B8]">
                            <QrCode className="w-10 h-10" />
                            <span className="text-xs font-semibold">Click to generate</span>
                          </span>
                        )}
                      </AnimatePresence>
                    </div>
                  </button>

                  <div className="px-4 pb-4 flex-1 flex flex-col">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isLab(room.room_type) ? <Monitor className="w-3.5 h-3.5 text-[#D97706] flex-shrink-0" /> : <BookOpen className="w-3.5 h-3.5 text-[#1D5BD6] flex-shrink-0" />}
                      <p className="text-sm font-bold text-[#0B2A5B] truncate">{room.room_name}</p>
                    </div>
                    {!room.generated && <div className="mt-1.5"><MissingPill /></div>}
                    <div className="mt-auto pt-3">
                      {room.generated ? (
                        <div className="grid grid-cols-2 gap-1.5">
                          <button type="button" onClick={() => handleDownload(room)}
                            className={`h-8 inline-flex items-center justify-center gap-1 rounded-lg text-xs font-semibold border transition-colors ${
                              saved === room.id ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-[#EFF6FF] text-[#1D5BD6] border-[#BFDBFE] hover:bg-[#DBEAFE]'
                            }`}>
                            {saved === room.id ? <><CheckCircle2 className="w-3.5 h-3.5" /> Saved</> : <><Download className="w-3.5 h-3.5" /> Download</>}
                          </button>
                          <button type="button" onClick={() => printRooms([room], `QR Code — ${room.room_name}`)}
                            className="h-8 inline-flex items-center justify-center gap-1 rounded-lg text-xs font-semibold border border-[#E2E8F0] text-[#475569] hover:bg-[#F8FAFC] hover:text-[#0B2A5B] transition-colors">
                            <Printer className="w-3.5 h-3.5" /> Print
                          </button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => generateOne(room)} disabled={busy !== null}
                          className="w-full h-8 inline-flex items-center justify-center gap-1.5 rounded-lg text-xs font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors disabled:opacity-50"
                          style={WHITE}>
                          {busy === room.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <QrCode className="w-3.5 h-3.5" />} Generate QR
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        ))}
      </PageLoadTransition>

      {/* ── Preview ─────────────────────────────────────────────────────── */}
      <Modal open={!!preview && !confirmRegen} onClose={() => { if (!success) setPreviewId(null); }} title="QR Code" size="sm" headerAccent>
        {preview && (
          <div className="space-y-4">
            {success && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
                <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl">
                  <svg width="72" height="72" viewBox="0 0 52 52" aria-hidden="true">
                    <circle className="save-success-circle" cx="26" cy="26" r="24" fill="none" stroke="#22C55E" strokeWidth="3" />
                    <path className="save-success-check" fill="none" stroke="#22C55E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" d="M14.5 27 22 34.5 38 17" />
                  </svg>
                  <p className="text-base font-semibold text-[#0B2A5B]">{success}</p>
                </div>
              </div>
            )}
            <div className="rounded-2xl p-5 flex justify-center bg-[#F8FAFC] border border-[#E2E8F0] qr-keep-light">
              {preview.qr_data_url && (
                <motion.img
                  key={preview.qr_code_id}
                  src={preview.qr_data_url}
                  alt={`QR code for ${preview.room_name}`}
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1, transition: { duration: 0.35, ease: EASE } }}
                  className="w-52 h-52 object-contain"
                />
              )}
            </div>

            <div className="text-center">
              <p className="text-lg font-bold text-[#0B2A5B]">{preview.room_name}</p>
              <p className="text-sm text-[#64748B]">{[preview.room_type, preview.building].filter(Boolean).join(' · ')}</p>
            </div>

            {/* QR-to-room association */}
            <dl className="rounded-xl border border-[#E3E9F3] divide-y divide-[#F1F5F9] text-sm">
              <div className="flex items-center gap-3 px-4 py-2.5">
                <dt className="text-[#64748B] w-24 flex-shrink-0">QR ID</dt>
                <dd className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold text-[#0B2A5B] truncate">{preview.qr_code_id}</span>
                  <button type="button" onClick={() => preview.qr_code_id && copyId(preview.qr_code_id)} aria-label="Copy QR ID"
                    className="ml-auto p-1.5 rounded-lg text-[#64748B] hover:text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors">
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </dd>
              </div>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <dt className="text-[#64748B] w-24 flex-shrink-0">Linked to</dt>
                <dd className="font-semibold text-[#0B2A5B]">{preview.room_name}</dd>
              </div>
              <div className="flex items-center gap-3 px-4 py-2.5">
                <dt className="text-[#64748B] w-24 flex-shrink-0">Generated</dt>
                <dd className="font-semibold text-[#0B2A5B]">{fmtDate(preview.qr_generated_at)}</dd>
              </div>
            </dl>

            <div className="grid grid-cols-2 gap-2.5">
              <motion.button type="button" whileTap={reduceMotion ? undefined : { scale: 0.97 }} onClick={() => handleDownload(preview)}
                className="h-11 inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors" style={WHITE}>
                <Download className="w-4 h-4" /> Download
              </motion.button>
              <motion.button type="button" whileTap={reduceMotion ? undefined : { scale: 0.97 }} onClick={() => printRooms([preview], `QR Code — ${preview.room_name}`)}
                className="h-11 inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold border border-[#D6E0EF] text-[#0B2A5B] hover:bg-[#F8FAFC] transition-colors">
                <Printer className="w-4 h-4" /> Print
              </motion.button>
            </div>
            <button type="button" onClick={() => setConfirmRegen(true)}
              className="w-full h-10 inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold text-[#64748B] hover:text-amber-700 hover:bg-amber-50 transition-colors">
              <RotateCcw className="w-4 h-4" /> Regenerate QR
            </button>
          </div>
        )}
      </Modal>

      {/* ── Regenerate confirmation ─────────────────────────────────────── */}
      <Modal open={!!preview && confirmRegen} onClose={() => { if (busy === null) setConfirmRegen(false); }} title="Regenerate QR?" size="sm">
        {preview && (
          <div className="space-y-5">
            <p className="text-sm text-[#475569] leading-relaxed">
              <span className="font-semibold text-[#0B2A5B]">{preview.room_name}</span> gets a new QR code.
              Printed copies of the current one will stop working — replace them after printing the new QR.
            </p>
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirmRegen(false)} disabled={busy !== null}
                className="flex-1 h-11 rounded-xl border border-[#D6E0EF] text-sm font-semibold text-[#0B2A5B] hover:bg-[#F8FAFC] transition-colors disabled:opacity-50">
                Cancel
              </button>
              <motion.button type="button" whileTap={reduceMotion ? undefined : { scale: 0.97 }} onClick={regenerate} disabled={busy !== null}
                className="flex-1 h-11 inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold bg-amber-500 hover:bg-amber-600 transition-colors disabled:opacity-60"
                style={WHITE}>
                {busy === preview.id ? <><Loader2 className="w-4 h-4 animate-spin" /> Regenerating…</> : <><RotateCcw className="w-4 h-4" /> Regenerate</>}
              </motion.button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
