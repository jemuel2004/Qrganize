'use client';

/**
 * Room Management — register and manage the rooms available in DCS.
 * Main question it answers: "What rooms exist in the department?"
 *
 *  • Add Room — numbered names (Lecture-8, + Lecture-9 …) or a custom name
 *    (CCA Gym, M.P. 3 …), type (Lecture / Laboratory), status
 *  • Room list — room, type, status, actions
 *  • Edit Room
 *  • Activate / Deactivate — inactive rooms stay on file (and on existing
 *    schedules) but can't be picked for new schedules
 *  • Search by name/number · filter by type · filter by status
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useToast } from '@/context/ToastContext';
import { useRealtime } from '@/context/RealtimeContext';
import Modal from '@/components/ui/Modal';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import AnchoredPopover from '@/components/ui/AnchoredPopover';
import TrashDropAnimation from '@/components/ui/TrashDropAnimation';
import UnassignedRoomsPanel from './UnassignedRoomsPanel';
import SplitMajorRoomsPanel from './SplitMajorRoomsPanel';
import { FilterSelect } from '@/components/ui/SearchFilter';
import {
  AlertTriangle, BookOpen, Building2, Download, Loader2, Monitor, MoreVertical,
  Pencil, Plus, Power, QrCode, Search, Trash2, X, Zap,
  ChevronDown, ListOrdered, PenLine,
} from 'lucide-react';
import { ListSkeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';

/* ─── Types ──────────────────────────────────────────────────────────────── */

interface Room {
  id: number;
  room_name: string;
  room_type: string;
  capacity: number;
  building: string;
  qr_code_id: string;
  qr_code_data: string;
  status: string;
}

type RoomType = 'Lecture' | 'Laboratory';

interface RoomForm {
  room_name: string;
  room_type: RoomType;
  capacity: string;
  building: string;
  status: 'Active' | 'Inactive';
}

interface UsageSession {
  subject_code: string; type: string; block_name: string; program_code: string;
  day: string; start_time: string; end_time: string; semester: string; academic_year: string;
}
interface Usage { in_use: boolean; session_count: number; sessions: UsageSession[] }

/* ─── Constants / helpers ────────────────────────────────────────────────── */

/** Balanced timing: unhurried (≈0.45s) with a soft ease-in-out */
const T = { duration: 0.45, ease: [0.45, 0, 0.55, 1] as const };
const EMPTY_FORM: RoomForm = { room_name: '', room_type: 'Lecture', capacity: '40', building: 'DCS', status: 'Active' };

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** Most rooms added in one save */
const MAX_NEW_ROOMS = 20;

/** Add Room naming: numbered (Lecture-8, Lecture-9 …) or a name typed in (CCA Gym, M.P. 3 …) */
type NameMode = 'numbered' | 'custom';
/** Same rule as the server (services/rooms.ts validateRoom) */
const ROOM_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._\-/#()]*$/u;

/** "Lab-1" / "lec 2" → "laboratory-1" / "lecture-2" — so short names count as taken too */
const canonicalRoomName = (s: string) =>
  norm(s).replace(/^lab(?![a-z])/, 'laboratory').replace(/^lec(?![a-z])/, 'lecture').replace(/\s*-\s*|\s+/g, '-');

/** The next `count` unused names for a type: "Lecture-1", "Lecture-4", … (fills gaps first) */
function nextRoomNames(type: RoomType, taken: Room[], count: number): string[] {
  const used = new Set(taken.map(r => canonicalRoomName(r.room_name)));
  const names: string[] = [];
  for (let n = 1; names.length < count && n < 1000; n++) {
    const name = `${type}-${n}`;
    if (!used.has(canonicalRoomName(name))) names.push(name);
  }
  return names;
}

/** Chip colours per room type — Lecture blue, Laboratory amber (as the tabs) */
const TYPE_CHIP: Record<RoomType, { chip: string; tile: string; add: string; text: string }> = {
  Lecture:    { chip: 'bg-[#EFF6FF] border-[#BFDBFE]', tile: 'bg-[#1D5BD6]', add: 'border-[#93C5FD] hover:bg-[#EFF6FF] hover:border-[#1D5BD6]', text: '#1D5BD6' },
  Laboratory: { chip: 'bg-amber-50 border-amber-200', tile: 'bg-amber-500', add: 'border-amber-300 hover:bg-amber-50 hover:border-amber-500', text: '#B45309' },
};
const naturalSort = (a: Room, b: Room) =>
  a.room_name.localeCompare(b.room_name, undefined, { numeric: true, sensitivity: 'base' });

function fmt12(t: string) {
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h)) return t;
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/* White text set inline — the light-mode rule in globals.css repaints
   `text-white` as dark ink. */
const WHITE = { color: '#FFFFFF' } as const;


/** Filled field box: light background, border, and a blue focus ring drawn by
 *  the wrapper (globals.css removes border/shadow from focused inputs in light
 *  mode, so a bordered <input> would turn invisible while typing). */
function FieldBox({ children, error = false, className = '' }: { children: React.ReactNode; error?: boolean; className?: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
      className={`relative flex items-center rounded-xl transition-[background-color,border-color,box-shadow] duration-200 ${className}`}
      style={{
        backgroundColor: focused ? '#FFFFFF' : '#F4F7FC',
        border: `1px solid ${error ? '#FCA5A5' : focused ? '#1D5BD6' : '#D6E0EF'}`,
        boxShadow: focused ? `0 0 0 4px ${error ? 'rgba(239,68,68,0.10)' : 'rgba(29,91,214,0.10)'}` : 'none',
      }}
    >
      {children}
    </div>
  );
}

/* Bare control that sits inside a FieldBox */
const FIELD_CONTROL = 'w-full h-full bg-transparent border-0 outline-none text-sm text-[#0B2A5B] placeholder:text-[#94A3B8]';

/* Same icons + colours as Scheduling / Workload: Lecture = book (blue),
   Laboratory = monitor (amber). */
function RoomIcon({ type, className }: { type: string; className?: string }) {
  return type === 'Laboratory' ? <Monitor className={className} /> : <BookOpen className={className} />;
}

