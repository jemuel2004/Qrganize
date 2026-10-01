'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInstructorProfile } from '@/context/InstructorProfileContext';
import { useScrollLock } from '@/hooks/useScrollLock';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import Link from 'next/link';
import {
  QrCode, CheckCircle, XCircle, AlertTriangle, Clock,
  MapPin, Camera, CameraOff,
  Timer, ShieldX, Building2, Loader2,
} from 'lucide-react';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { CardSkeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface ScanResult {
  status: 'In-Use' | 'Pending' | 'Valid' | 'Late' | 'Overuse' | 'Blocked' | 'Unauthorized' | 'Invalid' | 'Error';
  scan_status?: 'Valid' | 'Late' | 'Overuse';
  message: string;
  scan_time: string;
  already_occupied?: boolean;
  /** ISO timestamp from room_occupancy.occupied_at when already checked in */
  checked_in_at?: string | null;
  room?: { id: number; name: string; type: string };
  schedule?: {
    subject_name: string;
    session_start: string | null;
    session_end: string | null;
    block_name: string;
    program_code?: string;
  };
  occupancy?: { faculty_name: string; status: string; expires_at?: string | null };
  occupancy_status?: 'Pending' | 'Occupied';
  authorized_faculty?: string;
  available_rooms?: { id: number; room_name: string; room_type: string; building: string | null }[];
  expires_in_mins?: number;
  error?: string;
}

type StatusKey = ScanResult['status'];

/* ─── Status config (persistent result card) ─────────────────────────────── */
const STATUS_UI: Record<StatusKey, {
  border: string; bg: string; icon: React.ReactNode; label: string; labelColor: string;
}> = {
  'In-Use': {
    border: 'border-[#A7F3D0]', bg: 'bg-[#ECFDF5]',
    icon: <CheckCircle className="w-9 h-9 text-[#059669]" />,
    label: 'In-Use', labelColor: 'text-[#059669]',
  },
  'Pending': {
    border: 'border-[#FDE68A]', bg: 'bg-[#FFFBEB]',
    icon: <Timer className="w-9 h-9 text-[#D97706]" />,
    label: 'Pending — Scan Again to Confirm', labelColor: 'text-[#D97706]',
  },
  'Valid': {
    border: 'border-[#A7F3D0]', bg: 'bg-[#ECFDF5]',
    icon: <CheckCircle className="w-9 h-9 text-[#059669]" />,
    label: 'Valid', labelColor: 'text-[#059669]',
  },
  'Late': {
    border: 'border-[#FDE68A]', bg: 'bg-[#FFFBEB]',
    icon: <AlertTriangle className="w-9 h-9 text-[#CA8A04]" />,
    label: 'Late Check-In', labelColor: 'text-[#A16207]',
  },
  'Overuse': {
    border: 'border-[#FECACA]', bg: 'bg-[#FEF2F2]',
    icon: <XCircle className="w-9 h-9 text-[#DC2626]" />,
    label: 'Overuse', labelColor: 'text-[#DC2626]',
  },
  'Blocked': {
    border: 'border-[#FECACA]', bg: 'bg-[#FEF2F2]',
    icon: <XCircle className="w-9 h-9 text-[#DC2626]" />,
    label: 'Blocked', labelColor: 'text-[#DC2626]',
  },
  'Unauthorized': {
    border: 'border-[#FECACA]', bg: 'bg-[#FEF2F2]',
    icon: <ShieldX className="w-9 h-9 text-[#DC2626]" />,
    label: 'Unauthorized Access', labelColor: 'text-[#DC2626]',
  },
  'Invalid': {
    border: 'border-[#E2E8F0]', bg: 'bg-[#F8FAFC]',
    icon: <XCircle className="w-9 h-9 text-[#64748B]" />,
    label: 'Invalid QR Code', labelColor: 'text-[#64748B]',
  },
  'Error': {
    border: 'border-[#FECACA]', bg: 'bg-[#FEF2F2]',
    icon: <XCircle className="w-9 h-9 text-[#DC2626]" />,
    label: 'Connection Problem', labelColor: 'text-[#DC2626]',
  },
};

function fmt5(t: string | null | undefined) { return t ? String(t).slice(0, 5) : '—'; }

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

/** Format occupancy checked-in timestamp for the Already Checked In modal. */
function formatCheckedInAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const dt = new Date(iso);
    if (isNaN(dt.getTime())) return null;
    return dt.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return null;
  }
}

