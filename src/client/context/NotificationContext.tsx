'use client';

import React, {
  createContext, useCallback, useContext,
  useEffect, useMemo, useRef, useState,
} from 'react';
import { useVisibilityAwareInterval } from '@/client/hooks/useVisibilityAwareInterval';

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

export type NotificationRole = 'admin' | 'department_chair' | 'instructor';

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

const POLL_MS = 30_000;

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
      const res = await fetch('/api/notifications?limit=50', { cache: 'no-store' });
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
       * Skip setState entirely when the data hasn't changed.
       * Polling fires every 15 s — without this guard, every poll
       * creates a new array reference and re-renders all subscribers
       * even when nothing actually changed.
       *
       * Fast heuristic: compare count + newest-item id + unread count.
       * Catches the overwhelmingly common case (no new activity) in O(1).
       */
      setNotifications(prev => {
        if (
          prev.length     === incoming.length &&
          prev[0]?.id     === incoming[0]?.id &&
          prev[0]?.is_read === incoming[0]?.is_read
        ) return prev;   // same reference → no re-render
        return incoming;
      });
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

  // Visibility-aware polling: pauses when tab is hidden, resumes on focus
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
