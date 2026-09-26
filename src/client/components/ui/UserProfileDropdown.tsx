'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from 'framer-motion';
import {
  User, KeyRound, LogOut, ChevronDown, X,
  ShieldCheck, UserCog,
} from 'lucide-react';
import InstructorAvatar from '@/client/components/ui/InstructorAvatar';
import {
  dropdownVariants,
  NAV_DURATION,
  NAV_EASE,
} from '@/client/components/layout/navMotion';

/* ── Types ───────────────────────────────────────────────────────────────── */
interface UserData {
  id: number;
  username?: string;
  name?: string;
  email?: string;
  role: string;
  profile_picture?: string | null;
}

interface MenuItem {
  icon: React.ElementType;
  label: string;
  href?: string;
  action?: 'logout' | 'logout-forget';
  danger?: boolean;
  divider?: boolean;
}

type Theme = 'light' | 'dark' | 'brand';

interface Props {
  theme?: Theme;
  /** Show username only (no role line), matching the compact admin header. */
  compact?: boolean;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function getDisplayName(user: UserData): string {
  if (user.name && user.name.trim()) return user.name.trim();
  if (user.username && user.username.trim()) return user.username.trim();
  return 'User';
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function getRoleLabel(role: string): string {
  switch (role) {
    case 'admin':            return 'Administrator';
    case 'program_chair': return 'Department Chair';
    case 'instructor':       return 'Instructor';
    default:                 return role;
  }
}

const AVATAR_BG: Record<string, string> = {
  admin:            'bg-[#1D5BD6]',
  program_chair: 'bg-[#6366F1]',
  instructor:       'bg-[#10B981]',
};
const AVATAR_RING: Record<string, string> = {
  admin:            'ring-[#1D5BD6]/40',
  program_chair: 'ring-[#6366F1]/40',
  instructor:       'ring-[#10B981]/40',
};

function menuItems(role: string): MenuItem[] {
  const base: MenuItem[] = [];

  if (role === 'admin') {
    base.push(
      { icon: User,       label: 'My Profile',      href: '/settings'  },
      { icon: KeyRound,   label: 'Change Password',  href: '/settings'  },
      { icon: ShieldCheck,label: 'Account Settings', href: '/settings', divider: true },
    );
  } else if (role === 'program_chair') {
    base.push(
      { icon: User,       label: 'My Profile',      href: '/dept-chair/account' },
      { icon: KeyRound,   label: 'Change Password',  href: '/dept-chair/account', divider: true },
    );
  } else if (role === 'instructor') {
    base.push(
      { icon: User,       label: 'My Profile',      href: '/instructor/profile' },
      { icon: UserCog,    label: 'Edit Profile',     href: '/instructor/profile', divider: true },
    );
  }

  base.push({ icon: LogOut, label: 'Log Out', action: 'logout', danger: true });
  base.push({ icon: LogOut, label: 'Log Out and Forget This Device', action: 'logout-forget', danger: true });
  return base;
}

/* ── Avatar ──────────────────────────────────────────────────────────────── */
function Avatar({ user, size = 36, ring = true }: { user: UserData; size?: number; ring?: boolean }) {
  const name    = getDisplayName(user);
  const initials = getInitials(name);
  const bgCls   = AVATAR_BG[user.role] ?? 'bg-slate-500';
  const ringCls = ring ? `ring-2 ${AVATAR_RING[user.role] ?? 'ring-slate-500/40'}` : '';
  const px      = `${size}px`;

  if (user.role === 'instructor') {
    return (
      <InstructorAvatar
        src={user.profile_picture ?? null}
        name={name}
        size={size}
        className={`ring-2 ${AVATAR_RING[user.role] ?? 'ring-slate-500/40'}`}
      />
    );
  }

  if (user.profile_picture) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.profile_picture}
        alt={name}
        className={`flex-shrink-0 rounded-full ${ringCls} object-cover`}
        style={{ width: px, height: px }}
      />
    );
  }

  return (
    <div
      className={`flex-shrink-0 rounded-full ${ringCls} ${bgCls}
        flex items-center justify-center font-bold text-white select-none`}
      style={{ width: px, height: px, fontSize: size * 0.38 }}
    >
      {initials}
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────────────────── */
export default function UserProfileDropdown({ theme = 'light', compact = false }: Props) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [user,       setUser]       = useState<UserData | null>(null);
  const [open,       setOpen]       = useState(false);
  const [viewPhoto,  setViewPhoto]  = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [mounted,    setMounted]    = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  // Fetch current user
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.user) setUser(d.user); })
      .catch(() => {});
  }, []);

  // React to profile picture changes dispatched from any upload component
  useEffect(() => {
    function onPictureChanged(e: Event) {
      const { picUrl } = (e as CustomEvent<{ picUrl: string | null }>).detail ?? {};
      setUser(u => u ? { ...u, profile_picture: picUrl ?? null } : u);
    }
    window.addEventListener('profile-picture-changed', onPictureChanged);
    return () => window.removeEventListener('profile-picture-changed', onPictureChanged);
  }, []);

  // Close on outside click / Escape (photo viewer first)
  useEffect(() => {
    function onMouse(e: MouseEvent) {
      if (viewPhoto) return;
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (viewPhoto) { setViewPhoto(false); return; }
      setOpen(false);
    }
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('keydown', onKey);
    };
  }, [viewPhoto]);

  const handleLogout = useCallback(async (forgetDevice = false) => {
    setLoggingOut(true);
    setOpen(false);
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forgetDevice }),
    }).catch(() => {});
    router.push('/login');
  }, [router]);

  const handleMenuClick = useCallback(async (item: MenuItem) => {
    setOpen(false);
    if (item.action === 'logout') { await handleLogout(false); return; }
    if (item.action === 'logout-forget') { await handleLogout(true); return; }
    if (item.href) router.push(item.href);
  }, [router, handleLogout]);

  if (!user) {
    // Skeleton while loading
    return (
      <div className={`flex items-center ${theme === 'brand' ? 'gap-1.5 h-8 sm:h-9 px-1 sm:px-1.5' : 'gap-2.5 px-2 py-1'}`}>
        <div className={`rounded-full qr-skeleton ${theme === 'brand' ? 'w-7 h-7' : 'w-9 h-9'} ${theme === 'dark' ? 'opacity-40' : theme === 'brand' ? 'opacity-50' : ''}`} />
        <div className="hidden sm:flex flex-col gap-1">
          <div className={`rounded qr-skeleton ${theme === 'brand' ? 'w-14 h-2.5' : 'w-20 h-3'} ${theme === 'dark' ? 'opacity-40' : theme === 'brand' ? 'opacity-50' : ''}`} />
          {theme !== 'brand' && (
            <div className={`w-14 h-2.5 rounded qr-skeleton ${theme === 'dark' ? 'opacity-40' : ''}`} />
          )}
        </div>
      </div>
    );
  }

  const displayName  = getDisplayName(user);
  const roleLabel    = getRoleLabel(user.role);
  const items        = menuItems(user.role);

  /* ── Trigger styling per theme ── */
  const triggerBase = theme === 'brand'
    ? `flex items-center gap-2 h-10 pl-1 pr-2.5 sm:pr-3 rounded-full cursor-pointer
    select-none outline-none transition-colors duration-150
    focus-visible:ring-2 focus-visible:ring-white/80`
    : `flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl cursor-pointer
    select-none outline-none transition-colors duration-150`;
  const triggerTheme =
    theme === 'brand'
      ? open
        ? 'bg-white text-[#0B2A5B] shadow-sm'
        : 'bg-white/25 ring-1 ring-inset ring-white/45 text-white hover:bg-white/40'
      : theme === 'dark'
        ? `${open ? 'bg-white/20' : 'hover:bg-white/10'}`
        : `${open ? 'bg-[#EFF6FF]' : 'hover:bg-[#F1F5F9]'}`;

  const nameClass =
    theme === 'brand'
      ? (open ? 'text-[#0B2A5B]' : 'text-white')
      : theme === 'light'
        ? 'text-[#0B2A5B]'
        : 'text-white';
  const roleClass  = theme === 'dark' ? 'text-slate-400'  : theme === 'brand' ? (open ? 'text-[#64748B]' : 'text-white/85') : 'text-[#64748B]';
  const chevronCls =
    theme === 'brand'
      ? (open ? 'text-[#64748B]' : 'text-white')
      : theme === 'light'
        ? 'text-slate-400'
        : 'text-white/75';

  return (
    <div ref={containerRef} className="relative">
      {/* Full chip is the click target — avatar + name + chevron */}
      <motion.button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`${triggerBase} ${triggerTheme}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Account menu for ${displayName}`}
        disabled={loggingOut}
        whileHover={reduceMotion ? undefined : { scale: 1.02 }}
        whileTap={reduceMotion ? undefined : { scale: 0.98 }}
        transition={{ duration: NAV_DURATION, ease: NAV_EASE }}
      >
        <span
          className={`relative inline-flex rounded-full flex-shrink-0 ring-2 ${
            theme === 'brand'
              ? open
                ? 'ring-[#BFDBFE]'
                : 'ring-white'
              : 'ring-transparent'
          }`}
        >
          <Avatar user={user} size={theme === 'brand' ? 32 : 34} ring={false} />
        </span>

        <div className="hidden sm:flex flex-col items-start leading-none min-w-0">
          <span className={`font-semibold truncate text-[13px] sm:text-[14px] max-w-[100px] sm:max-w-[132px] ${nameClass}`}>
            {displayName}
          </span>
          {!compact && (
            <span className={`text-[11px] mt-0.5 truncate max-w-[120px] ${roleClass}`}>
              {roleLabel}
            </span>
          )}
        </div>
        <ChevronDown
          className={`w-4 h-4 flex-shrink-0 transition-transform duration-150 ${chevronCls} ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </motion.button>

      {/* Instagram-style account card */}
      <AnimatePresence>
        {open && (
          <motion.div
            className="qr-nav-menu absolute right-0 top-[calc(100%+8px)] w-[17.5rem] max-w-[calc(100vw-1.5rem)] z-50
              bg-white border border-[#E5E7EB] rounded-2xl shadow-[0_12px_40px_rgba(15,23,42,0.16)] origin-top-right overflow-hidden"
            role="menu"
            aria-label="User menu"
            variants={reduceMotion ? undefined : {
              ...dropdownVariants,
              hidden: { ...dropdownVariants.hidden, scale: 0.96, y: -4 },
            }}
            initial={reduceMotion ? false : 'hidden'}
            animate="visible"
            exit={reduceMotion ? undefined : 'exit'}
          >
            {/* Centered profile header */}
            <div className="px-5 pt-5 pb-4 text-center border-b border-[#F1F5F9]">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setViewPhoto(true);
                }}
                className="mx-auto mb-3 inline-flex rounded-full ring-2 ring-[#E2E8F0] ring-offset-2 ring-offset-white
                  cursor-pointer transition-transform duration-150 hover:scale-105 focus-visible:outline-none
                  focus-visible:ring-2 focus-visible:ring-[#1D5BD6] focus-visible:ring-offset-2"
                aria-label={`View ${displayName}'s profile picture`}
              >
                <Avatar user={user} size={64} ring={false} />
              </button>
              <p className="text-[15px] font-bold text-[#0F172A] truncate">{displayName}</p>
              {user.email && (
                <p className="text-[12px] text-[#64748B] truncate mt-0.5 px-2">{user.email}</p>
              )}
              <span className={`inline-flex items-center gap-1 mt-2.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide
                ${user.role === 'admin'            ? 'bg-[#DBEAFE] text-[#164BB5]' :
                  user.role === 'program_chair' ? 'bg-[#EDE9FE] text-[#7C3AED]' :
                                                     'bg-[#D1FAE5] text-[#059669]'}`}>
                {roleLabel}
              </span>
            </div>

            {/* Menu items */}
            <div className="py-1.5 pb-2">
              {items.map((item, i) => {
                const Icon = item.icon;
                return (
                  <React.Fragment key={i}>
                    {item.divider && <div className="my-1.5 mx-3 border-t border-[#F1F5F9]" />}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => handleMenuClick(item)}
                      disabled={loggingOut && (item.action === 'logout' || item.action === 'logout-forget')}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium
                        text-left transition-colors duration-150
                        ${item.danger
                          ? 'text-red-500 hover:bg-red-50'
                          : 'text-[#334155] hover:bg-[#F8FAFC]'
                        }
                        disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      <Icon className={`w-4 h-4 flex-shrink-0 ${item.danger ? 'text-red-400' : 'text-[#94A3B8]'}`} />
                      {item.danger && loggingOut ? 'Signing out…' : item.label}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full-screen profile picture viewer */}
      {mounted && createPortal(
        <AnimatePresence>
          {viewPhoto && (
            <motion.div
              className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/70"
              role="dialog"
              aria-modal="true"
              aria-label={`${displayName}'s profile picture`}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setViewPhoto(false)}
            >
              <button
                type="button"
                onClick={() => setViewPhoto(false)}
                className="absolute top-4 right-4 inline-flex items-center justify-center w-10 h-10 rounded-full
                  bg-white/15 text-white hover:bg-white/25 transition-colors"
                aria-label="Close profile picture"
              >
                <X className="w-5 h-5" />
              </button>
              <motion.div
                className="relative"
                initial={reduceMotion ? false : { scale: 0.92, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={reduceMotion ? undefined : { scale: 0.96, opacity: 0 }}
                transition={{ duration: 0.2, ease: NAV_EASE }}
                onClick={(e) => e.stopPropagation()}
              >
                {user.profile_picture ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.profile_picture}
                    alt={displayName}
                    className="max-w-[min(88vw,420px)] max-h-[min(80vh,420px)] w-auto h-auto rounded-full
                      object-cover shadow-2xl ring-4 ring-white/90"
                  />
                ) : (
                  <Avatar user={user} size={280} ring={false} />
                )}
                <p className="mt-4 text-center text-white text-sm font-medium drop-shadow">{displayName}</p>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
