'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { InstructorProfileProvider } from '@/context/InstructorProfileContext';
import { InstructorThemeProvider } from '@/context/InstructorThemeContext';
import { NotificationProvider, useNotifications } from '@/context/NotificationContext';
import { RealtimeProvider } from '@/context/RealtimeContext';
import { ToastProvider, useToast } from '@/context/ToastContext';
import NotificationBell from '@/components/ui/NotificationBell';
import UserProfileDropdown from '@/components/ui/UserProfileDropdown';
import SystemLogo from '@/components/ui/SystemLogo';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import InstructorSidebar, { InstructorMobileNav } from '@/components/layout/InstructorSidebar';
import { useScrollLock } from '@/hooks/useScrollLock';
import { useNavTrail } from '@/lib/navTrail';
import { PageSuccessCheckHost } from '@/components/ui/SaveSuccessOverlay';

/**
 * A subject newly assigned to this faculty pops up on whatever page is open
 * (the bell keeps it too). My Workload says so itself, so it stays quiet there.
 */
function NewSubjectToasts() {
  const { notifications, isInitialLoad } = useNotifications();
  const toast = useToast();
  const pathname = usePathname();
  const seen = useRef<Set<number> | null>(null);

  useEffect(() => {
    if (isInitialLoad) return;
    const assigned = notifications.filter(n => n.type === 'workload_updated');
    // Anything already in the inbox when the page opened is old news
    if (!seen.current) { seen.current = new Set(assigned.map(n => n.id)); return; }
    for (const n of assigned) {
      if (seen.current.has(n.id)) continue;
      seen.current.add(n.id);
      if (!n.is_read && !pathname.startsWith('/instructor/workload')) toast.info(n.message, n.title);
    }
  }, [notifications, isInitialLoad, pathname, toast]);

  return null;
}

/** Reminders already popped up in this browser session (so a reload doesn't repeat them) */
const SHOWN_KEY = 'qr-class-reminders-shown';
function shownReminders(): Set<number> {
  try { return new Set(JSON.parse(sessionStorage.getItem(SHOWN_KEY) || '[]') as number[]); } catch { return new Set(); }
}

/**
 * Class reminders (the server makes them: "You have 3 classes today" and
 * "Your class starts soon") pop up once on whatever page is open — also right
 * after signing in — and stay in the bell. A class starting now is amber.
 */
function ClassReminderToasts() {
  const { notifications, isInitialLoad } = useNotifications();
  const toast = useToast();

  useEffect(() => {
    if (isInitialLoad) return;
    const reminders = notifications
      .filter(n => !n.is_read && (n.type === 'class_today' || n.type === 'class_starting'))
      // The day's summary first, then what is starting
      .sort((a, b) => Number(a.type === 'class_starting') - Number(b.type === 'class_starting'));
    if (reminders.length === 0) return;
    const shown = shownReminders();
    let changed = false;
    for (const n of reminders) {
      if (shown.has(n.id)) continue;
      shown.add(n.id);
      changed = true;
      if (n.type === 'class_starting') toast.warning(n.message, n.title);
      else toast.info(n.message, n.title);
    }
    if (changed) {
      try { sessionStorage.setItem(SHOWN_KEY, JSON.stringify([...shown].slice(-100))); } catch { /* private mode */ }
    }
  }, [notifications, isInitialLoad, toast]);

  return null;
}

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
  // Back buttons return to the page this tab came from
  useNavTrail(pathname, '/instructor');

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
    <RealtimeProvider>
      <InstructorProfileProvider>
        <InstructorThemeProvider>
          <NotificationProvider role="instructor">
            <ToastProvider>
              <NewSubjectToasts />
              <ClassReminderToasts />
              <div className="flex flex-col h-screen overflow-hidden dashboard-layout-root">
                <header className="qr-app-header sticky top-0 flex-shrink-0 z-40 bg-[#12408F] isolate no-print">
                  <div className="h-[72px] flex items-center gap-3 sm:gap-6 px-4 sm:px-6 min-w-0">
                    <Link
                      href="/instructor"
                      className="flex items-center gap-2 min-w-0 flex-shrink-0 rounded-md px-1 py-0.5 -ml-1 transition-colors duration-150 hover:bg-white/10 cursor-pointer"
                    >
                      <SystemLogo size={56} />
                      <span className="max-[359px]:hidden text-[16px] font-semibold text-white tracking-tight">
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

                {/* "Saved" checks that play after a dialog has closed */}
                <PageSuccessCheckHost />

                {/* Phones / tablets: slide-in sidebar */}
                <InstructorMobileNav open={mobileOpen} onClose={() => setMobileOpen(false)} />

                <main
                  className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable] dashboard-main-scroll flex flex-col bg-[var(--background)]"
                  data-app-scroll
                >
                  {/* A crashed page shows a reload screen and is reported to Error Logs */}
                  <ErrorBoundary>{children}</ErrorBoundary>
                </main>
              </div>
            </ToastProvider>
          </NotificationProvider>
        </InstructorThemeProvider>
      </InstructorProfileProvider>
    </RealtimeProvider>
  );
}
