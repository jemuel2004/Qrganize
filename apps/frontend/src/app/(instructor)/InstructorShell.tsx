'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { InstructorProfileProvider } from '@/context/InstructorProfileContext';
import { InstructorThemeProvider } from '@/context/InstructorThemeContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { ToastProvider } from '@/context/ToastContext';
import NotificationBell from '@/components/ui/NotificationBell';
import UserProfileDropdown from '@/components/ui/UserProfileDropdown';
import SystemLogo from '@/components/ui/SystemLogo';
import InstructorSidebar, { InstructorMobileNav } from '@/components/layout/InstructorSidebar';
import { useScrollLock } from '@/hooks/useScrollLock';

/**
 * Instructor chrome — same top-nav shell as Admin (AdminShell).
 * Menu items remain instructor-specific; colors/spacing/active/hover match Admin.
 */
export default function InstructorShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isWorkloadPrint =
    pathname === '/instructor/workload/print'
    || pathname.startsWith('/instructor/workload/print/');

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    // Shared authenticated theme via html.light — clear any legacy attr.
    document.documentElement.removeAttribute('data-instructor-theme');
  }, []);

  useScrollLock(mobileOpen);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  if (isWorkloadPrint) {
    return <>{children}</>;
  }

  return (
    <InstructorProfileProvider>
      <InstructorThemeProvider>
        <NotificationProvider role="instructor">
          <ToastProvider>
            <div className="flex flex-col h-screen overflow-hidden dashboard-layout-root">
              <header className="qr-app-header sticky top-0 flex-shrink-0 z-40 bg-[#12408F] isolate no-print">
                <div className="h-[72px] flex items-center gap-6 px-4 sm:px-6 min-w-0">
                  <Link
                    href="/instructor"
                    className="flex items-center gap-2 min-w-0 flex-shrink-0 rounded-md px-1 py-0.5 -ml-1 transition-colors duration-150 hover:bg-white/10 cursor-pointer"
                  >
                    <SystemLogo size={56} />
                    <span className="text-[16px] font-semibold text-white tracking-tight">
                      QRganize
                    </span>
                    <span className="hidden sm:inline text-[12px] font-medium text-white bg-white/20 rounded-full px-2.5 py-1 leading-none">
                      Faculty
                    </span>
                  </Link>

                  <div className="hidden lg:flex flex-1 min-w-0 items-stretch">
                    <InstructorSidebar onNavigate={() => setMobileOpen(false)} />
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

              </header>

              {/* Phones / tablets: slide-in sidebar */}
              <InstructorMobileNav open={mobileOpen} onClose={() => setMobileOpen(false)} />

              <main
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden dashboard-main-scroll flex flex-col bg-[var(--background)]"
                data-app-scroll
              >
                {children}
              </main>
            </div>
          </ToastProvider>
        </NotificationProvider>
      </InstructorThemeProvider>
    </InstructorProfileProvider>
  );
}
