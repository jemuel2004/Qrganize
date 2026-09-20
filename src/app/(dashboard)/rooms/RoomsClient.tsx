'use client';

import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useToast } from '@/client/context/ToastContext';
import Modal from '@/client/components/ui/Modal';
import {
  Plus, Pencil, Trash2, QrCode,
  Building2, Users, Download, Monitor, BookOpen,
  AlertTriangle, X, CheckCircle, ChevronDown, Search,
} from 'lucide-react';
import { CardSkeleton, ListSkeleton } from '@/client/components/ui/skeletons';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/client/hooks/useMinLoading';

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

type RoomFormData = {
  room_name: string;
  room_type: string;
  capacity: number;
  building: string;
};

type FilterTab = 'All' | 'Lecture' | 'Laboratory';
type RoomType  = 'Lecture' | 'Laboratory';

/* ─── Constants ──────────────────────────────────────────────────────────── */

const EMPTY_FORM: RoomFormData = { room_name: '', room_type: 'Lecture', capacity: 40, building: 'DCS' };
const LECTURE_OPTIONS          = Array.from({ length: 10 }, (_, i) => `Lecture-${i + 1}`);
const LAB_OPTIONS              = Array.from({ length: 15 }, (_, i) => `Lab-${i + 1}`);
const FILTER_TABS: FilterTab[] = ['All', 'Lecture', 'Laboratory'];

/* ─── Design tokens ──────────────────────────────────────────────────────── */

const C = {
  navy:        '#1E3A5F',
  blue:        '#3C91E6',
  blueDark:    '#2E7DD1',
  blueTint:    '#EFF6FF',
  bluePale:    '#DBEAFE',
  blueBorder:  '#BFDBFE',
  slate:       '#64748B',
  muted:       '#94A3B8',
  border:      '#E2E8F0',
  divider:     '#F1F5F9',
  surface:     '#F8FAFC',
} as const;

/* ─── Pure helpers ───────────────────────────────────────────────────────── */

function getRoomOptions(type: string): string[] {
  return type === 'Lecture' ? LECTURE_OPTIONS : LAB_OPTIONS;
}

function sortRoomsNumerically(list: Room[]): Room[] {
  return [...list].sort((a, b) => {
    const na = parseInt(a.room_name.replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(b.room_name.replace(/\D/g, ''), 10) || 0;
    return na - nb || a.room_name.localeCompare(b.room_name);
  });
}

/* ─── Shared input class ─────────────────────────────────────────────────── */

const INPUT_CLS =
  'w-full bg-slate-100 border-0 rounded-xl px-3 py-2.5 text-sm text-slate-800 ' +
  'placeholder:text-slate-400 transition-all duration-200 outline-none ' +
  'hover:bg-slate-200/60 focus:bg-white focus:shadow-[0_2px_10px_rgba(0,0,0,0.08)]';

/* ─── SummaryCard ────────────────────────────────────────────────────────── */

interface SummaryCardProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  iconBg: string;
}

