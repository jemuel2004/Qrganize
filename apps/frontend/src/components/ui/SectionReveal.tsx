'use client';

import { motion, useReducedMotion } from 'framer-motion';

/**
 * Shows that a card or tab just opened another section (Actual Load, Regular
 * Load, Overload, Praise Load): the content fades in and rises into place each
 * time `sectionKey` changes. `play` stays false until the user has switched once,
 * so the first display (which has its own page transition) and live refreshes
 * (same key) don't move.
 */
export default function SectionReveal({
  sectionKey, play, offsetX = 0, className, children,
}: {
  sectionKey: string;
  play: boolean;
  /** Also come in from the side the user moved toward (-1 left, 1 right) */
  offsetX?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      key={sectionKey}
      initial={play && !reduceMotion ? { opacity: 0, y: 22, x: 20 * offsetX } : false}
      animate={{ opacity: 1, y: 0, x: 0 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
