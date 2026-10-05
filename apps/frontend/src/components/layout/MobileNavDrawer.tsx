'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { LogOut, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import SystemLogo from '@/components/ui/SystemLogo';

/**
 * Phone / tablet navigation shared by the Faculty and the Admin shells — a
 * sidebar that slides in from the left over a dimmed backdrop: brand header,
 * the role's menu (sections of DrawerLink rows), Log Out at the bottom. Tap the
 * backdrop, the X, a link, or press Esc (the shell) to close.
 */
export function MobileNavDrawer({ open, onClose, subtitle, signedInAs, children }: {
  open: boolean;
  onClose: () => void;
  /** Under "QRganize" in the header, e.g. "Faculty" or "Administrator" */
  subtitle: string;
  /** "Signed in as …" line ('' / null hides it) */
  signedInAs?: string | null;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  /* Log Out: the sidebar closes at once and a "Signing out…" card covers the page
     until the sign-in page opens — the button's own text never changes (swapping it
     inside the sliding sidebar left both labels drawn on top of each other). */
  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    onClose();
    try { await fetch('/api/auth/logout', { method: 'POST' }); } finally { router.push('/login'); }
  }

  return createPortal(
    <>
    {signingOut && (
      <div className="fixed inset-0 z-[90] flex items-center justify-center save-success-overlay qr-overlay-page" role="status" aria-live="polite">
        <div className="save-success-badge flex items-center gap-3 px-5 py-3.5 rounded-2xl bg-white border border-[#E2E8F0] shadow-xl">
          <span className="w-6 h-6 border-[3px] border-[#DBE5F4] border-t-[#1D5BD6] rounded-full animate-spin" aria-hidden="true" />
          <p className="text-[15px] font-semibold" style={{ color: '#0B2A5B' }}>Signing out…</p>
        </div>
      </div>
    )}
    <AnimatePresence>
      {open && (
        <motion.div
          key="mobile-nav"
          className="lg:hidden fixed inset-0 z-[60]"
          data-modal-root
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.2 } }}
          transition={{ duration: reduceMotion ? 0 : 0.2 }}
        >
          <div className="absolute inset-0 bg-[#0B2A5B]/45 backdrop-blur-sm" onClick={onClose} aria-hidden />
          <motion.nav
            aria-label="Mobile"
            className="absolute inset-y-0 left-0 w-[84%] max-w-[320px] bg-white shadow-[0_0_40px_rgba(11,42,91,0.35)] flex flex-col"
            initial={reduceMotion ? false : { x: '-100%' }}
            animate={{ x: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { x: '-100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 38 }}
          >
            {/* Brand header */}
            <div className="relative overflow-hidden bg-[#12408F] px-4 pt-4 pb-5" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
              <span aria-hidden className="absolute -right-12 -top-16 w-44 h-44 rounded-full bg-white/10" />
              <div className="relative flex items-center gap-2.5">
                <SystemLogo size={40} />
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-semibold leading-tight" style={{ color: '#FFFFFF' }}>QRganize</p>
                  <p className="text-[12px] font-medium" style={{ color: 'rgba(255,255,255,0.75)' }}>{subtitle}</p>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close menu"
                  className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-white/15 hover:bg-white/25 transition-colors"
                  style={{ color: '#FFFFFF' }}
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              {signedInAs && (
                <p className="relative mt-3 text-[14px] truncate" style={{ color: 'rgba(255,255,255,0.9)' }}>
                  Signed in as <span className="font-semibold" style={{ color: '#FFFFFF' }}>{signedInAs}</span>
                </p>
              )}
            </div>

            {/* Menu */}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3">{children}</div>

            <LogOutRow onSignOut={signOut} />
          </motion.nav>
        </motion.div>
      )}
    </AnimatePresence>
    </>,
    document.body,
  );
}

function LogOutRow({ onSignOut }: { onSignOut: () => void }) {
  return (
    <div className="border-t border-[#E2E8F0] p-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
      <button
        type="button"
        onClick={onSignOut}
        className="w-full flex items-center gap-3 min-h-12 px-3 rounded-xl text-[15px] font-semibold text-[#B91C1C] hover:bg-red-50 active:bg-red-100 transition-colors"
      >
        <span className="w-9 h-9 rounded-lg flex items-center justify-center bg-red-50 flex-shrink-0">
          <LogOut className="w-[18px] h-[18px]" />
        </span>
        Log Out
      </button>
    </div>
  );
}

/** One group of the menu, with its small capital heading */
export function DrawerSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <p className="px-3 pt-2 pb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#94A3B8]">{label}</p>
      {children}
    </div>
  );
}

/** A menu row: icon tile, label, optional red count, and a bar on the current page */
export function DrawerLink({ href, label, icon: Icon, active, badge, index, onClick }: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  badge?: number;
  /** Position in the whole menu — rows slide in one after another */
  index: number;
  onClick: () => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1], delay: reduceMotion ? 0 : 0.06 + index * 0.03 }}
    >
      <Link
        href={href}
        onClick={onClick}
        aria-current={active ? 'page' : undefined}
        className={[
          'flex items-center gap-3 min-h-12 px-3 rounded-xl text-[15px] transition-colors duration-200',
          active
            ? 'bg-[#E8F1FB] text-[#12408F] font-semibold'
            : 'text-[#334155] hover:bg-[#F1F5F9] active:bg-[#E2E8F0]',
        ].join(' ')}
      >
        <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${active ? 'bg-[#12408F]' : 'bg-[#F1F5F9]'}`}>
          <Icon className="w-[18px] h-[18px]" style={{ color: active ? '#FFFFFF' : '#475569' }} />
        </span>
        <span className="flex-1 min-w-0 truncate">{label}</span>
        {badge !== undefined && badge > 0 && (
          <span className="min-w-[22px] h-[22px] px-1.5 rounded-full text-[11px] font-bold flex items-center justify-center bg-[#DC2626]" style={{ color: '#FFFFFF' }}>
            {badge > 9 ? '9+' : badge}
          </span>
        )}
        {active && <span aria-hidden className="w-1.5 h-6 rounded-full bg-[#12408F]" />}
      </Link>
    </motion.div>
  );
}
