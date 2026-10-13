'use client';

/**
 * The green "saved" check for a Settings section, like every other dialog's:
 * while it shows, the Settings window itself (white box, header, content) steps
 * aside — the panel's `[data-check-area]` styles in SettingsClient — so only the
 * check card floats over the dimmed page; the section then closes the window.
 * The card is centred on the window, kept inside its scrolled body (the list may
 * be scrolled), so it is never hidden under the header on a phone. The section's
 * root must be `relative`.
 */

import { useLayoutEffect, useRef } from 'react';
import SaveSuccessOverlay from '@/components/ui/SaveSuccessOverlay';

/** Half the card's height plus a little room — keeps it clear of the header and bottom edge */
const CARD_HALF = 100;

export default function SettingsSaveCheck({ title }: { title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const area = ref.current;
    const root = area?.parentElement;
    if (!area || !root) return;
    let scroller = root.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return;
    const body = scroller.getBoundingClientRect();
    const h = scroller.clientHeight;
    const panel = scroller.closest('[role="dialog"]')?.getBoundingClientRect();
    const mid = panel ? (panel.top + panel.bottom) / 2 : body.top + h / 2;
    const centre = Math.min(Math.max(mid, body.top + CARD_HALF), body.top + h - CARD_HALF);
    // Placed before the first paint, so the card never jumps
    area.style.top = `${centre - h / 2 - root.getBoundingClientRect().top}px`;
    area.style.height = `${h}px`;
    area.style.bottom = 'auto';
  }, []);
  return (
    <div ref={ref} data-check-area className="absolute inset-x-0 top-0 bottom-0 z-10">
      <SaveSuccessOverlay title={title} />
    </div>
  );
}
