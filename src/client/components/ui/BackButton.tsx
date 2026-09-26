'use client';

import { useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

/**
 * Returns to wherever the user actually came from (router.back()),
 * not a hardcoded route — keeps entry point (Dashboard, a workflow
 * step, another list page, etc.) intact.
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
  const variantClass = variant === 'dark'
    ? 'text-white/90 hover:text-white hover:bg-white/10'
    : 'text-[#1D5BD6] hover:text-[#164BB5] hover:bg-[#EFF6FF]';
  return (
    <button
      type="button"
      onClick={() => router.back()}
      className={`inline-flex items-center gap-2 -ml-2.5 mb-2.5 min-h-10 px-3 py-2 rounded-xl text-[15px] font-semibold transition-colors cursor-pointer ${variantClass} ${className}`}
    >
      <ChevronLeft className="w-5 h-5" /> {label}
    </button>
  );
}