/** In-Use (first check-in, late, or already occupying) — camera should fully stop. */
function shouldStopCameraAfterResult(result: ScanResult): boolean {
  return result.status === 'In-Use';
}

function haptic(kind: 'success' | 'error' | 'info') {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    if (kind === 'success') navigator.vibrate(30);
    else if (kind === 'error') navigator.vibrate([40, 40, 40]);
    else navigator.vibrate(20);
  } catch { /* optional */ }
}

type ModalKind =
  | 'success'
  | 'already'
  | 'pending'
  | 'late'
  | 'blocked'
  | 'unauthorized'
  | 'invalid'
  | 'overuse'
  | 'error';

interface ModalPresentation {
  kind: ModalKind;
  title: string;
  message: string;
  buttonLabel: string;
  action: 'done' | 'scan_again';
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info';
}

function presentScanResult(result: ScanResult): ModalPresentation {
  if (result.status === 'Error') {
    return {
      kind: 'error',
      title: 'Connection Problem',
      message: result.message || "We couldn't verify this QR code. Check your connection and try again.",
      buttonLabel: 'Try Again',
      action: 'scan_again',
      tone: 'danger',
    };
  }
  if (result.status === 'Invalid') {
    return {
      kind: 'invalid',
      title: 'Invalid Room QR Code',
      message: result.message || 'This QR code could not be verified. Please scan a valid QRganize room QR code.',
      buttonLabel: 'Scan Again',
      action: 'scan_again',
      tone: 'neutral',
    };
  }
  if (result.status === 'Blocked') {
    return {
      kind: 'blocked',
      title: 'Unable to Check In',
      message: result.message || 'This room is currently occupied.',
      buttonLabel: 'Close',
      action: 'done',
      tone: 'danger',
    };
  }
  if (result.status === 'Unauthorized') {
    return {
      kind: 'unauthorized',
      title: 'Unauthorized Room',
      message: result.message || 'This room is assigned to a different faculty member at this time.',
      buttonLabel: 'Close',
      action: 'done',
      tone: 'danger',
    };
  }
  if (result.status === 'Overuse') {
    return {
      kind: 'overuse',
      title: 'Session Ended',
      message: result.message || 'The class session has already ended. The scan window is closed.',
      buttonLabel: 'Close',
      action: 'done',
      tone: 'danger',
    };
  }
  if (result.status === 'Pending') {
    const mins = result.expires_in_mins ?? 15;
    return {
      kind: 'pending',
      title: 'Room Reserved',
      message: result.message
        || `This room is reserved for you for ${mins} minutes. Scan the QR code at the room to confirm your check-in.`,
      buttonLabel: 'Got it',
      action: 'scan_again',
      tone: 'warning',
    };
  }
  if (result.status === 'In-Use' && result.already_occupied) {
    return {
      kind: 'already',
      title: 'Already Checked In',
      message: result.message || 'You are already occupying this room. This room has already been successfully scanned.',
      buttonLabel: 'Done',
      action: 'done',
      tone: 'success',
    };
  }
  if (result.status === 'In-Use' && result.scan_status === 'Late') {
    return {
      kind: 'late',
      title: 'Late Check-In',
      message: result.message || 'You checked in after the scheduled start time.',
      buttonLabel: 'Continue',
      action: 'done',
      tone: 'warning',
    };
  }
  if (result.status === 'Late') {
    return {
      kind: 'late',
      title: 'Late Check-In',
      message: result.message || 'You checked in after the scheduled start time.',
      buttonLabel: 'Continue',
      action: 'done',
      tone: 'warning',
    };
  }
  if (result.status === 'In-Use' || result.status === 'Valid') {
    return {
      kind: 'success',
      title: 'Room Occupied Successfully',
      message: result.message || 'You are now checked in and occupying this room.',
      buttonLabel: 'Done',
      action: 'done',
      tone: 'success',
    };
  }
  return {
    kind: 'invalid',
    title: 'Scan Result',
    message: result.message || 'Scan completed.',
    buttonLabel: 'Close',
    action: 'done',
    tone: 'neutral',
  };
}

const cardClass =
  'bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden';

