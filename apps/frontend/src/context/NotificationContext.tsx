'use client';

import React, {
  createContext, useCallback, useContext,
  useEffect, useMemo, useRef, useState,
} from 'react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';

export interface AppNotification {
  id: number;
  recipient_id: number;
  recipient_role: string;
  title: string;
  message: string;
  type: string;
  is_read: boolean;
  created_at: string;
  related_module: string | null;
  related_id: number | null;
}

export type NotificationRole = 'admin' | 'department_chair' | 'program_chair' | 'instructor';

interface NotificationContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  loading: boolean;
  /** True until the very first fetch resolves — drives skeleton loaders. */
  isInitialLoad: boolean;
  role: NotificationRole;
  markRead: (id: number) => void;
  markAllRead: () => void;
  refresh: () => void;
}

const NotificationContext = createContext<NotificationContextValue>({
  notifications: [],
  unreadCount: 0,
  loading: false,
  isInitialLoad: true,
  role: 'admin',
  markRead: () => {},
  markAllRead: () => {},
  refresh: () => {},
});

/** Fallback only — new and changed notifications arrive through live updates. */
const POLL_MS = 60_000;

/** Same items in the same order with the same text and read state. */
function sameNotifications(a: AppNotification[], b: AppNotification[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id !== y.id || x.is_read !== y.is_read || x.title !== y.title || x.message !== y.message) return false;
  }
  return true;
}

interface Props {
  children: React.ReactNode;
  role: NotificationRole;
}

export function NotificationProvider({ children, role }: Props) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount]     = useState(0);
  const [loading, setLoading]             = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const mountedRef                        = useRef(true);

  const fetchNotifications = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/notifications?limit=200', { cache: 'no-store' });
      if (res.status === 401 && typeof window !== 'undefined') {
        window.location.replace('/login');
        return;
      }
      if (!res.ok || !mountedRef.current) return;
      const data = await res.json();
      if (!mountedRef.current) return;

      const incoming: AppNotification[] = data.notifications ?? [];
      const incomingUnread: number      = data.unread_count ?? 0;

      /*
       * Skip setState when nothing changed, so subscribers don't re-render.
       * Every item is compared — live alerts keep their id while their text
       * changes (e.g. "3 classes not yet scheduled" → "2 classes").
       */
      setNotifications(prev => (sameNotifications(prev, incoming) ? prev : incoming));
      setUnreadCount(prev => (prev === incomingUnread ? prev : incomingUnread));
      setIsInitialLoad(false);
    } catch { /* silent */ } finally {
      if (!silent && mountedRef.current) setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    mountedRef.current = true;
    fetchNotifications();
    return () => { mountedRef.current = false; };
  }, [fetchNotifications]);

  // Live updates: this inbox changed (new, updated, read elsewhere or removed)
  useRealtime(['notifications'], () => fetchNotifications(true), { enabled: !isInitialLoad });

  // Fallback polling (pauses while the tab is hidden) — also lets the server
  // refresh time-based alerts
  useVisibilityAwareInterval(() => fetchNotifications(true), POLL_MS);

  const markRead = useCallback(async (id: number) => {
    let alreadyRead = false;
    setNotifications(prev => {
      const current = prev.find(n => n.id === id);
      alreadyRead = Boolean(current?.is_read);
      if (!current || current.is_read) return prev;
      return prev.map(n => n.id === id ? { ...n, is_read: true } : n);
    });
    if (alreadyRead) return;
    setUnreadCount(prev => Math.max(0, prev - 1));
    await fetch(`/api/notifications/${id}`, { method: 'PATCH' }).catch(() => {});
  }, []);

  const markAllRead = useCallback(async () => {
    // Optimistic update
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
    setUnreadCount(0);
    await fetch('/api/notifications/read-all', { method: 'PATCH' }).catch(() => {});
  }, []);

  const refresh = useCallback(() => fetchNotifications(true), [fetchNotifications]);

  const value = useMemo(() => ({
    notifications, unreadCount, loading, isInitialLoad, role,
    markRead, markAllRead, refresh,
  }), [notifications, unreadCount, loading, isInitialLoad, role, markRead, markAllRead, refresh]);

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}
