'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronDown, Lock, Search } from 'lucide-react';
import AnchoredPopover from '@/components/ui/AnchoredPopover';

/*
 * Large, easy-to-read dropdown for filter rows — a replacement for a native
 * <select> where the browser's small list is hard to use. Big rows, a check on
 * the current choice, an optional second line (e.g. a program's full name) and
 * a status pill (e.g. "8 available"). Mouse, touch and keyboard (↑ ↓ Home End
 * Enter Esc) all work.
 */

export interface FriendlyOption {
  value: string;
  label: string;
  /** Second, smaller line under the label */
  hint?: string;
  /** Small pill on the right, e.g. "8 available" */
  badge?: string;
  badgeTone?: 'green' | 'blue' | 'muted';
  disabled?: boolean;
}

const EASE = [0.4, 0, 0.2, 1] as const;

/** Lower-case, letters and digits only — so "1a", "1 A" and "1-A" all find "1A". */
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Label match always; hint match from 3 characters on, so "a" doesn't hit every "Year". */
function matches(o: FriendlyOption, q: string): boolean {
  if (normalize(o.label).includes(q)) return true;
  return q.length >= 3 && !!o.hint && normalize(o.hint).includes(q);
}

const BADGE_TONES: Record<NonNullable<FriendlyOption['badgeTone']>, string> = {
  green: 'bg-[#ECFDF5] text-[#047857]',
  blue:  'bg-[#EFF6FF] text-[#1D5BD6]',
  muted: 'bg-[#F1F5F9] text-[#64748B]',
};

