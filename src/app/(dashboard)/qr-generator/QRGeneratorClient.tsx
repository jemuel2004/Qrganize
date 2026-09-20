'use client';

import { useEffect, useState, useRef } from 'react';
import {
  QrCode, Download, Printer, Search,
  RefreshCw, X, CheckCircle, AlertTriangle, Loader2, RotateCcw,
} from 'lucide-react';
import { CardSkeleton } from '@/client/components/ui/skeletons';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/client/hooks/useMinLoading';
import { useToast } from '@/client/context/ToastContext';
import { useScrollLock } from '@/client/hooks/useScrollLock';

interface RoomWithQR {
  id: number;
  room_name: string;
  room_type: string;
  building: string | null;
  capacity: number;
  qr_code_id: string;
  qr_data_url: string;
}

/* ─── Print helpers (logic unchanged) ───────────────────────────────────── */
function downloadQR(room: RoomWithQR) {
  const a = document.createElement('a');
  a.href = room.qr_data_url;
  a.download = `QR_${room.room_name.replace(/\s+/g, '_')}.png`;
  a.click();
}

function printOne(room: RoomWithQR) {
  const win = window.open('', '_blank', 'width=500,height=600');
  if (!win) return;
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>QR Code — ${room.room_name}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #fff; }
        .card { text-align: center; padding: 32px; border: 2px solid #e5e7eb; border-radius: 16px; max-width: 320px; }
        .logo { font-size: 13px; font-weight: 900; letter-spacing: 0.05em; color: #f97316; margin-bottom: 16px; text-transform: uppercase; }
        img { width: 240px; height: 240px; display: block; margin: 0 auto 16px; }
        .room-name { font-size: 20px; font-weight: 900; color: #111827; margin-bottom: 4px; }
        .room-type { font-size: 12px; font-weight: 600; color: #6b7280; margin-bottom: 4px; }
        .room-building { font-size: 11px; color: #9ca3af; margin-bottom: 12px; }
        .qr-id { font-family: monospace; font-size: 10px; color: #d1d5db; background: #f9fafb; padding: 4px 8px; border-radius: 4px; border: 1px solid #e5e7eb; display: inline-block; }
        .instruction { font-size: 10px; color: #9ca3af; margin-top: 12px; line-height: 1.5; }
        @media print { body { min-height: auto; } }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="logo">QRganize</div>
        <img src="${room.qr_data_url}" alt="QR Code for ${room.room_name}" />
        <div class="room-name">${room.room_name}</div>
        <div class="room-type">${room.room_type}</div>
        ${room.building ? `<div class="room-building">${room.building}</div>` : ''}
        <div class="qr-id">${room.qr_code_id}</div>
        <div class="instruction">Scan to validate room entry</div>
      </div>
    </body>
    </html>
  `);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); win.close(); }, 400);
}

function printAll(rooms: RoomWithQR[]) {
  const cards = rooms.map(room => `
    <div class="card">
      <div class="logo">QRganize</div>
      <img src="${room.qr_data_url}" alt="QR ${room.room_name}" />
      <div class="room-name">${room.room_name}</div>
      <div class="room-type">${room.room_type}</div>
      ${room.building ? `<div class="room-building">${room.building}</div>` : ''}
      <div class="qr-id">${room.qr_code_id}</div>
      <div class="instruction">Scan to validate room entry</div>
    </div>
  `).join('');

  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return;
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>All Room QR Codes — QRganize</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; background: #fff; padding: 20px; }
        h1 { text-align: center; font-size: 18px; font-weight: 900; color: #f97316; margin-bottom: 24px; letter-spacing: 0.05em; text-transform: uppercase; }
        .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
        .card { text-align: center; padding: 20px 16px; border: 1.5px solid #e5e7eb; border-radius: 12px; break-inside: avoid; }
        .logo { font-size: 10px; font-weight: 900; letter-spacing: 0.08em; color: #f97316; margin-bottom: 10px; text-transform: uppercase; }
        img { width: 180px; height: 180px; display: block; margin: 0 auto 10px; }
        .room-name { font-size: 14px; font-weight: 900; color: #111827; margin-bottom: 2px; }
        .room-type { font-size: 10px; font-weight: 600; color: #6b7280; margin-bottom: 2px; }
        .room-building { font-size: 10px; color: #9ca3af; margin-bottom: 6px; }
        .qr-id { font-family: monospace; font-size: 8px; color: #d1d5db; background: #f9fafb; padding: 2px 6px; border-radius: 4px; border: 1px solid #e5e7eb; display: inline-block; }
        .instruction { font-size: 9px; color: #9ca3af; margin-top: 6px; }
        @media print { .grid { gap: 12px; } @page { margin: 0.5in; } }
      </style>
    </head>
    <body>
      <h1>QRganize — Room QR Codes</h1>
      <div class="grid">${cards}</div>
    </body>
    </html>
  `);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); win.close(); }, 500);
}

/* ─── Main component ─────────────────────────────────────────────────────── */
export default function QRGeneratorPage() {
  const toast = useToast();
  const [rooms, setRooms]               = useState<RoomWithQR[]>([]);
  const [loading, setLoading]           = useState(true);
  const [loadError, setLoadError]       = useState<string | null>(null);
  const [search, setSearch]             = useState('');
  const [typeFilter, setTypeFilter]     = useState('All');
  const [preview, setPreview]           = useState<RoomWithQR | null>(null);
  const [downloaded, setDownloaded]     = useState<number | null>(null);
  const [confirmRegen, setConfirmRegen] = useState<RoomWithQR | null>(null);
  useScrollLock(Boolean(preview || confirmRegen));
  const [regenerating, setRegenerating] = useState(false);
  const downloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/rooms/qr-codes', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRooms(data.rooms || []);
    } catch (err) {
      setLoadError('Failed to load QR codes. Please try again.');
      console.error('[QR Generator] load:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    return () => { if (downloadTimer.current !== null) clearTimeout(downloadTimer.current); };
  }, []);

  const handleRegen = async () => {
    if (!confirmRegen) return;
    setRegenerating(true);
    try {
      const res = await fetch('/api/rooms/qr-codes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: confirmRegen.id }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Failed to regenerate QR code.'); return; }
      const updated: RoomWithQR = data.room;
      setRooms(prev => prev.map(r => r.id === updated.id ? { ...r, ...updated } : r));
      if (preview?.id === updated.id) setPreview(p => p ? { ...p, ...updated } : p);
      toast.success('QR code regenerated successfully.');
      setConfirmRegen(null);
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setRegenerating(false);
    }
  };

  const filtered = rooms.filter(r => {
    const matchType   = typeFilter === 'All' || r.room_type === typeFilter;
    const matchSearch = !search ||
      r.room_name.toLowerCase().includes(search.toLowerCase()) ||
      r.room_type.toLowerCase().includes(search.toLowerCase()) ||
      (r.building ?? '').toLowerCase().includes(search.toLowerCase());
    return matchType && matchSearch;
  });
  const showQrSkeleton = useMinLoading(loading && rooms.length === 0 && !loadError, PAGE_SKELETON_MIN_MS);

  const handleDownload = (room: RoomWithQR) => {
    downloadQR(room);
    setDownloaded(room.id);
    if (downloadTimer.current !== null) clearTimeout(downloadTimer.current);
    downloadTimer.current = setTimeout(() => setDownloaded(null), 2000);
  };

  const typesInData = ['All', ...Array.from(new Set(rooms.map(r => r.room_type))).sort()];

  return (
    <div className="min-h-full bg-[#F8FAFC]">
      <div className="max-w-screen-xl mx-auto px-6 md:px-8 py-8 space-y-6">

        {/* ── Header ── */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-[#1E3A5F] tracking-tight">QR Code Generator</h1>
            <p className="text-sm text-[#64748B] mt-0.5">
              Download or print QR codes for each room — place them at room entrances for scanning
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={load}
              disabled={loading}
              title="Refresh"
              className="inline-flex items-center justify-center w-10 h-10 rounded-xl border border-[#E2E8F0] bg-white text-[#64748B] shadow-sm hover:bg-[#F8FAFC] hover:border-[#CBD5E1] disabled:opacity-50 transition-all"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-[#3C91E6]' : ''}`} />
            </button>
            <button
              onClick={() => printAll(filtered)}
              disabled={filtered.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#3C91E6] hover:bg-[#2563EB] disabled:opacity-40 text-white text-sm font-semibold shadow-sm transition-colors"
            >
              <Printer className="w-4 h-4" />
              Print All ({filtered.length})
            </button>
          </div>
        </div>

        {/* ── Filter bar ── */}
        <div className="flex flex-wrap items-end justify-between gap-3 w-full min-w-0">
          <div className="w-72 max-w-full">
            <label htmlFor="qr-rooms-search" className="block text-xs font-semibold text-[#64748B] mb-1.5">
              Search
            </label>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#64748B]"
              />
              <input
                id="qr-rooms-search"
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Room name or building"
                className="w-full bg-white border border-[#CBD5E1] rounded-xl pl-9 pr-9 py-2.5 text-sm text-[#1E3A5F] placeholder:text-[#94A3B8] hover:border-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/25 focus:border-[#3C91E6]"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-[#64748B] hover:text-[#1E3A5F] hover:bg-[#F1F5F9]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0 ml-auto mb-0.5">
          <div className="flex gap-1 p-1 rounded-xl bg-white border border-[#CBD5E1] shadow-sm">
            {typesInData.map(t => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  typeFilter === t
                    ? 'bg-[#3C91E6] text-white shadow-sm'
                    : 'text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#1E3A5F]'
                }`}
              >
                {t}
                {t !== 'All' && (
                  <span className={`ml-1.5 ${typeFilter === t ? 'text-white/80' : 'text-[#94A3B8]'}`}>
                    {rooms.filter(r => r.room_type === t).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          <p className="text-xs text-[#64748B]">
            {filtered.length} of {rooms.length} rooms
          </p>
          </div>
        </div>

        {/* ── Error ── */}
        {loadError && !loading && (
          <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-4 flex items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-700 flex-1">{loadError}</p>
            <button
              onClick={load}
              className="text-xs text-[#3C91E6] hover:underline flex items-center gap-1 font-medium"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        )}

        {/* ── Grid ── */}
        <PageLoadTransition
          showSkeleton={showQrSkeleton}
          skeleton={
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {Array.from({ length: 10 }, (_, i) => (
                <CardSkeleton key={i} className="aspect-[3/4] min-h-[200px]" />
              ))}
            </div>
          }
        >
        {filtered.length === 0 ? (
          <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-[#F1F5F9] flex items-center justify-center mb-4">
              <QrCode className="w-8 h-8 text-[#CBD5E1]" />
            </div>
            <p className="text-base font-bold text-[#1E3A5F] mb-1">No rooms found</p>
            <p className="text-sm text-[#94A3B8]">
              {rooms.length === 0
                ? 'No active rooms in the system.'
                : 'Try a different filter or search term.'}
            </p>
          </div>

        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filtered.map(room => (
              <div
                key={room.id}
                className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm hover:shadow-md hover:border-[#CBD5E1] transition-all duration-200 overflow-hidden group"
              >
                {/* QR Image — clickable for preview */}
                <button
                  onClick={() => setPreview(room)}
                  className="w-full p-4 pb-3 block"
                  title="Click to preview"
                >
                  <div className="bg-[#F8FAFC] qr-keep-light border border-[#E2E8F0] rounded-xl p-2.5 flex items-center justify-center group-hover:bg-[#EFF6FF] group-hover:border-[#BFDBFE] transition-colors">
                    {room.qr_data_url ? (
                      <img
                        src={room.qr_data_url}
                        alt={`QR Code for ${room.room_name}`}
                        className="w-full max-w-[120px] aspect-square object-contain"
                      />
                    ) : (
                      <div className="w-24 h-24 flex items-center justify-center">
                        <QrCode className="w-12 h-12 text-[#CBD5E1]" />
                      </div>
                    )}
                  </div>
                </button>

                <div className="px-3.5 pb-3.5">
                  <p className="text-sm font-bold text-[#1E3A5F] truncate leading-tight">{room.room_name}</p>
                  <p className="text-xs text-[#475569] mt-1 truncate">
                    {[room.room_type, room.building].filter(Boolean).join(' · ')}
                  </p>
                  <div className="grid grid-cols-2 gap-1.5 mt-3">
                    <button
                      onClick={() => handleDownload(room)}
                      className={`flex items-center justify-center gap-1 py-2 rounded-xl text-[11px] font-semibold transition-all ${
                        downloaded === room.id
                          ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                          : 'bg-[#EFF6FF] text-[#3C91E6] border border-[#BFDBFE] hover:bg-[#DBEAFE] hover:border-[#93C5FD]'
                      }`}
                    >
                      {downloaded === room.id
                        ? <><CheckCircle className="w-3 h-3" /> Saved</>
                        : <><Download className="w-3 h-3" /> Download</>}
                    </button>
                    <button
                      onClick={() => printOne(room)}
                      className="flex items-center justify-center gap-1 py-2 bg-[#F8FAFC] border border-[#E2E8F0] text-[#475569] rounded-xl text-[11px] font-semibold hover:bg-[#F1F5F9] hover:border-[#CBD5E1] hover:text-[#1E3A5F] transition-colors"
                    >
                      <Printer className="w-3 h-3" /> Print
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        </PageLoadTransition>
      </div>

      {/* ── Preview Modal ── */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          data-modal-root
          onClick={() => setPreview(null)}
          onKeyDown={e => { if (e.key === 'Escape') setPreview(null); }}
          tabIndex={-1}
          role="presentation"
        >
          <div
            className="bg-white border border-[#E2E8F0] rounded-3xl shadow-2xl max-w-sm w-full p-7 text-center"
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-[#1E3A5F]">QR Preview</h2>
              <button
                onClick={() => setPreview(null)}
                className="p-1.5 hover:bg-[#F1F5F9] rounded-xl transition-colors"
              >
                <X className="w-4 h-4 text-[#94A3B8]" />
              </button>
            </div>

            {/* QR image */}
            <div className="bg-[#F8FAFC] qr-keep-light border border-[#E2E8F0] rounded-2xl p-6 mb-5">
              <img
                src={preview.qr_data_url}
                alt={`QR Code for ${preview.room_name}`}
                className="w-full max-w-[200px] mx-auto aspect-square object-contain"
              />
            </div>

            <p className="text-lg font-bold text-[#1E3A5F]">{preview.room_name}</p>
            <p className="text-sm text-[#475569] mt-1">
              {[preview.room_type, preview.building].filter(Boolean).join(' · ')}
            </p>
            <button
              type="button"
              title="Copy QR code ID"
              onClick={() => {
                void navigator.clipboard.writeText(preview.qr_code_id).then(
                  () => toast.success('QR code ID copied.'),
                  () => toast.error('Could not copy QR code ID.'),
                );
              }}
              className="mt-3 mb-5 w-full text-xs font-mono font-medium text-[#334155] bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-3 py-2 hover:bg-white hover:border-[#CBD5E1] transition-colors"
            >
              {preview.qr_code_id}
            </button>

            {/* Actions */}
            <div className="grid grid-cols-2 gap-3 mb-2.5">
              <button
                onClick={() => handleDownload(preview)}
                className="flex items-center justify-center gap-2 py-2.5 bg-[#3C91E6] hover:bg-[#2563EB] text-white rounded-xl text-sm font-semibold transition-colors"
              >
                <Download className="w-4 h-4" /> Download
              </button>
              <button
                onClick={() => printOne(preview)}
                className="flex items-center justify-center gap-2 py-2.5 bg-[#F8FAFC] border border-[#E2E8F0] text-[#64748B] hover:bg-[#F1F5F9] rounded-xl text-sm font-semibold transition-colors"
              >
                <Printer className="w-4 h-4" /> Print
              </button>
            </div>
            <button
              onClick={() => { setConfirmRegen(preview); setPreview(null); }}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold
                bg-white border border-[#E2E8F0] text-[#94A3B8]
                hover:border-amber-300 hover:bg-amber-50 hover:text-amber-600
                transition-all"
            >
              <RotateCcw className="w-4 h-4" /> Regenerate QR Code
            </button>
          </div>
        </div>
      )}

      {/* ── Regenerate Confirmation Modal ── */}
      {confirmRegen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
          data-modal-root
          onClick={() => { if (!regenerating) setConfirmRegen(null); }}
          onKeyDown={e => { if (e.key === 'Escape' && !regenerating) setConfirmRegen(null); }}
          tabIndex={-1}
          role="presentation"
        >
          <div
            className="bg-white border border-[#E2E8F0] rounded-2xl shadow-2xl max-w-md w-full p-7"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-4 mb-5">
              <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center flex-shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h2 className="text-base font-bold text-[#1E3A5F]">Regenerate QR Code?</h2>
                <p className="text-sm text-[#64748B] mt-0.5">{confirmRegen.room_name}</p>
              </div>
            </div>

            <p className="text-sm text-[#475569] mb-6 leading-relaxed">
              Regenerating this QR code will replace the old QR and issue a new unique token.
              Any printed copies of the old QR code will no longer work. Continue?
            </p>

            <div className="flex gap-3">
              <button
                onClick={() => setConfirmRegen(null)}
                disabled={regenerating}
                className="flex-1 py-2.5 rounded-xl border border-[#E2E8F0] text-[#64748B] hover:bg-[#F8FAFC] text-sm font-semibold transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRegen}
                disabled={regenerating}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold transition-colors disabled:opacity-60"
              >
                {regenerating
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Regenerating…</>
                  : <><RotateCcw className="w-4 h-4" /> Regenerate</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
