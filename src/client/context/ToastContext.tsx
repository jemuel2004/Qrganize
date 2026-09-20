'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ToastContainer from '@/client/components/ui/Toast';

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'delete';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

export type ToastFns = {
  success: (msg: string) => void;
  error:   (msg: string) => void;
  warning: (msg: string) => void;
  info:    (msg: string) => void;
  delete:  (msg: string) => void;
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
    return () => { timers.current.forEach(clearTimeout); };
  }, []);

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t !== undefined) { clearTimeout(t); timers.current.delete(id); }
    setItems(prev => prev.filter(toast => toast.id !== id));
  }, []);

  const push = useCallback((type: ToastType, message: string) => {
    const key = `${type}:${message}`;
    const now = Date.now();
    if ((now - (recent.current.get(key) ?? 0)) < DEDUP_MS) return;
    recent.current.set(key, now);
    const id = ++uid;
    setItems(prev => [...prev.slice(-4), { id, type, message }]);
    const timer = setTimeout(() => dismiss(id), DISMISS_MS);
    timers.current.set(id, timer);
  }, [dismiss]);

  const toast = useMemo<ToastFns>(() => ({
    success: (msg) => push('success', msg),
    error:   (msg) => push('error',   msg),
    warning: (msg) => push('warning', msg),
    info:    (msg) => push('info',    msg),
    delete:  (msg) => push('delete',  msg),
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
