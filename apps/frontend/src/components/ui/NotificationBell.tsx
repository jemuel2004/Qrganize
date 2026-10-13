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
import { useScrollLock } from '@/hooks/useScrollLock';
import { useHeaderDrop } from '@/components/ui/headerDrop';
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
  NAV_DURATION,
  NAV_EASE,
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

/**
 * Faculty list row, Facebook style: round icon, the title in bold over the
 * message, the time (blue while unread) and a blue dot. The whole row opens it.
 */
function FeedRow({
  n, onOpen, reduceMotion,
}: {
  n: AppNotification; onOpen: (n: AppNotification) => void; reduceMotion: boolean;
}) {
  const tone = PRIORITY_TONE[notificationPriority(n)];
  const Icon = CATEGORY_ICON[notificationCategory(n)];
  return (
    <motion.button
      type="button"
      onClick={() => onOpen(n)}
      variants={reduceMotion ? undefined : notificationRowVariants}
      transition={{ duration: NAV_DURATION, ease: NAV_EASE }}
      className="w-full text-left flex items-center gap-3 px-2.5 py-2.5 rounded-xl transition-colors hover:bg-[#F1F5F9] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#164BB5]/30"
    >
      <span aria-hidden className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: tone.bg, color: tone.fg }}>
        <Icon className="w-6 h-6" />
      </span>
      <span className="flex-1 min-w-0 block">
        <span className={`block text-[15px] font-bold leading-snug break-words ${n.is_read ? 'text-[#334155]' : 'text-[#0F172A]'}`}>{n.title}</span>
        <span className={`block text-[14px] leading-snug break-words mt-0.5 ${n.is_read ? 'text-[#64748B]' : 'text-[#334155]'}`}>{n.message}</span>
        <span className={`block mt-1 text-[13px] ${n.is_read ? 'text-[#64748B]' : 'font-semibold text-[#1D5BD6]'}`}>{relativeTime(n.created_at)}</span>
      </span>
      {!n.is_read && <span aria-label="Unread" className="flex-shrink-0 w-3 h-3 rounded-full bg-[#1D5BD6]" />}
    </motion.button>
  );
}

/*
 * The panel and the blur behind it move together: opening eases out (it
 * glides in and settles softly), closing eases in (it lifts away gently, then
 * goes). A fade and a short drop only — no zoom or bounce, so text never resizes.
 */
const PANEL_EASE_OUT = [0.33, 1, 0.68, 1] as const;
const PANEL_EASE_IN = [0.32, 0, 0.67, 0] as const;
const PANEL_OPEN_S = 0.26;
const PANEL_CLOSE_S = 0.2;

const panelVariants = {
  hidden: { opacity: 0, y: -6 },
  visible: { opacity: 1, y: 0, transition: { duration: PANEL_OPEN_S, ease: PANEL_EASE_OUT } },
  exit: { opacity: 0, y: -4, transition: { duration: PANEL_CLOSE_S, ease: PANEL_EASE_IN } },
};

/** A tab's list: fades in as a whole (empty message included), its rows one after another */
const tabListVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.22, ease: NAV_EASE, staggerChildren: 0.04, delayChildren: 0.02 },
  },
};

