'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { Html5Qrcode } from 'html5-qrcode';
import { useInstructorProfile } from '@/context/InstructorProfileContext';
import { useScrollLock } from '@/hooks/useScrollLock';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  QrCode, CheckCircle, XCircle, AlertTriangle, Clock,
  MapPin, Camera, CameraOff, SwitchCamera, CalendarX2, DoorClosed,
  WifiOff, LogIn, Timer, Building2, Loader2,
} from 'lucide-react';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { CardSkeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { NAV_EASE } from '@/components/layout/navMotion';
import { isQrCode, qrCodeFromScan } from '@shared/qrLink';
import {
  presentScanResult, VIEW_SESSION_LABEL,
  type ModalKind, type ModalPresentation, type ScanAction, type ScanResult,
} from '@/lib/scanResult';

/* ─── Scanner settings ───────────────────────────────────────────────────── */
const SCANNER_ID = 'instructor-qr-reader';
/** A QR whose answer was shown is read again only after the camera has not seen it for this long */
const SAME_QR_GAP_MS = 2000;
/** No answer after this long counts as a connection problem */
const SCAN_TIMEOUT_MS = 15_000;

/**
 * Computers: the viewfinder's side — as big as the window's height allows, so
 * the whole scanner (Start button included) shows without scrolling. The top
 * bar, title and the card's own header, padding and button take about 448px.
 * Phones keep their own size (the full card width).
 */
const DESKTOP_VIEWFINDER = { '--viewfinder': 'clamp(280px, calc(100dvh - 448px), 440px)' } as React.CSSProperties;

type Facing = 'environment' | 'user';

/** Icon per answer — the same in the pop-up and the result card */
const KIND_ICON: Record<ModalKind, React.ElementType> = {
  success: CheckCircle,
  already: CheckCircle,
  late: AlertTriangle,
  pending: Timer,
  in_use: DoorClosed,
  not_assigned: CalendarX2,
  overuse: XCircle,
  invalid: QrCode,
  error: WifiOff,
  signed_out: LogIn,
};

/** Result card colours per tone */
const CARD_TONE: Record<ModalPresentation['tone'], { box: string; icon: string; label: string }> = {
  success: { box: 'border-[#A7F3D0] bg-[#ECFDF5]', icon: 'text-[#059669]', label: 'text-[#059669]' },
  warning: { box: 'border-[#FDE68A] bg-[#FFFBEB]', icon: 'text-[#D97706]', label: 'text-[#A16207]' },
  danger:  { box: 'border-[#FECACA] bg-[#FEF2F2]', icon: 'text-[#DC2626]', label: 'text-[#DC2626]' },
  neutral: { box: 'border-[#E2E8F0] bg-[#F8FAFC]', icon: 'text-[#64748B]', label: 'text-[#64748B]' },
  info:    { box: 'border-[#BFDBFE] bg-[#EFF6FF]', icon: 'text-[#1D5BD6]', label: 'text-[#1D5BD6]' },
};

function fmt5(t: string | null | undefined) { return t ? String(t).slice(0, 5) : '—'; }

/** The device clock as HH:MM:SS — for answers the page makes itself */
const clockNow = () => new Date().toTimeString().slice(0, 8);

function formatScanClock(scanTime: string): string {
  try {
    const part = String(scanTime).split('.')[0];
    const [hStr, mStr] = part.split(':');
    let h = parseInt(hStr, 10);
    const m = mStr ?? '00';
    if (!Number.isFinite(h)) return scanTime;
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm}`;
  } catch {
    return scanTime;
  }
}

/** When the faculty first scanned the room they hold — for the Already Scanned pop-up */
function formatScannedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return null;
    return dt.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return null;
  }
}

function haptic(kind: 'success' | 'error' | 'info') {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    // Browsers refuse (and warn) before the first tap — e.g. a scan opened from a QR link
    const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    if (activation && !activation.hasBeenActive) return;
    if (kind === 'success') navigator.vibrate(30);
    else if (kind === 'error') navigator.vibrate([40, 40, 40]);
    else navigator.vibrate(20);
  } catch { /* optional */ }
}

const cardClass =
  'bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden';

/* ─── Camera helpers ─────────────────────────────────────────────────────── */

/** Stop a scanner's camera stream — the camera light goes off */
async function releaseScanner(scanner: Html5Qrcode | null) {
  if (!scanner) return;
  try { await scanner.stop(); } catch { /* not running — a start still under way releases it when it finishes */ }
}

/** Empty the scanner box for the next start */
function resetScannerBox() {
  const box = document.getElementById(SCANNER_ID);
  if (!box) return;
  box.replaceChildren();
  box.style.width = '';
  box.style.transform = '';
}

/** Resolves once the video shows pictures (or after a few seconds — never waits forever) */
function videoPlaying(video: HTMLVideoElement): Promise<void> {
  return new Promise(resolve => {
    if (video.readyState >= 2 && !video.paused) { resolve(); return; }
    const done = () => {
      video.removeEventListener('playing', done);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, 4000);
    video.addEventListener('playing', done);
  });
}

/**
 * Keep the running camera filling the square viewfinder: the picture keeps its
 * own shape and is scaled to cover the square, cropped evenly on both sides —
 * never stretched. The scanner's scan square scales with it, so it stays in the
 * middle, over the area that is read. If the phone turns and the camera picture
 * turns with it, `onTurn` restarts the scanner so the square is measured again.
 */
function watchCamera(viewport: HTMLElement, box: HTMLElement, video: HTMLVideoElement, onTurn: () => void) {
  const fit = () => {
    // Exact (fractional) sizes, before scaling — whole pixels could leave a hairline gap
    const style = getComputedStyle(box);
    const w = parseFloat(style.width);
    const h = parseFloat(style.height);
    if (!w || !h) return;
    // One pixel of overscan hides rounding at the edges
    const scale = Math.max((viewport.clientWidth + 1) / w, (viewport.clientHeight + 1) / h);
    box.style.transform = `scale(${scale.toFixed(4)})`;
  };
  const observer = new ResizeObserver(fit);
  observer.observe(viewport);
  observer.observe(box);
  fit();
  const portrait = video.videoHeight > video.videoWidth;
  const onResize = () => {
    if (video.videoWidth && video.videoHeight && (video.videoHeight > video.videoWidth) !== portrait) onTurn();
  };
  video.addEventListener('resize', onResize);
  return () => {
    observer.disconnect();
    video.removeEventListener('resize', onResize);
  };
}

/** Why the camera did not start, in plain words */
function cameraErrorMessage(err: unknown): string {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? '');
  if (/NotAllowed|Permission|denied/i.test(text)) {
    return 'Camera access is blocked. Allow the camera for this site in your browser settings, then try again.';
  }
  if (/NotFound|Overconstrained|not found/i.test(text)) return 'No camera was found on this device.';
  if (/NotReadable|Could not start|in use/i.test(text)) {
    return 'The camera is being used by another app. Close that app, then try again.';
  }
  if (/not supported/i.test(text)) return 'This browser cannot open the camera. Open QRganize in Chrome or Safari.';
  return 'Camera unavailable. Check your browser permissions and try again.';
}

/* ─── Centered scan result dialog ────────────────────────────────────────── */
function ScanResultDialog({
  open,
  result,
  onAction,
}: {
  open: boolean;
  result: ScanResult | null;
  onAction: (action: ScanAction) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const titleId = useId();
  const descId = useId();

  useEffect(() => { setMounted(true); }, []);
  useScrollLock(open);

  useEffect(() => {
    if (!open || !result) return;
    const presentation = presentScanResult(result);
    haptic(presentation.tone === 'success' ? 'success' : presentation.tone === 'danger' ? 'error' : 'info');
  }, [open, result]);

  // Escape only closes — like the backdrop
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onAction('close'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onAction]);

  if (!open || !result || !mounted) return null;

  const p = presentScanResult(result);
  const iconWrap =
    p.tone === 'success' ? 'bg-[#ECFDF5] text-[#059669]'
    : p.tone === 'warning' ? 'bg-[#FFFBEB] text-[#D97706]'
    : p.tone === 'danger' ? 'bg-[#FEF2F2] text-[#DC2626]'
    : p.tone === 'info' ? 'bg-[#EFF6FF] text-[#1D5BD6]'
    : 'bg-[#F1F5F9] text-[#64748B]';

  const Icon = KIND_ICON[p.kind];

  const buttonClass =
    p.tone === 'success'
      ? 'bg-[#059669] hover:bg-[#047857] text-white'
      : p.tone === 'warning'
        ? 'bg-[#D97706] hover:bg-[#B45309] text-white'
        : p.tone === 'danger'
          ? 'bg-[#DC2626] hover:bg-[#B91C1C] text-white'
          : 'bg-[#1D5BD6] hover:bg-[#2E7DD1] text-white';

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      role="presentation"
      data-modal-root
    >
      <div
        aria-hidden="true"
        className="qr-backdrop-in absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={() => onAction('close')}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="qr-modal-in relative w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-2xl bg-white border border-[#E2E8F0] shadow-xl px-5 py-6 text-center"
        onClick={e => e.stopPropagation()}
      >
        {p.tone === 'success' ? (
          /* Animated check — the circle draws, then the tick */
          <svg className="mx-auto" width="72" height="72" viewBox="0 0 52 52" aria-hidden="true">
            <circle className="save-success-circle" cx="26" cy="26" r="24" fill="none" stroke="#059669" strokeWidth="3" />
            <path
              className="save-success-check"
              fill="none" stroke="#059669" strokeWidth="3.5"
              strokeLinecap="round" strokeLinejoin="round"
              d="M14.5 27 22 34.5 38 17"
            />
          </svg>
        ) : (
          <div className={`mx-auto w-14 h-14 rounded-full flex items-center justify-center ${iconWrap}`}>
            <Icon className="w-7 h-7" aria-hidden="true" />
          </div>
        )}

        <h2 id={titleId} className="mt-4 text-xl font-bold text-[#0B2A5B]">
          {p.title}
        </h2>

        {result.room?.name && (
          <p className="mt-2 text-base font-semibold text-[#0F172A]">
            {result.room.name}
          </p>
        )}

        <p id={descId} className="mt-2 text-sm text-[#475569] leading-relaxed">
          {p.message}
        </p>

        {p.kind === 'already' && formatScannedAt(result.checked_in_at) && (
          <p className="mt-3 text-xs font-medium text-[#64748B]">
            Scanned at {formatScannedAt(result.checked_in_at)}
          </p>
        )}

        {result.scan_time && p.kind !== 'already' && (
          <p className="mt-3 text-xs text-[#94A3B8] flex items-center justify-center gap-1.5">
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
            {formatScanClock(result.scan_time)}
          </p>
        )}

        {result.scan_time && p.kind === 'already' && !formatScannedAt(result.checked_in_at) && (
          <p className="mt-3 text-xs text-[#94A3B8] flex items-center justify-center gap-1.5">
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
            Scanned at {formatScanClock(result.scan_time)}
          </p>
        )}

        <button
          type="button"
          autoFocus
          onClick={() => onAction(p.action)}
          className={`mt-6 w-full min-h-11 rounded-xl text-sm font-semibold transition ${buttonClass}`}
        >
          {p.buttonLabel}
        </button>
        {/* A scan that went through: the button above opens My Session; this only closes */}
        {p.action === 'session' && (
          <button
            type="button"
            onClick={() => onAction('close')}
            className="mt-2 w-full min-h-11 rounded-xl text-sm font-semibold text-[#475569] hover:bg-[#F1F5F9] transition"
          >
            Close
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ─── Main component ─────────────────────────────────────────────────────── */
export default function ScanClient() {
  const { facultyId } = useInstructorProfile();
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showProcessing, setShowProcessing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraLoading, setCameraLoading] = useState(false);
  /** Front camera pictures are shown mirrored, like a mirror */
  const [mirrored, setMirrored] = useState(false);
  /** The device has a second camera (front / back) to switch to */
  const [canSwitch, setCanSwitch] = useState(false);
  const [booting, setBooting] = useState(true);
  useEffect(() => { setBooting(false); }, []);
  const showSkeleton = useMinLoading(booting, LOADING_DELAY);

  const viewportRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  /** Bumped by every start and stop, so a start that finishes late knows it was cancelled */
  const runRef = useRef(0);
  const facingRef = useRef<Facing>('environment');
  /** Undoes the viewfinder fitting of the running camera */
  const detachRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const modalOpenRef = useRef(false);
  const submittingRef = useRef(false);
  /** The QR whose answer was shown and when the camera last saw it — not read again while it stays in view */
  const heldRef = useRef<{ code: string; seenAt: number } | null>(null);
  /** The room code of the last answer (Try Again asks again) */
  const lastCodeRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const decodeRef = useRef<(text: string) => void>(() => {});
  const restartRef = useRef<(mode: Facing) => Promise<void>>(async () => {});

  /* ── Camera ──────────────────────────────────────────────────────────── */

  /** Release the camera (if any) and empty the box; the camera-on look stays (see stopCamera) */
  const closeScanner = useCallback(async () => {
    runRef.current += 1;
    detachRef.current?.();
    detachRef.current = null;
    const scanner = scannerRef.current;
    scannerRef.current = null;
    await releaseScanner(scanner);
    resetScannerBox();
  }, []);

  const startCamera = useCallback(async (mode: Facing) => {
    const run = ++runRef.current;
    facingRef.current = mode;
    setCameraError('');
    setCameraOn(true);
    setCameraLoading(true);
    setMirrored(mode === 'user');
    let scanner: Html5Qrcode | null = null;
    try {
      const { Html5Qrcode: Scanner, Html5QrcodeSupportedFormats } = await import('html5-qrcode');
      if (run !== runRef.current) return;
      scanner = new Scanner(SCANNER_ID, { verbose: false, formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE] });
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: mode },
        {
          fps: 8,
          // Scan square: 70% of the picture's shorter side, in its middle
          qrbox: (w: number, h: number) => {
            const size = Math.max(160, Math.floor(Math.min(w, h) * 0.7));
            return { width: size, height: size };
          },
        },
        // A /room/<code> link (new codes), the older JSON text, or the bare code
        (decodedText: string) => decodeRef.current(decodedText),
        () => {},
      );
      // Stopped, or the page was left, while the camera was starting: let it go at once
      if (run !== runRef.current) { await releaseScanner(scanner); return; }

      const box = document.getElementById(SCANNER_ID);
      const video = box?.querySelector('video');
      const viewport = viewportRef.current;
      if (box && video && viewport) {
        // The picture keeps this size from now on — the scanner placed its scan square for it
        box.style.width = `${box.getBoundingClientRect().width}px`;
        await videoPlaying(video);
        if (run !== runRef.current) return;
        detachRef.current = watchCamera(viewport, box, video, () => { void restartRef.current(facingRef.current); });
      }
      try {
        // A laptop's only camera faces the user too
        if (scanner.getRunningTrackSettings().facingMode === 'user') setMirrored(true);
      } catch { /* unknown */ }
      navigator.mediaDevices?.enumerateDevices?.()
        .then(list => { if (run === runRef.current) setCanSwitch(list.filter(d => d.kind === 'videoinput').length > 1); })
        .catch(() => {});
    } catch (err) {
      if (run !== runRef.current) return;
      await releaseScanner(scanner);
      scannerRef.current = null;
      resetScannerBox();
      setCameraOn(false);
      setCanSwitch(false);
      setCameraError(cameraErrorMessage(err));
    } finally {
      if (run === runRef.current) setCameraLoading(false);
    }
  }, []);

  /** Turn the camera off and release it */
  const stopCamera = useCallback(async () => {
    setCameraOn(false);
    setCameraLoading(false);
    setCanSwitch(false);
    await closeScanner();
  }, [closeScanner]);

  /** Start again with the same or the other camera — the viewfinder stays as it is */
  const restartCamera = useCallback(async (mode: Facing) => {
    setCameraLoading(true);
    await closeScanner();
    if (mountedRef.current) await startCamera(mode);
  }, [closeScanner, startCamera]);

  useEffect(() => { restartRef.current = restartCamera; }, [restartCamera]);

  // Leaving the page releases the camera and drops a scan still waiting for its answer
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (processingTimerRef.current) clearTimeout(processingTimerRef.current);
      void closeScanner();
    };
  }, [closeScanner]);

  // Back from another app or tab: some phones stop the camera meanwhile — start it again
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const video = document.querySelector<HTMLVideoElement>(`#${SCANNER_ID} video`);
      const stream = video?.srcObject;
      if (!video || !(stream instanceof MediaStream)) return;
      if (!stream.getVideoTracks().some(t => t.readyState === 'live')) void restartCamera(facingRef.current);
      else if (video.paused) void video.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [restartCamera]);

  /* ── Scanning ────────────────────────────────────────────────────────── */

  const showAnswer = useCallback((answer: ScanResult) => {
    modalOpenRef.current = true;
    setScanResult(answer);
    setModalOpen(true);
  }, []);

  /** Ask the server about a room code. The server decides — the page only shows the answer. */
  const checkRoom = useCallback(async (code: string) => {
    lastCodeRef.current = code;
    // Not a QRganize room code at all (some other QR): say so without asking
    if (!isQrCode(code)) {
      showAnswer({ status: 'Invalid', message: '', scan_time: clockNow() });
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    if (processingTimerRef.current) clearTimeout(processingTimerRef.current);
    processingTimerRef.current = setTimeout(() => setShowProcessing(true), 180);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timeout = setTimeout(() => ctrl.abort(), SCAN_TIMEOUT_MS);

    let answer: ScanResult;
    try {
      const res = await fetch('/api/qr/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The server scans as the signed-in faculty; the id only lets it catch a mix-up
        body: JSON.stringify({ qr_code_id: code, faculty_id: facultyId }),
        signal: ctrl.signal,
      });
      const raw = await res.json().catch(() => ({})) as Partial<ScanResult>;
      answer =
        res.status === 401 || res.status === 403 ? { status: 'SignedOut', message: '', scan_time: clockNow() }
        : raw.status ? { ...raw, status: raw.status, message: raw.message ?? '', scan_time: raw.scan_time || clockNow() }
        : res.status === 400 || res.status === 404 ? { status: 'Invalid', message: '', scan_time: clockNow() }
        : { status: 'Error', message: '', scan_time: clockNow() };
    } catch {
      answer = { status: 'Error', message: '', scan_time: clockNow() };
    } finally {
      clearTimeout(timeout);
      if (abortRef.current === ctrl) abortRef.current = null;
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current);
        processingTimerRef.current = null;
      }
      submittingRef.current = false;
    }
    if (!mountedRef.current) return;
    setShowProcessing(false);
    setSubmitting(false);
    showAnswer(answer);
    // Scanned: the camera's work is done. Signed out: let the camera go.
    // Any other answer leaves the camera running.
    if (answer.status === 'In-Use' || answer.status === 'SignedOut') await stopCamera();
  }, [facultyId, showAnswer, stopCamera]);

  // Every QR the camera reads comes here (several times a second while in view)
  useEffect(() => {
    decodeRef.current = (decodedText: string) => {
      const code = qrCodeFromScan(decodedText).trim();
      if (!code) return;
      const now = Date.now();
      const held = heldRef.current;
      if (held && held.code === code) {
        const cameBack = now - held.seenAt > SAME_QR_GAP_MS;
        held.seenAt = now;
        // Still in view since its answer: no repeat pop-up
        if (!cameBack) return;
      }
      if (modalOpenRef.current || submittingRef.current) return;
      heldRef.current = { code, seenAt: now };
      void checkRoom(code);
    };
  }, [checkRoom]);

  const handleDialogAction = useCallback((action: ScanAction) => {
    modalOpenRef.current = false;
    setModalOpen(false);
    if (action === 'retry' && lastCodeRef.current) {
      const code = lastCodeRef.current;
      heldRef.current = { code, seenAt: Date.now() };
      void checkRoom(code);
    } else if (action === 'sign_in') {
      window.location.assign(`/login?next=${encodeURIComponent('/instructor/scan')}`);
    } else if (action === 'session') {
      // The dashboard's Active Room Session: the room and the class start and end
      router.push('/instructor');
    }
    // 'close': the camera keeps running — the same QR is read again once it has left the view
  }, [checkRoom, router]);

  async function toggleCamera() {
    if (typeof window === 'undefined' || cameraLoading) return;
    if (cameraOn) {
      await stopCamera();
      return;
    }
    heldRef.current = null;
    await startCamera(facingRef.current);
  }

  async function switchCamera() {
    if (!cameraOn || cameraLoading) return;
    await restartCamera(facingRef.current === 'environment' ? 'user' : 'environment');
  }

  const fade = {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    transition: { duration: reduceMotion ? 0 : 0.2, ease: NAV_EASE },
  };

  /* ── Render ──────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-full p-4 sm:p-6 lg:p-8 overflow-x-hidden min-w-0">

      <div className="mb-5 sm:mb-6">
        <BackButton />
        <div className="mt-2 lg:mt-5">
          <WatermarkTitle>Scan Room QR</WatermarkTitle>
        </div>
      </div>

      {!facultyId && (
        <div className="bg-[#FFFBEB] border border-[#FDE68A] text-[#92400E] px-4 py-3 rounded-2xl text-sm mb-5">
          Loading faculty profile… If this persists, please log out and log back in.
        </div>
      )}

      {/* Phones: one column. Computers: the scanner card hugs its viewfinder,
          the result fills the rest of the row at the same height. */}
      <div
        className="grid grid-cols-1 gap-5 lg:grid-cols-[calc(var(--viewfinder)_+_42px)_minmax(0,1fr)] lg:max-w-6xl lg:mx-auto"
        style={DESKTOP_VIEWFINDER}
      >

        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={<CardSkeleton className="min-h-[360px]" />}
          className="lg:self-start"
        >
        <div className="space-y-4">

          <div className={cardClass}>
            <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <Camera className="w-3.5 h-3.5 text-[#1D5BD6]" />
              </div>
              <span className="text-sm font-semibold text-[#0B2A5B]">Camera Scanner</span>
            </div>
            <div className="p-5">
              {/* Square viewfinder, the same size with the camera on or off. The camera
                  picture sits in its middle at its own shape (cropped evenly, never
                  stretched), so the scan square is always centred. */}
              <div
                ref={viewportRef}
                className={`relative mx-auto w-full max-w-[min(440px,70dvh)] lg:w-[var(--viewfinder)] lg:max-w-none aspect-square overflow-hidden rounded-xl border flex items-center justify-center transition-colors duration-200 ${
                  cameraOn ? 'bg-black border-[#0B2A5B]' : 'bg-[#F1F5F9] border-[#E2E8F0]'
                }`}
              >
                <div
                  id={SCANNER_ID}
                  className={`qr-scan-box w-full flex-shrink-0 ${mirrored ? '[&_video]:[transform:scaleX(-1)]' : ''}`}
                />

                <AnimatePresence initial={false}>
                  {!cameraOn && (
                    <motion.div key="off" {...fade} className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
                      <div className="w-14 h-14 rounded-2xl bg-white border border-[#E2E8F0] flex items-center justify-center mb-3">
                        <QrCode className="w-7 h-7 text-[#1D5BD6]" />
                      </div>
                      <p className="text-[#0B2A5B] text-sm font-semibold">Camera is off</p>
                      <p className="text-[#94A3B8] text-xs mt-1">Press the button below to start scanning</p>
                    </motion.div>
                  )}

                  {cameraLoading && (
                    <motion.div
                      key="starting"
                      {...fade}
                      className="absolute inset-0 z-10 bg-black/40 flex flex-col items-center justify-center text-white gap-2"
                      role="status"
                      aria-live="polite"
                    >
                      <Loader2 className="w-7 h-7 animate-spin" />
                      <p className="text-sm font-semibold">Starting camera…</p>
                      <p className="text-xs text-white/80">Requesting camera access</p>
                    </motion.div>
                  )}

                  {showProcessing && (
                    <motion.div
                      key="verifying"
                      {...fade}
                      className="absolute inset-0 z-20 bg-black/45 flex flex-col items-center justify-center text-white gap-2"
                      role="status"
                      aria-live="polite"
                    >
                      <Loader2 className="w-7 h-7 animate-spin" />
                      <p className="text-sm font-semibold">Verifying…</p>
                      <p className="text-xs text-white/80">Checking room information</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {cameraError && (
                <p className="text-[#DC2626] text-xs mt-2.5 flex items-start gap-1.5">
                  <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {cameraError}
                </p>
              )}
              <div className={`mt-3 ${cameraOn && canSwitch ? 'grid grid-cols-2 gap-2' : ''}`}>
                <button
                  type="button"
                  onClick={toggleCamera}
                  disabled={!facultyId || submitting || cameraLoading}
                  className={`w-full py-2.5 min-h-11 rounded-xl font-semibold text-sm transition flex items-center justify-center gap-2 disabled:opacity-40 ${
                    cameraOn
                      ? 'bg-white text-[#DC2626] border border-[#FECACA] hover:bg-[#FEF2F2] active:bg-[#FEF2F2]'
                      : 'bg-[#1D5BD6] text-white hover:bg-[#2E7DD1] active:bg-[#2670BD] border border-transparent shadow-sm'
                  }`}
                >
                  {cameraLoading
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting camera…</>
                    : cameraOn
                      ? <><CameraOff className="w-4 h-4" /> Stop Camera</>
                      : <><Camera className="w-4 h-4" /> Start Camera Scanner</>}
                </button>
                {cameraOn && canSwitch && (
                  <button
                    type="button"
                    onClick={switchCamera}
                    disabled={submitting || cameraLoading}
                    className="w-full py-2.5 min-h-11 rounded-xl font-semibold text-sm transition flex items-center justify-center gap-2 disabled:opacity-40 bg-white text-[#1D5BD6] border border-[#BFDBFE] hover:bg-[#EFF6FF] active:bg-[#EFF6FF]"
                  >
                    <SwitchCamera className="w-4 h-4" /> Switch Camera
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        </PageLoadTransition>

        <div className="space-y-4 lg:flex lg:flex-col">
          {scanResult ? (
            <ScanResultCard result={scanResult} />
          ) : (
            <div className={`${cardClass} p-12 flex flex-col items-center justify-center text-center lg:flex-1`}>
              <div className="w-14 h-14 rounded-2xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center mb-3">
                <QrCode className="w-7 h-7 text-[#1D5BD6]" />
              </div>
              <p className="text-[#0B2A5B] text-sm font-semibold">No scan yet</p>
            </div>
          )}
        </div>
      </div>

      <ScanResultDialog
        open={modalOpen}
        result={scanResult}
        onAction={handleDialogAction}
      />
    </div>
  );
}

/* ─── Persistent scan result card (kept below camera) ────────────────────── */
function ScanResultCard({ result }: { result: ScanResult }) {
  const p = presentScanResult(result);
  const ui = CARD_TONE[p.tone];
  const Icon = KIND_ICON[p.kind];

  return (
    <div className={`rounded-2xl border p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] ${ui.box}`}>

      <div className="flex items-start gap-3.5 mb-4">
        <Icon className={`w-9 h-9 flex-shrink-0 ${ui.icon}`} aria-hidden="true" />
        <div className="min-w-0">
          <p className={`text-lg font-bold leading-tight ${ui.label}`}>{p.title}</p>
          <p className="text-sm text-[#475569] mt-1 leading-snug">{p.message}</p>
        </div>
      </div>

      {result.status === 'Pending' && (
        <div className="bg-white border border-[#FDE68A] rounded-xl px-4 py-3 mb-3 flex items-start gap-3">
          <Timer className="w-5 h-5 text-[#D97706] flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-[#92400E]">Action Required</p>
            <p className="text-xs text-[#A16207] mt-0.5 leading-relaxed">
              This is for a submitted Room Request. Go to the room and scan its QR code
              within {result.expires_in_mins ?? 15} minutes to confirm occupancy.
            </p>
            <Link href="/instructor/room-requests" className="text-xs text-[#1D5BD6] hover:underline font-semibold mt-1.5 inline-block">
              View Room Requests →
            </Link>
          </div>
        </div>
      )}

      {result.status === 'In-Use' && result.scan_status && result.scan_status !== 'Valid' && !result.already_occupied && (
        <div className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-lg mb-3 border ${
          result.scan_status === 'Late' ? 'bg-[#FFFBEB] text-[#A16207] border-[#FDE68A]' :
          result.scan_status === 'Overuse' ? 'bg-[#FEF2F2] text-[#DC2626] border-[#FECACA]' :
          'bg-[#ECFDF5] text-[#059669] border-[#A7F3D0]'
        }`}>
          <AlertTriangle className="w-3 h-3" />
          {result.scan_status === 'Late' ? 'Late scan recorded' :
           result.scan_status === 'Overuse' ? 'Overuse recorded' : 'Valid'}
        </div>
      )}

      {result.room && (
        <div className="bg-white border border-[#E2E8F0] rounded-xl p-3.5 mb-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#EFF6FF] flex items-center justify-center flex-shrink-0">
            <MapPin className="w-4 h-4 text-[#1D5BD6]" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-[#94A3B8] uppercase tracking-wide font-semibold">Room</p>
            <p className="font-semibold text-[#0B2A5B]">{result.room.name}</p>
            <p className="text-xs text-[#64748B]">{result.room.type}</p>
          </div>
        </div>
      )}

      {/* The faculty's own class only — never another faculty's class in this room */}
      {result.schedule && result.status !== 'Unauthorized' && (
        <div className="bg-white border border-[#E2E8F0] rounded-xl p-3.5 mb-3">
          <p className="text-[10px] text-[#94A3B8] uppercase tracking-wide font-semibold mb-1">Scheduled Class</p>
          <p className="font-semibold text-[#0B2A5B] break-words">{result.schedule.subject_name}</p>
          {result.schedule.block_name && (
            <p className="text-xs text-[#64748B] mt-0.5">Block {result.schedule.block_name}</p>
          )}
          {(result.schedule.session_start || result.schedule.session_end) && (
            <p className="text-xs text-[#64748B] flex items-center gap-1 mt-1.5">
              <Clock className="w-3 h-3 text-[#1D5BD6]" />
              {fmt5(result.schedule.session_start)} – {fmt5(result.schedule.session_end)}
            </p>
          )}
        </div>
      )}

      {result.status === 'Blocked' && result.occupancy && (
        <div className="bg-white border border-[#E2E8F0] rounded-xl p-3.5 mb-3">
          <p className="text-[10px] text-[#94A3B8] uppercase tracking-wide font-semibold mb-1">Currently Held By</p>
          <p className="text-sm font-semibold text-[#0B2A5B]">{result.occupancy.faculty_name}</p>
          <p className="text-xs text-[#64748B]">Status: {result.occupancy.status}</p>
        </div>
      )}
      {result.status === 'Blocked' && result.available_rooms && result.available_rooms.length > 0 && (
        <div className="mt-2">
          <p className="text-xs text-[#64748B] uppercase tracking-wide font-semibold mb-2">Available Rooms</p>
          <div className="space-y-1.5">
            {result.available_rooms.slice(0, 4).map(r => (
              <div key={r.id} className="flex items-center gap-2 bg-white border border-[#A7F3D0] rounded-lg px-3 py-2">
                <Building2 className="w-3.5 h-3.5 text-[#059669] flex-shrink-0" />
                <span className="text-xs font-semibold text-[#065F46]">{r.room_name}</span>
                <span className="text-[10px] text-[#64748B] ml-auto">{r.room_type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.scan_time && (
        <p className="text-xs text-[#94A3B8] flex items-center gap-1.5 mt-3">
          <Clock className="w-3 h-3" /> Scanned at {formatScanClock(result.scan_time)}
        </p>
      )}

      {p.action === 'session' && (
        <Link href="/instructor" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-[#1D5BD6] hover:underline">
          {VIEW_SESSION_LABEL} →
        </Link>
      )}
    </div>
  );
}