function SummaryCard({ icon, label, value, iconBg }: SummaryCardProps) {
  return (
    <div className="bg-white rounded-xl p-4 flex items-center gap-3 border border-[#E2E8F0] w-full min-w-0">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider leading-tight text-[#64748B]">
          {label}
        </p>
        <p className="text-2xl font-bold leading-none mt-1 text-[#1E3A5F]">
          {value}
        </p>
      </div>
    </div>
  );
}

/* ─── ActionButton ───────────────────────────────────────────────────────── */

interface ActionButtonProps {
  onClick: () => void;
  title: string;
  variant: 'default' | 'danger';
  children: React.ReactNode;
}

function ActionButton({ onClick, title, variant, children }: ActionButtonProps) {
  const [hovered, setHovered] = useState(false);

  const bg    = hovered ? (variant === 'danger' ? '#FEF2F2' : C.blueTint) : 'transparent';
  const color = hovered ? (variant === 'danger' ? '#EF4444' : C.blue)    : C.muted;

  return (
    <button
      onClick={onClick}
      title={title}
      className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors duration-150"
      style={{ color, backgroundColor: bg }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </button>
  );
}

/* ─── RoomCard ───────────────────────────────────────────────────────────── */

interface RoomCardProps {
  room: Room;
  onEdit: (r: Room) => void;
  onDelete: (id: number) => void;
  onViewQR: (r: Room) => void;
  onOpenDetails: (r: Room) => void;
}

function RoomCard({ room, onEdit, onDelete, onViewQR, onOpenDetails }: RoomCardProps) {
  const active = room.status === 'Active';

  return (
    <div className="bg-white rounded-xl overflow-hidden transition-colors duration-150 border border-[#E2E8F0] hover:border-[#BFDBFE]">
      <div className="flex items-start gap-2 px-4 pt-4 pb-2">
        <button
          type="button"
          onClick={() => onOpenDetails(room)}
          className="min-w-0 flex-1 text-left hover:opacity-90 transition-opacity"
          aria-label={`View details for ${room.room_name}`}
        >
          <div className="flex items-start gap-2 flex-wrap">
            <h3 className="font-bold text-[15px] leading-snug break-words text-[#1E3A5F]">
              {room.room_name}
            </h3>
            <span
              className={[
                'inline-flex items-center text-[11px] font-semibold px-2 py-0.5 rounded-full border flex-shrink-0 mt-0.5',
                active
                  ? 'text-[#16A34A] bg-[#ECFDF5] border-[#BBF7D0]'
                  : 'text-[#DC2626] bg-[#FEF2F2] border-[#FECACA]',
              ].join(' ')}
            >
              {room.status}
            </span>
          </div>
          <p className="text-xs mt-1 break-words text-[#64748B]">
            {room.room_type}
            {room.building ? ` · ${room.building}` : ''}
            {` · ${room.capacity} seats`}
          </p>
        </button>
        <div className="flex items-center gap-0.5 flex-shrink-0 -mr-1 -mt-1">
          <ActionButton onClick={() => onViewQR(room)} title="View QR Code" variant="default">
            <QrCode className="w-4 h-4" />
          </ActionButton>
          <ActionButton onClick={() => onEdit(room)} title="Edit room" variant="default">
            <Pencil className="w-4 h-4" />
          </ActionButton>
          <ActionButton onClick={() => onDelete(room.id)} title="Delete room" variant="danger">
            <Trash2 className="w-4 h-4" />
          </ActionButton>
        </div>
      </div>

      {/* QR strip */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onViewQR(room)}
        onKeyDown={e => e.key === 'Enter' && onViewQR(room)}
        className="mx-4 mb-4 flex items-center gap-2.5 rounded-xl px-3 py-2 cursor-pointer transition-colors duration-150 border border-[#E2E8F0] bg-[#F8FAFC] hover:border-[#BFDBFE] hover:bg-[#EFF6FF]"
        title="View QR Code"
      >
        {room.qr_code_data?.startsWith('data:image/') ? (
          <img
            src={room.qr_code_data}
            alt="QR"
            className="w-9 h-9 rounded-lg flex-shrink-0 bg-white qr-keep-light p-0.5 border border-[#E2E8F0]"
          />
        ) : (
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-[#F8FAFC] border border-[#E2E8F0]">
            <QrCode className="w-5 h-5 text-[#CBD5E1]" />
          </div>
        )}
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider leading-none mb-1 text-[#94A3B8]">
            QR Code
          </p>
          <p className="font-mono text-[11px] break-all text-[#64748B]">
            {room.qr_code_id}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ─── SectionPanel ───────────────────────────────────────────────────────── */

interface SectionPanelProps {
  type: RoomType;
  rooms: Room[];
  onEdit: (r: Room) => void;
  onDelete: (id: number) => void;
  onViewQR: (r: Room) => void;
  onOpenDetails: (r: Room) => void;
  search: string;
  /** Two-up cards when this section is the only one on screen. */
  wide?: boolean;
  /** Controlled from the parent so each section has a fully independent,
   *  named state variable. This also makes SectionPanel a pure controlled
   *  component with no internal expand state to get confused by React
   *  reconciliation across filter-tab changes. */
  expanded: boolean;
  onToggle: () => void;
}

function SectionPanel({ type, rooms, onEdit, onDelete, onViewQR, onOpenDetails, search, wide = false, expanded, onToggle }: SectionPanelProps) {
  const isLab    = type === 'Laboratory';
  const TypeIcon = isLab ? Monitor : BookOpen;
  const count    = rooms.length;

  return (
    <section className="bg-white rounded-xl overflow-hidden border border-[#E2E8F0] w-full min-w-0">
      {/* ── Section header (toggle button) ── */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`section-${type}`}
        className="w-full flex items-center gap-3 px-5 py-4 text-left transition-colors duration-150 hover:bg-[#F8FAFC]"
      >
        {/* Type icon */}
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-[#EFF6FF]">
          <TypeIcon className="w-[18px] h-[18px] text-[#3C91E6]" />
        </div>

        {/* Title + subtitle */}
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-bold leading-tight text-[#1E3A5F]">
            {type} Rooms
          </h2>
          <p className="text-xs mt-0.5 text-[#94A3B8]">
            {count} room{count !== 1 ? 's' : ''} registered
          </p>
        </div>

        {/* Count badge */}
        <span className="text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0 text-[#3C91E6] bg-[#DBEAFE] border border-[#BFDBFE]">
          {count}
        </span>

        {/* Circular toggle — blue bg, white chevron, smooth rotation */}
        <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-[#3C91E6]">
          <ChevronDown
            className={`w-4 h-4 text-white transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${expanded ? '-rotate-180' : 'rotate-0'}`}
          />
        </div>
      </button>

      {/* ── Animated body — CSS grid-row trick ── */}
      <div
        id={`section-${type}`}
        aria-hidden={!expanded}
        className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="p-4 border-t border-[#F1F5F9]">
            {count === 0 ? (
              <div className="rounded-xl py-12 text-center border border-dashed border-[#E2E8F0]">
                <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 bg-[#F8FAFC]">
                  <TypeIcon className="w-6 h-6 text-[#CBD5E1]" />
                </div>
                <p className="text-sm font-medium text-[#94A3B8]">
                  {search
                    ? `No ${type.toLowerCase()} rooms match your search.`
                    : `No ${type.toLowerCase()} rooms added yet.`}
                </p>
              </div>
            ) : (
              <div className={wide ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'space-y-3'}>
                {rooms.map(r => (
                  <RoomCard
                    key={r.id}
                    room={r}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onViewQR={onViewQR}
                    onOpenDetails={onOpenDetails}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────── */

export default function RoomsPage() {
  const toast = useToast();

  const [rooms, setRooms]             = useState<Room[]>([]);
  const [form, setForm]               = useState<RoomFormData>(EMPTY_FORM);
  const [editId, setEditId]           = useState<number | null>(null);
  const [modalOpen, setModalOpen]     = useState(false);
  const [qrModalRoom, setQrModalRoom] = useState<Room | null>(null);
  const [detailRoom, setDetailRoom]   = useState<Room | null>(null);
  const [error, setError]             = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [loading, setLoading]         = useState(false);
  const [search, setSearch]           = useState('');
  const [activeTab, setActiveTab]     = useState<FilterTab>('All');

  const [roomsLoading, setRoomsLoading] = useState(true);

  /* ── Section expand state — independent named variables, lifted to parent ── */
  const [isLectureExpanded,    setIsLectureExpanded]    = useState(false);
  const [isLaboratoryExpanded, setIsLaboratoryExpanded] = useState(false);

  const toggleLecture    = useCallback(() => setIsLectureExpanded(x => !x),    []);
  const toggleLaboratory = useCallback(() => setIsLaboratoryExpanded(x => !x), []);

  /* ── Data loading ── */

  const loadRooms = useCallback(() => {
    setRoomsLoading(true);
    fetch('/api/rooms')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setRooms(d.rooms || []); })
      .catch(() => {})
      .finally(() => setRoomsLoading(false));
  }, []);

  useEffect(() => { loadRooms(); }, [loadRooms]);

  /* ── Derived state ── */

  const filtered = useMemo(() => {
    let list = rooms;
    if (activeTab !== 'All') list = list.filter(r => r.room_type === activeTab);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        r.room_name.toLowerCase().includes(q) ||
        (r.building || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [rooms, activeTab, search]);

  const lectureRooms  = useMemo(() => sortRoomsNumerically(filtered.filter(r => r.room_type === 'Lecture')),   [filtered]);
  const labRooms      = useMemo(() => sortRoomsNumerically(filtered.filter(r => r.room_type === 'Laboratory')), [filtered]);
  const totalLecture  = rooms.filter(r => r.room_type === 'Lecture').length;
  const totalLab      = rooms.filter(r => r.room_type === 'Laboratory').length;
  const totalActive   = rooms.filter(r => r.status === 'Active').length;
  const showRoomsSkeleton = useMinLoading(roomsLoading && rooms.length === 0, PAGE_SKELETON_MIN_MS);

  /* ── Helpers ── */

  function firstAvailableName(type: string, excludeId?: number): string {
    const taken = new Set(
      rooms
        .filter(r => r.room_type === type && r.status === 'Active' && r.id !== excludeId)
        .map(r => r.room_name)
    );
    return getRoomOptions(type).find(o => !taken.has(o)) ?? '';
  }

  /* ── Actions ── */

  function openAdd() {
    setForm({ ...EMPTY_FORM, room_name: firstAvailableName('Lecture') });
    setEditId(null);
    setError('');
    setModalOpen(true);
  }

  function openEdit(r: Room) {
    setForm({ room_name: r.room_name, room_type: r.room_type, capacity: r.capacity, building: r.building || 'DCS' });
    setEditId(r.id);
    setError('');
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const url    = editId ? `/api/rooms/${editId}` : '/api/rooms';
    const method = editId ? 'PUT' : 'POST';
    try {
      const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      if (!res.ok) {
        let msg = 'Error saving room.';
        try { msg = ((await res.json()) as { error?: string })?.error ?? msg; } catch { /* html */ }
        setError(msg); toast.error(msg); return;
      }
      const data = await res.json();
      setModalOpen(false);
      toast.success(editId ? 'Room updated successfully.' : 'Room added successfully.');
      loadRooms();
    } catch {
      setError('Connection error');
      toast.error('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: number) {
    setDeleteError('');
    let inUse = false;
    try {
      const checkRes = await fetch(`/api/rooms/${id}/usage`);
      if (checkRes.ok) {
        const d = await checkRes.json() as { in_use?: boolean };
        inUse = d.in_use === true;
      }
    } catch { /* fall through */ }

    const message = inUse
      ? 'This room is used in schedules. Deleting it will remove the room assignment from those schedules. Continue?'
      : 'Delete this room permanently?';
    if (!confirm(message)) return;

    try {
      const res = await fetch(`/api/rooms/${id}`, { method: 'DELETE' });
      let data: { error?: string } = {};
      try { data = await res.json(); } catch { /* no body */ }
      if (!res.ok) {
        setDeleteError(data.error || 'Failed to delete room.');
        toast.error(data.error || 'Failed to delete room.');
        return;
      }
      toast.delete('Room deleted successfully.');
      setRooms(prev => prev.filter(r => r.id !== id));
    } catch {
      setDeleteError('Connection error — could not delete room.');
      toast.error('Connection error — could not delete room.');
    }
  }

  /* ── Render ── */

  return (
    <div className="w-full min-w-0 p-4 sm:p-6 lg:p-8 space-y-5 sm:space-y-6">

      {/* ── Page header ──────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 min-w-0">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: C.navy }}>Room Management</h1>
          <p className="text-sm mt-0.5" style={{ color: C.slate }}>
            Create, view, edit, and manage rooms and their QR codes.
          </p>
        </div>

        {/* Add Room — primary blue, white text + icon */}
        {/*
          bg-blue-600 is intentional: it acts as a CSS hook so the
          light-mode restoration rule in globals.css —
            html.light [class*="bg-blue-6"][class~="text-white"] { color:#fff !important }
          — fires with specificity 0-3-1, beating the blanket override
            html.light [class~="text-white"] { color:#1a2638 !important }
          at 0-2-1. The inline style still controls the actual rendered
          background (inline > class for non-!important properties).
        */}
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold shadow-sm flex-shrink-0 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2"
          style={{ backgroundColor: C.blue, outlineColor: C.blue }}
          onMouseEnter={e => (e.currentTarget.style.backgroundColor = C.blueDark)}
          onMouseLeave={e => (e.currentTarget.style.backgroundColor = C.blue)}
        >
          <Plus className="w-4 h-4 text-white" />
          Add Room
        </button>
      </div>

      {/* ── Delete error banner ───────────────────────────────────── */}
      {deleteError && (
        <div
          className="px-4 py-3 rounded-xl text-sm flex items-center justify-between gap-3"
          style={{ backgroundColor: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626' }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">{deleteError}</span>
          </div>
          <button
            onClick={() => setDeleteError('')}
            aria-label="Dismiss"
            className="flex-shrink-0 transition-colors hover:opacity-70"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Summary cards ─────────────────────────────────────────── */}
      <PageLoadTransition
        showSkeleton={showRoomsSkeleton}
        skeleton={
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 w-full">
            {Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} className="h-[88px]" />)}
          </div>
        }
      >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 w-full">
        <SummaryCard
          icon={<Building2 className="w-5 h-5" style={{ color: C.blue }} />}
          label="Total Rooms"
          value={rooms.length}
          iconBg="bg-[#EFF6FF]"
        />
        <SummaryCard
          icon={<BookOpen className="w-5 h-5" style={{ color: C.blue }} />}
          label="Lecture"
          value={totalLecture}
          iconBg="bg-[#EFF6FF]"
        />
        <SummaryCard
          icon={<Monitor className="w-5 h-5" style={{ color: C.blue }} />}
          label="Laboratory"
          value={totalLab}
          iconBg="bg-[#EFF6FF]"
        />
        <SummaryCard
          icon={<CheckCircle className="w-5 h-5 text-green-500" />}
          label="Active"
          value={totalActive}
          iconBg="bg-green-50"
        />
      </div>
      </PageLoadTransition>

      {/* ── Search + filter ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3 w-full min-w-0">
        <div className="w-72 max-w-full">
          <label htmlFor="rooms-search" className="block text-xs font-semibold text-[#64748B] mb-1.5">
            Search
          </label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#64748B]"
            />
            <input
              id="rooms-search"
              type="search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Room name or building"
              className="w-full bg-white border border-[#CBD5E1] rounded-xl pl-9 pr-9 py-2.5 text-sm text-[#1E3A5F] placeholder:text-[#94A3B8] hover:border-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/25 focus:border-[#3C91E6]"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-[#64748B] hover:text-[#1E3A5F] hover:bg-[#F1F5F9]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex gap-1 p-1 rounded-xl bg-white border border-[#CBD5E1] shadow-sm flex-shrink-0 ml-auto mb-0.5">
          {FILTER_TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className="px-4 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150 whitespace-nowrap"
              style={
                activeTab === tab
                  ? { backgroundColor: C.blue, color: 'white' }
                  : { color: C.slate }
              }
              onMouseEnter={e => { if (activeTab !== tab) e.currentTarget.style.backgroundColor = 'white'; }}
              onMouseLeave={e => { if (activeTab !== tab) e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* ── Room sections ─────────────────────────────────────────── */}
      <PageLoadTransition
        showSkeleton={showRoomsSkeleton}
        skeleton={<ListSkeleton rows={8} />}
      >
      {rooms.length === 0 && !search ? (
        <div
          className="bg-white rounded-2xl p-16 text-center shadow-sm"
          style={{ border: `1px solid ${C.border}` }}
        >
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ backgroundColor: C.blueTint }}
          >
            <QrCode className="w-8 h-8" style={{ color: C.blue }} />
          </div>
          <p className="font-semibold text-base" style={{ color: C.navy }}>No rooms yet</p>
          <p className="text-sm mt-1" style={{ color: C.muted }}>
            Click &ldquo;Add Room&rdquo; to register your first room.
          </p>
        </div>
      ) : (
        <div
          className={[
            'grid gap-4 sm:gap-6 items-start w-full min-w-0',
            activeTab === 'All' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1',
          ].join(' ')}
        >
          {(activeTab === 'All' || activeTab === 'Lecture') && (
            <SectionPanel
              key="lecture"
              type="Lecture"
              rooms={lectureRooms}
              onEdit={openEdit}
              onDelete={handleDelete}
              onViewQR={setQrModalRoom}
              onOpenDetails={setDetailRoom}
              search={search}
              wide={activeTab !== 'All'}
              expanded={isLectureExpanded}
              onToggle={toggleLecture}
            />
          )}
          {(activeTab === 'All' || activeTab === 'Laboratory') && (
            <SectionPanel
              key="laboratory"
              type="Laboratory"
              rooms={labRooms}
              onEdit={openEdit}
              onDelete={handleDelete}
              onViewQR={setQrModalRoom}
              onOpenDetails={setDetailRoom}
              search={search}
              wide={activeTab !== 'All'}
              expanded={isLaboratoryExpanded}
              onToggle={toggleLaboratory}
            />
          )}
        </div>
      )}
      </PageLoadTransition>

      {/* ── Room Details Modal ────────────────────────────────────── */}
      {detailRoom && (
        <Modal open onClose={() => setDetailRoom(null)} title="Room Details" size="sm">
          <div className="space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: C.muted }}>
                Room Name
              </p>
              <p className="text-xl font-bold mt-0.5 break-words" style={{ color: C.navy }}>
                {detailRoom.room_name}
              </p>
            </div>
            <div className="space-y-0 text-sm">
              {(
                [
                  { label: 'Room Type', value: detailRoom.room_type },
                  { label: 'Status', value: detailRoom.status },
                  { label: 'Location / Department', value: detailRoom.building || '—' },
                  { label: 'Capacity', value: `${detailRoom.capacity} seats` },
                  { label: 'QR ID', value: detailRoom.qr_code_id },
                ] as const
              ).map(({ label, value }) => (
                <div
                  key={label}
                  className="flex justify-between items-start gap-3 py-2.5"
                  style={{ borderBottom: `1px solid ${C.divider}` }}
                >
                  <span className="font-medium flex-shrink-0" style={{ color: C.slate }}>{label}</span>
                  <span
                    className={`font-semibold text-right break-words ${label === 'QR ID' ? 'font-mono text-xs' : ''}`}
                    style={{
                      color:
                        label === 'Status' && value === 'Active'
                          ? '#16A34A'
                          : label === 'Status'
                            ? '#DC2626'
                            : label === 'QR ID'
                              ? C.muted
                              : C.navy,
                    }}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  const r = detailRoom;
                  setDetailRoom(null);
                  setQrModalRoom(r);
                }}
                className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold border transition-colors"
                style={{ color: C.blue, borderColor: C.blueBorder, backgroundColor: C.blueTint }}
              >
                <QrCode className="w-4 h-4" /> View QR
              </button>
              <button
                type="button"
                onClick={() => {
                  const r = detailRoom;
                  setDetailRoom(null);
                  openEdit(r);
                }}
                className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors"
                style={{ backgroundColor: C.blue }}
              >
                <Pencil className="w-4 h-4" /> Edit Room
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ── QR Code Modal ─────────────────────────────────────────── */}
      {qrModalRoom && (
        <Modal open onClose={() => setQrModalRoom(null)} title="QR Code">
          <div className="space-y-5">
            <div
              className="rounded-2xl p-6 flex justify-center"
              style={{ backgroundColor: C.surface, border: `1px solid ${C.border}` }}
            >
              {qrModalRoom.qr_code_data?.startsWith('data:image/') ? (
                <img
                  src={qrModalRoom.qr_code_data}
                  alt="QR Code"
                  className="w-52 h-52 rounded-xl bg-white qr-keep-light p-2 shadow-sm"
                />
              ) : (
                <div
                  className="w-52 h-52 rounded-xl flex items-center justify-center shadow-sm bg-white qr-keep-light"
                  style={{ border: `1px solid ${C.border}` }}
                >
                  <QrCode className="w-14 h-14" style={{ color: '#CBD5E1' }} />
                </div>
              )}
            </div>

            <div className="space-y-0 text-sm">
              {(
                [
                  { label: 'Room Name', value: qrModalRoom.room_name,  mono: false },
                  { label: 'Type',      value: qrModalRoom.room_type,  mono: false },
                  { label: 'Building',  value: qrModalRoom.building || '—', mono: false },
                  { label: 'QR ID',     value: qrModalRoom.qr_code_id, mono: true  },
                ] as const
              ).map(({ label, value, mono }) => (
                <div
                  key={label}
                  className="flex justify-between items-center py-2.5"
                  style={{ borderBottom: `1px solid ${C.divider}` }}
                >
                  <span className="font-medium" style={{ color: C.slate }}>{label}</span>
                  <span
                    className={mono ? 'font-mono text-xs' : 'font-semibold'}
                    style={{ color: mono ? C.muted : C.navy }}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>

            <button
              onClick={() => {
                const a    = document.createElement('a');
                a.href     = qrModalRoom.qr_code_data;
                a.download = `${qrModalRoom.qr_code_id}.png`;
                a.click();
              }}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-white text-sm font-semibold transition-colors duration-150"
              style={{ backgroundColor: C.blue }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = C.blueDark)}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = C.blue)}
            >
              <Download className="w-4 h-4" />
              Download QR Code
            </button>
          </div>
        </Modal>
      )}

      {/* ── Add / Edit Modal ──────────────────────────────────────── */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editId ? 'Edit Room' : 'Add New Room'}
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p
              className="px-4 py-3 rounded-xl text-sm"
              style={{ backgroundColor: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626' }}
            >
              {error}
            </p>
          )}

          {/* Room type */}
          <div>
            <label className="block text-sm font-semibold mb-2" style={{ color: C.navy }}>
              Room Type *
            </label>
            <div className="grid grid-cols-2 gap-3">
              {(['Lecture', 'Laboratory'] as const).map(type => {
                const Icon   = type === 'Lecture' ? BookOpen : Monitor;
                const active = form.room_type === type;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => {
                      const next = firstAvailableName(type, editId ?? undefined);
                      setForm(f => ({ ...f, room_type: type, room_name: next }));
                    }}
                    className="flex items-center justify-center gap-2 py-3 rounded-xl border-2 text-sm font-semibold transition-all duration-150"
                    style={
                      active
                        ? { borderColor: C.blue, backgroundColor: C.blueTint, color: C.blue }
                        : { borderColor: C.border, backgroundColor: 'white', color: C.slate }
                    }
                    onMouseEnter={e => { if (!active) e.currentTarget.style.borderColor = C.blueBorder; }}
                    onMouseLeave={e => { if (!active) e.currentTarget.style.borderColor = C.border; }}
                  >
                    <Icon className="w-4 h-4" />
                    {type}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Room name */}
          <div>
            <label className="block text-sm font-semibold mb-2" style={{ color: C.navy }}>
              Room Name *
            </label>
            {(() => {
              const options  = getRoomOptions(form.room_type);
              const takenNow = new Set(
                rooms
                  .filter(r => r.room_type === form.room_type && r.status === 'Active' && r.id !== editId)
                  .map(r => r.room_name)
              );
              const extraOption =
                editId && form.room_name && !options.includes(form.room_name)
                  ? form.room_name
                  : null;
              const allTaken = options.every(o => takenNow.has(o));

              return (
                <>
                  <select
                    value={form.room_name}
                    onChange={e => setForm(f => ({ ...f, room_name: e.target.value }))}
                    required
                    className={INPUT_CLS}
                    style={{ color: C.navy, borderColor: C.border }}
                  >
                    <option value="" disabled>— Select room name —</option>
                    {extraOption && <option key="legacy" value={extraOption}>{extraOption}</option>}
                    {options.map(name => {
                      const taken = takenNow.has(name);
                      return (
                        <option key={name} value={name} disabled={taken}>
                          {name}{taken ? ' (already registered)' : ''}
                        </option>
                      );
                    })}
                  </select>
                  {allTaken && (
                    <p className="text-xs mt-1.5 font-medium text-amber-600">
                      All {form.room_type === 'Lecture' ? 'Lecture (1–10)' : 'Lab (1–15)'} rooms are already registered.
                    </p>
                  )}
                </>
              );
            })()}
          </div>

          {/* Capacity */}
          <div>
            <label className="block text-sm font-semibold mb-2" style={{ color: C.navy }}>
              Capacity (students)
            </label>
            <input
              type="number"
              min="0"
              value={form.capacity}
              onChange={e => setForm(f => ({ ...f, capacity: parseInt(e.target.value, 10) || 0 }))}
              className={INPUT_CLS}
              style={{ color: C.navy, borderColor: C.border }}
            />
          </div>

          {/* Building */}
          <div>
            <label className="block text-sm font-semibold mb-2" style={{ color: C.navy }}>
              Building
              <span className="ml-2 text-[10px] font-normal uppercase tracking-wider" style={{ color: C.muted }}>
                Auto-filled
              </span>
            </label>
            <input
              type="text"
              value={form.building}
              readOnly
              className={`${INPUT_CLS} cursor-default opacity-60 select-none`}
              style={{ color: C.navy, borderColor: C.border }}
            />
          </div>

          {/* QR notice */}
          {!editId && (
            <div
              className="flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm"
              style={{ backgroundColor: C.surface, border: `1px solid ${C.border}`, color: C.slate }}
            >
              <QrCode className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: C.muted }} />
              <span>A unique QR code will be automatically generated for this room.</span>
            </div>
          )}

          {/* Form actions */}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors duration-150"
              style={{ border: `1px solid ${C.border}`, color: C.slate, backgroundColor: 'white' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = C.surface)}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'white')}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold transition-colors duration-150 disabled:opacity-50"
              style={{ backgroundColor: C.blue }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.backgroundColor = C.blueDark; }}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = C.blue)}
            >
              {loading ? 'Saving…' : editId ? 'Update Room' : 'Add Room'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