/** Tinted icon tile for the Room column (greyed out when inactive) */
function RoomIconTile({ type, active }: { type: string; active: boolean }) {
  const lab = type === 'Laboratory';
  const tone = !active
    ? 'bg-[#F1F5F9] text-[#94A3B8]'
    : lab ? 'bg-amber-50 text-amber-600' : 'bg-[#EFF6FF] text-[#1D5BD6]';
  return (
    <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors duration-500 ${tone}`}>
      <RoomIcon type={type} className="w-[18px] h-[18px]" />
    </span>
  );
}

/* ─── Pills ──────────────────────────────────────────────────────────────── */

function StatusPill({ active }: { active: boolean }) {
  const reduceMotion = useReducedMotion();
  return (
    <span className="relative inline-grid">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={active ? 'on' : 'off'}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1, transition: reduceMotion ? { duration: 0 } : T }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.92, transition: { duration: 0.2, ease: T.ease } }}
          className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${
            active ? 'bg-emerald-50 text-emerald-700' : 'bg-[#F1F5F9] text-[#64748B]'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-500' : 'bg-[#94A3B8]'}`} aria-hidden="true" />
          {active ? 'Active' : 'Inactive'}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/* ─── Animated height ────────────────────────────────────────────────────── */

/** Glides its height to fit the content, so the list grows/shrinks smoothly
 *  between filters instead of jumping. */
function AutoHeight({ children, reduceMotion }: { children: React.ReactNode; reduceMotion: boolean }) {
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
      initial={false}
      animate={{ height }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.5, ease: T.ease }}
      className="overflow-hidden"
    >
      <div ref={innerRef}>{children}</div>
    </motion.div>
  );
}

/* ─── Row "more" menu (QR code, download, delete) ────────────────────────── */

function RowMenu({ room, onQr, onDelete }: { room: Room; onQr: () => void; onDelete: () => void }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const hasQr = room.qr_code_data?.startsWith('data:image/');
  const item = 'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-left transition-colors';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={`More actions for ${room.room_name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${open ? 'bg-[#EFF6FF] text-[#1D5BD6]' : 'text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#0B2A5B]'}`}
      >
        <MoreVertical className="w-4 h-4" />
      </button>
      <AnchoredPopover open={open} onClose={close} anchorRef={btnRef} panelRef={panelRef} width={200} maxHeight={220} label="Room actions"
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}>
        <div role="menu" className="p-1.5">
          <button type="button" role="menuitem" className={`${item} text-[#0B2A5B] hover:bg-[#F4F7FC]`} onClick={() => { setOpen(false); onQr(); }}>
            <QrCode className="w-4 h-4 text-[#64748B]" /> View QR code
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!hasQr}
            className={`${item} text-[#0B2A5B] hover:bg-[#F4F7FC] disabled:opacity-40`}
            onClick={() => {
              setOpen(false);
              const a = document.createElement('a');
              a.href = room.qr_code_data;
              a.download = `${room.room_name.replace(/[^\w-]+/g, '_')}-${room.qr_code_id}.png`;
              a.click();
            }}
          >
            <Download className="w-4 h-4 text-[#64748B]" /> Download QR
          </button>
          <div className="my-1 border-t border-[#F1F5F9]" />
          <button type="button" role="menuitem" className={`${item} text-red-600 hover:bg-red-50`} onClick={() => { setOpen(false); onDelete(); }}>
            <Trash2 className="w-4 h-4" /> Delete room
          </button>
        </div>
      </AnchoredPopover>
    </>
  );
}

/* Keep activate/deactivate loading visible long enough to register */
const MIN_BUSY_MS = 700;
const nowMs = () => Date.now();
const waitRest = (since: number) =>
  new Promise(r => window.setTimeout(r, Math.max(0, MIN_BUSY_MS - (nowMs() - since))));

