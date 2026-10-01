'use client';

import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

/*
 * Popover panel anchored to a trigger element — shared by the Scheduling
 * Time and Room pickers.
 *
 * Portalled to <body> with fixed positioning (the session table scrolls
 * horizontally, which would clip an absolutely-positioned panel), opens below
 * or above the trigger depending on the space available, stays within the
 * viewport on any screen width, follows the trigger on scroll/resize, and
 * closes on an outside click.
 */

const GAP = 8;
const EASE = [0.4, 0, 0.2, 1] as const;

export default function AnchoredPopover({
  open,
  onClose,
  anchorRef,
  panelRef,
  width = 340,
  maxHeight = 440,
  label,
  onKeyDown,
  align = 'start',
  duration = 0.18,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  width?: number;
  maxHeight?: number;
  label: string;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  /** 'end' lines the panel up with the trigger's right edge */
  align?: 'start' | 'end';
  /** Open animation length in seconds (close runs a little quicker) */
  duration?: number;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number; up: boolean } | null>(null);

  const place = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 24);
    // Line up with the trigger's left edge (reads as "dropping out of" it);
    // shift left only as far as needed to stay on screen.
    const left = Math.min(Math.max(12, align === 'end' ? r.right - w : r.left), vw - w - 12);
    // Never open over the sticky app header
    const headerBottom = document.querySelector('.qr-app-header')?.getBoundingClientRect().bottom ?? 0;
    const topSafe = Math.max(12, headerBottom + 8);
    const below = vh - r.bottom - GAP - 12;
    const above = r.top - GAP - topSafe;
    const up = below < 300 && above > below;
    const maxH = Math.max(180, Math.min(maxHeight, up ? above : below));
    setPos({ top: up ? r.top - GAP : r.bottom + GAP, left, width: w, maxH, up });
  }, [anchorRef, width, maxHeight, align]);

  /* Still on screen — open, or playing its close animation. */
  const [present, setPresent] = useState(open);
  useLayoutEffect(() => { if (open) { setPresent(true); place(); } }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !anchorRef.current?.contains(t)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose, anchorRef, panelRef]);

  /* Follow the trigger until the panel is gone — a pick that resizes the page
     (and scrolls it) must not leave the closing panel floating over the trigger. */
  useEffect(() => {
    if (!present) return;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [present, place]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <AnimatePresence onExitComplete={() => setPresent(false)}>
      {open && pos && (
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-label={label}
          onKeyDown={onKeyDown}
          initial={reduceMotion ? false : { opacity: 0, y: pos.up ? 6 : -6, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduceMotion ? 0 : duration, ease: EASE } }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: pos.up ? 6 : -6, scale: 0.97, transition: { duration: duration * 0.72, ease: EASE } }}
          style={{
            position: 'fixed',
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxH,
            ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
            transformOrigin: pos.up ? 'bottom center' : 'top center',
            zIndex: 80, // above the sticky app header
          }}
          className="flex flex-col bg-white border border-[#E2E8F0] rounded-2xl shadow-[0_18px_44px_-14px_rgba(11,42,91,0.4)] overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
