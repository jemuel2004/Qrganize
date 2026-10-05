'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from 'framer-motion';
import { ArrowRight, Bell, CalendarClock, CheckCheck, ChevronDown, ClipboardList, DoorOpen, RefreshCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useNotifications, AppNotification, type NotificationRole } from '@/context/NotificationContext';
import {
  NOTIFICATION_TABS,
  emptyFilterMessage,
  groupNotifications,
  matchesNotificationFilter,
  notificationAction,
  notificationCategory,
  notificationPriority,
  type NotificationCategory,
  type NotificationFilter,
  type NotificationPriority,
} from '@/lib/notificationMeta';
import {
  dropdownVariants,
  NAV_DURATION,
  NAV_EASE,
  notificationListVariants,
  notificationRowVariants,
} from '@/components/layout/navMotion';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Yesterday';
  return `${d} days ago`;
}

/** Priority colours (icon tile + group count): red = needs attention, amber = pending, blue = recent */
const PRIORITY_TONE: Record<NotificationPriority, { bg: string; fg: string }> = {
  high: { bg: '#FEF2F2', fg: '#DC2626' },
  medium: { bg: '#FFFBEB', fg: '#D97706' },
  low: { bg: '#EFF6FF', fg: '#1D5BD6' },
};
const CATEGORY_ICON: Record<NotificationCategory, LucideIcon> = {
  workload: ClipboardList,
  schedule: CalendarClock,
  room: DoorOpen,
};
/** Rows shown per group before "Show all" */
const GROUP_PREVIEW = 3;

function SkeletonRow() {
  return (
    <div className="flex items-start gap-3 px-3 py-3">
      <div className="qr-skeleton w-10 h-10 rounded-xl flex-shrink-0" />
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="qr-skeleton h-3.5 rounded w-full mb-2" />
        <div className="qr-skeleton h-3.5 rounded w-2/3 mb-2.5" />
        <div className="qr-skeleton h-3 rounded w-1/3" />
      </div>
    </div>
  );
}

function NotificationRow({
  n, role, onOpen, reduceMotion, showTitle,
}: {
  n: AppNotification; role: NotificationRole; onOpen: (n: AppNotification) => void; reduceMotion: boolean;
  /** Off inside a single-kind group — the group heading already names it */
  showTitle: boolean;
}) {
  const action = notificationAction(n, role);
  const tone = PRIORITY_TONE[notificationPriority(n)];
  const Icon = CATEGORY_ICON[notificationCategory(n)];
  return (
    <motion.button
      type="button"
      onClick={() => onOpen(n)}
      variants={reduceMotion ? undefined : notificationRowVariants}
      transition={{ duration: NAV_DURATION, ease: NAV_EASE }}
      className="group w-full text-left flex items-start gap-3 px-3 py-3 rounded-xl transition-colors hover:bg-[#F8FAFC] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#164BB5]/30"
    >
      <span aria-hidden className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: tone.bg, color: tone.fg }}>
        <Icon className="w-5 h-5" />
      </span>
      <span className="flex-1 min-w-0 block">
        {showTitle && (
          <span className={`block text-[14px] leading-snug break-words ${n.is_read ? 'font-semibold text-[#334155]' : 'font-bold text-[#0F172A]'}`}>
            {n.title}
          </span>
        )}
        <span className={`block text-[14px] leading-snug break-words ${
          showTitle ? 'text-[#475569] mt-0.5' : n.is_read ? 'text-[#475569]' : 'font-semibold text-[#0F172A]'
        }`}>
          {n.message}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
          <span className="text-[#64748B]">{relativeTime(n.created_at)}</span>
          {action && (
            <>
              <span aria-hidden className="text-[#CBD5E1]">•</span>
              <span className="inline-flex items-center gap-1 font-semibold text-[#1D5BD6]">
                {action.label} <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
            </>
          )}
        </span>
      </span>
      {!n.is_read && (
        <span aria-label="Unread" className="flex-shrink-0 w-2.5 h-2.5 rounded-full bg-[#1D5BD6] mt-1.5" />
      )}
    </motion.button>
  );
}

interface NotificationBellProps {
  /** light = page chrome; dark = instructor bar; brand = blue admin header. */
  theme?: 'light' | 'dark' | 'brand';
}

