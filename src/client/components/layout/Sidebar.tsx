'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from 'framer-motion';
import {
  ChevronDown, Home, Settings, CalendarDays, DoorOpen, Shield,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  getNavSections,
  isChildPathActive,
  isItemActive,
  isPathActive,
  isSectionActive,
  PRIORITY_PREFETCH,
  type NavItem,
  type NavSection,
} from '@/client/components/layout/adminNav';
import {
  dropdownItemVariants,
  dropdownVariants,
  instantTransition,
  NAV_DURATION,
  NAV_EASE,
  navItemHover,
  navItemTap,
} from '@/client/components/layout/navMotion';

interface SidebarProps {
  onNavigate?: () => void;
}

const SECTION_ICON: Record<string, LucideIcon> = {
  main: Home,
  setup: Settings,
  scheduling: CalendarDays,
  rooms: DoorOpen,
  system: Shield,
  account: Settings,
};

const navItemBase =
  'group relative inline-flex items-center gap-2 h-10 px-3.5 text-[15px] font-medium rounded-md cursor-pointer';
/* Dark keeps Tailwind hover (brand-blue text). Light overrides via .qr-nav-chrome-idle in globals.css */
const navIdle = 'qr-nav-chrome-idle text-white/90';
const navActive = 'qr-nav-chrome-chip text-[#3074B8]';

function NavLink({
  href,
  label,
  active,
  onNavigate,
  onPrefetch,
  className = '',
  reduceMotion,
}: {
  href: string;
  label: string;
  active: boolean;
  onNavigate?: () => void;
  onPrefetch: (href: string) => void;
  className?: string;
  reduceMotion: boolean;
}) {
  return (
    <motion.div
      variants={reduceMotion ? undefined : dropdownItemVariants}
      whileHover={reduceMotion ? undefined : { x: 2 }}
      transition={{ duration: NAV_DURATION, ease: NAV_EASE }}
    >
      <Link
        href={href}
        onClick={() => onNavigate?.()}
        onMouseEnter={() => onPrefetch(href)}
        onFocus={() => onPrefetch(href)}
        className={[
          'block text-[14px] leading-6 min-h-10 px-3 py-2 rounded-md transition-colors duration-150 cursor-pointer',
          active ? 'text-[#2563EB] font-medium bg-[#E8F1FB]' : 'text-[#475569] hover:text-[#3C91E6] hover:bg-[#F8FAFC]',
          className,
        ].join(' ')}
      >
        {label}
      </Link>
    </motion.div>
  );
}

function ActiveIndicators({
  active,
  reduceMotion,
}: {
  active: boolean;
  reduceMotion: boolean;
}) {
  if (!active) return null;
  const transition = reduceMotion
    ? instantTransition
    : { type: 'spring' as const, stiffness: 420, damping: 32, mass: 0.6 };

  return (
    <>
      <motion.span
        layoutId="admin-nav-pill"
        className="absolute inset-y-0 left-1.5 right-1.5 my-auto h-10 rounded-md bg-white shadow-[0_0_18px_rgba(60,145,230,0.28)] pointer-events-none"
        transition={transition}
        aria-hidden
      />
      <motion.span
        layoutId="admin-nav-underline"
        className="absolute bottom-0 left-2 right-2 h-0.5 bg-white origin-left pointer-events-none"
        initial={reduceMotion ? false : { scaleX: 0 }}
        animate={{ scaleX: 1 }}
        transition={reduceMotion ? instantTransition : { duration: NAV_DURATION, ease: NAV_EASE }}
        aria-hidden
      />
    </>
  );
}

function DesktopNavChip({
  active,
  open,
  children,
  reduceMotion,
}: {
  active: boolean;
  open?: boolean;
  children: ReactNode;
  reduceMotion: boolean;
}) {
  const lit = active || !!open;
  return (
    <motion.span
      className={[
        navItemBase,
        lit ? navActive : navIdle,
        lit && !active ? 'bg-white' : '',
        'z-[1]',
      ].join(' ')}
      whileHover={
        reduceMotion || lit
          ? undefined
          : {
              ...navItemHover,
              backgroundColor: 'rgba(255,255,255,0.16)',
              boxShadow: '0 0 18px rgba(60,145,230,0.35)',
            }
      }
      whileTap={reduceMotion || lit ? undefined : navItemTap}
      animate={
        reduceMotion
          ? undefined
          : lit
            ? { scale: 1.02 }
            : { scale: 1 }
      }
      transition={{ duration: NAV_DURATION, ease: NAV_EASE }}
    >
      {children}
    </motion.span>
  );
}

