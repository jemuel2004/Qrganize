'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

const EASE = [0.4, 0, 0.2, 1] as const;

/** Animates its height to fit its content, so a panel glides instead of
 *  jumping when what's inside changes size. */
export default function AutoHeight({ children, className }: { children: ReactNode; className?: string }) {
  const reduceMotion = useReducedMotion();
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <motion.div
      className={className}
      initial={false}
      animate={{ height }}
      transition={{ duration: reduceMotion ? 0 : 0.32, ease: EASE }}
    >
      <div ref={innerRef}>{children}</div>
    </motion.div>
  );
}
