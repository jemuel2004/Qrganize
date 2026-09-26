'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { drawImageSmooth } from '@/client/lib/drawImageSmooth';
import { useScrollLock } from '@/client/hooks/useScrollLock';

type Props = {
  open: boolean;
  imageSrc: string;
  fileName?: string;
  outputSize?: number;
  outputType?: 'image/jpeg' | 'image/png';
  shape?: 'circle' | 'square';
  title?: string;
  hint?: string;
  saveLabel?: string;
  theme?: 'light' | 'dark';
  onCancel: () => void;
  onSave: (file: File) => void;
};

type Point = { x: number; y: number };

function loadFullResImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

/**
 * Instagram-style 1:1 cropper: pan, pinch/wheel zoom, grid while dragging.
 * No extra library. Circle preview for avatars; square for logos.
 */
export default function ImageCropDialog({
  open,
  imageSrc,
  fileName = 'image.jpg',
  outputSize = 512,
  outputType = 'image/jpeg',
  shape = 'circle',
  title = 'Adjust Photo',
  hint,
  saveLabel = 'Save Photo',
  theme = 'light',
  onCancel,
  onSave,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [frameSize, setFrameSize] = useState(320);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');

  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pinchRef = useRef<{ dist: number; zoom: number } | null>(null);
  const wheelHideRef = useRef<number | null>(null);
  const zoomRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const imgSizeRef = useRef({ w: 0, h: 0 });
  const frameSizeRef = useRef(320);

  zoomRef.current = zoom;
  offsetRef.current = offset;
  imgSizeRef.current = imgSize;
  frameSizeRef.current = frameSize;

  useEffect(() => { setMounted(true); }, []);
  useScrollLock(open);

  useEffect(() => {
    if (!open) return;
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setSaving(false);
    setDragging(false);
    setError('');
    pointersRef.current.clear();
    dragRef.current = null;
    pinchRef.current = null;
  }, [open, imageSrc]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  useEffect(() => {
    if (!open) return;
    const el = frameRef.current;
    if (!el) return;
    const sync = () => setFrameSize(el.clientWidth || 320);
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [open]);

  const onImgLoad = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  const coverScale =
    imgSize.w > 0 && imgSize.h > 0
      ? Math.max(frameSize / imgSize.w, frameSize / imgSize.h)
      : 1;
  const displayW = imgSize.w * coverScale * zoom;
  const displayH = imgSize.h * coverScale * zoom;

  function clampOffset(next: Point, z: number, size = imgSizeRef.current, frame = frameSizeRef.current) {
    if (!size.w || !size.h) return next;
    const scale = Math.max(frame / size.w, frame / size.h) * z;
    const w = size.w * scale;
    const h = size.h * scale;
    const maxX = Math.max(0, (w - frame) / 2);
    const maxY = Math.max(0, (h - frame) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }

  function applyZoom(nextZoom: number) {
    const z = Math.min(4, Math.max(1, nextZoom));
    setZoom(z);
    setOffset(prev => clampOffset(prev, z));
  }

  function resetView() {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }

  function pointerDistance(a: Point, b: Point) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size === 2) {
      const [p1, p2] = [...pointersRef.current.values()];
      pinchRef.current = { dist: pointerDistance(p1, p2), zoom: zoomRef.current };
      dragRef.current = null;
      setDragging(true);
      return;
    }

    dragRef.current = { x: e.clientX, y: e.clientY, ox: offsetRef.current.x, oy: offsetRef.current.y };
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [p1, p2] = [...pointersRef.current.values()];
      const dist = pointerDistance(p1, p2);
      if (pinchRef.current.dist > 0) {
        applyZoom(pinchRef.current.zoom * (dist / pinchRef.current.dist));
      }
      return;
    }

    const drag = dragRef.current;
    if (!drag) return;
    setOffset(clampOffset({
      x: drag.ox + (e.clientX - drag.x),
      y: drag.oy + (e.clientY - drag.y),
    }, zoomRef.current));
  }

  function onPointerUp(e: React.PointerEvent) {
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 1) {
      const remaining = [...pointersRef.current.values()][0];
      dragRef.current = {
        x: remaining.x,
        y: remaining.y,
        ox: offsetRef.current.x,
        oy: offsetRef.current.y,
      };
    }
    if (pointersRef.current.size === 0) {
      dragRef.current = null;
      setDragging(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      applyZoom(zoomRef.current + delta);
      setDragging(true);
      if (wheelHideRef.current != null) window.clearTimeout(wheelHideRef.current);
      wheelHideRef.current = window.setTimeout(() => setDragging(false), 180);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (wheelHideRef.current != null) window.clearTimeout(wheelHideRef.current);
    };
  }, [open]);

  async function handleSave() {
    if (!imgSize.w || !imgSize.h) return;

    setSaving(true);
    setError('');
    try {
      const source = await loadFullResImage(imageSrc);
      const natW = source.naturalWidth;
      const natH = source.naturalHeight;
      const cover = Math.max(frameSize / natW, frameSize / natH);
      const scale = cover * zoom;
      const dw = natW * scale;
      const dh = natH * scale;
      const sx = (0 - ((frameSize - dw) / 2 + offset.x)) / scale;
      const sy = (0 - ((frameSize - dh) / 2 + offset.y)) / scale;
      const sSize = frameSize / scale;
      const exportSize = Math.max(1, Math.min(outputSize, Math.round(sSize)));

      const canvas = document.createElement('canvas');
      canvas.width = exportSize;
      canvas.height = exportSize;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      if (outputType === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, exportSize, exportSize);
      }
      drawImageSmooth(ctx, source, sx, sy, sSize, sSize, 0, 0, exportSize, exportSize);

      const blob = await new Promise<Blob | null>(resolve =>
        canvas.toBlob(resolve, outputType, outputType === 'image/jpeg' ? 0.95 : undefined)
      );
      if (!blob) throw new Error('Crop failed');
      const ext = outputType === 'image/png' ? 'png' : 'jpg';
      const base = (fileName || 'image').replace(/\.[^.]+$/, '') || 'image';
      onSave(new File([blob], `${base}.${ext}`, { type: outputType }));
    } catch {
      setError('Could not crop this image. Please try another photo.');
      setSaving(false);
    }
  }

  if (!open || !mounted) return null;

  const dark = theme === 'dark';
  const panel = dark
    ? 'bg-[#111827] border-white/10 text-white'
    : 'bg-white border-[#E2E8F0] text-[#0B2A5B]';
  const muted = dark ? 'text-slate-400' : 'text-[#64748B]';
  const controlBg = dark ? 'bg-white/5 border-white/10' : 'bg-[#F8FAFC] border-[#E2E8F0]';
  const square = shape === 'square';
  const defaultHint = square
    ? 'Pinch or scroll to zoom, then drag to frame your logo — like Instagram.'
    : 'Drag to reposition and use zoom to frame your photo. Preview is circular.';

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4" role="presentation" data-modal-root>
      <div aria-hidden className="absolute inset-0 bg-black/75" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="crop-dialog-title"
        className={`relative w-full max-w-md rounded-2xl border shadow-xl max-h-[94vh] overflow-y-auto ${panel}`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`flex items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b sticky top-0 z-10 ${dark ? 'border-white/10 bg-[#111827]' : 'border-[#E2E8F0] bg-white'}`}>
          <h2 id="crop-dialog-title" className="text-base font-bold">{title}</h2>
          <button
            type="button"
            onClick={onCancel}
            className={`p-2 rounded-xl min-h-11 min-w-11 inline-flex items-center justify-center ${muted} hover:opacity-80`}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 sm:px-5 py-5 space-y-4">
          <p className={`text-sm ${muted}`}>{hint ?? defaultHint}</p>

          <div className="flex justify-center">
            <div
              ref={frameRef}
              className={`relative w-[min(100%,320px)] aspect-square overflow-hidden touch-none select-none cursor-grab active:cursor-grabbing bg-black ${
                square ? 'rounded-lg' : 'rounded-full ring-2 ring-[#1D5BD6]/40'
              }`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={imageSrc}
                alt="Crop preview"
                draggable={false}
                onLoad={onImgLoad}
                className="absolute max-w-none pointer-events-none"
                style={{
                  width: displayW || '100%',
                  height: displayH || 'auto',
                  left: '50%',
                  top: '50%',
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                }}
              />
              {square && (
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute inset-0 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.35)]" />
                  <div
                    className={`absolute inset-0 transition-opacity duration-150 ${dragging ? 'opacity-100' : 'opacity-0'}`}
                  >
                    <div className="absolute inset-y-0 left-1/3 w-px bg-white/70" />
                    <div className="absolute inset-y-0 left-2/3 w-px bg-white/70" />
                    <div className="absolute inset-x-0 top-1/3 h-px bg-white/70" />
                    <div className="absolute inset-x-0 top-2/3 h-px bg-white/70" />
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className={`rounded-xl border px-3 py-3 ${controlBg}`}>
            <div className="flex items-center gap-2 sm:gap-3">
              <button
                type="button"
                onClick={() => applyZoom(zoom - 0.1)}
                className={`p-2 rounded-lg min-h-10 min-w-10 inline-flex items-center justify-center ${muted}`}
                aria-label="Zoom out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <input
                type="range"
                min={1}
                max={4}
                step={0.01}
                value={zoom}
                onChange={e => applyZoom(Number(e.target.value))}
                className="flex-1 min-w-0 accent-[#1D5BD6]"
                aria-label="Zoom"
              />
              <button
                type="button"
                onClick={() => applyZoom(zoom + 0.1)}
                className={`p-2 rounded-lg min-h-10 min-w-10 inline-flex items-center justify-center ${muted}`}
                aria-label="Zoom in"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={resetView}
                className={`inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-semibold ${muted}`}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-500">{error}</p>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
            <button
              type="button"
              disabled={saving}
              onClick={onCancel}
              className={`min-h-11 px-4 py-2.5 rounded-xl text-sm font-semibold ${muted}`}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || !imgSize.w}
              onClick={() => void handleSave()}
              className="min-h-11 px-4 py-2.5 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] disabled:opacity-50 text-white"
            >
              {saving ? 'Saving…' : saveLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