export default function NotificationBell({ theme = 'light' }: NotificationBellProps) {
  const {
    notifications, unreadCount, loading,
    markRead, markAllRead, refresh,
    isInitialLoad, role,
  } = useNotifications();
  const router = useRouter();
  const reduceMotion = useReducedMotion();

  const [open, setOpen] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [ripple, setRipple] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleMouse(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleMouse);
    return () => document.removeEventListener('mousedown', handleMouse);
  }, []);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  /* One group per kind (room requests, block schedules, workloads...), most urgent first */
  const sections = useMemo(
    () => groupNotifications(notifications.filter(n => matchesNotificationFilter(n, filter))),
    [notifications, filter],
  );

  const tabCounts = useMemo(() => {
    const counts: Record<NotificationFilter, number> = { all: notifications.length, unread: 0, workload: 0, schedule: 0, room: 0 };
    for (const n of notifications) {
      if (!n.is_read) counts.unread += 1;
      counts[notificationCategory(n)] += 1;
    }
    return counts;
  }, [notifications]);
  // Area tabs only when they have something (All / Unread always shown)
  const tabs = NOTIFICATION_TABS.filter(t => t.id === 'all' || t.id === 'unread' || tabCounts[t.id] > 0);

  const badge = unreadCount > 99 ? '99+' : unreadCount > 0 ? String(unreadCount) : null;

  const bellCls =
    theme === 'brand'
      ? open
        ? 'text-[#12408F] bg-white shadow-sm'
        : 'text-white bg-white/25 ring-1 ring-inset ring-white/40 hover:bg-white/35'
      : theme === 'dark'
        ? open
          ? 'text-white bg-white/15'
          : 'text-white hover:bg-white/10'
        : open
          ? 'text-[#164BB5] bg-[#EFF6FF]'
          : 'text-[#64748B] hover:bg-[#F1F5F9]';

  const badgeRing =
    theme === 'brand' ? 'ring-white'
    : theme === 'dark' ? 'ring-[#111827]'
    : 'ring-white';

  /** Where we're heading after a notification click — drives the loading card */
  const [goingTo, setGoingTo] = useState<{ href: string; label: string } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Hide the loading card once the target page is showing (or after 10 s)
  useEffect(() => {
    if (!goingTo) return;
    const target = new URL(goingTo.href, window.location.origin);
    const started = Date.now();
    const id = window.setInterval(() => {
      const here = window.location.pathname + window.location.search;
      if (here === target.pathname + target.search || Date.now() - started > 10_000) {
        window.setTimeout(() => setGoingTo(null), 350); // let the new page paint first
        window.clearInterval(id);
      }
    }, 120);
    return () => window.clearInterval(id);
  }, [goingTo]);

  function openNotification(n: AppNotification) {
    if (!n.is_read) markRead(n.id);
    const action = notificationAction(n, role);
    setOpen(false);
    if (!action) return;
    const here = window.location.pathname + window.location.search;
    if (here === action.href) return; // already there
    setGoingTo({ href: action.href, label: action.label });
    router.push(action.href);
  }

  function handleBellClick() {
    if (!reduceMotion) {
      setRinging(true);
      setRipple(true);
      window.setTimeout(() => setRinging(false), 450);
      window.setTimeout(() => setRipple(false), 500);
    }
    setOpen(o => !o);
  }

  return (
    <div ref={ref} className="relative inline-flex items-center">
      {/* Unread: glowing ring that breathes around the bell */}
      {badge && !reduceMotion && !open && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-full"
          animate={{ boxShadow: ['0 0 0 0 rgba(228,30,63,0.55)', '0 0 0 9px rgba(228,30,63,0)', '0 0 0 0 rgba(228,30,63,0)'] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      <motion.button
        type="button"
        onClick={handleBellClick}
        aria-label={`Notifications${badge ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        whileHover={reduceMotion ? undefined : { scale: 1.03 }}
        whileTap={reduceMotion ? undefined : { scale: 0.97 }}
        animate={
          reduceMotion
            ? undefined
            : ringing
              ? { rotate: [0, -10, 8, -5, 3, 0] }
              : badge && !open
                // gentle ring every few seconds while there is something unread
                ? { rotate: [0, -12, 10, -7, 4, 0, 0, 0, 0, 0] }
                : { rotate: 0 }
        }
        transition={
          ringing
            ? { duration: 0.4, ease: NAV_EASE }
            : badge && !open
              ? { duration: 2.6, repeat: Infinity, ease: 'easeInOut' }
              : { duration: NAV_DURATION, ease: NAV_EASE }
        }
        className={`relative inline-flex items-center justify-center rounded-full transition-colors duration-150 cursor-pointer ${
          theme === 'brand'
            ? 'h-10 w-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80'
            : 'h-10 w-10'
        } ${bellCls}`}
      >
        <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-full" aria-hidden>
          <AnimatePresence>
            {ripple && !reduceMotion && (
              <motion.span
                className="absolute inset-0 rounded-full bg-white/35"
                initial={{ scale: 0.45, opacity: 0.5 }}
                animate={{ scale: 1.35, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: NAV_EASE }}
              />
            )}
          </AnimatePresence>
        </span>
        <Bell
          className={`${theme === 'brand' ? 'w-5 h-5' : 'w-[22px] h-[22px]'} relative z-[1]`}
          strokeWidth={theme === 'brand' ? 2 : 1.75}
          fill="none"
        />
        {badge && (
          <motion.span
            key={badge}
            initial={reduceMotion ? false : { scale: 0.4 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 18 }}
            className={`absolute -top-0.5 -right-0.5 z-[2] min-w-[18px] h-[18px] px-[5px] rounded-full
              bg-[#E41E3F] text-white text-[10px] font-bold tabular-nums leading-none
              flex items-center justify-center ring-2 ${badgeRing} shadow-sm`}
          >
            {badge}
          </motion.span>
        )}
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Notifications panel"
            className="qr-nav-menu fixed z-[60] left-3 right-3 top-14 max-h-[min(74vh,36rem)]
              md:absolute md:left-auto md:right-0 md:top-12 md:w-[32rem] md:max-w-[calc(100vw-1.5rem)]
              bg-white border border-[#E2E8F0] rounded-2xl overflow-hidden flex flex-col origin-top-right
              shadow-[0_20px_48px_-12px_rgba(11,42,91,0.28)]"
            variants={reduceMotion ? undefined : dropdownVariants}
            initial={reduceMotion ? false : 'hidden'}
            animate="visible"
            exit={reduceMotion ? undefined : 'exit'}
          >
            {/* Title · unread count · refresh · mark all read */}
            <div className="flex items-center justify-between gap-2 pl-4 pr-2 pt-3 pb-2 flex-shrink-0 bg-white min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h3 className="text-[17px] font-bold text-[#0B2A5B] whitespace-nowrap">
                  Notifications
                </h3>
                {unreadCount > 0 && (
                  <span className="hidden min-[400px]:inline-flex items-center flex-shrink-0 h-6 px-2.5 rounded-full bg-[#EFF6FF] text-[#1D5BD6] text-[12px] font-bold tabular-nums">
                    {unreadCount} unread
                  </span>
                )}
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <button
                  type="button"
                  onClick={refresh}
                  aria-label="Refresh notifications"
                  title="Refresh"
                  className="h-10 w-10 rounded-full text-[#64748B] hover:text-[#0B2A5B] hover:bg-[#F1F5F9] inline-flex items-center justify-center transition-colors"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    aria-label="Mark all notifications as read"
                    className="h-10 px-3 rounded-full inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] whitespace-nowrap transition-colors"
                  >
                    <CheckCheck className="w-4 h-4" aria-hidden />
                    Mark all as read
                  </button>
                )}
              </div>
            </div>

            {/* Filters — pills that wrap (no sideways scrolling); the navy pill slides to the one picked */}
            <div
              role="tablist"
              aria-label="Notification categories"
              className="flex-shrink-0 flex flex-wrap gap-1.5 px-4 pb-3 border-b border-[#EEF2F7] bg-white"
            >
              {tabs.map(tab => {
                const selected = filter === tab.id;
                const count = tabCounts[tab.id];
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setFilter(tab.id)}
                    className={`relative h-9 px-3 rounded-full inline-flex items-center gap-1.5 text-[13px] font-semibold whitespace-nowrap transition-colors ${
                      selected ? '' : 'bg-[#F1F5F9] text-[#334155] hover:bg-[#E2E8F0]'
                    }`}
                    style={selected ? { color: '#FFFFFF' } : undefined}
                  >
                    {selected && (
                      <motion.span
                        layoutId="notif-filter-pill"
                        aria-hidden
                        className="absolute inset-0 rounded-full"
                        style={{ backgroundColor: '#0B2A5B' }}
                        transition={{ duration: reduceMotion ? 0 : 0.28, ease: NAV_EASE }}
                      />
                    )}
                    <span className="relative">{tab.label}</span>
                    {tab.id !== 'all' && count > 0 && (
                      <span className="relative text-[12px] tabular-nums" style={{ color: selected ? 'rgba(255,255,255,0.75)' : '#64748B' }}>
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <motion.div
              className="overflow-y-auto overflow-x-hidden overscroll-contain flex-1 min-h-0 px-1.5 pb-1.5"
              role="tabpanel"
              variants={reduceMotion ? undefined : notificationListVariants}
              initial={reduceMotion ? false : 'hidden'}
              animate="visible"
            >
              {isInitialLoad ? (
                <div className="pt-2">
                  <SkeletonRow />
                  <SkeletonRow />
                  <SkeletonRow />
                </div>
              ) : sections.length === 0 ? (
                <div className="py-12 px-6 flex flex-col items-center text-center">
                  <span className="w-12 h-12 rounded-full bg-[#EFF6FF] flex items-center justify-center mb-3" aria-hidden>
                    <Bell className="w-6 h-6 text-[#1D5BD6]" />
                  </span>
                  <p className="text-[15px] font-semibold text-[#0F172A]">{emptyFilterMessage(filter)}</p>
                </div>
              ) : (
                sections.map((sec, si) => {
                  const showAll = !!expanded[sec.key];
                  const rows = showAll ? sec.items : sec.items.slice(0, GROUP_PREVIEW);
                  const tone = PRIORITY_TONE[sec.priority];
                  return (
                    <section key={sec.key} aria-label={sec.label} className={si > 0 ? 'border-t border-[#EEF2F7] mt-1' : ''}>
                      {/* Group heading stays in view while its rows scroll */}
                      <div className="sticky top-0 z-[1] flex items-center gap-2 px-3 pt-3 pb-1.5 bg-white">
                        <span className="text-[13px] font-bold text-[#0B2A5B]">{sec.label}</span>
                        <span
                          className="ml-auto min-w-6 h-6 px-2 rounded-full text-[12px] font-bold tabular-nums inline-flex items-center justify-center"
                          style={{ backgroundColor: tone.bg, color: tone.fg }}
                        >
                          {sec.items.length}
                        </span>
                      </div>
                      {rows.map(n => (
                        <NotificationRow key={n.id} n={n} role={role} onOpen={openNotification} reduceMotion={!!reduceMotion} showTitle={sec.key === 'recent'} />
                      ))}
                      {sec.items.length > GROUP_PREVIEW && (
                        <button
                          type="button"
                          onClick={() => setExpanded(e => ({ ...e, [sec.key]: !showAll }))}
                          className="ml-[3.25rem] mb-1 h-9 px-3 rounded-full inline-flex items-center gap-1 text-[13px] font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors"
                        >
                          {showAll ? 'Show less' : `Show all ${sec.items.length}`}
                          <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${showAll ? 'rotate-180' : ''}`} aria-hidden />
                        </button>
                      )}
                    </section>
                  );
                })
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {mounted && createPortal(
        <AnimatePresence>
          {goingTo && (
            <motion.div
              key="notif-redirect"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.2 } }}
              exit={{ opacity: 0, transition: { duration: 0.25 } }}
              className="fixed inset-x-0 bottom-0 top-[72px] z-[70] flex items-center justify-center"
              style={{ backgroundColor: 'rgba(11, 42, 91, 0.10)' }}
              role="status" aria-live="polite"
            >
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, scale: 0.94, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.3, ease: NAV_EASE } }}
                className="flex items-center gap-3 px-6 py-4 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl"
              >
                <span className="w-6 h-6 border-[3px] border-[#1D5BD6]/25 border-t-[#1D5BD6] rounded-full animate-spin" aria-hidden />
                <span className="text-[15px] font-semibold text-[#0B2A5B]">Opening {goingTo.label.replace(/^(View|Open|Review)\s+/i, '')}…</span>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
