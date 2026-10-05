'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronDown, LayoutDashboard, CalendarDays, DoorOpen, Settings,
} from 'lucide-react';
import { DrawerLink, DrawerSection, MobileNavDrawer } from '@/components/layout/MobileNavDrawer';
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

/* ── Phone / tablet: slide-in sidebar (shared with the Admin shell) ──────────── */

function FacultyMenu({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const requestsCount = useRequestsBadge(); // polls only while the sidebar is open
  const navSections = getInstructorNavSections(requestsCount);
  let row = 0;
  return (
    <>
      {navSections.map(section => (
        <DrawerSection key={section.id} label={section.label}>
          {section.items.map(item => (
            <DrawerLink
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={isInstructorPathActive(pathname, item.href)}
              badge={item.badge}
              index={row++}
              onClick={onClose}
            />
          ))}
        </DrawerSection>
      ))}
    </>
  );
}

/**
 * Mobile navigation — a sidebar that slides in from the left over a dimmed
 * backdrop. Tap the backdrop, the X, a link, or press Esc to close.
 */
export function InstructorMobileNav({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { name } = useInstructorProfile();
  return (
    <MobileNavDrawer open={open} onClose={onClose} subtitle="Faculty" signedInAs={name}>
      <FacultyMenu onClose={onClose} />
    </MobileNavDrawer>
  );
}
