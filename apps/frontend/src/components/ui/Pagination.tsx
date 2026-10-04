'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/*
 * Numbered pages for a long list: ‹ Previous · 1 2 3 … 6 · Next ›, with
 * "Showing 11–20 of 53 faculty". Large buttons in the same style as
 * CountFilterTabs (one highlight slides to the current page). Phones show
 * ‹ Page 2 of 6 › instead of the numbers so the row never overflows.
 */

/** Page numbers to show: all when there are few, else the first, the last and those around the current one */
export function pageItems(page: number, count: number): (number | 'gap')[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1);
  const from = Math.max(2, Math.min(page - 1, count - 4));
  const to = Math.min(count - 1, Math.max(page + 1, 5));
  const items: (number | 'gap')[] = [1];
  if (from > 2) items.push('gap');
  for (let p = from; p <= to; p++) items.push(p);
  if (to < count - 1) items.push('gap');
  items.push(count);
  return items;
}

const SPRING = { type: 'spring', stiffness: 420, damping: 28 } as const;

export default function Pagination({
  page,
  pageCount,
  onChange,
  layoutId,
  total,
  pageSize,
  noun = 'items',
  className = '',
}: {
  /** Current page, from 1 */
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  /** Unique per page so two pagers never share a highlight */
  layoutId: string;
  /** With pageSize: the "Showing 11–20 of 53 …" line */
  total?: number;
  pageSize?: number;
  /** What is being listed ("faculty") */
  noun?: string;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  if (pageCount <= 1) return null;
  const go = (p: number) => { if (p >= 1 && p <= pageCount && p !== page) onChange(p); };
  const arrow = 'inline-flex items-center justify-center gap-1.5 min-h-[44px] min-w-[44px] px-3 rounded-xl border-2 border-[#CBD5E1] bg-white text-[15px] font-bold text-[#0B2A5B] transition-colors duration-200 hover:border-[#1D5BD6] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-[#CBD5E1]';

  return (
    <nav aria-label="Pages" className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 ${className}`}>
      {total != null && pageSize != null && (
        <p className="text-[14px] text-[#475569] tabular-nums">
          Showing <span className="font-semibold text-[#0B2A5B]">{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)}</span> of{' '}
          <span className="font-semibold text-[#0B2A5B]">{total}</span> {noun}
        </p>
      )}
      <div className="flex items-center gap-1.5 self-center sm:self-auto">
        <motion.button
          type="button"
          onClick={() => go(page - 1)}
          disabled={page <= 1}
          whileTap={reduceMotion || page <= 1 ? undefined : { scale: 0.95 }}
          transition={SPRING}
          aria-label="Previous page"
          className={arrow}
        >
          <ChevronLeft className="w-4 h-4" aria-hidden="true" />
          <span className="hidden md:inline">Previous</span>
        </motion.button>

        {/* Phones: just where you are */}
        <span className="sm:hidden px-3 text-[15px] font-bold text-[#0B2A5B] tabular-nums whitespace-nowrap">
          Page {page} of {pageCount}
        </span>

        {pageItems(page, pageCount).map((item, i) => item === 'gap' ? (
          <span key={`gap-${i}`} className="hidden sm:inline-flex w-6 justify-center text-[15px] font-bold text-[#64748B]" aria-hidden="true">…</span>
        ) : (
          <motion.button
            key={item}
            type="button"
            onClick={() => go(item)}
            aria-label={`Page ${item}`}
            aria-current={item === page ? 'page' : undefined}
            whileHover={reduceMotion || item === page ? undefined : { y: -2 }}
            whileTap={reduceMotion ? undefined : { scale: 0.95 }}
            transition={SPRING}
            className={`relative isolate hidden sm:inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-2 rounded-xl border-2 text-[15px] font-bold tabular-nums transition-[border-color,color,box-shadow] duration-200 ${
              item === page ? 'border-transparent shadow-[0_8px_18px_-10px_rgba(11,42,91,0.55)]' : 'bg-white border-[#CBD5E1] text-[#0B2A5B] hover:border-[#1D5BD6]'
            }`}
            // White set inline — the light-mode rule repaints `text-white` as dark ink
            style={item === page ? { color: '#FFFFFF' } : undefined}
          >
            {item === page && (
              <motion.span
                layoutId={layoutId}
                className="absolute -inset-[2px] -z-10 rounded-xl bg-[#1D5BD6]"
                transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 32 }}
                aria-hidden="true"
              />
            )}
            {item}
          </motion.button>
        ))}

        <motion.button
          type="button"
          onClick={() => go(page + 1)}
          disabled={page >= pageCount}
          whileTap={reduceMotion || page >= pageCount ? undefined : { scale: 0.95 }}
          transition={SPRING}
          aria-label="Next page"
          className={arrow}
        >
          <span className="hidden md:inline">Next</span>
          <ChevronRight className="w-4 h-4" aria-hidden="true" />
        </motion.button>
      </div>
    </nav>
  );
}
