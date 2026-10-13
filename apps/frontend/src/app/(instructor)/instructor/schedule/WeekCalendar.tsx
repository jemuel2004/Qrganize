'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { QrCode, ShieldCheck, DoorOpen } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeletons';
import { dayTone } from '@/lib/dayTones';
import { WEEK_DAYS, shortDay, type WeekDay } from '@shared/dayCombination';
import { clock12, clockRange12 } from '@shared/clock12';
import { LUNCH_END_MIN, LUNCH_START_MIN, SCHOOL_DAY_END_MIN, SCHOOL_DAY_START_MIN } from '@shared/schoolDay';

/** One meeting of a class on the calendar (a session on one day) */
export interface CalendarEvent {
  key: string;
  msId: number;
  day: WeekDay;
  startMin: number;
  endMin: number;
  subject_code: string;
  subject_name: string;
  /** "BSIT 4B" */
  blockLabel: string;
  room_name: string | null;
  part: 'lec' | 'lab' | null;
}

/** What a class block on today's column shows about QR scanning (others: in the details) */
export type CalendarFlag = 'scan' | 'in-use' | 'released' | null;

/** "08:30:00" → 510 */
export const minutesOf = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

/** Monday–Friday always; Saturday / Sunday only when there are classes then */
export function calendarDays(events: CalendarEvent[]): WeekDay[] {
  return WEEK_DAYS.filter((d, i) => i < 5 || events.some(e => e.day === d));
}

/** 7 AM – 6 PM (the school day), widened to whole hours if a class falls outside it */
function hourRange(events: CalendarEvent[]): { from: number; to: number } {
  const first = Math.min(SCHOOL_DAY_START_MIN, ...events.map(e => e.startMin));
  const last = Math.max(SCHOOL_DAY_END_MIN, ...events.map(e => e.endMin));
  return { from: Math.floor(first / 60) * 60, to: Math.ceil(last / 60) * 60 };
}

