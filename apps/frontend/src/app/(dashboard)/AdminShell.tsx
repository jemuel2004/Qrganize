'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import Sidebar, { AdminMobileNav, adminHomeHref } from '@/components/layout/Sidebar';
import { NotificationProvider } from '@/context/NotificationContext';
import NotificationBell from '@/components/ui/NotificationBell';
import UserProfileDropdown from '@/components/ui/UserProfileDropdown';
import SystemLogo from '@/components/ui/SystemLogo';
import { useScrollLock } from '@/hooks/useScrollLock';
import { logoHover, logoTap, NAV_DURATION, NAV_EASE } from '@/components/layout/navMotion';
import { useSchedulingPendingCounts } from '@/hooks/useSchedulingPendingCounts';

/**
 * Admin chrome: sticky top navigation + full-width content.
 */
export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [role, setRole] = useState('admin');
  const isWorkloadPrint = pathname === '/workload/print' || pathname.startsWith('/workload/print/');
  const pendingCounts = useSchedulingPendingCounts();

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useScrollLock(mobileOpen);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  useEffect(() => {
    // Shared authenticated theme via html.light — clear any legacy attr.
    document.documentElement.removeAttribute('data-instructor-theme');
  }, []);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data?.user?.role) setRole(data.user.role);
      })
      .catch(() => {});
  }, []);

  if (isWorkloadPrint) {
    return <>{children}</>;
  }

  const homeHref = adminHomeHref(role);

  return (
    <NotificationProvider role={role === 'program_chair' || role === 'department_chair' ? role : 'admin'}>
      <div className="flex flex-col h-screen overflow-hidden dashboard-layout-root">
        <header className="qr-app-header sticky top-0 flex-shrink-0 z-40 bg-[#12408F] isolate no-print">
          <div className="h-[72px] flex items-center gap-6 px-4 sm:px-6 min-w-0">
            <motion.div
              className="flex-shrink-0"
              whileHover={
                reduceMotion
                  ? undefined
                  : {
                      ...logoHover,
                      filter: 'drop-shadow(0 0 10px rgba(147,197,253,0.65))',
                    }
              }
              whileTap={reduceMotion ? undefined : logoTap}
              transition={{ duration: NAV_DURATION, ease: NAV_EASE }}
            >
              <Link
                href={homeHref}
                className="flex items-center gap-2 min-w-0 flex-shrink-0 rounded-md px-1 py-0.5 -ml-1 transition-colors duration-150 hover:bg-white/10 cursor-pointer"
              >
                <SystemLogo size={56} />
                <span className="text-[16px] font-semibold text-white tracking-tight">
                  QRganize
                </span>
              </Link>
            </motion.div>

            <div className="hidden lg:flex flex-1 min-w-0 items-stretch">
              <Sidebar onNavigate={() => setMobileOpen(false)} pendingCounts={pendingCounts} />
            </div>

            <div className="flex items-center gap-2.5 ml-auto flex-shrink-0">
              <NotificationBell theme="brand" />
              <UserProfileDropdown theme="brand" compact />
              <button
                type="button"
                onClick={() => setMobileOpen(v => !v)}
                className="lg:hidden inline-flex items-center justify-center h-10 w-10 text-white rounded-full bg-white/20 ring-1 ring-inset ring-white/35 transition-colors duration-150 hover:bg-white/30 cursor-pointer"
                aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={mobileOpen}
              >
                {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {mobileOpen && (
            <AdminMobileNav onNavigate={() => setMobileOpen(false)} pendingCounts={pendingCounts} />
          )}
        </header>

        <main
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden dashboard-main-scroll flex flex-col bg-[var(--background)]"
          data-app-scroll
        >
          {children}
        </main>
      </div>
    </NotificationProvider>
  );
}
