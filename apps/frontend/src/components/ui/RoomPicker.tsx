'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronDown, DoorOpen, FlaskConical, Monitor, Users } from 'lucide-react';
import AnchoredPopover from './AnchoredPopover';

/*
 * Room picker for the Scheduling session table.
 *
 * A searchable grid of room cards (optionally filtered by room type) — each
 * card shows the room, its capacity and a Free / Busy status. A room already
 * booked at the session's current day/time can still be picked — the page then
 * moves the session to that room's first free time, and the Time picker greys
 * out only the room's occupied times. Free rooms are listed first.
 */

export interface RoomOption {
  id: number;
  room_name: string;
  room_type: string;
  capacity?: number | null;
  /** Set when the room is already booked at this session's current day/time */
  busyWith?: string | null;
}

const EASE = [0.4, 0, 0.2, 1] as const;

function RoomTypeIcon({ type, className }: { type: string | null; className?: string }) {
  if (type === 'Computer Lab') return <Monitor className={className} />;
  if (type === 'Laboratory') return <FlaskConical className={className} />;
  return <DoorOpen className={className} />;
}

export default function RoomPicker({
  value,
  onChange,
  rooms,
  day,
  warnEmpty = false,
}: {
  /** room id as string, '' = none */
  value: string;
  onChange: (value: string) => void;
  rooms: RoomOption[];
  component: 'lec' | 'lab';
  /** Selected day ('' = no day yet — availability unknown) */
  day: string;
  /** e.g. "8:30 AM – 10:00 AM", shown in the header */
  timeLabel?: string;
  /** Highlight the trigger when no room is chosen (Laboratory needs one) */
  warnEmpty?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [focusIdx, setFocusIdx] = useState(-1);
  const close = useCallback(() => setOpen(false), []);

  const selected = rooms.find(r => String(r.id) === value) ?? null;
  const selectedBusy = !!selected?.busyWith;
  const types = useMemo(() => [...new Set(rooms.map(r => r.room_type))].sort(), [rooms]);

  // Free rooms first, then booked; natural name order (Lecture-2 before Lecture-10)
  const list = useMemo(() => rooms
    .filter(r => typeFilter === 'all' || r.room_type === typeFilter)
    .sort((a, b) =>
      Number(!!a.busyWith) - Number(!!b.busyWith)
      || a.room_name.localeCompare(b.room_name, undefined, { numeric: true })),
  [rooms, typeFilter]);


  useEffect(() => {
    if (!open) return;
    setTypeFilter('all');
    setFocusIdx(-1);
    const id = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, 40);
    return () => window.clearTimeout(id);
  }, [open]);

  function choose(v: string) {
    onChange(v);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? 2 : e.key === 'ArrowUp' ? -2 : 0;
    if (step && (e.key.startsWith('Arrow'))) {
      e.preventDefault();
      setFocusIdx(i => {
        const n = Math.min(list.length - 1, Math.max(0, (i < 0 ? -1 : i) + step));
        window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>(`[data-room-id="${list[n]?.id}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
        return n;
      });
    } else if (e.key === 'Enter' && list[focusIdx]) {
      e.preventDefault();
      choose(String(list[focusIdx].id));
    }
  }

  const focusedId = list[focusIdx]?.id;

  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        onKeyDown={onKeyDown}
        whileTap={reduceMotion ? undefined : { scale: 0.97 }}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{ height: 44, minWidth: 184, maxWidth: 240 }}
        title={selectedBusy ? `Already booked: ${selected?.busyWith}` : 'Choose a room'}
        className={`inline-flex items-center gap-2.5 pl-3.5 pr-2.5 rounded-xl border bg-white text-[14px] font-semibold transition-[border-color,box-shadow,background-color] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40 ${
          selectedBusy
            ? 'border-red-300 text-red-700 bg-red-50/60'
            : open
              ? 'border-[#1D5BD6] text-[#0B2A5B] ring-2 ring-[#1D5BD6]/15'
              : warnEmpty && !selected
                ? 'border-amber-400 text-[#64748B] hover:border-amber-500'
                : `border-[#CBD5E1] hover:border-[#9DB8E8] ${selected ? 'text-[#0B2A5B]' : 'text-[#64748B]'}`
        }`}
      >
        <RoomTypeIcon
          type={selected?.room_type ?? null}
          className={`w-4 h-4 flex-shrink-0 ${selectedBusy ? 'text-red-500' : selected ? 'text-[#1D5BD6]' : 'text-[#94A3B8]'}`}
        />
        <span className="flex-1 text-left truncate">{selected ? selected.room_name : 'No room'}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.2, ease: EASE }} className="inline-flex">
          <ChevronDown className="w-4 h-4 text-[#64748B]" />
        </motion.span>
      </motion.button>

      <AnchoredPopover open={open} onClose={close} anchorRef={triggerRef} panelRef={panelRef} width={360} maxHeight={440} label="Room" onKeyDown={onKeyDown}>
        {types.length > 1 && (
          <div className="px-3 pt-3 pb-2.5 flex-shrink-0 border-b border-[#EEF2F8] flex items-center gap-1.5 flex-wrap">
            {['all', ...types].map(t => {
              const on = typeFilter === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setTypeFilter(t); setFocusIdx(-1); }}
                  className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] font-semibold border transition-colors ${
                    on ? 'bg-[#1D5BD6] border-[#1D5BD6]' : 'bg-white border-[#E2E8F0] text-[#64748B] hover:border-[#9DB8E8] hover:text-[#0B2A5B]'
                  }`}
                  style={on ? { color: '#FFFFFF' } : undefined}
                >
                  {t !== 'all' && <RoomTypeIcon type={t} className="w-3 h-3" />}
                  {t === 'all' ? 'All' : t}
                </button>
              );
            })}
          </div>
        )}

        {/* Room grid */}
        <div role="listbox" aria-label="Rooms" className="overflow-y-auto overscroll-contain p-3 flex-1 min-h-0 bg-[#FAFBFD]">
          {list.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-[#94A3B8]">No rooms.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {list.map((r, i) => {
                const isSel = String(r.id) === value;
                const busy = !!r.busyWith;
                const focused = r.id === focusedId;
                return (
                  <motion.button
                    key={r.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    data-selected={isSel}
                    data-room-id={r.id}
                    // Clicking the selected room again clears it (no room yet)
                    onClick={() => choose(isSel ? '' : String(r.id))}
                    onMouseEnter={() => setFocusIdx(list.findIndex(x => x.id === r.id))}
                    initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.2, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 12) * 0.025 } }}
                    whileHover={reduceMotion ? undefined : { y: -2 }}
                    whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                    title={isSel
                      ? 'Click again to remove the room'
                      : busy ? `Busy at this time: ${r.busyWith} — pick it to see its free times` : undefined}
                    className={`relative text-left rounded-xl border px-3 py-2.5 transition-[background-color,border-color,box-shadow] ${
                      isSel
                          ? 'bg-[#1D5BD6] border-[#1D5BD6] shadow-[0_10px_22px_-12px_rgba(29,91,214,0.9)]'
                          : focused
                            ? 'bg-white border-[#1D5BD6] shadow-[0_8px_18px_-12px_rgba(29,91,214,0.6)]'
                            : busy
                              ? 'bg-[#FFFBEB] border-[#FDE68A] hover:border-[#F59E0B] hover:shadow-[0_8px_18px_-12px_rgba(11,42,91,0.35)]'
                              : 'bg-white border-[#E2E8F0] hover:border-[#9DB8E8] hover:shadow-[0_8px_18px_-12px_rgba(11,42,91,0.35)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-[13px] font-bold truncate ${isSel ? '' : 'text-[#0B2A5B]'}`}
                        // White set inline — the light-mode rule repaints `text-white` as dark ink
                        style={isSel ? { color: '#FFFFFF' } : undefined}
                      >
                        {r.room_name}
                      </span>
                      {isSel
                        ? <Check className="w-4 h-4 flex-shrink-0" style={{ color: '#FFFFFF' }} />
                        : (
                          <span
                            className={`w-2 h-2 rounded-full flex-shrink-0 ${busy ? 'bg-amber-500' : day ? 'bg-emerald-500' : 'bg-[#CBD5E1]'}`}
                            aria-hidden="true"
                          />
                        )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] min-w-0">
                      {r.capacity ? (
                        <span
                          className={`inline-flex items-center gap-1 tabular-nums flex-shrink-0 ${isSel ? '' : 'text-[#64748B]'}`}
                          style={isSel ? { color: 'rgba(255,255,255,0.85)' } : undefined}
                        >
                          <Users className="w-3 h-3" /> {r.capacity}
                        </span>
                      ) : null}
                      {busy && !isSel && <span className="truncate font-semibold text-[#B45309]">Busy · {r.busyWith}</span>}
                    </div>
                  </motion.button>
                );
              })}
            </div>
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}