/** Side-by-side lanes for classes that overlap on one day (normally there are none) */
function withLanes(dayEvents: CalendarEvent[]): { e: CalendarEvent; lane: number; lanes: number }[] {
  const sorted = [...dayEvents].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: { e: CalendarEvent; lane: number; lanes: number }[] = [];
  let cluster: { e: CalendarEvent; lane: number; lanes: number }[] = [];
  let clusterEnd = -1;
  const close = () => { const n = Math.max(1, ...cluster.map(c => c.lane + 1)); cluster.forEach(c => { c.lanes = n; }); out.push(...cluster); cluster = []; };
  for (const e of sorted) {
    if (e.startMin >= clusterEnd && cluster.length) close();
    const used = new Set(cluster.filter(c => c.e.endMin > e.startMin).map(c => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ e, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, e.endMin);
  }
  if (cluster.length) close();
  return out;
}

const hourLabel = (min: number) => clock12(min).replace(':00', '');
const FLAG: Record<Exclude<CalendarFlag, null>, { label: string; Icon: typeof QrCode; cls: string }> = {
  scan: { label: 'Scan now', Icon: QrCode, cls: 'bg-emerald-600 border-emerald-600' },
  'in-use': { label: 'In use', Icon: ShieldCheck, cls: 'bg-emerald-600 border-emerald-600' },
  released: { label: 'Freed', Icon: DoorOpen, cls: 'bg-slate-500 border-slate-500' },
};

function EventBlock({ e, lane, lanes, from, hourPx, flag, wide, onOpen }: {
  e: CalendarEvent; lane: number; lanes: number; from: number; hourPx: number;
  flag: CalendarFlag; wide: boolean; onOpen: (e: CalendarEvent) => void;
}) {
  const reduceMotion = useReducedMotion();
  const t = dayTone(e.day);
  const top = ((e.startMin - from) / 60) * hourPx;
  const height = Math.max(30, ((e.endMin - e.startMin) / 60) * hourPx - 3);
  const f = flag ? FLAG[flag] : null;
  return (
    <motion.button
      type="button"
      onClick={() => onOpen(e)}
      whileHover={reduceMotion ? undefined : { y: -1 }}
      whileTap={reduceMotion ? undefined : { scale: 0.98 }}
      transition={{ duration: 0.15 }}
      aria-label={`${e.subject_code} ${e.blockLabel}, ${clockRange12(e.startMin, e.endMin)}${e.room_name ? `, ${e.room_name}` : ''}`}
      className="absolute rounded-lg border border-l-4 text-left overflow-hidden px-2 py-1.5 shadow-[0_1px_2px_rgba(11,42,91,0.08)] hover:shadow-[0_6px_14px_-8px_rgba(11,42,91,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/50 transition-shadow"
      style={{
        top: top + 1,
        height,
        left: `calc(${(lane / lanes) * 100}% + 3px)`,
        width: `calc(${100 / lanes}% - 6px)`,
        backgroundColor: t.bg,
        borderColor: t.border,
        borderLeftColor: t.bar,
      }}
    >
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="text-[15px] font-bold leading-tight truncate" style={{ color: t.text }}>{e.subject_code}</span>
        {e.part && (
          <span className="text-[12px] font-semibold leading-none flex-shrink-0 text-[#475569]">{e.part === 'lab' ? 'Lab' : 'Lec'}</span>
        )}
        {f && (
          <span className={`ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] font-bold leading-none flex-shrink-0 ${f.cls} ${flag === 'scan' ? 'animate-pulse' : ''}`} style={{ color: '#FFFFFF' }}>
            <f.Icon className="w-3 h-3" aria-hidden /> {f.label}
          </span>
        )}
      </span>
      <span className="block text-[13px] font-semibold text-[#0B2A5B] tabular-nums leading-snug truncate">{clockRange12(e.startMin, e.endMin)}</span>
      {height >= 58 && (
        <span className="block text-[13px] text-[#334155] leading-snug truncate">
          <span className="font-semibold">{e.blockLabel}</span>
          {e.room_name ? <> · {e.room_name}</> : <span className="text-[#B45309]"> · No room</span>}
        </span>
      )}
      {wide && height >= 84 && (
        <span className="block text-[13px] text-[#475569] leading-snug truncate">{e.subject_name}</span>
      )}
    </motion.button>
  );
}

/** Hour lines, the lunch band and the classes of one day */
function DayColumn({ day, events, from, to, hourPx, isToday, nowMin, flagOf, wide, onOpen }: {
  day: WeekDay; events: CalendarEvent[]; from: number; to: number; hourPx: number;
  isToday: boolean; nowMin: number; flagOf: (e: CalendarEvent) => CalendarFlag; wide: boolean;
  onOpen: (e: CalendarEvent) => void;
}) {
  const height = ((to - from) / 60) * hourPx;
  const lunchTop = ((LUNCH_START_MIN - from) / 60) * hourPx;
  const lunchH = ((LUNCH_END_MIN - LUNCH_START_MIN) / 60) * hourPx;
  return (
    <div
      className={`relative border-l border-[#E2E8F0] ${isToday ? 'bg-[#F5F9FF]' : ''}`}
      style={{
        height,
        backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${hourPx - 1}px, #E8EEF6 ${hourPx - 1}px, #E8EEF6 ${hourPx}px)`,
      }}
    >
      {LUNCH_START_MIN >= from && LUNCH_END_MIN <= to && (
        <div className="absolute inset-x-0 flex items-center justify-center bg-[#F1F5F9]/80" style={{ top: lunchTop, height: lunchH - 1 }} aria-hidden>
          <span className="text-[12px] font-semibold uppercase tracking-wide text-[#94A3B8]">Lunch</span>
        </div>
      )}
      {withLanes(events).map(({ e, lane, lanes }) => (
        <EventBlock key={e.key} e={e} lane={lane} lanes={lanes} from={from} hourPx={hourPx} flag={flagOf(e)} wide={wide} onOpen={onOpen} />
      ))}
      {isToday && nowMin >= from && nowMin <= to && (
        <div className="absolute inset-x-0 z-10 pointer-events-none" style={{ top: ((nowMin - from) / 60) * hourPx }} aria-hidden>
          <div className="relative h-0.5 bg-[#DC2626]">
            <span className="absolute -left-1 -top-[3px] w-2 h-2 rounded-full bg-[#DC2626]" />
          </div>
        </div>
      )}
      <span className="sr-only">{day}</span>
    </div>
  );
}

/** The hour labels down the left side */
function TimeGutter({ from, to, hourPx }: { from: number; to: number; hourPx: number }) {
  const hours = Array.from({ length: (to - from) / 60 + 1 }, (_, i) => from + i * 60);
  return (
    <div className="relative" style={{ height: ((to - from) / 60) * hourPx }} aria-hidden>
      {hours.map((m, i) => (
        <span
          key={m}
          className="absolute right-2 text-[13px] font-semibold text-[#64748B] tabular-nums whitespace-nowrap leading-none"
          style={{ top: i * hourPx - 6 }}
        >
          {hourLabel(m)}
        </span>
      ))}
    </div>
  );
}

/**
 * Weekly calendar of a faculty's classes, 7 AM to 6 PM.
 * Tablets and up: every day side by side. Phones: one day at a time (day tabs on top).
 */
export default function WeekCalendar({ events, todayName, nowMin, flagOf, onOpen }: {
  events: CalendarEvent[];
  todayName: string;
  /** Minutes after midnight now, for the red now-line on today */
  nowMin: number;
  flagOf: (e: CalendarEvent) => CalendarFlag;
  onOpen: (e: CalendarEvent) => void;
}) {
  const reduceMotion = useReducedMotion();
  const days = calendarDays(events);
  const { from, to } = hourRange(events);
  const byDay = (d: WeekDay) => events.filter(e => e.day === d);
  const todayShown = days.includes(todayName as WeekDay) ? (todayName as WeekDay) : null;
  const [pickedDay, setPickedDay] = useState<WeekDay | null>(null);
  const phoneDay = pickedDay && days.includes(pickedDay)
    ? pickedDay
    : todayShown ?? days.find(d => byDay(d).length > 0) ?? days[0];
  const cols = { gridTemplateColumns: `64px repeat(${days.length}, minmax(0, 1fr))` };

  return (
    <>
      {/* ── Phones: day tabs + one day ── */}
      <div className="md:hidden">
        <div className="grid gap-1.5 mb-3" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }} role="tablist" aria-label="Day">
          {days.map(d => {
            const active = d === phoneDay;
            const t = dayTone(d);
            const n = byDay(d).length;
            return (
              <motion.button
                key={d}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setPickedDay(d)}
                whileTap={reduceMotion ? undefined : { scale: 0.95 }}
                animate={{ backgroundColor: active ? t.bar : '#FFFFFF', borderColor: active ? t.bar : t.border, color: active ? '#FFFFFF' : t.text }}
                transition={{ duration: reduceMotion ? 0 : 0.2 }}
                className="relative flex flex-col items-center justify-center h-14 rounded-xl border-2 font-bold min-w-0"
              >
                <span className="text-[15px] leading-tight">{shortDay(d)}</span>
                <span className="text-[12px] font-semibold leading-tight opacity-90 tabular-nums">{n} class{n === 1 ? '' : 'es'}</span>
                {d === todayShown && (
                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 px-1 rounded text-[10px] font-bold uppercase leading-tight bg-white border" style={{ color: t.text, borderColor: t.border }}>Today</span>
                )}
              </motion.button>
            );
          })}
        </div>
        <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
          <div className="grid pt-3 pb-3 pr-2" style={{ gridTemplateColumns: '56px minmax(0, 1fr)' }}>
            <TimeGutter from={from} to={to} hourPx={78} />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={phoneDay}
                initial={reduceMotion ? false : { opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, transition: { duration: 0.1 } }}
                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              >
                <DayColumn day={phoneDay} events={byDay(phoneDay)} from={from} to={to} hourPx={78}
                  isToday={phoneDay === todayShown} nowMin={nowMin} flagOf={flagOf} wide onOpen={onOpen} />
              </motion.div>
            </AnimatePresence>
          </div>
          {byDay(phoneDay).length === 0 && (
            <p className="px-4 pb-4 -mt-1 text-center text-[15px] text-[#64748B]">No classes on {phoneDay}.</p>
          )}
        </div>
      </div>

      {/* ── Tablets and up: the whole week ── */}
      <div className="hidden md:block bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
        <div className="grid border-b border-[#E2E8F0] bg-[#F8FAFC]" style={cols}>
          <div />
          {days.map(d => {
            const t = dayTone(d);
            const isToday = d === todayShown;
            const n = byDay(d).length;
            return (
              <div key={d} className={`border-l border-[#E2E8F0] px-2 py-2.5 text-center ${isToday ? 'bg-[#EAF1FD]' : ''}`}>
                <div className="flex items-center justify-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: t.bar }} aria-hidden />
                  <span className="text-[15px] font-bold text-[#0B2A5B]">{d}</span>
                </div>
                <div className="text-[13px] font-semibold tabular-nums" style={{ color: isToday ? '#1D5BD6' : '#64748B' }}>
                  {isToday ? 'Today · ' : ''}{n} class{n === 1 ? '' : 'es'}
                </div>
              </div>
            );
          })}
        </div>
        <div className="grid pt-3 pb-3" style={cols}>
          <TimeGutter from={from} to={to} hourPx={72} />
          {days.map(d => (
            <DayColumn key={d} day={d} events={byDay(d)} from={from} to={to} hourPx={72}
              isToday={d === todayShown} nowMin={nowMin} flagOf={flagOf} wide={days.length <= 5} onOpen={onOpen} />
          ))}
        </div>
      </div>
    </>
  );
}

/** Same shape as the calendar while it loads */
export function WeekCalendarSkeleton() {
  return (
    <>
      <div className="md:hidden">
        <div className="grid grid-cols-5 gap-1.5 mb-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div>
        <Skeleton className="h-[880px] rounded-2xl" />
      </div>
      <div className="hidden md:block bg-white rounded-2xl border border-[#E2E8F0] overflow-hidden">
        <div className="grid border-b border-[#E2E8F0] bg-[#F8FAFC] px-2 py-3 gap-3" style={{ gridTemplateColumns: '64px repeat(5, minmax(0, 1fr))' }}>
          <div />
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-9 rounded-lg" />)}
        </div>
        <div className="grid gap-3 p-3" style={{ gridTemplateColumns: '64px repeat(5, minmax(0, 1fr))' }}>
          <Skeleton className="h-[792px] rounded-lg" />
          {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[792px] rounded-lg opacity-60" />)}
        </div>
      </div>
    </>
  );
}