/** Centred loading card (same look as Refresh / Scheduling's "Going back…") */
function CenterLoading({ label }: { label: string | null }) {
  const reduceMotion = useReducedMotion();
  const [mounted, setMounted] = useState(false); // portal only after hydration
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {label && (
        <motion.div
          key="center-loading"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.25, ease: T.ease } }}
          exit={{ opacity: 0, transition: { duration: 0.25, ease: T.ease } }}
          className="fixed inset-x-0 bottom-0 top-[72px] z-30 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(11, 42, 91, 0.08)' }}
          role="status"
          aria-live="polite"
        >
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, scale: 0.94, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0, transition: { duration: 0.3, ease: T.ease } }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
            className="flex items-center gap-3 px-5 py-3.5 rounded-2xl bg-white border border-[#E2E8F0] shadow-[0_12px_32px_-12px_rgba(11,42,91,0.35)]"
          >
            <div className="w-6 h-6 border-[3px] border-[#DBE5F4] border-t-[#1D5BD6] rounded-full animate-spin" aria-hidden="true" />
            <p className="text-sm font-semibold text-[#0B2A5B]">{label}</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function RoomsPage() {
  const toast = useToast();
  const reduceMotion = useReducedMotion();

  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);

  const [search, setSearch] = useState('');
  const [activeType, setActiveType] = useState<RoomType>('Lecture'); // tab
  // Closed when the page opens — a tab opens its room list; clicking it again closes it
  const [listOpen, setListOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState(''); // '' = All Status

  const [formOpen, setFormOpen] = useState(false);
  const [editRoom, setEditRoom] = useState<Room | null>(null);
  const [form, setForm] = useState<RoomForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  /** Add mode: how many rooms to create in one save (names are suggested) */
  const [addCount, setAddCount] = useState(1);
  /** Add mode: numbered names (Lecture-8, Lecture-9 …) or one room with a name typed in */
  const [nameMode, setNameMode] = useState<NameMode>('numbered');

  const [qrRoom, setQrRoom] = useState<Room | null>(null);
  /** Room being activated/deactivated, and which way — drives the button's loading label */
  const [toggling, setToggling] = useState<{ id: number; to: 'Active' | 'Inactive' } | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<{ room: Room; usage: Usage } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ room: Room; usage: Usage | null } | null>(null);
  const [deleting, setDeleting] = useState(false);
  /* Success overlays — same as Faculty / Blocks / Curriculum: play ~1.3s, then close + toast */
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null);

  /* ── Data ── */
  const loadRooms = useCallback(() => {
    setRoomsLoading(true);
    fetch('/api/rooms')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) setRooms(d.rooms || []); })
      .catch(() => toast.error('Could not load rooms.'))
      .finally(() => setRoomsLoading(false));
  }, [toast]);
  useEffect(() => { loadRooms(); }, [loadRooms]);

  // Live updates: rooms added, edited, (de)activated or given a new QR
  // elsewhere — quiet reload; an open QR window shows the room's latest code.
  useRealtime(['rooms'], () => fetch('/api/rooms')
    .then(r => (r.ok ? r.json() : null))
    .then(d => {
      if (!d || !Array.isArray(d.rooms)) return;
      const fresh = d.rooms as Room[];
      setRooms(fresh);
      setQrRoom(prev => (prev ? fresh.find(r => r.id === prev.id) ?? prev : prev));
    })
    .catch(() => {}), { enabled: !roomsLoading });

  const visible = useMemo(() => {
    const q = norm(search);
    return rooms
      .filter(r => !statusFilter || (statusFilter === 'Active' ? r.status === 'Active' : r.status !== 'Active'))
      .filter(r => !q || norm(r.room_name).includes(q))
      .sort((a, b) => (a.room_type === b.room_type ? naturalSort(a, b) : a.room_type.localeCompare(b.room_type)));
  }, [rooms, search, statusFilter]);

  const filtersOn = !!search || !!statusFilter;
  const clearFilters = () => { setSearch(''); setStatusFilter(''); };

  /** Typing a search opens the list (the lists start closed) — on the room type that has matches */
  function onSearch(value: string) {
    setSearch(value);
    const q = norm(value);
    if (!q) return;
    const hasMatch = (t: RoomType) => rooms.some(r => r.room_type === t && norm(r.room_name).includes(q)
      && (!statusFilter || (statusFilter === 'Active' ? r.status === 'Active' : r.status !== 'Active')));
    const other: RoomType = activeType === 'Lecture' ? 'Laboratory' : 'Lecture';
    if (!hasMatch(activeType) && hasMatch(other)) setActiveType(other);
    setListOpen(true);
  }
  const showSkeleton = useMinLoading(roomsLoading && rooms.length === 0, PAGE_SKELETON_MIN_MS);

  /* ── Add / Edit ── */
  function openAdd() {
    setEditRoom(null);
    // Start with the type of the tab being viewed
    setForm({ ...EMPTY_FORM, room_type: activeType });
    setAddCount(1);
    setNameMode('numbered');
    setFormError('');
    setFormOpen(true);
  }

  /** Add mode: suggested names ("Lecture-1", then + → "Lecture-2", …) */
  const newRoomNames = useMemo(
    () => (editRoom ? [] : nextRoomNames(form.room_type, rooms, addCount)),
    [editRoom, form.room_type, rooms, addCount],
  );
  const nextRoomName = useMemo(
    () => (editRoom || addCount >= MAX_NEW_ROOMS ? null : nextRoomNames(form.room_type, rooms, addCount + 1)[addCount] ?? null),
    [editRoom, form.room_type, rooms, addCount],
  );
  function openEdit(r: Room) {
    setEditRoom(r);
    setForm({
      room_name: r.room_name,
      room_type: r.room_type === 'Laboratory' ? 'Laboratory' : 'Lecture',
      capacity: String(r.capacity ?? 0),
      building: r.building || 'DCS',
      status: r.status === 'Active' ? 'Active' : 'Inactive',
    });
    setFormError('');
    setFormOpen(true);
  }

  /** A name typed in (Edit, or Add → Custom name) */
  const typedName = editRoom || nameMode === 'custom';
  const cleanName = form.room_name.trim().replace(/\s+/g, ' ');
  /** The registered room a typed name matches — same name apart from case and
   *  spacing, or the short form ("Lab 1" = "Laboratory-1") */
  const clashRoom = useMemo(() => {
    if (!typedName || !cleanName) return null;
    const c = canonicalRoomName(cleanName);
    return rooms.find(r => r.id !== editRoom?.id && canonicalRoomName(r.room_name) === c) ?? null;
  }, [typedName, cleanName, rooms, editRoom]);
  const nameInvalid = typedName && !!cleanName && !ROOM_NAME_RE.test(cleanName);
  const nameProblem = clashRoom
    ? `${clashRoom.room_name} is already registered.`
    : nameInvalid ? 'Use letters, numbers, spaces and - _ . / # ( ) only.' : null;
  /** Rooms this Add will create */
  const addNames = nameMode === 'custom' ? (cleanName ? [cleanName] : []) : newRoomNames;

  /** Add mode: create each room in turn; stop at the first failure */
  async function createRooms() {
    if (nameProblem) { setFormError(nameProblem); return; }
    setSaving(true);
    setFormError('');
    const created: string[] = [];
    const noQr: string[] = [];
    try {
      for (const name of addNames) {
        const res = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            room_name: name,
            room_type: form.room_type,
            capacity: form.capacity === '' ? 0 : Number(form.capacity),
            building: form.building,
            status: form.status,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setFormError(`${data.error || `Could not save ${name}.`}${created.length ? ` (${created.join(', ')} ${created.length === 1 ? 'was' : 'were'} added.)` : ''}`);
          if (created.length) { loadRooms(); setAddCount(1); }
          return;
        }
        created.push(data.room?.room_name ?? name);
        if (data.qr_generated === false) noQr.push(data.room?.room_name ?? name);
      }
      // Each new room gets its QR code automatically on the server
      const msg = created.length === 1
        ? `${created[0]} added with its QR code.`
        : `${created.length} rooms added with QR codes (${created[0]} – ${created[created.length - 1]}).`;
      setSaveSuccess(created.length === 1 ? 'Room added!' : `${created.length} rooms added!`);
      loadRooms();
      window.setTimeout(() => {
        setSaveSuccess(null);
        setFormOpen(false);
        if (noQr.length) {
          toast.error(`${noQr.join(', ')} added, but the QR code could not be created. Generate it in QR Generator.`);
        } else {
          toast.success(msg);
        }
      }, 1300);
    } catch {
      setFormError(`Connection error. Please try again.${created.length ? ` (${created.join(', ')} ${created.length === 1 ? 'was' : 'were'} added.)` : ''}`);
      if (created.length) { loadRooms(); setAddCount(1); }
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editRoom) { await createRooms(); return; }
    if (nameProblem) { setFormError(nameProblem); return; }
    setSaving(true);
    setFormError('');
    try {
      const res = await fetch(editRoom ? `/api/rooms/${editRoom.id}` : '/api/rooms', {
        method: editRoom ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_name: form.room_name,
          room_type: form.room_type,
          capacity: form.capacity === '' ? 0 : Number(form.capacity),
          building: form.building,
          status: form.status,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setFormError(data.error || 'Could not save the room.'); return; }
      const name = data.room?.room_name ?? 'Room';
      const msg = editRoom ? `${name} updated.` : `${name} added.`;
      setSaveSuccess(editRoom ? 'Room updated!' : 'Room added!');
      loadRooms();
      window.setTimeout(() => {
        setSaveSuccess(null);
        setFormOpen(false);
        toast.success(msg);
      }, 1300);
    } catch {
      setFormError('Connection error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  /* ── Activate / Deactivate ── */
  async function fetchUsage(id: number): Promise<Usage | null> {
    try {
      const r = await fetch(`/api/rooms/${id}/usage`);
      return r.ok ? await r.json() as Usage : null;
    } catch { return null; }
  }

  async function setStatus(room: Room, status: 'Active' | 'Inactive', since = nowMs()) {
    setToggling({ id: room.id, to: status });
    try {
      const res = await fetch(`/api/rooms/${room.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({}));
      await waitRest(since);
      if (!res.ok) { toast.error(data.error || 'Could not update the room.'); return; }
      // Button, pill and row change together, right as the loading ends
      setRooms(prev => prev.map(r => (r.id === room.id ? { ...r, status } : r)));
      toast.success(status === 'Active' ? `${room.room_name} activated.` : `${room.room_name} deactivated.`);
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setToggling(null);
    }
  }

  async function requestToggle(room: Room) {
    if (toggling) return;
    const since = nowMs();
    if (room.status !== 'Active') { setStatus(room, 'Active', since); return; }
    // Deactivating a room that classes use → confirm first, showing what uses it
    setToggling({ id: room.id, to: 'Inactive' });
    const usage = await fetchUsage(room.id);
    if (usage?.in_use) {
      await waitRest(since);
      setToggling(null);
      setConfirmDeactivate({ room, usage });
    } else {
      setStatus(room, 'Inactive', since); // stays "Deactivating…" throughout
    }
  }

  /* ── Delete ── */
  async function requestDelete(room: Room) {
    setConfirmDelete({ room, usage: null });
    const usage = await fetchUsage(room.id);
    setConfirmDelete(cur => (cur && cur.room.id === room.id ? { room, usage } : cur));
  }
  async function doDelete() {
    if (!confirmDelete) return;
    const { room } = confirmDelete;
    setDeleting(true);
    try {
      const res = await fetch(`/api/rooms/${room.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data.error || 'Failed to delete room.'); return; }
      setDeleteSuccess('Room deleted!');
      window.setTimeout(() => {
        setDeleteSuccess(null);
        setConfirmDelete(null);
        setRooms(prev => prev.filter(r => r.id !== room.id));
        toast.delete(`${room.room_name} deleted.`);
      }, 1300);
    } catch {
      toast.error('Connection error — could not delete room.');
    } finally {
      setDeleting(false);
    }
  }

  // Rows glide in/out (filters, activating/deactivating) — balanced, not snappy
  const rowAnim = (i: number) => ({
    layout: true as const,
    transition: { layout: reduceMotion ? { duration: 0 } : T },
    initial: reduceMotion ? false : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.45, ease: T.ease, delay: reduceMotion ? 0 : 0.08 + Math.min(i, 10) * 0.05 } },
    exit: reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, transition: { duration: 0.3, ease: T.ease } },
  });

  /* Compact row actions for the side-by-side panels:
     Activate/Deactivate · Edit · more (QR, download, delete) */
  const rowActions = (r: Room) => {
    const active = r.status === 'Active';
    const busy = toggling?.id === r.id;
    return (
      <>
        <motion.button
          type="button"
          onClick={() => requestToggle(r)}
          disabled={busy}
          whileTap={reduceMotion ? undefined : { scale: 0.96 }}
          title={active ? 'Deactivate room' : 'Activate room'}
          className={`inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg border text-[12px] font-semibold transition-colors duration-300 disabled:opacity-60 min-w-[104px] ${
            active
              ? 'border-red-200 bg-white text-red-600 hover:bg-red-50 hover:border-red-300'
              : 'border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50 hover:border-emerald-300'
          }`}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={busy ? `busy-${toggling?.to}` : active ? 'deactivate' : 'activate'}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: T.ease } }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
              className="inline-flex items-center gap-1.5"
            >
              {busy
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> {toggling?.to === 'Active' ? 'Activating…' : 'Deactivating…'}</>
                : active
                  ? <><Power className="w-3.5 h-3.5" /> Deactivate</>
                  : <><Zap className="w-3.5 h-3.5" /> Activate</>}
            </motion.span>
          </AnimatePresence>
        </motion.button>
        <button
          type="button"
          onClick={() => openEdit(r)}
          title="Edit room"
          aria-label={`Edit ${r.room_name}`}
          className="w-8 h-8 flex items-center justify-center rounded-lg border border-[#D6E0EF] bg-white text-[#475569] hover:text-[#1D5BD6] hover:border-[#9DB8E8] hover:bg-[#F8FBFF] transition-colors"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <RowMenu room={r} onQr={() => setQrRoom(r)} onDelete={() => requestDelete(r)} />
      </>
    );
  };

  /* Tab identity — same colours/icons as Scheduling (Lecture blue, Laboratory amber) */
  const TABS: { type: RoomType; title: string; bar: string; tile: string }[] = [
    { type: 'Lecture', title: 'Lecture Rooms', bar: '#1D5BD6', tile: 'bg-[#EFF6FF] text-[#1D5BD6]' },
    { type: 'Laboratory', title: 'Laboratory Rooms', bar: '#F59E0B', tile: 'bg-amber-50 text-amber-600' },
  ];
  const list = visible.filter(r => r.room_type === activeType);

  /* ── Render ── */
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0 space-y-5">
      {/* Header — same watermark title as the other sections */}
      <div>
        <BackButton />
        <div className="mt-4 sm:mt-7 mb-4">
          <WatermarkTitle>Room Management</WatermarkTitle>
        </div>
      </div>

      {/* Search · Status · Add Room */}
      <div className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] p-4 sm:p-5">
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_200px_auto] gap-3 items-center">
          <FieldBox className="h-[42px] pl-3.5 pr-2.5 gap-2.5">
            <Search aria-hidden className="pointer-events-none w-4 h-4 text-[#64748B] flex-shrink-0" />
            <input
              type="search"
              value={search}
              onChange={e => onSearch(e.target.value)}
              placeholder="Search room number or name…"
              aria-label="Search rooms"
              className={FIELD_CONTROL}
            />
            {search && (
              <button type="button" onClick={() => setSearch('')} aria-label="Clear search"
                className="p-0.5 rounded-md text-[#64748B] hover:text-[#0B2A5B] hover:bg-[#E3E9F3] flex-shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </FieldBox>
          <FilterSelect value={statusFilter} onChange={setStatusFilter} label="Status" className="qr-ms-field">
            <option value="">All Status</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </FilterSelect>
          <motion.button
            type="button"
            onClick={openAdd}
            whileHover={reduceMotion ? undefined : { y: -1 }}
            whileTap={reduceMotion ? undefined : { scale: 0.97 }}
            className="justify-self-end inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-lg bg-[#1D5BD6] hover:bg-[#164BB5] text-[13px] font-semibold shadow-[0_6px_14px_-8px_rgba(29,91,214,0.9)] transition-colors"
            style={WHITE}
          >
            <Plus className="w-3.5 h-3.5" style={WHITE} /> Add Room
          </motion.button>
        </div>
      </div>

      <PageLoadTransition showSkeleton={showSkeleton} skeleton={<ListSkeleton rows={8} />}>
        {rooms.length === 0 ? (
          <div className="bg-white rounded-2xl p-12 sm:p-16 text-center border border-[#E3E9F3]">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 bg-[#EFF6FF]">
              <Building2 className="w-8 h-8 text-[#1D5BD6]" />
            </div>
            <p className="font-semibold text-base text-[#0B2A5B]">No rooms registered yet</p>
          </div>
        ) : (
          <div className="space-y-4">
            <UnassignedRoomsPanel refreshKey={rooms.length} />
            <SplitMajorRoomsPanel refreshKey={rooms.length} />
            {/* Lecture Rooms | Laboratory Rooms — click to show that type (both closed at first) */}
            <div className="grid grid-cols-2 gap-4" role="tablist" aria-label="Room type">
              {TABS.map(t => {
                // Highlighted only while its list is open
                const on = listOpen && activeType === t.type;
                const count = visible.filter(r => r.room_type === t.type).length;
                return (
                  <motion.button
                    key={t.type}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => { if (on) setListOpen(false); else { setActiveType(t.type); setListOpen(true); } }}
                    aria-expanded={on}
                    title={on ? 'Hide rooms' : 'Show rooms'}
                    whileHover={reduceMotion || on ? undefined : { y: -2 }}
                    whileTap={reduceMotion ? undefined : { scale: 0.98 }}
                    className={`relative overflow-hidden text-left bg-white rounded-2xl border px-3 sm:px-5 py-4 flex items-center gap-2 sm:gap-3 transition-[border-color,box-shadow] duration-300 ${
                      on ? 'shadow-[0_10px_24px_-14px_rgba(11,42,91,0.45)]' : 'border-[#E3E9F3] hover:border-[#BFD3F5]'
                    }`}
                    style={on ? { borderColor: t.bar } : undefined}
                  >
                    {on && (
                      <motion.span
                        layoutId="room-tab-bar"
                        className="absolute inset-x-0 top-0 h-1"
                        style={{ backgroundColor: t.bar }}
                        transition={reduceMotion ? { duration: 0 } : { duration: 0.4, ease: T.ease }}
                      />
                    )}
                    <span className={`hidden sm:flex w-10 h-10 rounded-xl items-center justify-center flex-shrink-0 ${t.tile}`}>
                      <RoomIcon type={t.type} className="w-5 h-5" />
                    </span>
                    <span className={`min-w-0 flex-1 block text-[15px] font-bold leading-tight sm:truncate ${on ? 'text-[#0B2A5B]' : 'text-[#475569]'}`}>{t.title}</span>
                    <span
                      className="text-sm font-bold tabular-nums px-2.5 py-0.5 rounded-full transition-colors duration-300"
                      style={on ? { backgroundColor: t.bar, color: '#FFFFFF' } : { backgroundColor: '#F1F5F9', color: '#64748B' }}
                    >
                      {count}
                    </span>
                    <motion.span
                      animate={{ rotate: on ? 180 : 0, opacity: on ? 1 : 0.55 }}
                      transition={{ duration: reduceMotion ? 0 : 0.3, ease: T.ease }}
                      className="flex-shrink-0"
                      style={{ color: on ? t.bar : '#94A3B8' }}
                      aria-hidden
                    >
                      <ChevronDown className="w-5 h-5" />
                    </motion.span>
                  </motion.button>
                );
              })}
            </div>

            {/* The selected type's rooms (hideable) */}
            <AnimatePresence initial={false}>
            {listOpen && (
            <motion.section
              key="room-list"
              initial={reduceMotion ? false : { height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1, transition: { duration: reduceMotion ? 0 : 0.35, ease: T.ease } }}
              exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0, transition: { duration: 0.28, ease: T.ease } }}
              className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] overflow-hidden">
              <AutoHeight reduceMotion={!!reduceMotion}>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={`${activeType}|${statusFilter}|${list.length === 0 ? 'empty' : 'list'}`}
                    initial={reduceMotion ? false : { opacity: 0, x: activeType === 'Lecture' ? -12 : 12 }}
                    animate={{ opacity: 1, x: 0, transition: { duration: reduceMotion ? 0 : 0.35, ease: T.ease } }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: activeType === 'Lecture' ? 12 : -12, transition: { duration: 0.2, ease: T.ease } }}
                  >
                    {list.length === 0 ? (
                      <div className="px-5 py-12 text-center">
                        <RoomIcon type={activeType} className="w-7 h-7 mx-auto text-[#CBD5E1]" />
                        <p className="text-sm text-[#94A3B8] mt-2">
                          {filtersOn ? 'No rooms match.' : `No ${activeType.toLowerCase()} rooms yet.`}
                        </p>
                        {filtersOn && (
                          <button type="button" onClick={clearFilters} className="mt-2 text-sm font-semibold text-[#1D5BD6] hover:underline">Clear filters</button>
                        )}
                      </div>
                    ) : (
                      <ul className="divide-y divide-[#F1F5F9]">
                        <AnimatePresence>
                          {list.map((r, i) => {
                            const active = r.status === 'Active';
                            return (
                              <motion.li
                                key={r.id}
                                {...rowAnim(i)}
                                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 sm:px-5 py-3 transition-colors duration-500 hover:bg-[#F8FBFF]"
                              >
                                <RoomIconTile type={r.room_type} active={active} />
                                <p className={`min-w-0 flex-1 font-semibold text-sm truncate transition-colors duration-500 ${active ? 'text-[#0B2A5B]' : 'text-[#94A3B8]'}`}>{r.room_name}</p>
                                <StatusPill active={active} />
                                <div className="flex items-center gap-1.5">{rowActions(r)}</div>
                              </motion.li>
                            );
                          })}
                        </AnimatePresence>
                      </ul>
                    )}
                  </motion.div>
                </AnimatePresence>
              </AutoHeight>
            </motion.section>
            )}
            </AnimatePresence>
          </div>
        )}
      </PageLoadTransition>

      <CenterLoading
        label={toggling
          ? `${toggling.to === 'Active' ? 'Activating' : 'Deactivating'} ${rooms.find(r => r.id === toggling.id)?.room_name ?? 'room'}…`
          : null}
      />

      {/* ── Add / Edit Room ────────────────────────────────────────── */}
      <Modal open={formOpen} onClose={() => !saving && !saveSuccess && setFormOpen(false)} title={editRoom ? 'Edit Room' : 'Add Room'} size="sm">
        {saveSuccess && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl">
              <svg width="72" height="72" viewBox="0 0 52 52" aria-hidden="true">
                <circle className="save-success-circle" cx="26" cy="26" r="24" fill="none" stroke="#22C55E" strokeWidth="3" />
                <path className="save-success-check" fill="none" stroke="#22C55E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" d="M14.5 27 22 34.5 38 17" />
              </svg>
              <p className="text-base font-semibold text-[#0B2A5B]">{saveSuccess}</p>
            </div>
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-5">
          {formError && (
            <p className="px-4 py-3 rounded-xl text-sm bg-red-50 border border-red-200 text-red-600 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {formError}
            </p>
          )}

          {editRoom && (
            <div>
              <label htmlFor="room-name" className="block text-sm font-semibold mb-2 text-[#0B2A5B]">
                Room Name / Number <span className="text-red-500">*</span>
              </label>
              <FieldBox error={!!nameProblem} className="h-11 px-3.5">
                <input
                  id="room-name"
                  value={form.room_name}
                  onChange={e => { setForm(f => ({ ...f, room_name: e.target.value })); setFormError(''); }}
                  placeholder="e.g. Room 101"
                  maxLength={50}
                  required
                  autoFocus
                  aria-invalid={!!nameProblem}
                  className={FIELD_CONTROL}
                />
              </FieldBox>
              {nameProblem && <p className="text-xs mt-1.5 font-medium text-red-600">{nameProblem}</p>}
            </div>
          )}

          <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-3">
            <div>
              <label htmlFor="room-type" className="block text-sm font-semibold mb-2 text-[#0B2A5B]">
                Room Type <span className="text-red-500">*</span>
              </label>
              <FieldBox className="h-11 px-3">
                <select
                  id="room-type"
                  value={form.room_type}
                  onChange={e => setForm(f => ({ ...f, room_type: e.target.value as RoomType }))}
                  className={`${FIELD_CONTROL} cursor-pointer`}
                >
                  <option value="Lecture">Lecture</option>
                  <option value="Laboratory">Laboratory</option>
                </select>
              </FieldBox>
            </div>
            <div>
              <label htmlFor="room-capacity" className="block text-sm font-semibold mb-2 text-[#0B2A5B]">Capacity</label>
              <FieldBox className="h-11 px-3.5">
                <input
                  id="room-capacity"
                  type="number"
                  min={0}
                  max={500}
                  inputMode="numeric"
                  value={form.capacity}
                  onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))}
                  className={FIELD_CONTROL}
                />
              </FieldBox>
            </div>
          </div>

          {/* Add mode — Room Name: numbered (like Block Creation: "Lecture-1", then + for
              the next) or a name typed in for rooms that aren't numbered (CCA Gym, M.P. 3 …) */}
          {!editRoom && (
            <div>
              <div className="flex items-baseline justify-between gap-2 mb-2">
                <span className="block text-sm font-semibold text-[#0B2A5B]">
                  Room Name <span className="text-red-500">*</span>
                </span>
                {nameMode === 'numbered' && newRoomNames.length > 1 && (
                  <span className="text-xs font-semibold" style={{ color: TYPE_CHIP[form.room_type].text }}>
                    {newRoomNames.length} rooms · {newRoomNames[0]} – {newRoomNames[newRoomNames.length - 1]}
                  </span>
                )}
              </div>

              <div role="radiogroup" aria-label="How to name the room" className="grid grid-cols-2 gap-1 p-1 mb-3 rounded-xl bg-[#F1F5F9] border border-[#E2E8F0]">
                {([
                  { key: 'numbered', label: 'Numbered', icon: ListOrdered },
                  { key: 'custom', label: 'Custom name', icon: PenLine },
                ] as const).map(m => {
                  const on = nameMode === m.key;
                  return (
                    <motion.button
                      key={m.key}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => { setNameMode(m.key); setFormError(''); }}
                      whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                      className={`relative h-10 rounded-lg text-sm font-semibold transition-colors ${on ? '' : 'text-[#475569] hover:text-[#0B2A5B] hover:bg-white/70'}`}
                      style={on ? WHITE : undefined}
                    >
                      {on && (
                        <motion.span
                          layoutId="room-name-mode"
                          className="absolute inset-0 rounded-lg bg-[#1D5BD6] shadow-[0_6px_14px_-8px_rgba(29,91,214,0.8)]"
                          transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 }}
                        />
                      )}
                      <span className="relative inline-flex items-center justify-center gap-1.5">
                        <m.icon className="w-4 h-4" style={on ? WHITE : undefined} /> {m.label}
                      </span>
                    </motion.button>
                  );
                })}
              </div>

              <AnimatePresence mode="wait" initial={false}>
              {nameMode === 'custom' ? (
                <motion.div
                  key="custom"
                  initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: T.ease } }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, transition: { duration: 0.15 } }}
                >
                  <FieldBox error={!!nameProblem} className="h-11 px-3.5">
                    <input
                      id="room-custom-name"
                      value={form.room_name}
                      onChange={e => { setForm(f => ({ ...f, room_name: e.target.value })); setFormError(''); }}
                      placeholder="e.g. CCA Gym, M.P. 3, Robotics Lab"
                      maxLength={50}
                      autoFocus
                      aria-label="Room name"
                      aria-invalid={!!nameProblem}
                      aria-describedby="room-custom-help"
                      className={FIELD_CONTROL}
                    />
                  </FieldBox>
                  <p id="room-custom-help" className={`text-[11px] mt-1.5 ${nameProblem ? 'font-medium text-red-600' : 'text-[#94A3B8]'}`}>
                    {nameProblem ?? 'For rooms not named Lecture-N or Laboratory-N. Adds one room.'}
                  </p>
                </motion.div>
              ) : (
              <motion.div
                key="numbered"
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: T.ease } }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, transition: { duration: 0.15 } }}
              >
              <motion.div layout className="flex flex-wrap items-center gap-2" role="group" aria-label="Rooms to create">
                <AnimatePresence initial={false}>
                  {newRoomNames.map((name, i) => {
                    const removable = i === newRoomNames.length - 1 && newRoomNames.length > 1;
                    const num = name.slice(name.lastIndexOf('-') + 1);
                    return (
                      <motion.div
                        key={name}
                        layout
                        initial={reduceMotion ? false : { opacity: 0, scale: 0.6, x: -8 }}
                        animate={{ opacity: 1, scale: 1, x: 0 }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                        transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 30 }}
                        className={`relative inline-flex items-center gap-1.5 h-11 pl-2 pr-2 rounded-xl border ${TYPE_CHIP[form.room_type].chip}`}
                      >
                        <span className={`min-w-7 h-7 px-1.5 rounded-lg text-sm font-bold flex items-center justify-center ${TYPE_CHIP[form.room_type].tile}`} style={WHITE}>{num}</span>
                        <span className="text-sm font-semibold pr-1 text-[#0B2A5B]">{name}</span>
                        {removable && (
                          <button
                            type="button"
                            onClick={() => { setAddCount(c => Math.max(1, c - 1)); setFormError(''); }}
                            className="w-6 h-6 rounded-md flex items-center justify-center text-[#64748B] hover:text-red-500 hover:bg-red-50 transition-colors"
                            aria-label={`Remove ${name}`}
                            title={`Remove ${name}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </motion.div>
                    );
                  })}
                </AnimatePresence>

                {nextRoomName && (
                  <motion.button
                    layout
                    type="button"
                    onClick={() => { setAddCount(c => Math.min(MAX_NEW_ROOMS, c + 1)); setFormError(''); }}
                    whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                    transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 30 }}
                    className={`inline-flex items-center gap-1.5 h-11 px-3.5 rounded-xl border border-dashed text-sm font-semibold transition-colors ${TYPE_CHIP[form.room_type].add}`}
                    style={{ color: TYPE_CHIP[form.room_type].text }}
                    aria-label={`Add ${nextRoomName}`}
                    title={`Add ${nextRoomName}`}
                  >
                    <Plus className="w-4 h-4" /> {nextRoomName}
                  </motion.button>
                )}
              </motion.div>
              <p className="text-[11px] mt-1.5 text-[#94A3B8]">
                Click <span className="font-semibold text-[#64748B]">+</span> to add the next room. All rooms are saved together.
              </p>
              </motion.div>
              )}
              </AnimatePresence>
            </div>
          )}

          <fieldset>
            <legend className="text-sm font-semibold mb-2 text-[#0B2A5B]">Status <span className="text-red-500">*</span></legend>
            <div className="flex items-center gap-6">
              {(['Active', 'Inactive'] as const).map(st => {
                const on = form.status === st;
                return (
                  <label key={st} className="inline-flex items-center gap-2 cursor-pointer select-none text-sm text-[#0B2A5B]">
                    <input
                      type="radio"
                      name="room-status"
                      value={st}
                      checked={on}
                      onChange={() => setForm(f => ({ ...f, status: st }))}
                      className="sr-only peer"
                    />
                    <span className={`w-[18px] h-[18px] rounded-full border-2 flex items-center justify-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[#1D5BD6]/30 ${
                      on ? 'border-[#1D5BD6]' : 'border-[#CBD5E1]'
                    }`}>
                      <motion.span
                        className="w-2 h-2 rounded-full bg-[#1D5BD6]"
                        initial={false}
                        animate={{ scale: on ? 1 : 0 }}
                        transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: T.ease }}
                      />
                    </span>
                    {st}
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="flex justify-end gap-3 pt-4 border-t border-[#F1F5F9]">
            <button type="button" onClick={() => setFormOpen(false)} disabled={saving}
              className="h-11 px-5 rounded-xl text-sm font-semibold border border-[#D6E0EF] text-[#0B2A5B] bg-white hover:bg-[#F8FAFC] transition-colors">
              Cancel
            </button>
            <button type="submit"
              disabled={saving || (typedName ? !!nameProblem || !cleanName : addNames.length === 0)}
              className="h-11 px-5 inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors disabled:opacity-50"
              style={WHITE}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" style={WHITE} />}
              {saving
                ? (!editRoom && addNames.length > 1 ? `Saving ${addNames.length} rooms…` : 'Saving…')
                : (!editRoom && addNames.length > 1 ? `Save ${addNames.length} Rooms` : 'Save Room')}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Confirm deactivate (room is used by classes) ───────────── */}
      <Modal open={!!confirmDeactivate} onClose={() => setConfirmDeactivate(null)} title="Deactivate room?" size="sm">
        {confirmDeactivate && (
          <div className="space-y-4">
            <p className="text-sm text-[#475569]">
              <span className="font-semibold text-[#0B2A5B]">{confirmDeactivate.room.room_name}</span> is used by{' '}
              <span className="font-semibold">{confirmDeactivate.usage.session_count}</span> scheduled class session{confirmDeactivate.usage.session_count === 1 ? '' : 's'}.
              Those schedules keep the room, but it won&apos;t be offered for new schedules until you activate it again.
            </p>
            <UsageList usage={confirmDeactivate.usage} />
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setConfirmDeactivate(null)}
                className="h-11 px-5 rounded-xl text-sm font-semibold border border-[#D6E0EF] text-[#0B2A5B] hover:bg-[#F8FAFC]">Cancel</button>
              <button type="button"
                onClick={() => { const r = confirmDeactivate.room; setConfirmDeactivate(null); setStatus(r, 'Inactive'); }}
                className="h-11 px-5 inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-700 transition-colors" style={WHITE}>
                <Power className="w-4 h-4" style={WHITE} /> Deactivate
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Confirm delete ─────────────────────────────────────────── */}
      <Modal open={!!confirmDelete} onClose={() => !deleting && !deleteSuccess && setConfirmDelete(null)} title="Delete room?" size="sm">
        {deleteSuccess && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl">
              <TrashDropAnimation className="bg-red-50 border-red-200" />
              <p className="text-base font-semibold text-[#0B2A5B]">{deleteSuccess}</p>
            </div>
          </div>
        )}
        {confirmDelete && (
          <div className="space-y-4">
            {confirmDelete.usage === null ? (
              <div className="flex items-center gap-2 text-sm text-[#64748B]"><Loader2 className="w-4 h-4 animate-spin" /> Checking where this room is used…</div>
            ) : confirmDelete.usage.in_use ? (
              <>
                <p className="text-sm text-[#475569]">
                  <span className="font-semibold text-[#0B2A5B]">{confirmDelete.room.room_name}</span> is used by{' '}
                  {confirmDelete.usage.session_count} class session{confirmDelete.usage.session_count === 1 ? '' : 's'}. Deleting it
                  removes the room from those schedules (the classes stay, with no room).
                </p>
                <UsageList usage={confirmDelete.usage} />
                <p className="text-xs text-[#64748B] bg-[#F8FAFC] border border-[#E2E8F0] rounded-lg px-3 py-2">
                  Tip: <span className="font-semibold">Deactivate</span> instead to keep its history and QR code.
                </p>
              </>
            ) : (
              <p className="text-sm text-[#475569]">
                Permanently delete <span className="font-semibold text-[#0B2A5B]">{confirmDelete.room.room_name}</span> and its QR code? This can&apos;t be undone.
              </p>
            )}
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setConfirmDelete(null)} disabled={deleting}
                className="h-11 px-5 rounded-xl text-sm font-semibold border border-[#D6E0EF] text-[#0B2A5B] hover:bg-[#F8FAFC]">Cancel</button>
              <button type="button" onClick={doDelete} disabled={deleting || confirmDelete.usage === null}
                className="h-11 px-5 inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50" style={WHITE}>
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" style={WHITE} /> : <Trash2 className="w-4 h-4" style={WHITE} />}
                Delete
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ── QR code ────────────────────────────────────────────────── */}
      <Modal open={!!qrRoom} onClose={() => setQrRoom(null)} title={qrRoom ? `QR Code — ${qrRoom.room_name}` : 'QR Code'} size="sm">
        {qrRoom && (
          <div className="space-y-5">
            <div className="rounded-2xl p-6 flex justify-center bg-[#F8FAFC] border border-[#E2E8F0]">
              {qrRoom.qr_code_data?.startsWith('data:image/') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrRoom.qr_code_data} alt={`QR code for ${qrRoom.room_name}`} className="w-52 h-52 rounded-xl bg-white qr-keep-light p-2 shadow-sm" />
              ) : (
                <div className="w-52 h-52 rounded-xl flex items-center justify-center shadow-sm bg-white qr-keep-light border border-[#E2E8F0]">
                  <QrCode className="w-14 h-14 text-[#CBD5E1]" />
                </div>
              )}
            </div>
            {qrRoom.qr_code_data?.startsWith('data:image/')
              ? <p className="text-center font-mono text-xs text-[#94A3B8]">{qrRoom.qr_code_id}</p>
              : <p className="text-center text-sm text-[#64748B]">No QR yet — generate it in <Link href="/qr-generator" className="font-semibold text-[#1D5BD6] hover:underline">QR Generator</Link>.</p>}
            <button
              type="button"
              onClick={() => {
                const a = document.createElement('a');
                a.href = qrRoom.qr_code_data;
                a.download = `${qrRoom.room_name.replace(/[^\w-]+/g, '_')}-${qrRoom.qr_code_id}.png`;
                a.click();
              }}
              disabled={!qrRoom.qr_code_data?.startsWith('data:image/')}
              className="w-full h-11 flex items-center justify-center gap-2 rounded-xl text-sm font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors disabled:opacity-50"
              style={WHITE}
            >
              <Download className="w-4 h-4" style={WHITE} /> Download QR Code
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ─── Classes using a room (shown before deactivate / delete) ────────────── */

function UsageList({ usage }: { usage: Usage }) {
  if (!usage.sessions.length) return null;
  return (
    <div className="rounded-xl border border-[#E2E8F0] divide-y divide-[#F1F5F9] max-h-48 overflow-y-auto">
      {usage.sessions.map((s, i) => (
        <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
          <span className="font-semibold text-[#0B2A5B] truncate">
            {s.subject_code} {s.type === 'lab' ? 'Lab' : 'Lec'} · {s.program_code} {s.block_name}
          </span>
          <span className="text-[#64748B] whitespace-nowrap tabular-nums">{s.day.slice(0, 3)} {fmt12(s.start_time)}–{fmt12(s.end_time)}</span>
        </div>
      ))}
      {usage.session_count > usage.sessions.length && (
        <p className="px-3 py-2 text-[11px] text-[#94A3B8]">…and {usage.session_count - usage.sessions.length} more</p>
      )}
    </div>
  );
}
