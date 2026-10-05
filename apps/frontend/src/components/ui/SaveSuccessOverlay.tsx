'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import TrashDropAnimation from '@/components/ui/TrashDropAnimation';

/** How long the "saved" check stays before the page carries on (same as the other success cards) */
export const SAVE_SUCCESS_MS = 1500;

/**
 * The green "saved" check that draws itself — circle, then tick — over the card
 * or dialog it sits in (that parent must be `relative`). Same look as every other
 * success card (save-success-* styles in globals.css). `compact` lays it out in a
 * row for short areas such as the profile-picture strip. `trash` swaps the tick
 * for the delete animation (something was removed).
 */
export default function SaveSuccessOverlay({ title, note, compact = false, page = false, trash = false }: {
  title: string;
  note?: string;
  compact?: boolean;
  /** Over the whole page (after a dialog has closed) instead of over its parent */
  page?: boolean;
  trash?: boolean;
}) {
  const size = compact ? 44 : 72;
  return (
    <div
      // qr-overlay-page: a soft dim with the page still showing — without it the
      // globals.css "card floats on its own" rule hides everything else in <body>
      className={`${page ? 'fixed inset-0 z-[80] qr-overlay-page' : 'absolute inset-0 z-10 rounded-2xl'} flex items-center justify-center save-success-overlay`}
      role="status"
      aria-live="polite"
    >
      <div className={`save-success-badge flex items-center rounded-2xl bg-white border border-[#E2E8F0] shadow-xl ${
        compact ? 'flex-row gap-3 px-5 py-3' : 'flex-col gap-3 px-8 py-7'
      }`}>
        {trash ? <TrashDropAnimation /> : (
        <svg width={size} height={size} viewBox="0 0 52 52" aria-hidden="true" className="flex-shrink-0">
          <circle className="save-success-circle" cx="26" cy="26" r="24" fill="none" stroke="#16A34A" strokeWidth="3" />
          <path
            className="save-success-check"
            fill="none" stroke="#16A34A" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"
            d="M14.5 27 22 34.5 38 17"
          />
        </svg>
        )}
        <div className={compact ? 'text-left' : 'text-center'}>
          <p className="text-base font-semibold" style={{ color: '#0B2A5B' }}>{title}</p>
          {note && <p className="mt-0.5 text-sm text-[#475569]">{note}</p>}
        </div>
      </div>
    </div>
  );
}

const PAGE_CHECK_EVENT = 'qr-page-success-check';

/**
 * The check over the whole page — for a save whose dialog closes first (e.g. a
 * new profile picture). Works even though the dialog that saved is gone:
 * <PageSuccessCheckHost /> in the app shell shows it. `delayMs` lets the dialog
 * finish closing before the check appears. `trash` plays the delete animation.
 */
export function showPageSuccessCheck(title: string, delayMs = 220, trash = false) {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent(PAGE_CHECK_EVENT, { detail: { title, trash } }));
  }, delayMs);
}

/** Mounted once per shell (Admin, Faculty): shows showPageSuccessCheck() calls */
export function PageSuccessCheckHost() {
  const [shown, setShown] = useState<{ title: string; trash: boolean } | null>(null);
  const [run, setRun] = useState(0); // a new save restarts the drawing
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    let timer: number | null = null;
    const onCheck = (e: Event) => {
      const detail = (e as CustomEvent<{ title?: string; trash?: boolean }>).detail;
      if (timer) window.clearTimeout(timer);
      setShown({ title: detail?.title ?? 'Saved', trash: detail?.trash === true });
      setRun(r => r + 1);
      timer = window.setTimeout(() => { timer = null; setShown(null); }, SAVE_SUCCESS_MS);
    };
    window.addEventListener(PAGE_CHECK_EVENT, onCheck);
    return () => {
      window.removeEventListener(PAGE_CHECK_EVENT, onCheck);
      if (timer) window.clearTimeout(timer);
    };
  }, []);
  if (!mounted || !shown) return null;
  return createPortal(<SaveSuccessOverlay key={run} title={shown.title} trash={shown.trash} page />, document.body);
}

/**
 * Shows the check for SAVE_SUCCESS_MS, then runs `then` (e.g. a toast or closing
 * the dialog). The timer is cleared if the component goes away first.
 */
export function useSaveSuccess(ms = SAVE_SUCCESS_MS) {
  const [shown, setShown] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const play = useCallback((then?: () => void) => {
    if (timer.current) window.clearTimeout(timer.current);
    setShown(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setShown(false);
      then?.();
    }, ms);
  }, [ms]);
  return { shown, play };
}