/** Newest first */
const newestFirst = (a: AppNotification, b: AppNotification) =>
  new Date(b.created_at).getTime() - new Date(a.created_at).getTime();

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
  // While the panel is open the page behind it stays still — only the list scrolls
  useScrollLock(open);
  const [ringing, setRinging] = useState(false);
  const [ripple, setRipple] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const ref = useRef<HTMLDivElement>(null);
  const drop = useHeaderDrop(ref, open);

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

  // Switching tabs: the list keeps the height it had (All is always the
  // longest), the old list fades out and the new one eases in — no jump
  const listRef = useRef<HTMLDivElement>(null);
  const [listMinH, setListMinH] = useState<number | undefined>(undefined);
  function switchTab(next: NotificationFilter) {
    if (next === filter) return;
    const h = listRef.current?.offsetHeight;
    if (h) setListMinH(prev => Math.max(prev ?? 0, h));
    setFilter(next);
  }

  // Faculty: one list like Facebook — "New" (unread) then "Earlier", newest first
  const feed = role === 'instructor';
  const feedNew = useMemo(() => notifications.filter(n => !n.is_read).sort(newestFirst), [notifications]);
  const feedEarlier = useMemo(() => notifications.filter(n => n.is_read).sort(newestFirst), [notifications]);

  // Nothing pops up on the page: when something new arrives, the bell rings once
  const lastUnread = useRef<number | null>(null);
  useEffect(() => {
    if (isInitialLoad) return;
    if (lastUnread.current !== null && unreadCount > lastUnread.current && !reduceMotion) {
      setRinging(true);
      const id = window.setTimeout(() => setRinging(false), 450);
      lastUnread.current = unreadCount;
      return () => window.clearTimeout(id);
    }
    lastUnread.current = unreadCount;
  }, [unreadCount, isInitialLoad, reduceMotion]);

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
  // Area tabs only when they have something (All / Unread always shown); faculty: All / Unread only
  const tabs = NOTIFICATION_TABS.filter(t => t.id === 'all' || t.id === 'unread' || (!feed && tabCounts[t.id] > 0));

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
    // The bell rings on every tap (and a soft ripple spreads), as well as when something new arrives
    if (!reduceMotion) {
      setRinging(true);
      setRipple(true);
      window.setTimeout(() => setRinging(false), 450);
      window.setTimeout(() => setRipple(false), 500);
    }
    // The list sizes itself afresh; its content is already current (live updates)
    if (!open) setListMinH(undefined);
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
            // The scroll lock lets this panel (and only it) scroll
            data-scroll-portal
            style={{ '--drop-fixed': `${drop.fixedTop}px`, '--drop-abs': `${drop.belowAnchor}px` } as React.CSSProperties}
            // Just below the header bar, never over it (phones: fixed to the screen; larger: under the bell)
            className="qr-nav-menu fixed z-[60] left-3 right-3 top-[var(--drop-fixed)] max-h-[min(74dvh,36rem)]
              md:absolute md:left-auto md:right-0 md:top-[var(--drop-abs)] md:w-[32rem] md:max-w-[calc(100vw-1.5rem)]
              bg-white border border-[#E2E8F0] rounded-2xl overflow-hidden flex flex-col origin-top-right
              shadow-[0_20px_48px_-12px_rgba(11,42,91,0.28)]"
            variants={reduceMotion ? undefined : panelVariants}
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
                {unreadCount > 0 && !feed && (
                  <span className="hidden min-[400px]:inline-flex items-center flex-shrink-0 h-6 px-2.5 rounded-full bg-[#EFF6FF] text-[#1D5BD6] text-[12px] font-bold tabular-nums">
                    {unreadCount} unread
                  </span>
                )}
              </div>
              <div className="flex items-center gap-0.5 flex-shrink-0">
                {!feed && <button
                  type="button"
                  onClick={refresh}
                  aria-label="Refresh notifications"
                  title="Refresh"
                  className="h-10 w-10 rounded-full text-[#64748B] hover:text-[#0B2A5B] hover:bg-[#F1F5F9] inline-flex items-center justify-center transition-colors"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>}
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
                    onClick={() => switchTab(tab.id)}
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

            <div
              ref={listRef}
              className="overflow-y-auto overflow-x-hidden overscroll-contain flex-1 min-h-0 px-1.5 pb-1.5"
              style={{ minHeight: listMinH }}
              role="tabpanel"
            >
              <AnimatePresence
                mode="wait"
                // Opening shows the list in place with the panel; only tab switches fade
                initial={false}
                // The new tab's list starts at its top
                onExitComplete={() => listRef.current?.scrollTo({ top: 0 })}
              >
              <motion.div
                key={filter}
                variants={reduceMotion ? undefined : tabListVariants}
                initial={reduceMotion ? false : 'hidden'}
                animate="visible"
                exit={reduceMotion ? undefined : { opacity: 0, transition: { duration: 0.12, ease: NAV_EASE } }}
              >
              {isInitialLoad ? (
                <div className="pt-2">
                  <SkeletonRow />
                  <SkeletonRow />
                  <SkeletonRow />
                </div>
              ) : feed ? (
                (filter === 'unread' && feedNew.length === 0) || feedNew.length + feedEarlier.length === 0 ? (
                  <div className="py-12 px-6 flex flex-col items-center text-center">
                    <span className="w-12 h-12 rounded-full bg-[#EFF6FF] flex items-center justify-center mb-3" aria-hidden>
                      <Bell className="w-6 h-6 text-[#1D5BD6]" />
                    </span>
                    <p className="text-[15px] font-semibold text-[#0F172A]">{filter === 'unread' ? emptyFilterMessage('unread') : 'No notifications yet.'}</p>
                  </div>
                ) : (
                  <>
                    {feedNew.length > 0 && (
                      <section aria-label="New">
                        <h4 className="px-2.5 pt-3 pb-1 text-[16px] font-bold text-[#0B2A5B]">New</h4>
                        {feedNew.map(n => <FeedRow key={n.id} n={n} onOpen={openNotification} reduceMotion={!!reduceMotion} />)}
                      </section>
                    )}
                    {filter === 'all' && feedEarlier.length > 0 && (
                      <section aria-label="Earlier">
                        <h4 className="px-2.5 pt-3 pb-1 text-[16px] font-bold text-[#0B2A5B]">Earlier</h4>
                        {feedEarlier.map(n => <FeedRow key={n.id} n={n} onOpen={openNotification} reduceMotion={!!reduceMotion} />)}
                      </section>
                    )}
                  </>
                )
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
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* While the panel is open the page behind it is blurred (the top bar, bell
          and panel stay sharp: the header sits above at z-40); a tap closes it */}
      {mounted && createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              key="notif-backdrop"
              aria-hidden
              onClick={() => setOpen(false)}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: reduceMotion ? 0 : PANEL_OPEN_S, ease: PANEL_EASE_OUT } }}
              exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : PANEL_CLOSE_S, ease: PANEL_EASE_IN } }}
              className="fixed inset-0 z-[39] bg-[#0B2A5B]/20 backdrop-blur-sm"
            />
          )}
        </AnimatePresence>,
        document.body,
      )}
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
