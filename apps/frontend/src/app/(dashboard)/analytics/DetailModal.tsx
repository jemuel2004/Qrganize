'use client';

import { useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { BookOpen, CheckCircle2, Monitor } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { EASE } from './charts';
import { byPosition } from '@/lib/positionRank';

/* Pop-up behind each Analytics summary card: Rooms, Utilization, Faculty, Conflicts. */

type Kind = 'lec' | 'lab';
export type DetailKey = 'rooms' | 'utilization' | 'faculty' | 'conflicts';

export interface Details {
  rooms: { id: number; room_name: string; kind: Kind; status: 'In Use' | 'Available' | 'Inactive'; pct: number }[];
  faculty: { id: number; name: string; employment_status: string | null; position: string | null; load: 'Regular' | 'Overload' | 'Praise' | null }[];
  conflicts: { type: 'instructor' | 'room' | 'block'; day: string; start: number; end: number; a: string; b: string; room: string | null }[];
}

const TITLES: Record<DetailKey, string> = {
  rooms: 'Rooms',
  utilization: 'Room Utilization',
  faculty: 'Faculty',
  conflicts: 'Scheduling Conflicts',
};

const STATUS_TONE = {
  'In Use': { bg: '#EFF6FF', fg: '#1D5BD6' },
  Available: { bg: '#ECFDF5', fg: '#047857' },
  Inactive: { bg: '#F1F5F9', fg: '#64748B' },
} as const;

const LOAD_TONE: Record<string, string> = {
  Regular: 'var(--load-regular)',
  Overload: 'var(--load-overload)',
  Praise: 'var(--load-praise)',
};

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

function UtilizationView({ rooms, rate }: { rooms: Details['rooms']; rate: number }) {
  const reduceMotion = useReducedMotion();
  const list = rooms.filter(r => r.status !== 'Inactive').sort((a, b) => b.pct - a.pct);
  return (
    <div className="space-y-4">
      <p className="text-sm text-[#64748B]">
        Overall <span className="text-2xl font-bold text-[#0B2A5B] align-middle ml-1">{rate}%</span>
        <span className="ml-2">of weekly room hours booked</span>
      </p>
      <List>
        {list.map((r, i) => (
          <div key={r.id}>
            <div className="flex items-center gap-2 text-sm">
              <KindIcon kind={r.kind} />
              <span className="font-semibold text-[#0B2A5B]">{r.room_name}</span>
              <span className="ml-auto font-bold tabular-nums text-[#0B2A5B]">{r.pct}%</span>
            </div>
            <div className="mt-1.5 h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--donut-track)' }}>
              <motion.div className="h-full rounded-full" style={{ backgroundColor: r.kind === 'lab' ? '#F59E0B' : '#1D5BD6' }}
                initial={reduceMotion ? false : { width: 0 }} animate={{ width: `${r.pct}%` }}
                transition={{ duration: reduceMotion ? 0 : 0.6, ease: EASE, delay: reduceMotion ? 0 : Math.min(i, 12) * 0.04 }} />
            </div>
          </div>
        ))}
      </List>
    </div>
  );
}

function FacultyView({ faculty }: { faculty: Details['faculty'] }) {
  const [filter, setFilter] = useState<'All' | 'Permanent' | 'Contractual'>('All');
  // Permanent: highest position first · Contractual: A–Z · All: Permanent (by rank), then Contractual (A–Z)
  const isPerm = (f: Details['faculty'][number]) => f.employment_status === 'Permanent';
  const permanent = faculty.filter(isPerm).sort(byPosition);
  const contractual = faculty.filter(f => !isPerm(f)).sort((a, b) => a.name.localeCompare(b.name));
  const list = filter === 'Permanent' ? permanent : filter === 'Contractual' ? contractual : [...permanent, ...contractual];
  return (
    <div className="space-y-4">
      <div className="flex gap-1 p-1 rounded-full bg-[#EAF0FA] w-fit">
        {(['All', 'Permanent', 'Contractual'] as const).map(f => {
          const on = f === filter;
          const n = f === 'All' ? faculty.length : f === 'Permanent' ? permanent.length : contractual.length;
          return (
            <button key={f} type="button" onClick={() => setFilter(f)}
              className={`relative px-3.5 h-8 rounded-full text-[13px] font-semibold transition-colors ${on ? '' : 'text-[#475569] hover:text-[#0B2A5B]'}`}
              style={on ? { color: '#FFFFFF' } : undefined}>
              {on && <motion.span layoutId="faculty-filter" className="absolute inset-0 rounded-full bg-[#0B2A5B]" transition={{ duration: 0.3, ease: EASE }} />}
              <span className="relative">{f} <span className="opacity-70">{n}</span></span>
            </button>
          );
        })}
      </div>
      <List key={filter}>
        {list.map(f => (
          <div key={f.id} className="flex items-center gap-3 min-w-0">
            <span className="w-9 h-9 rounded-full bg-[#EFF6FF] text-[#1D5BD6] text-xs font-bold flex items-center justify-center flex-shrink-0">
              {f.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-[#0B2A5B] truncate">{f.name}</p>
              <p className="text-xs text-[#64748B] truncate">{f.position || f.employment_status || '—'}</p>
            </div>
            <span className="ml-auto">
              {f.load
                ? <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#0B2A5B]"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: LOAD_TONE[f.load] }} />{f.load}</span>
                : <span className="text-xs text-[#94A3B8]">No load</span>}
            </span>
          </div>
        ))}
      </List>
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

export default function DetailModal({ open, details, rate, onClose }: {
  open: DetailKey | null; details: Details; rate: number; onClose: () => void;
}) {
  return (
    <Modal open={!!open} onClose={onClose} title={open ? TITLES[open] : ''} size="lg" headerAccent>
      {open === 'rooms' && <RoomsView rooms={details.rooms} />}
      {open === 'utilization' && <UtilizationView rooms={details.rooms} rate={rate} />}
      {open === 'faculty' && <FacultyView faculty={details.faculty} />}
      {open === 'conflicts' && <ConflictsView conflicts={details.conflicts} />}
    </Modal>
  );
}