function Pill({ text, tone = 'blue' }: { text: string; tone?: FriendlyOption['badgeTone'] }) {
  return (
    <span className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-bold tabular-nums whitespace-nowrap ${BADGE_TONES[tone]}`}>
      {text}
    </span>
  );
}

export default function FriendlySelect({
  value,
  onChange,
  options,
  label,
  placeholder = 'Select…',
  disabled = false,
  disabledText,
  emptyText = 'Nothing to choose yet.',
  guide = false,
  minPanelWidth = 300,
  showHintInTrigger = false,
  searchable = false,
  searchPlaceholder = 'Type to search…',
}: {
  value: string;
  onChange: (value: string) => void;
  options: FriendlyOption[];
  /** Accessible name — also the list's title for screen readers */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /** Shown instead of the placeholder while disabled */
  disabledText?: string;
  emptyText?: string;
  /** Red "fill me in next" pulse (qr-guide-pulse) */
  guide?: boolean;
  minPanelWidth?: number;
  /** Also print the chosen option's hint in the closed box */
  showHintInTrigger?: boolean;
  /** Search box at the top of the list (case-insensitive, ignores spaces/dashes) */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const reduceMotion = useReducedMotion();
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [panelWidth, setPanelWidth] = useState(minPanelWidth);
  const [query, setQuery] = useState('');

  const selected = options.find(o => o.value === value) ?? null;
  /** The rows on screen — every option, or the search matches. */
  const shown = useMemo(() => {
    const q = searchable ? normalize(query) : '';
    return q ? options.filter(o => matches(o, q)) : options;
  }, [options, query, searchable]);
  const firstEnabled = (list = shown) => list.findIndex(o => !o.disabled);

  function openList() {
    if (disabled) return;
    setPanelWidth(Math.max(minPanelWidth, triggerRef.current?.offsetWidth ?? 0));
    setQuery('');
    const idx = options.findIndex(o => o.value === value && !o.disabled);
    setActive(idx >= 0 ? idx : firstEnabled(options));
    setOpen(true);
  }

  function close(refocus = true) {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }

  function onQueryChange(next: string) {
    setQuery(next);
    const q = normalize(next);
    setActive(firstEnabled(q ? options.filter(o => matches(o, q)) : options));
  }

  function pick(o: FriendlyOption) {
    if (o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close();
  }

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() =>
      (searchable ? searchRef.current : listRef.current)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [open, searchable]);

  useEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  function move(dir: 1 | -1) {
    const n = shown.length;
    if (n === 0) return;
    let i = active;
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n;
      if (!shown[i].disabled) { setActive(i); return; }
    }
  }

  function onListKey(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp':   e.preventDefault(); move(-1); break;
      case 'Home':      e.preventDefault(); setActive(firstEnabled()); break;
      case 'End': {
        e.preventDefault();
        for (let i = shown.length - 1; i >= 0; i--) if (!shown[i].disabled) { setActive(i); break; }
        break;
      }
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (shown[active]) pick(shown[active]);
        break;
      case 'Escape': e.preventDefault(); e.stopPropagation(); close(); break;
      case 'Tab': close(false); break;
    }
  }

  /** Search box: arrows / Enter / Esc drive the list; every other key types. */
  function onSearchKey(e: React.KeyboardEvent) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) onListKey(e);
  }

  const triggerTone = disabled
    ? 'bg-slate-50 border border-dashed border-slate-200 cursor-not-allowed'
    : open
      ? 'bg-white border border-[#1D5BD6] shadow-[0_2px_12px_rgba(11,42,91,0.12)]'
      : selected
        ? 'bg-white border border-[#D6E0EF] shadow-[0_1px_3px_rgba(0,0,0,0.05)] hover:border-[#1D5BD6]'
        : 'bg-slate-100 border border-transparent hover:bg-slate-200/60';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={e => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openList(); }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-label={selected ? `${label}: ${selected.label}` : label}
        className={`w-full min-h-[48px] flex items-center gap-2 rounded-xl px-3.5 py-2 text-left outline-none transition-[background-color,border-color,box-shadow] duration-300 focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/30 ${triggerTone} ${
          guide && !disabled && !open ? 'qr-guide-pulse' : ''
        }`}
      >
        <span className="min-w-0 flex-1 truncate text-[15px]">
          {selected ? (
            <>
              <span className="font-semibold text-[#0B2A5B]">{selected.label}</span>
              {showHintInTrigger && selected.hint && <span className="text-slate-500"> — {selected.hint}</span>}
            </>
          ) : (
            <span className={disabled ? 'text-slate-400' : 'text-slate-500'}>
              {disabled ? (disabledText ?? placeholder) : placeholder}
            </span>
          )}
        </span>
        {disabled ? (
          <Lock className="w-4 h-4 text-slate-300 flex-shrink-0" aria-hidden="true" />
        ) : (
          <motion.span
            animate={{ rotate: open ? 180 : 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.3, ease: EASE }}
            className="inline-flex flex-shrink-0"
            aria-hidden="true"
          >
            <ChevronDown className={`w-5 h-5 ${open ? 'text-[#1D5BD6]' : 'text-slate-500'}`} />
          </motion.span>
        )}
      </button>

      <AnchoredPopover
        open={open}
        onClose={() => close(false)}
        anchorRef={triggerRef}
        panelRef={panelRef}
        width={panelWidth}
        maxHeight={400}
        label={label}
        duration={0.28}
      >
        {searchable && (
          <div className="flex-shrink-0 p-1.5 pb-0">
            <div className="flex items-center gap-2 rounded-xl border border-[#D6E0EF] bg-white px-3 min-h-[44px] focus-within:border-[#1D5BD6] transition-colors duration-200">
              <Search className="w-4 h-4 text-slate-400 flex-shrink-0" aria-hidden="true" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={e => onQueryChange(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder={searchPlaceholder}
                role="combobox"
                aria-expanded={open}
                aria-controls={`${id}-list`}
                aria-autocomplete="list"
                aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
                aria-label={`Search ${label}`}
                autoComplete="off"
                spellCheck={false}
                className="flex-1 min-w-0 text-[15px] text-slate-800 placeholder:text-slate-400 bg-transparent border-0 outline-none"
              />
            </div>
          </div>
        )}
        <div
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
          onKeyDown={onListKey}
          className="min-h-0 overflow-y-auto overscroll-contain p-1.5 outline-none"
        >
          {shown.length === 0 ? (
            <p className="px-4 py-6 text-center text-[15px] text-slate-500">
              {options.length > 0 && query ? `No match for “${query.trim()}”.` : emptyText}
            </p>
          ) : shown.map((o, i) => {
            const isSel = o.value === value;
            const isActive = i === active && !o.disabled;
            return (
              <motion.div
                key={o.value || '__all'}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={isSel}
                aria-disabled={o.disabled || undefined}
                initial={reduceMotion ? false : { opacity: 0, y: -4 }}
                animate={{ opacity: o.disabled ? 0.55 : 1, y: 0 }}
                transition={{ duration: 0.25, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 8) * 0.035 }}
                onMouseEnter={() => { if (!o.disabled) setActive(i); }}
                onClick={() => pick(o)}
                className={`flex items-center gap-3 min-h-[52px] px-3 py-2.5 rounded-xl transition-colors duration-200 ${
                  o.disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                } ${isSel ? 'bg-[#EFF6FF]' : isActive ? 'bg-[#F4F7FC]' : ''}`}
              >
                <span className="w-5 flex-shrink-0 flex justify-center" aria-hidden="true">
                  {isSel && (
                    <motion.span
                      initial={reduceMotion ? false : { scale: 0.5, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ duration: 0.25, ease: EASE }}
                      className="inline-flex"
                    >
                      <Check className="w-5 h-5 text-[#1D5BD6]" strokeWidth={2.75} />
                    </motion.span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[15px] leading-snug ${isSel ? 'font-bold text-[#1D5BD6]' : 'font-semibold text-[#0B2A5B]'}`}>
                    {o.label}
                  </span>
                  {o.hint && <span className="block text-[13px] text-slate-500 leading-snug mt-0.5">{o.hint}</span>}
                </span>
                {o.badge && <Pill text={o.badge} tone={o.badgeTone} />}
              </motion.div>
            );
          })}
        </div>
      </AnchoredPopover>
    </>
  );
}
