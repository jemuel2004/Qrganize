'use client';

import { X, CheckCircle2, XCircle, AlertTriangle, Info, Trash2 } from 'lucide-react';
import type { ToastItem, ToastType } from '@/client/context/ToastContext';

const CFG: Record<ToastType, {
  icon: React.ReactNode;
  bg: string;
  border: string;
  leftBar: string;
  iconWrap: string;
  title: string;
  label: string;
  message: string;
}> = {
  success: {
    icon:     <CheckCircle2 className="w-4.5 h-4.5" />,
    bg:       'bg-white',
    border:   'border border-[#BBF7D0]',
    leftBar:  'bg-[#22C55E]',
    iconWrap: 'bg-[#DCFCE7] text-[#16A34A]',
    title:    'text-[#1E293B]',
    label:    'Success',
    message:  'text-[#64748B]',
  },
  error: {
    icon:     <XCircle className="w-4.5 h-4.5" />,
    bg:       'bg-white',
    border:   'border border-[#FECACA]',
    leftBar:  'bg-[#EF4444]',
    iconWrap: 'bg-[#FEE2E2] text-[#DC2626]',
    title:    'text-[#1E293B]',
    label:    'Error',
    message:  'text-[#64748B]',
  },
  warning: {
    icon:     <AlertTriangle className="w-4.5 h-4.5" />,
    bg:       'bg-white',
    border:   'border border-[#FDE68A]',
    leftBar:  'bg-[#F59E0B]',
    iconWrap: 'bg-[#FEF3C7] text-[#D97706]',
    title:    'text-[#1E293B]',
    label:    'Warning',
    message:  'text-[#64748B]',
  },
  info: {
    icon:     <Info className="w-4.5 h-4.5" />,
    bg:       'bg-white',
    border:   'border border-[#BFDBFE]',
    leftBar:  'bg-[#1D5BD6]',
    iconWrap: 'bg-[#DBEAFE] text-[#164BB5]',
    title:    'text-[#1E293B]',
    label:    'Info',
    message:  'text-[#64748B]',
  },
  delete: {
    icon:     <Trash2 className="w-4.5 h-4.5" />,
    bg:       'bg-white',
    border:   'border border-[#FECACA]',
    leftBar:  'bg-[#EF4444]',
    iconWrap: 'bg-[#FEE2E2] text-[#DC2626]',
    title:    'text-[#1E293B]',
    label:    'Deleted',
    message:  'text-[#64748B]',
  },
};

export default function ToastContainer({
  items,
  dismiss,
}: {
  items: ToastItem[];
  dismiss: (id: number) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="fixed top-5 right-5 z-[99999] flex flex-col gap-2.5 w-[21rem] max-w-[calc(100vw-2.5rem)] pointer-events-none"
    >
      {items.map(item => {
        const c = CFG[item.type];
        return (
          <div
            key={item.id}
            role="alert"
            className={[
              'relative overflow-hidden rounded-2xl pointer-events-auto toast-in',
              'shadow-[0_4px_24px_rgba(0,0,0,0.08)]',
              c.bg, c.border,
            ].join(' ')}
          >
            {/* Left accent bar */}
            <div className={`absolute left-0 top-0 bottom-0 w-[3px] rounded-l-2xl ${c.leftBar}`} />

            <div className="flex items-center gap-3 px-4 py-3.5 pl-5">
              {/* Icon */}
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${c.iconWrap} ${item.type === 'success' ? 'toast-check-pop' : ''}`}>
                {c.icon}
              </div>

              {/* Text */}
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-bold uppercase tracking-wider mb-0.5 ${c.title}`}>
                  {c.label}
                </p>
                <p className={`text-sm leading-snug break-words ${c.message}`}>
                  {item.message}
                </p>
              </div>

              {/* Close */}
              <button
                onClick={() => dismiss(item.id)}
                className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-lg transition-colors text-[#94A3B8] hover:text-[#475569]"
                aria-label="Dismiss notification"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
