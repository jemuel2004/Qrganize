'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ChevronDown, LayoutDashboard, CalendarDays, DoorOpen, Settings, LogOut, X,
} from 'lucide-react';
import SystemLogo from '@/components/ui/SystemLogo';
import { useInstructorProfile } from '@/context/InstructorProfileContext';
import type { LucideIcon } from 'lucide-react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import {
  getInstructorNavSections,
  isInstructorPathActive,
  isInstructorSectionActive,
  type InstructorNavSection,
} from '@/components/layout/instructorNav';

/** Same chrome tokens as Admin Sidebar — shared authenticated nav look. */
const navItemBase =
  'group relative inline-flex items-center gap-2 h-10 px-3.5 text-[15px] font-medium rounded-md transition-colors duration-150 cursor-pointer';
const navIdle = 'qr-nav-chrome-idle text-white/90 hover:text-[#1D5BD6] hover:bg-white/15';
const navActive = 'qr-nav-chrome-chip text-[#12408F] bg-white';

const SECTION_ICON: Record<string, LucideIcon> = {
  main: LayoutDashboard,
  schedule: CalendarDays,
  rooms: DoorOpen,
  account: Settings,
};

function useRequestsBadge() {
  const [count, setCount] = useState(0);
  const mountedRef = useRef(true);

  const refreshCount = useCallback(async () => {
    try {
      const res = await fetch('/api/instructor/room-requests?count=1');
      if (!res.ok || !mountedRef.current) return;
      const data = await res.json();
      if (mountedRef.current) {
        setCount(typeof data.pendingCount === 'number' ? data.pendingCount : 0);
      }
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refreshCount();
    return () => { mountedRef.current = false; };
  }, [refreshCount]);

  useRealtime(['room-requests'], refreshCount);
  useVisibilityAwareInterval(refreshCount, 60_000);

  return count;
}

function DesktopMenu({
  section,
  pathname,
  onNavigate,
}: {
  section: InstructorNavSection;
  pathname: string;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sectionActive = isInstructorSectionActive(pathname, section);
  const Icon = SECTION_ICON[section.id] ?? Settings;

  useEffect(() => {
    function onMouse(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative inline-flex items-center h-[72px] px-1.5 cursor-pointer"
      >
        <span className={`${navItemBase} ${sectionActive || open ? navActive : navIdle}`}>
          <Icon className="w-5 h-5 flex-shrink-0" />
          {section.label}
          <ChevronDown className={`qr-nav-chrome-chevron w-3.5 h-3.5 transition-transform duration-150 ${open ? 'rotate-180' : ''} ${sectionActive || open ? 'text-[#12408F]' : 'text-white/70 group-hover:text-[#1D5BD6]'}`} />
        </span>
        {sectionActive && (
          <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-white" />
        )}
      </button>

      {open && (
        <div
          className="qr-nav-menu absolute left-0 top-full z-50 mt-0 min-w-[220px] bg-white border border-[#E5E7EB] rounded-md py-1 shadow-[0_4px_12px_rgba(0,0,0,0.08)]"
          role="menu"
        >
          {section.items.map(item => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className={[
                'flex items-center gap-2 text-[14px] leading-6 min-h-10 px-3 py-2 transition-colors duration-150 cursor-pointer',
                isInstructorPathActive(pathname, item.href)
                  ? 'text-[#164BB5] font-medium bg-[#E8F1FB]'
                  : 'text-[#475569] hover:text-[#1D5BD6] hover:bg-[#F8FAFC]',
              ].join(' ')}
            >
              <item.icon className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">{item.label}</span>
              {item.badge !== undefined && (
                <span className="min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold flex items-center justify-center bg-[#12408F] text-white">
                  {item.badge > 9 ? '9+' : item.badge}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Desktop instructor nav — same visual chrome as Admin Sidebar (horizontal).
 * Menu items stay instructor-specific.
 */
export default function InstructorSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const requestsCount = useRequestsBadge();
  const navSections = getInstructorNavSections(requestsCount);
  const mainSection = navSections.find(s => s.id === 'main');
  const menuSections = navSections.filter(s => s.id !== 'main');

  return (
    <nav className="hidden lg:flex items-stretch min-w-0 gap-2" aria-label="Main">
      {mainSection?.items[0] && (
        <Link
          href={mainSection.items[0].href}
          onClick={() => onNavigate?.()}
          className="relative inline-flex items-center h-[72px] px-1.5 cursor-pointer"
        >
          <span className={`${navItemBase} ${isInstructorPathActive(pathname, mainSection.items[0].href) ? navActive : navIdle}`}>
            <LayoutDashboard className="w-5 h-5 flex-shrink-0" />
            {mainSection.items[0].label}
          </span>
          {isInstructorPathActive(pathname, mainSection.items[0].href) && (
            <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-white" />
          )}
        </Link>
      )}
      {menuSections.map(section => {
        const only = section.items[0];
        const Icon = SECTION_ICON[section.id] ?? Settings;
        if (section.items.length === 1 && only) {
          const active = isInstructorPathActive(pathname, only.href);
          return (
            <Link
              key={section.id}
              href={only.href}
              onClick={() => onNavigate?.()}
              className="relative inline-flex items-center h-[72px] px-1.5 cursor-pointer"
            >
              <span className={`${navItemBase} ${active ? navActive : navIdle}`}>
                <Icon className="w-5 h-5 flex-shrink-0" />
                {only.label}
              </span>
              {active && (
                <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-white" />
              )}
            </Link>
          );
        }
        return (
          <DesktopMenu
            key={section.id}
            section={section}
            pathname={pathname}
            onNavigate={onNavigate}
          />
        );
      })}
    </nav>
  );
}

/* ── Phone / tablet: slide-in sidebar ──────────────────────────────────────── */

function DrawerContent({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const requestsCount = useRequestsBadge(); // polls only while the sidebar is open
  const navSections = getInstructorNavSections(requestsCount);
  const { name } = useInstructorProfile();
  const [loggingOut, setLoggingOut] = useState(false);
  let row = 0;

  return (
    <>
      {/* Brand header */}
      <div className="relative overflow-hidden bg-[#12408F] px-4 pt-4 pb-5" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
        <span aria-hidden className="absolute -right-12 -top-16 w-44 h-44 rounded-full bg-white/10" />
        <div className="relative flex items-center gap-2.5">
          <SystemLogo size={40} />
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-semibold leading-tight" style={{ color: '#FFFFFF' }}>QRganize</p>
            <p className="text-[12px] font-medium" style={{ color: 'rgba(255,255,255,0.75)' }}>Faculty</p>
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
        {name && (
          <p className="relative mt-3 text-[14px] truncate" style={{ color: 'rgba(255,255,255,0.9)' }}>
            Signed in as <span className="font-semibold" style={{ color: '#FFFFFF' }}>{name}</span>
          </p>
        )}
      </div>

      {/* Menu */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3">
        {navSections.map(section => (
          <div key={section.id} className="mb-2">
            <p className="px-3 pt-2 pb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[#94A3B8]">
              {section.label}
            </p>
            {section.items.map(item => {
              const active = isInstructorPathActive(pathname, item.href);
              const i = row++;
              return (
                <motion.div
                  key={item.href}
                  initial={reduceMotion ? false : { opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1], delay: reduceMotion ? 0 : 0.06 + i * 0.03 }}
                >
                  <Link
                    href={item.href}
                    onClick={onClose}
                    aria-current={active ? 'page' : undefined}
                    className={[
                      'flex items-center gap-3 min-h-12 px-3 rounded-xl text-[15px] transition-colors duration-200',
                      active
                        ? 'bg-[#E8F1FB] text-[#12408F] font-semibold'
                        : 'text-[#334155] hover:bg-[#F1F5F9] active:bg-[#E2E8F0]',
                    ].join(' ')}
                  >
                    <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${active ? 'bg-[#12408F]' : 'bg-[#F1F5F9]'}`}>
                      <item.icon className="w-[18px] h-[18px]" style={{ color: active ? '#FFFFFF' : '#475569' }} />
                    </span>
                    <span className="flex-1 min-w-0 truncate">{item.label}</span>
                    {item.badge !== undefined && (
                      <span className="min-w-[22px] h-[22px] px-1.5 rounded-full text-[11px] font-bold flex items-center justify-center bg-[#DC2626]" style={{ color: '#FFFFFF' }}>
                        {item.badge > 9 ? '9+' : item.badge}
                      </span>
                    )}
                    {active && <span aria-hidden className="w-1.5 h-6 rounded-full bg-[#12408F]" />}
                  </Link>
                </motion.div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Log out */}
      <div className="border-t border-[#E2E8F0] p-3" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
        <button
          type="button"
          disabled={loggingOut}
          onClick={async () => {
            setLoggingOut(true);
            try { await fetch('/api/auth/logout', { method: 'POST' }); } finally { router.push('/login'); }
          }}
          className="w-full flex items-center gap-3 min-h-12 px-3 rounded-xl text-[15px] font-semibold text-[#B91C1C] hover:bg-red-50 active:bg-red-100 transition-colors disabled:opacity-60"
        >
          <span className="w-9 h-9 rounded-lg flex items-center justify-center bg-red-50 flex-shrink-0">
            <LogOut className="w-[18px] h-[18px]" />
          </span>
          {loggingOut ? 'Logging out…' : 'Log Out'}
        </button>
      </div>
    </>
  );
}

/**
 * Mobile navigation — a sidebar that slides in from the left over a dimmed
 * backdrop. Tap the backdrop, the X, a link, or press Esc to close.
 */
export function InstructorMobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="instructor-mobile-nav"
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
            <DrawerContent onClose={onClose} />
          </motion.nav>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