function DesktopMenu({
  section,
  pathname,
  onNavigate,
  onPrefetch,
  reduceMotion,
}: {
  section: NavSection;
  pathname: string;
  onNavigate?: () => void;
  onPrefetch: (href: string) => void;
  reduceMotion: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sectionActive = isSectionActive(pathname, section);

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

  const Icon = SECTION_ICON[section.id] ?? Settings;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="relative inline-flex items-center h-[72px] px-1.5 cursor-pointer"
      >
        <ActiveIndicators active={sectionActive} reduceMotion={!!reduceMotion} />
        <DesktopNavChip active={sectionActive} open={open} reduceMotion={!!reduceMotion}>
          <Icon
            className={`w-5 h-5 flex-shrink-0 transition-opacity duration-200 ${
              sectionActive || open ? 'opacity-100' : 'opacity-90 group-hover:opacity-100'
            }`}
          />
          {section.label}
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={reduceMotion ? instantTransition : { duration: NAV_DURATION, ease: NAV_EASE }}
            className="inline-flex"
          >
            <ChevronDown
              className={`qr-nav-chrome-chevron w-3.5 h-3.5 ${
                sectionActive || open ? 'text-[#3074B8]' : 'text-white/70 group-hover:text-[#3C91E6]'
              }`}
            />
          </motion.span>
        </DesktopNavChip>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="qr-nav-menu absolute left-0 top-full z-50 mt-0 min-w-[220px] bg-white border border-[#E5E7EB] rounded-md py-1 shadow-[0_4px_12px_rgba(0,0,0,0.08)] origin-top"
            role="menu"
            variants={reduceMotion ? undefined : dropdownVariants}
            initial={reduceMotion ? false : 'hidden'}
            animate="visible"
            exit={reduceMotion ? undefined : 'exit'}
          >
            {section.items.map(item => (
              <DesktopMenuItem
                key={item.href}
                item={item}
                pathname={pathname}
                onNavigate={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
                onPrefetch={onPrefetch}
                reduceMotion={!!reduceMotion}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DesktopMenuItem({
  item,
  pathname,
  onNavigate,
  onPrefetch,
  reduceMotion,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
  onPrefetch: (href: string) => void;
  reduceMotion: boolean;
}) {
  if (item.children?.length) {
    return (
      <div className="py-1">
        <p className="px-3 pt-1 pb-0.5 text-xs font-medium uppercase tracking-wide text-[#A1A1AA]">
          {item.label}
        </p>
        {item.children.map(child => (
          <NavLink
            key={child.href}
            href={child.href}
            label={child.label}
            active={isChildPathActive(pathname, child)}
            onNavigate={onNavigate}
            onPrefetch={onPrefetch}
            reduceMotion={reduceMotion}
          />
        ))}
      </div>
    );
  }

  return (
    <NavLink
      href={item.href}
      label={item.label}
      active={isItemActive(pathname, item)}
      onNavigate={onNavigate}
      onPrefetch={onPrefetch}
      reduceMotion={reduceMotion}
    />
  );
}

function MobileSection({
  section,
  pathname,
  onNavigate,
  onPrefetch,
}: {
  section: NavSection;
  pathname: string;
  onNavigate?: () => void;
  onPrefetch: (href: string) => void;
}) {
  const [open, setOpen] = useState(isSectionActive(pathname, section));

  if (section.id === 'main' && section.items.length === 1) {
    const item = section.items[0];
    return (
      <Link
        href={item.href}
        onClick={() => onNavigate?.()}
        onMouseEnter={() => onPrefetch(item.href)}
        className={[
          'flex items-center gap-2 min-h-11 px-4 text-[14px] transition-colors duration-150 cursor-pointer',
          isPathActive(pathname, item.href)
            ? 'text-[#2563EB] font-medium bg-[#E8F1FB]'
            : 'text-[#475569] hover:text-[#3C91E6] hover:bg-[#F8FAFC]',
        ].join(' ')}
      >
        <Home className="w-4 h-4" />
        {item.label}
      </Link>
    );
  }

  const SectionIcon = SECTION_ICON[section.id] ?? Settings;

  return (
    <div className="border-t border-[#E4E4E7]">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="flex items-center justify-between w-full min-h-11 px-4 text-[14px] font-medium text-[#475569] hover:text-[#3C91E6] transition-colors duration-150 cursor-pointer"
      >
        <span className="inline-flex items-center gap-2">
          <SectionIcon className="w-4 h-4" />
          {section.label}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="pb-2">
          {section.items.map(item => {
            if (item.children?.length) {
              return (
                <div key={item.href}>
                  <p className="px-4 pt-2 pb-1 text-xs font-medium uppercase tracking-wide text-[#A1A1AA]">
                    {item.label}
                  </p>
                  {item.children.map(child => (
                    <Link
                      key={child.href}
                      href={child.href}
                      onClick={() => onNavigate?.()}
                      className={[
                        'flex items-center min-h-11 px-6 text-[14px] transition-colors duration-150 cursor-pointer',
                        isChildPathActive(pathname, child)
                          ? 'text-[#18181B] font-medium bg-[#F4F4F5]'
                          : 'text-[#3F3F46] hover:text-[#3C91E6] hover:bg-[#F8FAFC]',
                      ].join(' ')}
                    >
                      {child.label}
                    </Link>
                  ))}
                </div>
              );
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => onNavigate?.()}
                onMouseEnter={() => onPrefetch(item.href)}
                className={[
                  'flex items-center min-h-11 px-6 text-[15px] transition-colors duration-150 cursor-pointer',
                  isItemActive(pathname, item)
                    ? 'text-[#18181B] font-medium bg-[#F4F4F5]'
                    : 'text-[#3F3F46] hover:text-[#3C91E6] hover:bg-[#F8FAFC]',
                ].join(' ')}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [userRole, setUserRole] = useState('admin');

  useEffect(() => {
    const theme = localStorage.getItem('admin-theme');
    if (!theme) {
      localStorage.setItem('admin-theme', 'light');
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.toggle('light', theme !== 'dark');
    }

    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data?.user) setUserRole(data.user.role ?? 'admin');
      })
      .catch(() => {});
  }, []);

  function prefetchIfPriority(href: string) {
    if (PRIORITY_PREFETCH.has(href)) router.prefetch(href);
  }

  const navSections = getNavSections(userRole);
  const mainSection = navSections.find(s => s.id === 'main');
  const menuSections = navSections.filter(s => s.id !== 'main');

  return (
    <>
      <LayoutGroup id="admin-top-nav">
        <nav className="hidden lg:flex items-stretch min-w-0 gap-2" aria-label="Main">
          {mainSection?.items[0] && (
            <Link
              href={mainSection.items[0].href}
              onClick={() => onNavigate?.()}
              onMouseEnter={() => prefetchIfPriority(mainSection.items[0].href)}
              className="relative inline-flex items-center h-[72px] px-1.5 cursor-pointer"
            >
              <ActiveIndicators
                active={isPathActive(pathname, mainSection.items[0].href)}
                reduceMotion={!!reduceMotion}
              />
              <DesktopNavChip
                active={isPathActive(pathname, mainSection.items[0].href)}
                reduceMotion={!!reduceMotion}
              >
                <Home className="w-5 h-5 flex-shrink-0" />
                {mainSection.items[0].label}
              </DesktopNavChip>
            </Link>
          )}
          {menuSections.map(section => {
            const only = section.items[0];
            const Icon = SECTION_ICON[section.id] ?? Settings;
            if (section.items.length === 1 && only && !only.children?.length) {
              const active = isPathActive(pathname, only.href);
              return (
                <Link
                  key={section.id}
                  href={only.href}
                  onClick={() => onNavigate?.()}
                  onMouseEnter={() => prefetchIfPriority(only.href)}
                  className="relative inline-flex items-center h-[72px] px-1.5 cursor-pointer"
                >
                  <ActiveIndicators active={active} reduceMotion={!!reduceMotion} />
                  <DesktopNavChip active={active} reduceMotion={!!reduceMotion}>
                    <Icon className="w-5 h-5 flex-shrink-0" />
                    {only.label}
                  </DesktopNavChip>
                </Link>
              );
            }
            return (
              <DesktopMenu
                key={section.id}
                section={section}
                pathname={pathname}
                onNavigate={onNavigate}
                onPrefetch={prefetchIfPriority}
                reduceMotion={!!reduceMotion}
              />
            );
          })}
        </nav>
      </LayoutGroup>
    </>
  );
}

export function AdminMobileNav({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [userRole, setUserRole] = useState('admin');

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data?.user) setUserRole(data.user.role ?? 'admin');
      })
      .catch(() => {});
  }, []);

  function prefetchIfPriority(href: string) {
    if (PRIORITY_PREFETCH.has(href)) router.prefetch(href);
  }

  const navSections = getNavSections(userRole);

  return (
    <nav className="qr-nav-menu lg:hidden border-t border-[#E4E4E7] bg-white max-h-[min(70vh,calc(100dvh-3.5rem))] overflow-y-auto overscroll-contain" aria-label="Mobile" data-modal-root>
      {navSections.map(section => (
        <MobileSection
          key={section.id}
          section={section}
          pathname={pathname}
          onNavigate={onNavigate}
          onPrefetch={prefetchIfPriority}
        />
      ))}
    </nav>
  );
}

export function adminHomeHref(role: string): string {
  return role === 'department_chair' ? '/dept-chair' : '/dashboard';
}
