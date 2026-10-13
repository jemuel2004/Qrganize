'use client';

import Link from 'next/link';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, ChevronRight, Users } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { EASE } from './charts';

/** One faculty member behind a number on an Analytics card */
export interface ListRow {
  key: string;
  name: string;
  /** e.g. "Load 18 of 18.25 units", "2 classes without a room" */
  note?: string;
  /** Their own page (Workload, Class Assignment) */
  href?: string;
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/**
 * The faculty behind a number on an Analytics card ("With Praise Load · 6"): one row each,
 * opening their page, and a button to the full page the card belongs to.
 */
export default function ListDialog({ open, title, subtitle, rows, footer, onClose }: {
  open: boolean;
  title: string;
  subtitle?: string;
  rows: ListRow[];
  footer?: { href: string; label: string };
  onClose: () => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      icon={Users}
      size="md"
      footer={footer ? (
        <div className="flex justify-end">
          <Link href={footer.href} className="group inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl text-[15px] font-bold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors" style={{ color: '#FFFFFF' }}>
            {footer.label} <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" style={{ color: '#FFFFFF' }} />
          </Link>
        </div>
      ) : undefined}
    >
      {rows.length === 0 ? (
        <p className="py-8 text-center text-[15px] text-[#64748B]">No one here right now.</p>
      ) : (
        <ul className="rounded-xl border border-[#E2E8F0] divide-y divide-[#F1F5F9] overflow-hidden">
          {rows.map((r, i) => {
            const body = (
              <>
                <span className="w-10 h-10 rounded-full bg-[#EFF6FF] text-[#1D5BD6] text-[13px] font-bold flex items-center justify-center flex-shrink-0" aria-hidden>
                  {initials(r.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-bold text-[#0B2A5B] truncate">{r.name}</span>
                  {r.note && <span className="block text-[13px] text-[#64748B]">{r.note}</span>}
                </span>
                {r.href && <ChevronRight className="w-5 h-5 flex-shrink-0 text-[#1D5BD6] transition-transform duration-200 group-hover:translate-x-0.5" aria-hidden />}
              </>
            );
            return (
              <motion.li
                key={r.key}
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 10) * 0.03 } }}
              >
                {r.href
                  ? <Link href={r.href} className="group flex items-center gap-3 px-4 py-3 hover:bg-[#F4F7FC] transition-colors">{body}</Link>
                  : <div className="flex items-center gap-3 px-4 py-3">{body}</div>}
              </motion.li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
