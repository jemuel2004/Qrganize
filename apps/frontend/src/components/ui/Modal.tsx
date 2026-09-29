'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useScrollLock } from '@/hooks/useScrollLock';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full' | 'form';
  /** Royal-blue header (the system default — pass false only for a plain header). */
  headerAccent?: boolean;
  /** Optional line under the title */
  subtitle?: string;
  /** Optional icon shown in a tile before the title */
  icon?: React.ElementType;
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

export default function Modal({ open, onClose, title, children, footer, size = 'md', headerAccent = true, subtitle, icon: Icon }: ModalProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  useScrollLock(open);

  /* Close on Escape */
  useEffect(() => {
    if (!open) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Stacked pop-ups: only the top one closes
      const roots = document.querySelectorAll('[data-modal-root]');
      if (rootRef.current && roots[roots.length - 1] !== rootRef.current) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    /* Outer trap — covers the full viewport, blocks pointer events behind the modal */
    <div
      ref={rootRef}
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
        className={`qr-modal-panel relative bg-[#111827] border border-white/10 rounded-2xl shadow-2xl w-full ${sizes[size]} max-h-[94dvh] sm:max-h-[92dvh] flex flex-col min-w-0 qr-modal-in`}
        /* Stop clicks inside the panel from bubbling to the backdrop */
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        {/* Header — same gradient banner on every pop-up (matches New Room Request) */}
        <div
          className={`relative overflow-hidden flex-shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 py-4 rounded-t-2xl ${
            headerAccent ? '' : 'border-b border-white/10'
          }`}
          style={headerAccent ? { background: 'linear-gradient(120deg, #1D5BD6 0%, #0B2A5B 120%)' } : undefined}
        >
          {headerAccent && <span aria-hidden className="absolute -right-10 -top-14 w-44 h-44 rounded-full bg-white/10 pointer-events-none" />}
          <div className="relative flex items-center gap-3 min-w-0">
            {Icon && (
              <span className="w-11 h-11 rounded-xl bg-white/15 ring-1 ring-white/25 flex items-center justify-center flex-shrink-0">
                <Icon className="w-5 h-5" style={{ color: '#FFFFFF' }} />
              </span>
            )}
            <div className="min-w-0">
              <h2 id="modal-title" className="text-lg sm:text-[19px] font-bold leading-tight min-w-0 break-words" style={{ color: '#FFFFFF' }}>{title}</h2>
              {subtitle && <p className="text-sm mt-0.5 break-words" style={{ color: 'rgba(255,255,255,0.8)' }}>{subtitle}</p>}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className={`relative rounded-xl transition-colors duration-150 min-h-11 min-w-11 inline-flex items-center justify-center flex-shrink-0 ${
              headerAccent ? 'bg-white/15 hover:bg-white/25' : 'text-slate-400 hover:text-white hover:bg-white/[0.07]'
            }`}
            style={headerAccent ? { color: '#FFFFFF' } : undefined}
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