type Html5Scanner = {
  start: (
    cameraIdOrConfig: string | MediaTrackConstraints,
    config: object,
    qrCodeSuccessCallback: (decodedText: string) => void,
    qrCodeErrorCallback?: (errorMessage: string) => void,
  ) => Promise<null>;
  stop: () => Promise<void>;
  pause?: (shouldPauseVideo?: boolean) => void;
  resume?: () => void;
};

/* ─── Centered scan result dialog ────────────────────────────────────────── */
function ScanResultDialog({
  open,
  result,
  onAction,
}: {
  open: boolean;
  result: ScanResult | null;
  onAction: (action: 'done' | 'scan_again') => void;
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

  if (!open || !result || !mounted) return null;

  const p = presentScanResult(result);
  const iconWrap =
    p.tone === 'success' ? 'bg-[#ECFDF5] text-[#059669]'
    : p.tone === 'warning' ? 'bg-[#FFFBEB] text-[#D97706]'
    : p.tone === 'danger' ? 'bg-[#FEF2F2] text-[#DC2626]'
    : p.tone === 'info' ? 'bg-[#EFF6FF] text-[#1D5BD6]'
    : 'bg-[#F1F5F9] text-[#64748B]';

  const Icon =
    p.kind === 'pending' ? Timer
    : p.kind === 'late' ? AlertTriangle
    : p.kind === 'unauthorized' ? ShieldX
    : (p.kind === 'success' || p.kind === 'already') ? CheckCircle
    : XCircle;

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
        onClick={() => onAction(p.action)}
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

        {p.kind === 'already' && formatCheckedInAt(result.checked_in_at) && (
          <p className="mt-3 text-xs font-medium text-[#64748B]">
            Checked in at: {formatCheckedInAt(result.checked_in_at)}
          </p>
        )}

        {result.scan_time && p.kind !== 'already' && (
          <p className="mt-3 text-xs text-[#94A3B8] flex items-center justify-center gap-1.5">
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
            {formatScanClock(result.scan_time)}
          </p>
        )}

        {result.scan_time && p.kind === 'already' && !formatCheckedInAt(result.checked_in_at) && (
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
      </div>
    </div>,
    document.body,
  );
}

/* ─── Main component ─────────────────────────────────────────────────────── */
export default function ScanClient() {
  const { facultyId } = useInstructorProfile();
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showProcessing, setShowProcessing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraLoading, setCameraLoading] = useState(false);
  const [htmlScanner, setHtmlScanner] = useState<Html5Scanner | null>(null);
  const [booting, setBooting] = useState(true);
  useEffect(() => { setBooting(false); }, []);
  const showSkeleton = useMinLoading(booting, LOADING_DELAY);

  const scannerContainerId = 'instructor-qr-reader';
  const scannerRef = useRef<Html5Scanner | null>(null);
  const processingQrRef = useRef<string | null>(null);
  const lastProcessedQrRef = useRef<string | null>(null);
  const modalOpenRef = useRef(false);
  const submittingRef = useRef(false);
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    modalOpenRef.current = modalOpen;
  }, [modalOpen]);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  useEffect(() => {
    return () => {
      const s = scannerRef.current;
      if (s) s.stop().catch(() => {});
      if (processingTimerRef.current) clearTimeout(processingTimerRef.current);
    };
  }, []);

  function pauseScanner() {
    try { scannerRef.current?.pause?.(true); } catch { /* optional */ }
  }

  function resumeScanner() {
    if (modalOpenRef.current || submittingRef.current) return;
    if (!scannerRef.current || !cameraOn) return;
    try { scannerRef.current.resume?.(); } catch { /* optional */ }
  }

  /** Fully stop scanner + release MediaStream tracks (camera indicator off). */
  async function stopCamera() {
    const s = scannerRef.current;
    if (s) {
      try { await s.stop(); } catch { /* ignore */ }
    }
    scannerRef.current = null;
    setHtmlScanner(null);
    setCameraOn(false);
    setCameraLoading(false);
  }

  function unlockForRetry() {
    processingQrRef.current = null;
    lastProcessedQrRef.current = null;
  }

  const doScan = useCallback(async (qrCodeId: string) => {
    if (!facultyId || !qrCodeId.trim()) return;
    const code = qrCodeId.trim();

    /* Duplicate lock — camera frames must not spam the API */
    if (modalOpenRef.current || submittingRef.current) return;
    if (code === processingQrRef.current) return;
    if (code === lastProcessedQrRef.current) return;

    processingQrRef.current = code;
    submittingRef.current = true;
    setSubmitting(true);
    pauseScanner();

    if (processingTimerRef.current) clearTimeout(processingTimerRef.current);
    processingTimerRef.current = setTimeout(() => setShowProcessing(true), 180);

    try {
      const res = await fetch('/api/qr/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_code_id: code, faculty_id: facultyId }),
      });

      /* Session-level frame dedup while this camera session stays open */
      lastProcessedQrRef.current = code;

      const raw = await res.json().catch(() => ({})) as ScanResult & { error?: string };

      if (!res.ok && !raw.status) {
        const err: ScanResult = {
          status: 'Error',
          message: raw.error || "We couldn't verify this QR code. Check your connection and try again.",
          scan_time: new Date().toTimeString().slice(0, 8),
        };
        setScanResult(err);
        setModalOpen(true);
        return;
      }

      const data: ScanResult = {
        ...raw,
        status: raw.status || (res.ok ? 'Invalid' : 'Error'),
        message: raw.message || raw.error || 'Scan completed.',
        scan_time: raw.scan_time || new Date().toTimeString().slice(0, 8),
      };

      setScanResult(data);
      setModalOpen(true);

      /*
       * Successful / Already Checked In / Late (In-Use): stop camera completely.
       * Closing the modal must NOT restart it — user presses Start Camera again.
       */
      if (shouldStopCameraAfterResult(data)) {
        await stopCamera();
      }
    } catch {
      const err: ScanResult = {
        status: 'Error',
        message: "We couldn't verify this QR code. Check your connection and try again.",
        scan_time: new Date().toTimeString().slice(0, 8),
      };
      setScanResult(err);
      setModalOpen(true);
      lastProcessedQrRef.current = null;
      processingQrRef.current = null;
    } finally {
      if (processingTimerRef.current) {
        clearTimeout(processingTimerRef.current);
        processingTimerRef.current = null;
      }
      setShowProcessing(false);
      submittingRef.current = false;
      setSubmitting(false);
      processingQrRef.current = null;
    }
  }, [facultyId]);

  function handleModalAction(action: 'done' | 'scan_again') {
    setModalOpen(false);
    if (action === 'scan_again') {
      unlockForRetry();
      /* Resume only if camera is still running (invalid / network retry). Never restart a stopped camera. */
      requestAnimationFrame(() => resumeScanner());
      return;
    }
    /* Done after In-Use: camera already stopped — do not resume. */
  }

  /* ── Camera ──────────────────────────────────────────────────────────── */
  async function toggleCamera() {
    if (typeof window === 'undefined') return;
    if (cameraLoading) return;
    setCameraError('');
    if (htmlScanner || scannerRef.current) {
      await stopCamera();
      return;
    }

    unlockForRetry();
    setCameraLoading(true);
    setCameraOn(true);
    try {
      const { Html5Qrcode } = await import('html5-qrcode');
      const scanner = new Html5Qrcode(scannerContainerId) as unknown as Html5Scanner;
      setHtmlScanner(scanner);
      scannerRef.current = scanner;
      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 8,
          // Scan square fits the actual video (70% of its shorter side), so the mask
          // and corner brackets line up on any phone
          qrbox: (w: number, h: number) => {
            const size = Math.max(160, Math.floor(Math.min(w, h) * 0.7));
            return { width: size, height: size };
          },
        },
        async (decodedText: string) => {
          let code = decodedText;
          try { code = (JSON.parse(decodedText) as { code?: string }).code ?? decodedText; }
          catch { /* raw */ }
          await doScan(code);
        },
        () => {},
      );
    } catch (err: unknown) {
      const s = scannerRef.current;
      if (s) {
        try { await s.stop(); } catch { /* ignore */ }
      }
      setCameraError(
        err instanceof Error
          ? 'Camera unavailable. Check browser permissions and try again.'
          : 'Could not access camera.',
      );
      setCameraOn(false);
      setHtmlScanner(null);
      scannerRef.current = null;
    } finally {
      setCameraLoading(false);
    }
  }

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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        <PageLoadTransition
          showSkeleton={showSkeleton}
          skeleton={<CardSkeleton className="min-h-[360px]" />}
        >
        <div className="space-y-4">

          <div className={cardClass}>
            <div className="px-5 py-3.5 border-b border-[#E2E8F0] flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                <Camera className="w-3.5 h-3.5 text-[#1D5BD6]" />
              </div>
              <span className="text-sm font-semibold text-[#0B2A5B]">Camera Scanner</span>
            </div>
            <div className="p-5 relative">
              <div className="relative">
                <div
                  id={scannerContainerId}
                  className={`qr-scan-box rounded-xl overflow-hidden bg-[#F1F5F9] border border-[#E2E8F0] ${
                    cameraOn ? 'block bg-black' : 'min-h-[240px] flex items-center justify-center'
                  }`}
                >
                  {!cameraOn && (
                    <div className="text-center py-12 px-4">
                      <div className="w-14 h-14 rounded-2xl bg-white border border-[#E2E8F0] flex items-center justify-center mx-auto mb-3">
                        <QrCode className="w-7 h-7 text-[#1D5BD6]" />
                      </div>
                      <p className="text-[#0B2A5B] text-sm font-semibold">Camera is off</p>
                      <p className="text-[#94A3B8] text-xs mt-1">Press the button below to start scanning</p>
                    </div>
                  )}
                </div>

                {cameraLoading && (
                  <div
                    className="absolute inset-0 rounded-xl bg-black/40 flex flex-col items-center justify-center text-white gap-2"
                    role="status"
                    aria-live="polite"
                  >
                    <Loader2 className="w-7 h-7 animate-spin" />
                    <p className="text-sm font-semibold">Starting camera…</p>
                    <p className="text-xs text-white/80">Requesting camera access</p>
                  </div>
                )}
              </div>

              {showProcessing && (
                <div
                  className="absolute inset-5 rounded-xl bg-black/45 flex flex-col items-center justify-center text-white gap-2 z-20"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2 className="w-7 h-7 animate-spin" />
                  <p className="text-sm font-semibold">Verifying…</p>
                  <p className="text-xs text-white/80">Checking room information</p>
                </div>
              )}

              {cameraError && (
                <p className="text-[#DC2626] text-xs mt-2.5 flex items-start gap-1.5">
                  <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> {cameraError}
                </p>
              )}
              <button
                type="button"
                onClick={toggleCamera}
                disabled={!facultyId || submitting || cameraLoading}
                className={`w-full mt-3 py-2.5 min-h-11 rounded-xl font-semibold text-sm transition flex items-center justify-center gap-2 disabled:opacity-40 ${
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
            </div>
          </div>
        </div>
        </PageLoadTransition>

        <div className="space-y-4">
          {scanResult ? (
            <ScanResultCard result={scanResult} />
          ) : (
            <div className={`${cardClass} p-12 flex flex-col items-center justify-center text-center`}>
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
        onAction={handleModalAction}
      />
    </div>
  );
}

/* ─── Persistent scan result card (kept below camera) ────────────────────── */
function ScanResultCard({ result }: { result: ScanResult }) {
  const ui = STATUS_UI[result.status] ?? STATUS_UI.Invalid;
  const label = result.already_occupied
    ? 'Already Checked In'
    : (result.status === 'In-Use' && result.scan_status === 'Late')
      ? 'Late Check-In'
      : ui.label;

  return (
    <div className={`rounded-2xl border p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] ${ui.border} ${ui.bg}`}>

      <div className="flex items-start gap-3.5 mb-4">
        {ui.icon}
        <div className="min-w-0">
          <p className={`text-lg font-bold leading-tight ${ui.labelColor}`}>{label}</p>
          <p className="text-sm text-[#475569] mt-1 leading-snug">{result.message}</p>
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
          {result.scan_status === 'Late' ? 'Late check-in recorded' :
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

      {result.schedule && (
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

      {result.status === 'Unauthorized' && result.authorized_faculty && (
        <div className="bg-white border border-[#FECACA] rounded-xl p-3.5 mb-3">
          <p className="text-[10px] text-[#DC2626] uppercase tracking-wide font-semibold mb-1">Assigned Faculty</p>
          <p className="text-sm font-semibold text-[#991B1B]">{result.authorized_faculty}</p>
          <p className="text-xs text-[#64748B] mt-0.5">Only this faculty member may occupy this room during the scheduled session.</p>
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

      <p className="text-xs text-[#94A3B8] flex items-center gap-1.5 mt-3">
        <Clock className="w-3 h-3" /> Scanned at {formatScanClock(result.scan_time)}
      </p>
    </div>
  );
}
