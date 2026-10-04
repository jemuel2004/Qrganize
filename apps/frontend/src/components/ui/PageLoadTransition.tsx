'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Cards that rise in one after another when a page's content (re)appears
 * after its skeleton. Spread onto a motion element: order 0, 1, 2…
 */
export function revealProps(order: number, reduceMotion: boolean | null) {
  if (reduceMotion) return {};
  return {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.35, ease: EASE, delay: 0.04 + order * 0.07 },
  };
}

function mergeClassName(...parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(' ') || undefined;
}

/**
 * Shared skeleton ↔ content transition for protected pages.
 * Navbar/shell stay outside this wrapper.
 *
 * - Opacity-only content enter (no translate/scale) — layout size stays stable.
 * - Skeleton exits instantly (no fade-out collapse gap before content mounts).
 * - Wrappers always use w-full min-w-0 so they match max-w-7xl page shells.
 */
export function PageLoadTransition({
  showSkeleton,
  skeleton,
  children,
  className = '',
}: {
  showSkeleton: boolean;
  skeleton: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.18, ease: EASE };
  const frameClass = mergeClassName('w-full min-w-0', className);

  return (
    <AnimatePresence mode="wait" initial={false}>
      {showSkeleton ? (
        <div key="page-skeleton" className={frameClass}>
          {skeleton}
        </div>
      ) : (
        <motion.div
          key="page-content"
          className={frameClass}
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={transition}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
