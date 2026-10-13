'use client';

import { useLayoutEffect, useState, type RefObject } from 'react';

/** Space between the app header's bottom edge and a pop-up that drops from it */
const GAP = 8;
/** The header bar's height (both shells) — used until the real one is measured */
const HEADER_PX = 72;

/**
 * Where a pop-up opened from the app header (bell, account menu) starts: just
 * BELOW the header bar, never over it. `fixedTop` is for a pop-up fixed to the
 * screen (phones); `belowAnchor` is for one placed `absolute` inside `anchor`
 * (its `relative` wrapper in the header). Measured when it opens and on resize.
 */
export function useHeaderDrop(anchor: RefObject<HTMLElement | null>, open: boolean) {
  const [pos, setPos] = useState({ fixedTop: HEADER_PX + GAP, belowAnchor: HEADER_PX / 2 + GAP });
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const header = document.querySelector('.qr-app-header')?.getBoundingClientRect();
      const a = anchor.current?.getBoundingClientRect();
      if (!header || !a) return;
      const fixedTop = Math.round(header.bottom + GAP);
      const belowAnchor = Math.round(header.bottom - a.top + GAP);
      setPos(p => (p.fixedTop === fixedTop && p.belowAnchor === belowAnchor ? p : { fixedTop, belowAnchor }));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [anchor, open]);
  return pos;
}
