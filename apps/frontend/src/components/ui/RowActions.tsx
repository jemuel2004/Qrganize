'use client';

/**
 * Account table row actions — the same on Faculty, Program Chair and Department
 * Chair Accounts: an "Edit" button (the account's details) and a "More" menu
 * with Reset password · Deactivate / Activate · Delete.
 */

import { useCallback, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { KeyRound, MoreHorizontal, Pencil, ShieldCheck, ShieldX, Trash2 } from 'lucide-react';
import AnchoredPopover from '@/components/ui/AnchoredPopover';

const EASE = [0.4, 0, 0.2, 1] as const;

/** "Edit" — opens the account's details */
export function RowEditButton({ onClick, label = 'Edit account' }: { onClick: () => void; label?: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={reduceMotion ? undefined : { y: -1 }}
      whileTap={reduceMotion ? undefined : { scale: 0.95 }}
      transition={{ duration: 0.15, ease: EASE }}
      className="flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-sm font-semibold bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1D5BD6] border border-[#BFDBFE] hover:border-[#93C5FD] transition-colors"
      title={label}
    >
      <Pencil className="w-3.5 h-3.5" /> Edit
    </motion.button>
  );
}

/** Row "More" menu: Reset password · Deactivate / Activate · Delete */
export function RowMoreMenu({ active, toggling, onReset, onToggle, onDelete }: {
  active: boolean;
  toggling: boolean;
  onReset: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };

  const items = [
    { key: 'reset', label: 'Reset password', Icon: KeyRound, color: '#1D5BD6', hover: 'hover:bg-[#EFF6FF]', onClick: onReset },
    active
      ? { key: 'toggle', label: 'Deactivate', Icon: ShieldX, color: '#B45309', hover: 'hover:bg-amber-50', onClick: onToggle }
      : { key: 'toggle', label: 'Activate', Icon: ShieldCheck, color: '#047857', hover: 'hover:bg-emerald-50', onClick: onToggle },
    { key: 'delete', label: 'Delete', Icon: Trash2, color: '#DC2626', hover: 'hover:bg-red-50', onClick: onDelete },
  ];

  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={toggling}
        whileTap={reduceMotion ? undefined : { scale: 0.95 }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        className={`flex items-center gap-1.5 px-3.5 h-9 rounded-lg text-sm font-semibold border transition-colors disabled:opacity-50 ${
          open ? 'bg-[#0B2A5B] border-[#0B2A5B]' : 'bg-white text-[#0B2A5B] border-[#C7D4EA] hover:bg-[#F4F7FC] hover:border-[#9DB8E8]'
        }`}
        style={open ? { color: '#FFFFFF' } : undefined}
      >
        {toggling
          ? <div className="w-3.5 h-3.5 border border-current border-t-transparent rounded-full animate-spin" />
          : <MoreHorizontal className="w-3.5 h-3.5" />}
        More
      </motion.button>
      <AnchoredPopover open={open} onClose={close} anchorRef={triggerRef} panelRef={panelRef} width={190} maxHeight={220} label="More actions" align="end"
        onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } }}>
        <div role="menu" className="p-1.5">
          {items.map(({ key, label, Icon, color, hover, onClick }, i) => (
            <motion.button
              key={key}
              type="button"
              role="menuitem"
              onClick={pick(onClick)}
              initial={reduceMotion ? false : { opacity: 0, x: 6 }}
              animate={{ opacity: 1, x: 0, transition: { duration: 0.2, delay: i * 0.04, ease: EASE } }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${hover} ${key === 'delete' ? 'mt-1 border-t border-[#F1F5F9] rounded-t-none pt-2.5' : ''}`}
              style={{ color }}
            >
              <Icon className="w-4 h-4" /> {label}
            </motion.button>
          ))}
        </div>
      </AnchoredPopover>
    </>
  );
}
