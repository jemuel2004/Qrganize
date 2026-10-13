'use client';

/**
 * Room Utilization — Weekly / Monthly: "Were the booked rooms actually used?"
 *  • Pie: classes scanned vs. not scanned (the class's own faculty scanned its
 *    room's QR code — or not). Only classes that already
 *    started count — walk-ins and classes still to come don't.
 *  • Rooms with missed scans: most missed first (5, then Show all). View
 *    opens that room's history on just its missed classes.
 * Counts only — no hours or percentages (easy to read).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useReducedMotion } from 'framer-motion';
import { CheckCircle2, ChevronDown, Eye } from 'lucide-react';
import { DonutChart, DonutLegend, PLAN_VARS, type Slice } from '@/components/roomPlanning/RoomPlanningCharts';
import { AutoHeight, EASE, motion, RoomIcon, type UtilRoom } from './shared';

export interface MissedRoom { room: UtilRoom; held: number; missed: number }

/** Rooms shown before "Show all" */
const SHOWN = 5;
const CARD = 'bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] min-w-0';
/* Scanned = the app blue (as the other pies), not scanned = amber (as the
   "Not scanned" card on Daily) — a colour-blind-safe pair, always with its label */
const VARS = `${PLAN_VARS} [--ru-miss:#F59E0B] [html:not(.light)_&]:[--ru-miss:#D97706]`;
const isLab = (type: string) => type === 'Laboratory' || type === 'Computer Lab';

export default function CheckinSummary({ checked, missed, rooms, period, ongoing, hrefOf }: {
  checked: number;
  missed: number;
  /** Rooms with at least one missed scan, most missed first */
  rooms: MissedRoom[];
  period: 'week' | 'month';
  /** The period includes today — its numbers are "so far" */
  ongoing: boolean;
  hrefOf: (roomId: number) => string;
}) {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const held = checked + missed;

  if (held === 0) {
    return (
      <div className={`${CARD} px-6 py-14 text-center`}>
        <p className="text-lg font-bold text-[#0B2A5B]">No classes yet</p>
        <p className="mt-1 text-[15px] text-[#64748B]">No class has started in this {period}.</p>
      </div>
    );
  }

  const slices: Slice[] = [
    { key: 'in', label: 'Scanned', value: checked, color: 'var(--plan-use)' },
    { key: 'miss', label: 'Not scanned', value: missed, color: 'var(--ru-miss)' },
  ];
  const shown = all ? rooms : rooms.slice(0, SHOWN);

  return (
    <div className={`grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-5 items-stretch ${VARS}`}>
      {/* ── Pie: the answer in the middle, one short line above ── */}
      <motion.section
        initial={reduceMotion ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE } }}
        className={`${CARD} p-5 sm:p-6 flex flex-col`}
      >
        <h2 className="text-[15px] font-semibold text-[#64748B]">Classes scanned</h2>
        <p className={`mt-1 text-[20px] font-bold leading-snug ${missed ? 'text-[#B45309]' : 'text-[#047857]'}`}>
          {missed ? `${missed} ${missed === 1 ? 'was' : 'were'} not scanned` : 'Every class was scanned'}
        </p>
        <p className="mt-0.5 text-[15px] text-[#64748B]">{ongoing ? 'Classes so far' : 'All classes'} in this {period}</p>
        <div className="mt-6 flex-1 flex flex-col items-center justify-center gap-5">
          <DonutChart
            slices={slices}
            size={188}
            label="Classes scanned"
            active={active}
            onActive={setActive}
            center={
              <>
                <span className="text-[34px] font-bold text-[#0B2A5B] leading-none tabular-nums">{checked}</span>
                <span className="mt-1 text-[15px] text-[#64748B]">of {held}</span>
              </>
            }
          />
          <div className="w-full max-w-[300px]">
            <DonutLegend slices={slices} showShare={false} active={active} onActive={setActive} />
          </div>
        </div>
      </motion.section>

      {/* ── Rooms with missed scans ── */}
      <motion.section
        initial={reduceMotion ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE, delay: reduceMotion ? 0 : 0.08 } }}
        className={`${CARD} overflow-hidden flex flex-col`}
      >
        <div className="px-5 sm:px-6 py-4 border-b border-[#EEF2F8]">
          <h2 className="text-lg font-bold text-[#0B2A5B]">Rooms with missed scans</h2>
        </div>

        {rooms.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-14">
            <span className="w-14 h-14 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7" />
            </span>
            <p className="mt-3 text-lg font-bold text-[#0B2A5B]">No missed scans</p>
          </div>
        ) : (
          <>
            <AutoHeight>
              <ul className="divide-y divide-[#F1F5F9]">
                {shown.map((x, i) => (
                  <motion.li
                    key={x.room.id}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE, delay: reduceMotion ? 0 : (i % SHOWN) * 0.05 } }}
                    className="flex items-center gap-3 sm:gap-4 px-5 sm:px-6 py-4"
                  >
                    <span className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                      isLab(x.room.room_type) ? 'bg-amber-50 text-amber-600' : 'bg-[#EFF6FF] text-[#1D5BD6]'
                    }`}>
                      <RoomIcon type={x.room.room_type} className="w-5 h-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-x-3 gap-y-0.5">
                        <span className="text-base font-semibold text-[#0B2A5B] truncate">{x.room.room_name}</span>
                        <span className="text-[15px] text-[#475569] tabular-nums whitespace-nowrap">
                          <span className="font-bold text-[#B45309]">{x.missed}</span> of {x.held} not scanned
                        </span>
                      </div>
                      <div className="mt-2 h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--donut-track)' }}>
                        <motion.div
                          className="h-full rounded-full"
                          style={{ backgroundColor: 'var(--ru-miss)' }}
                          initial={reduceMotion ? false : { width: 0 }}
                          animate={{ width: `${Math.max(4, Math.round((x.missed / x.held) * 100))}%` }}
                          transition={{ duration: reduceMotion ? 0 : 0.6, ease: EASE, delay: reduceMotion ? 0 : 0.1 }}
                        />
                      </div>
                    </div>
                    <Link
                      href={hrefOf(x.room.id)}
                      aria-label={`View the missed classes in ${x.room.room_name}`}
                      className="inline-flex items-center gap-1.5 h-10 px-3.5 rounded-lg border border-[#D6E0EF] text-sm font-semibold text-[#0B2A5B] hover:border-[#9DB8E8] hover:text-[#1D5BD6] hover:bg-[#F8FBFF] transition-colors flex-shrink-0"
                    >
                      <Eye className="w-4 h-4" /> View
                    </Link>
                  </motion.li>
                ))}
              </ul>
            </AutoHeight>
            {rooms.length > SHOWN && (
              <button
                type="button"
                onClick={() => setAll(a => !a)}
                aria-expanded={all}
                className="mt-auto w-full flex items-center justify-center gap-2 h-12 border-t border-[#EEF2F8] text-[15px] font-semibold text-[#1D5BD6] hover:bg-[#F8FBFF] [html:not(.light)_&]:hover:bg-white/5 transition-colors"
              >
                {all ? 'Show fewer' : `Show all ${rooms.length} rooms`}
                <motion.span animate={{ rotate: all ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.4, ease: EASE }} className="inline-flex">
                  <ChevronDown className="w-4 h-4" />
                </motion.span>
              </button>
            )}
          </>
        )}
      </motion.section>
    </div>
  );
}
