'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronLeft } from 'lucide-react';
import { backTarget } from '@/lib/navTrail';

/** How long the "Going back…" ring may spin if the page never changes */
const PENDING_MAX_MS = 10_000;

/**
 * Returns to wherever the user actually came from (router.back()),
 * not a hardcoded route — keeps entry point (Dashboard, a workflow
 * step, another list page, etc.) intact. A page opened fresh, with no
 * earlier page in the app, goes to the home page instead of leaving the app.
 *
 * On click the arrow turns into a spinning ring ("Going back…") until the
 * page it goes to takes over, so a slow page still answers the click at once.
 */
export default function BackButton({
  label = 'Back',
  variant = 'light',
  className = '',
}: {
  label?: string;
  /** 'light' for white/pale page backgrounds, 'dark' for dark hero/banner backgrounds. */
  variant?: 'light' | 'dark';
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();
  // The page the click was made on — a new page ends the pending look by itself
  const [pendingOn, setPendingOn] = useState<string | null>(null);
  const pending = pendingOn === pathname;
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const variantClass = variant === 'dark'
    ? 'text-white/90 hover:text-white hover:bg-white/10'
    : 'text-[#1D5BD6] hover:text-[#164BB5] hover:bg-[#EFF6FF]';
  const ringClass = variant === 'dark' ? 'border-white/30 border-t-white' : 'border-[#BFD3F5] border-t-[#1D5BD6]';
  return (
    <motion.button
      type="button"
      // A soft press; the arrow nudges left on hover (calm, never snappy)
      whileTap={reduceMotion || pending ? undefined : { scale: 0.96 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      onClick={() => {
        if (pending) return;
        setPendingOn(pathname);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPendingOn(null), PENDING_MAX_MS);
        // Two frames: the ring is on screen before the next page starts rendering
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const target = backTarget();
          if (target === 'back') router.back();
          else router.push(target);
        }));
      }}
      aria-busy={pending}
      className={`group inline-flex items-center gap-2 -ml-2.5 mb-2.5 min-h-10 px-3 py-2 rounded-xl text-[15px] font-semibold transition-colors duration-300 ${pending ? 'cursor-wait' : 'cursor-pointer'} ${variantClass} ${className}`}
    >
      {pending
        ? <span className="w-5 h-5 p-0.5" aria-hidden><span className={`block w-full h-full rounded-full border-[2.5px] ${ringClass} animate-spin`} /></span>
        : <ChevronLeft className="w-5 h-5 transition-transform duration-300 ease-out group-hover:-translate-x-1" />}
      {pending ? 'Going back…' : label}
    </motion.button>
  );
}
