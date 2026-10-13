'use client';

import { type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { BookOpen, CheckCircle2, Monitor } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { EASE } from './charts';

/* Pop-up behind Analytics' Rooms and Scheduling Conflicts. */

type Kind = 'lec' | 'lab';
export type DetailKey = 'rooms' | 'conflicts';

export interface Details {
  rooms: { id: number; room_name: string; kind: Kind; status: 'In Use' | 'Available' | 'Inactive'; pct: number }[];
  conflicts: { type: 'instructor' | 'room' | 'block'; day: string; start: number; end: number; a: string; b: string; room: string | null }[];
}

const TITLES: Record<DetailKey, string> = {
  rooms: 'Rooms',
  conflicts: 'Scheduling Conflicts',
};

const STATUS_TONE = {
  'In Use': { bg: '#EFF6FF', fg: '#1D5BD6' },
  Available: { bg: '#ECFDF5', fg: '#047857' },
  Inactive: { bg: '#F1F5F9', fg: '#64748B' },
} as const;

const CONFLICT_LABEL = { instructor: 'Faculty', room: 'Room', block: 'Block' } as const;

const fmt12 = (min: number) => {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

function Pill({ children, bg, fg }: { children: ReactNode; bg: string; fg: string }) {
  return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap" style={{ backgroundColor: bg, color: fg }}>{children}</span>;
}

function KindIcon({ kind }: { kind: Kind }) {
  return kind === 'lab' ? <Monitor className="w-4 h-4 text-[#D97706]" /> : <BookOpen className="w-4 h-4 text-[#1D5BD6]" />;
}

/** Rows fade/slide in one after another */
function List({ children }: { children: ReactNode[] }) {
  const reduceMotion = useReducedMotion();
  return (
    <ul className="divide-y divide-[#EEF2F8] rounded-xl border border-[#E3E9F3] overflow-hidden">
      {children.map((c, i) => (
        <motion.li
          key={i}
          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 12) * 0.03 } }}
          className="px-4 py-3 bg-white"
        >
          {c}
        </motion.li>
      ))}
    </ul>
  );
}

function RoomsView({ rooms }: { rooms: Details['rooms'] }) {
  return (
    <div className="space-y-5">
      {(['lec', 'lab'] as Kind[]).map(kind => {
        const list = rooms.filter(r => r.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind}>
            <p className="flex items-center gap-2 text-sm font-bold text-[#0B2A5B] mb-2">
              <KindIcon kind={kind} /> {kind === 'lab' ? 'Laboratory' : 'Lecture'} <span className="text-[#94A3B8] font-semibold">{list.length}</span>
            </p>
            <List>
              {list.map(r => (
                <div key={r.id} className="flex items-center gap-3">
                  <span className="font-semibold text-[#0B2A5B]">{r.room_name}</span>
                  <span className="ml-auto"><Pill {...STATUS_TONE[r.status]}>{r.status}</Pill></span>
                </div>
              ))}
            </List>
          </section>
        );
      })}
    </div>
  );
}

function ConflictsView({ conflicts }: { conflicts: Details['conflicts'] }) {
  if (!conflicts.length) {
    return (
      <div className="py-10 flex flex-col items-center text-center">
        <CheckCircle2 className="w-12 h-12 text-[#10B981] mb-3" />
        <p className="font-semibold text-[#0B2A5B]">No conflicts</p>
        <p className="text-sm text-[#64748B] mt-1">The current timetable has no faculty, room or block clashes.</p>
      </div>
    );
  }
  return (
    <List>
      {conflicts.map((c, i) => (
        <div key={i} className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Pill bg="#FEF2F2" fg="#B91C1C">{CONFLICT_LABEL[c.type]} conflict</Pill>
            <span className="text-sm font-semibold text-[#0B2A5B]">{c.day} · {fmt12(c.start)}–{fmt12(c.end)}</span>
            {c.room && <span className="text-sm text-[#64748B]">· {c.room}</span>}
          </div>
          <p className="text-sm text-[#475569]">{c.a}</p>
          <p className="text-sm text-[#475569]"><span className="text-[#94A3B8]">vs</span> {c.b}</p>
        </div>
      ))}
    </List>
  );
}

export default function DetailModal({ open, details, onClose }: {
  open: DetailKey | null; details: Details; onClose: () => void;
}) {
  return (
    <Modal open={!!open} onClose={onClose} title={open ? TITLES[open] : ''} size="lg" headerAccent>
      {open === 'rooms' && <RoomsView rooms={details.rooms} />}
      {open === 'conflicts' && <ConflictsView conflicts={details.conflicts} />}
    </Modal>
  );
}
