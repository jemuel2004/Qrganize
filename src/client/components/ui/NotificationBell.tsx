'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from 'framer-motion';
import {
  AlertTriangle,
  Bell,
  Calendar,
  CheckCircle2,
  ClipboardList,
  DoorOpen,
  Megaphone,
  QrCode,
  RefreshCw,
  ShieldAlert,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { useNotifications, AppNotification } from '@/client/context/NotificationContext';
import {
  NOTIFICATION_TABS,
  emptyFilterMessage,
  getNotificationCategory,
  matchesNotificationFilter,
  notificationHref,
  type NotificationFilter,
} from '@/client/lib/notificationMeta';
import {
  dropdownVariants,
  NAV_DURATION,
  NAV_EASE,
  notificationListVariants,
  notificationRowVariants,
} from '@/client/components/layout/navMotion';

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

function notificationIcon(type: string): LucideIcon {
  if (type === 'room_request_approved' || type === 'qr_scan_success') return CheckCircle2;
  if (type === 'room_request_rejected') return XCircle;
  if (type === 'room_request_submitted' || type === 'room_request_expired') return ClipboardList;
  if (type === 'room_occupied' || type === 'room_released') return DoorOpen;
  if (type === 'qr_scan_denied' || type === 'qr_scan_unauthorized') return ShieldAlert;
  if (type.startsWith('qr_scan_')) return QrCode;
  if (type === 'schedule_updated') return Calendar;
  if (type === 'system_alert') return Megaphone;
  if (
    type === 'workload_incomplete' ||
    type === 'workload_overload' ||
    type === 'block_unassigned'
  ) return AlertTriangle;
  return Bell;
}

function SkeletonRow() {
  return (
    <div className="px-4 py-3.5 border-b border-[#F1F5F9] last:border-0">
      <div className="qr-skeleton h-3.5 rounded w-2/3 mb-2" />
      <div className="qr-skeleton h-3 rounded w-full mb-1.5" />
      <div className="qr-skeleton h-2.5 rounded w-1/4" />
    </div>
  );
}

function NotificationRow({
  n, onOpen, reduceMotion,
}: { n: AppNotification; onOpen: (n: AppNotification) => void; reduceMotion: boolean }) {
  return (
    <motion.button
      type="button"
      onClick={() => onOpen(n)}
      variants={reduceMotion ? undefined : notificationRowVariants}
      whileHover={reduceMotion ? undefined : { backgroundColor: n.is_read ? '#F8FAFC' : '#F1F5F9', x: 2 }}
      transition={{ duration: NAV_DURATION, ease: NAV_EASE }}
      className={[
        'w-full text-left px-3 sm:px-4 py-3.5 border-b border-[#F1F5F9] last:border-0 min-h-11',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#164BB5]/30',
        n.is_read ? 'bg-white' : 'bg-[#F8FAFC]',
      ].join(' ')}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        {React.createElement(notificationIcon(n.type), {
          className: `w-4 h-4 mt-0.5 flex-shrink-0 ${n.is_read ? 'text-[#94A3B8]' : 'text-[#475569]'}`,
          strokeWidth: 1.75,
          'aria-hidden': true,
        })}
        <div className="flex-1 min-w-0">
          <p className={`text-sm leading-snug break-words ${n.is_read ? 'font-medium text-[#334155]' : 'font-semibold text-[#0F172A]'}`}>
            {n.title}
          </p>
          <p className="text-[13px] text-[#64748B] mt-0.5 leading-relaxed break-words">
            {n.message}
          </p>
          <p className="text-[11px] text-[#94A3B8] mt-1.5 font-medium">
            {relativeTime(n.created_at)}
          </p>
        </div>
        {!n.is_read && (
          <span
            aria-label="Unread"
            className="flex-shrink-0 w-2 h-2 rounded-full bg-[#164BB5] mt-1.5"
          />
        )}
      </div>
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

  const visible = useMemo(
    () => notifications.filter(n => matchesNotificationFilter(n, filter)),
    [notifications, filter],
  );

  const tabCounts = useMemo(() => {
    const counts: Record<NotificationFilter, number> = {
      all: notifications.length,
      unread: 0,
      room_requests: 0,
      schedule: 0,
      announcements: 0,
    };
    for (const n of notifications) {
      if (!n.is_read) counts.unread += 1;
      counts[getNotificationCategory(n)] += 1;
    }
    return counts;
  }, [notifications]);

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

  function openNotification(n: AppNotification) {
    if (!n.is_read) markRead(n.id);
    const href = notificationHref(n, role);
    setOpen(false);
    if (href) router.push(href);
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
              : { rotate: 0 }
        }
        transition={
          ringing
            ? { duration: 0.4, ease: NAV_EASE }
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
          <span
            className={`absolute -top-0.5 -right-0.5 z-[2] min-w-[18px] h-[18px] px-[5px] rounded-full
              bg-[#E41E3F] text-white text-[10px] font-bold tabular-nums leading-none
              flex items-center justify-center ring-2 ${badgeRing} shadow-sm`}
          >
            {badge}
          </span>
        )}
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Notifications panel"
            className="qr-nav-menu fixed z-[60] left-3 right-3 top-14 max-h-[min(72vh,34rem)]
              md:absolute md:left-auto md:right-0 md:top-12 md:w-[26rem] md:max-w-[calc(100vw-1.5rem)]
              bg-white border border-[#E5E7EB] rounded-xl overflow-hidden flex flex-col shadow-lg origin-top-right"
            variants={reduceMotion ? undefined : dropdownVariants}
            initial={reduceMotion ? false : 'hidden'}
            animate="visible"
            exit={reduceMotion ? undefined : 'exit'}
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-[#E5E7EB] flex-shrink-0 bg-white min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h3 className="text-sm font-bold text-[#1E293B] truncate">
                  Notifications
                </h3>
                {unreadCount > 0 && (
                  <span className="flex-shrink-0 px-2 py-0.5 bg-[#F1F5F9] text-[#475569] text-[11px] font-semibold rounded-full">
                    {unreadCount} unread
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  type="button"
                  onClick={refresh}
                  aria-label="Refresh notifications"
                  title="Refresh"
                  className="min-h-11 min-w-11 rounded-lg text-[#9CA3AF] hover:text-[#374151] hover:bg-[#F3F4F6] inline-flex items-center justify-center"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    aria-label="Mark all notifications as read"
                    className="min-h-11 px-2 rounded-lg text-[12px] font-semibold text-[#164BB5] hover:bg-[#EFF6FF] whitespace-nowrap"
                  >
                    Mark all as read
                  </button>
                )}
              </div>
            </div>

            <div
              role="tablist"
              aria-label="Notification categories"
              className="flex-shrink-0 overflow-x-auto overflow-y-hidden border-b border-[#E5E7EB] bg-white"
            >
              <div className="flex min-w-max px-1">
                {NOTIFICATION_TABS.map(tab => {
                  const selected = filter === tab.id;
                  const count = tabCounts[tab.id];
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setFilter(tab.id)}
                      className={[
                        'relative px-2.5 py-2.5 text-[12px] font-semibold whitespace-nowrap min-h-11',
                        selected
                          ? 'text-[#0F172A]'
                          : 'text-[#64748B] hover:text-[#1E293B]',
                      ].join(' ')}
                    >
                      {tab.label}
                      {tab.id !== 'all' && count > 0 && (
                        <span className="ml-1 text-[11px] font-medium text-[#94A3B8] tabular-nums">
                          {count}
                        </span>
                      )}
                      {selected && (
                        <span className="absolute left-2 right-2 bottom-0 h-0.5 rounded-full bg-[#0F172A]" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <motion.div
              className="overflow-y-auto overflow-x-hidden flex-1 min-h-0"
              role="tabpanel"
              variants={reduceMotion ? undefined : notificationListVariants}
              initial={reduceMotion ? false : 'hidden'}
              animate="visible"
            >
              {isInitialLoad ? (
                <>
                  <SkeletonRow />
                  <SkeletonRow />
                  <SkeletonRow />
                </>
              ) : visible.length === 0 ? (
                <div className="py-10 px-4 text-center">
                  <p className="text-sm font-medium text-[#1E293B]">{emptyFilterMessage(filter)}</p>
                </div>
              ) : (
                visible.map(n => (
                  <NotificationRow
                    key={n.id}
                    n={n}
                    onOpen={openNotification}
                    reduceMotion={!!reduceMotion}
                  />
                ))
              )}
            </motion.div>

            {!isInitialLoad && notifications.length > 0 && (
              <div className="flex-shrink-0 px-4 py-2.5 border-t border-[#E5E7EB] bg-white text-center">
                <button
                  type="button"
                  className="min-h-11 text-[13px] font-semibold text-[#164BB5] hover:text-[#1D4ED8]"
                  onClick={() => { markAllRead(); setOpen(false); }}
                >
                  Close
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
