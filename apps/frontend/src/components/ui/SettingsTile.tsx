'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronRight, X } from 'lucide-react';
import { useScrollLock } from '@/hooks/useScrollLock';

/*
 * One setting on a Settings page (faculty Settings, chairs' My Account): a big
 * colour tile; clicking it opens the setting in its own centred pop-up (no
 * long scrolling page). Close / Esc / backdrop closes it. On phones the
 * window fits the visible screen (dvh) and scrolls inside.
 */

const WHITE = { color: '#FFFFFF' } as const;
const EASE = [0.4, 0, 0.2, 1] as const;
/** Pop-up headers are solid royal blue, like every other window in QRganize */
const HEADER_BG = { backgroundColor: '#1D5BD6' } as const;

/** Phones: once the keyboard has opened, scroll the tapped field into the middle of the window */
export function revealFocused(e: React.FocusEvent) {
  const el = e.target as HTMLElement;
  if (!el.matches?.('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select')) return;
  window.setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
}

export default function SettingsTile({
  id, tone, icon: Icon, title, subtitle, open, onToggle, children, className = '',
}: {
  /** Unique per page (pop-up key) */
  id: string;
  /** Tile tint and icon colour */
  tone: string;
  icon: React.ElementType;
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useScrollLock(open);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // leave Esc to a nested window (e.g. Change Password) when one is open
      if (e.key === 'Escape' && document.querySelectorAll('[data-modal-root]').length === 0) onToggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onToggle]);

  return (
    <>
      <motion.button
        type="button"
        onClick={onToggle}
        aria-haspopup="dialog"
        whileHover={reduceMotion ? undefined : { y: -4, boxShadow: `0 18px 36px -18px ${tone}99` }}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
        className={`qr-stat-tint group relative overflow-hidden text-left rounded-2xl border p-5 flex items-center gap-4 min-h-[104px] w-full ${className}`}
        style={{ background: `linear-gradient(135deg, ${tone}1A 0%, #FFFFFF 70%)`, borderColor: `${tone}33` }}
      >
        <span aria-hidden className="absolute -right-8 -top-8 w-28 h-28 rounded-full" style={{ backgroundColor: `${tone}0F` }} />
        <span className="relative w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-[0_8px_18px_-8px_rgba(11,42,91,0.45)]"
          style={{ background: `linear-gradient(135deg, ${tone} 0%, #0B2A5B 140%)` }}>
          <Icon className="w-6 h-6" style={WHITE} />
        </span>
        <span className="relative min-w-0 flex-1">
          <span className="block text-[17px] font-bold leading-tight text-[#0B2A5B]">{title}</span>
          <span className="block text-sm text-[#64748B] mt-1 leading-snug">{subtitle}</span>
        </span>
        <ChevronRight className="relative w-5 h-5 flex-shrink-0 transition-transform duration-200 group-hover:translate-x-1" style={{ color: tone }} />
      </motion.button>

      {mounted && createPortal(
        <AnimatePresence>
          {open && (
            /* A centred window on every screen — it fits inside the visible screen and scrolls inside */
            <motion.div key={`setting-${id}`} className="fixed inset-0 z-40 flex items-center justify-center p-3 sm:p-6"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduceMotion ? 0 : 0.25 }}>
              <div className="absolute inset-0 bg-[#0B2A5B]/45 backdrop-blur-sm" onClick={onToggle} aria-hidden />
              <motion.div role="dialog" aria-modal="true" aria-label={title}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.96, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0, transition: { type: 'spring', stiffness: 360, damping: 30 } }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.18, ease: EASE } }}
                className="relative w-full max-w-lg sm:max-w-2xl max-h-[calc(100dvh-1.5rem)] sm:max-h-[min(90dvh,860px)] flex flex-col rounded-2xl sm:rounded-3xl overflow-hidden bg-white shadow-[0_30px_70px_-25px_rgba(11,42,91,0.6)]">
                <header className="flex-shrink-0 px-4 py-3.5 sm:px-6 sm:py-5" style={HEADER_BG}>
                  <div className="flex items-center gap-3 sm:gap-4">
                    <span className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl bg-white/15 ring-1 ring-white/25 flex items-center justify-center flex-shrink-0">
                      <Icon className="w-5 h-5 sm:w-6 sm:h-6" style={WHITE} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-lg sm:text-xl font-bold leading-tight truncate" style={WHITE}>{title}</h2>
                      <p className="text-[13px] sm:text-sm mt-0.5 leading-snug" style={{ color: 'rgba(255,255,255,0.85)' }}>{subtitle}</p>
                    </div>
                    <button type="button" onClick={onToggle} aria-label="Close"
                      className="inline-flex items-center justify-center gap-1.5 h-10 min-w-10 sm:px-3.5 rounded-full bg-white/15 hover:bg-white/25 text-[15px] font-semibold transition-colors flex-shrink-0" style={WHITE}>
                      <X className="w-5 h-5" /> <span className="hidden sm:inline">Close</span>
                    </button>
                  </div>
                </header>
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain" onFocusCapture={revealFocused}>{children}</div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
