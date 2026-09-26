'use client';

import React from 'react';
import { Search, X, ChevronDown, Calendar, Lock } from 'lucide-react';

/* ─────────────────────────────────────────────────────────────────────────────
   QRganize Design System — Search & Filter Tokens  (Facebook-inspired)
   ─────────────────────────────────────────────────────────────────────────────
   Philosophy: neutral gray background instead of a visible border.
   Focus state = background lifts to white + feather shadow on the wrapper.
   No blue ring. No harsh outline. Smooth, accessible, modern.
   ───────────────────────────────────────────────────────────────────────────── */

// ─── Token strings ────────────────────────────────────────────────────────────

/**
 * Standard text input — borderless, neutral gray bg, white on focus.
 * Use for raw <input> elements inside form modals/panels.
 */
export const SF_INPUT =
  'w-full bg-slate-100 rounded-xl px-3 py-2.5 text-sm text-slate-800 ' +
  'placeholder:text-slate-400 transition-all duration-200 ' +
  'border-0 outline-none ' +
  'hover:bg-slate-200/60 focus:bg-white focus:shadow-[0_2px_10px_rgba(0,0,0,0.08)]';

/**
 * Native <select> base — bg is set dynamically by FilterSelect based on value.
 * Import SF_SELECT only if you need raw select styling outside FilterSelect.
 * appearance-none hides the browser arrow; FilterSelect adds one custom ChevronDown.
 */
const SF_SELECT =
  'w-full rounded-xl px-3 py-2.5 text-sm text-slate-800 ' +
  'placeholder:text-slate-400 transition-all duration-200 ' +
  'border-0 outline-none appearance-none bg-none cursor-pointer';

/**
 * Disabled / read-only display field (e.g. semester, school year).
 * Includes appearance-none so native <select> arrows never stack with FilterSelect's chevron.
 */
export const SF_DISABLED =
  'w-full bg-slate-50 rounded-xl px-3 py-2.5 text-sm text-slate-400 ' +
  'cursor-not-allowed select-none border border-dashed border-slate-200 outline-none appearance-none opacity-70';

/**
 * Read-only display field with optional icon.
 */
const SF_READONLY =
  'flex items-center gap-2 bg-slate-100 rounded-xl px-3 py-2.5 ' +
  'text-sm text-slate-500 select-none border-0';

/**
 * Soft surface for a filter row — light elevation, no hard outline.
 */
const SF_PANEL =
  'bg-white rounded-2xl border border-[#E2E8F0]/70 shadow-sm p-5 mb-5';

// ─── SearchInput ──────────────────────────────────────────────────────────────

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes on the wrapper div */
  className?: string;
  autoFocus?: boolean;
  showIcon?: boolean;
}

/**
 * Facebook-style search bar.
 * Wrapper div owns all visual states (bg, shadow) so focus-within works cleanly
 * without interference from the global input:focus CSS rule.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  disabled = false,
  className = '',
  autoFocus = false,
  showIcon = true,
}: SearchInputProps) {
  const filled = value.trim() !== '';
  return (
    <div
      className={[
        'flex items-center gap-2.5 rounded-2xl px-4 py-2.5 transition-all duration-200',
        disabled
          ? 'bg-slate-50 border border-dashed border-slate-200 opacity-70 cursor-not-allowed'
          : filled
            /* Has text → white, stays white on hover/focus */
            ? 'bg-white shadow-[0_1px_3px_rgba(0,0,0,0.05)] hover:bg-slate-50 focus-within:shadow-[0_2px_12px_rgba(0,0,0,0.09)]'
            /* Empty → prompt gray, lifts to white on focus */
            : 'bg-slate-100 hover:bg-slate-200/60 focus-within:bg-white focus-within:shadow-[0_2px_12px_rgba(0,0,0,0.09)]',
        className,
      ].join(' ')}
    >
      {showIcon && <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />}
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={disabled ? 'Select a filter first' : placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        /* border-0 + outline-none ensure the global input:focus rule has nothing
           to colour; all visual focus is handled by the wrapper's focus-within. */
        className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-slate-700 placeholder:text-slate-400 disabled:cursor-not-allowed disabled:text-slate-500"
      />
      {value && !disabled && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          className="flex-shrink-0 text-slate-400 hover:text-slate-600 transition-colors rounded-full p-0.5 hover:bg-slate-200/80"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// ─── FilterSelect ─────────────────────────────────────────────────────────────

interface FilterSelectProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
  label?: string;
}

/**
 * Native <select> with a custom chevron.
 * The wrapper div owns the focus shadow so it's immune to the global CSS rule.
 */
export function FilterSelect({
  value,
  onChange,
  disabled = false,
  className = '',
  children,
  label,
}: FilterSelectProps) {
  /* Empty/placeholder → slate-100 ("fill me in").
     Has a selection   → white     ("done, clean").  */
  const isEmpty = !value || value === '';

  const activeBg = isEmpty
    ? 'bg-slate-100 hover:bg-slate-200/60'
    : 'bg-white hover:bg-slate-50';

  return (
    <div
      className={[
        'relative rounded-xl transition-all duration-200',
        !disabled && 'focus-within:shadow-[0_2px_10px_rgba(0,0,0,0.08)]',
        disabled && 'pointer-events-none',
      ].filter(Boolean).join(' ')}
    >
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
        className={[
          disabled
            ? SF_DISABLED
            : [SF_SELECT, activeBg].join(' '),
          /* Always strip native arrow — custom ChevronDown is the only indicator */
          'appearance-none bg-none pr-8',
          className,
        ].join(' ')}
      >
        {children}
      </select>
      {disabled ? (
        <Lock
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-300"
        />
      ) : (
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400"
        />
      )}
    </div>
  );
}

// ─── ReadonlyField ────────────────────────────────────────────────────────────

interface ReadonlyFieldProps {
  value: string | null | undefined;
  icon?: React.ReactNode;
  placeholder?: string;
  className?: string;
}

/**
 * Non-editable display field — semester / academic year driven by global settings.
 */
export function ReadonlyField({
  value,
  icon,
  placeholder = '—',
  className = '',
}: ReadonlyFieldProps) {
  return (
    <div className={[SF_READONLY, className].join(' ')}>
      {icon ?? <Calendar className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />}
      <span className="truncate text-slate-600 font-medium">{value || placeholder}</span>
    </div>
  );
}

// ─── FilterBar ────────────────────────────────────────────────────────────────

interface FilterBarProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * White card wrapper for filter rows — shadow instead of border.
 */
export function FilterBar({ children, className = '' }: FilterBarProps) {
  return (
    <div className={[SF_PANEL, className].join(' ')}>
      {children}
    </div>
  );
}
