'use client';

import { useEffect } from 'react';

/**
 * Reference-counted lock for the real QRganize scroll surface.
 * The dashboard/instructor shells scroll `<main>`, not document.body —
 * so body overflow:hidden alone does not stop the page.
 */

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

let lockCount = 0;
let snapshot: {
  htmlOverflow: string;
  bodyOverflow: string;
  bodyPaddingRight: string;
  scrollers: Array<{ el: HTMLElement; overflowY: string; paddingRight: string }>;
} | null = null;

function appScrollers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-app-scroll], .dashboard-main-scroll')];
}

function topModalRoot(): HTMLElement | null {
  const roots = document.querySelectorAll<HTMLElement>('[data-modal-root]');
  return roots.length ? roots[roots.length - 1] : null;
}

export function isInsideModal(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest('[data-modal-root]')
    || target.closest('[role="dialog"][aria-modal="true"]'),
  );
}

function canScrollInside(start: EventTarget | null, deltaX: number, deltaY: number): boolean {
  if (!(start instanceof Element)) return false;
  const root = start.closest('[data-modal-root], [role="dialog"][aria-modal="true"]');
  if (!root) return false;

  let node: Element | null = start;
  while (node && root.contains(node)) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      const yScrollable = /(auto|scroll|overlay)/.test(style.overflowY);
      const xScrollable = /(auto|scroll|overlay)/.test(style.overflowX);
      if (yScrollable && deltaY !== 0) {
        const max = node.scrollHeight - node.clientHeight;
        if (max > 1 && ((deltaY < 0 && node.scrollTop > 0) || (deltaY > 0 && node.scrollTop < max - 1))) {
          return true;
        }
      }
      if (xScrollable && deltaX !== 0) {
        const max = node.scrollWidth - node.clientWidth;
        if (max > 1 && ((deltaX < 0 && node.scrollLeft > 0) || (deltaX > 0 && node.scrollLeft < max - 1))) {
          return true;
        }
      }
    }
    node = node.parentElement;
  }
  return false;
}

function onWheel(e: WheelEvent) {
  if (canScrollInside(e.target, e.deltaX, e.deltaY)) return;
  e.preventDefault();
}

function onTouchMove(e: TouchEvent) {
  if (isInsideModal(e.target)) return;
  e.preventDefault();
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => {
    if (el.hasAttribute('disabled') || el.tabIndex === -1) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  });
}

function focusModalRoot() {
  const root = topModalRoot();
  if (!root) return;
  const dialog = root.querySelector<HTMLElement>('[role="dialog"]') ?? root;
  const alreadyInside = document.activeElement instanceof Element && root.contains(document.activeElement);
  if (alreadyInside) return;
  const first = focusableIn(dialog)[0] ?? dialog;
  first.focus({ preventScroll: true });
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Tab') {
    const root = topModalRoot();
    if (!root) return;
    const dialog = root.querySelector<HTMLElement>('[role="dialog"]') ?? root;
    const items = focusableIn(dialog);
    if (items.length === 0) {
      e.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }
    const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (current === first || !current || !dialog.contains(current))) {
      e.preventDefault();
      last.focus();
      return;
    }
    if (!e.shiftKey && (current === last || !current || !dialog.contains(current))) {
      e.preventDefault();
      first.focus();
    }
    return;
  }

  if (!SCROLL_KEYS.has(e.key)) return;
  if (isInsideModal(e.target)) return;
  e.preventDefault();
}

function applyLock() {
  const gap = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  snapshot = {
    htmlOverflow: document.documentElement.style.overflow,
    bodyOverflow: document.body.style.overflow,
    bodyPaddingRight: document.body.style.paddingRight,
    scrollers: appScrollers().map(el => ({
      el,
      overflowY: el.style.overflowY,
      paddingRight: el.style.paddingRight,
    })),
  };

  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
  if (gap > 0) document.body.style.paddingRight = `${gap}px`;

  for (const item of snapshot.scrollers) {
    const innerGap = Math.max(0, item.el.offsetWidth - item.el.clientWidth);
    item.el.style.overflowY = 'hidden';
    if (innerGap > 0) item.el.style.paddingRight = `${innerGap}px`;
  }

  document.addEventListener('wheel', onWheel, { passive: false, capture: true });
  document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  document.addEventListener('keydown', onKeyDown, { capture: true });
}

function restoreLock() {
  if (!snapshot) return;
  document.documentElement.style.overflow = snapshot.htmlOverflow;
  document.body.style.overflow = snapshot.bodyOverflow;
  document.body.style.paddingRight = snapshot.bodyPaddingRight;
  for (const item of snapshot.scrollers) {
    if (document.contains(item.el)) {
      item.el.style.overflowY = item.overflowY;
      item.el.style.paddingRight = item.paddingRight;
    }
  }
  snapshot = null;
  document.removeEventListener('wheel', onWheel, true);
  document.removeEventListener('touchmove', onTouchMove, true);
  document.removeEventListener('keydown', onKeyDown, true);
}

export function resetScrollLocks() {
  if (typeof document === 'undefined') return;
  lockCount = 0;
  restoreLock();
}

export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (lockCount === 0) applyLock();
    lockCount += 1;
    const id = window.requestAnimationFrame(() => focusModalRoot());
    return () => {
      window.cancelAnimationFrame(id);
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0) {
        restoreLock();
        if (previouslyFocused && document.contains(previouslyFocused)) {
          previouslyFocused.focus({ preventScroll: true });
        }
      }
    };
  }, [active]);
}
