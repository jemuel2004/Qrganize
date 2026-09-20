'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useScrollLock } from '@/client/hooks/useScrollLock';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full' | 'form';
}

const sizes = {
  sm:    'max-w-lg',
  md:    'max-w-xl',
  lg:    'max-w-3xl',
  xl:    'max-w-5xl',
  '2xl':  'max-w-7xl',
  full:  'max-w-[96vw]',
  form:  'max-w-[min(1280px,calc(100vw-1rem))]',
};

export default function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useScrollLock(open);

  /* Close on Escape */
  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    /* Outer trap — covers the full viewport, blocks pointer events behind the modal */
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-2 sm:p-4"
      role="presentation"
      data-modal-root
    >
      {/* Backdrop — click outside to close */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm qr-backdrop-in"
        onClick={onClose}
      />

      {/* Dialog panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className={`relative bg-[#111827] border border-white/10 rounded-2xl shadow-2xl w-full ${sizes[size]} max-h-[94vh] sm:max-h-[92vh] flex flex-col min-w-0 qr-modal-in`}
        /* Stop clicks inside the panel from bubbling to the backdrop */
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex-shrink-0 flex items-center justify-between gap-3 px-4 sm:px-8 py-4 sm:py-6 border-b border-white/10">
          <h2 id="modal-title" className="text-lg sm:text-xl font-bold text-white leading-tight min-w-0 break-words">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="p-2 -mr-1 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.07] transition-colors duration-150 min-h-11 min-w-11 inline-flex items-center justify-center flex-shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className={`overflow-y-auto overscroll-contain flex-1 min-h-0 min-w-0 ${size === 'form' ? 'px-3 sm:px-5 py-4 sm:py-5' : 'px-4 sm:px-8 py-5 sm:py-7'}`}>
          {children}
        </div>

        {/* Footer */}
        {footer ? (
          <div className="flex-shrink-0 px-4 sm:px-8 py-4 sm:py-6 border-t border-white/10 bg-[#0d1424] rounded-b-2xl">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
