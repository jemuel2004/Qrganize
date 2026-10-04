'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ToastContainer from '@/components/ui/Toast';

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'delete';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  /** Heading in place of the type's own ("Success", "Info"…) */
  title?: string;
}

export type ToastFns = {
  success: (msg: string, title?: string) => void;
  error:   (msg: string, title?: string) => void;
  warning: (msg: string, title?: string) => void;
  info:    (msg: string, title?: string) => void;
  delete:  (msg: string, title?: string) => void;
};

const ToastCtx = createContext<ToastFns | null>(null);

let uid = 0;
const DISMISS_MS = 4500;
const DEDUP_MS   = 600;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const recent = useRef<Map<string, number>>(new Map());
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  // Cancel all timers on unmount to prevent post-unmount state updates
  useEffect(() => {
    const pending = timers.current; // the same Map for the provider's whole life
    return () => { pending.forEach(clearTimeout); };
  }, []);

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t !== undefined) { clearTimeout(t); timers.current.delete(id); }
    setItems(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const push = useCallback((type: ToastType, message: string, title?: string) => {
    const key = `${type}:${title ?? ''}:${message}`;
    const now = Date.now();
    if ((now - (recent.current.get(key) ?? 0)) < DEDUP_MS) return;
    recent.current.set(key, now);
    const id = ++uid;
    setItems(prev => [...prev.slice(-4), { id, type, message, title }]);
    const timer = setTimeout(() => dismiss(id), DISMISS_MS);
    timers.current.set(id, timer);
  }, [dismiss]);

  const toast = useMemo<ToastFns>(() => ({
    success: (msg, title) => push('success', msg, title),
    error:   (msg, title) => push('error',   msg, title),
    warning: (msg, title) => push('warning', msg, title),
    info:    (msg, title) => push('info',    msg, title),
    delete:  (msg, title) => push('delete',  msg, title),
  }), [push]);

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <ToastContainer items={items} dismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastFns {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
