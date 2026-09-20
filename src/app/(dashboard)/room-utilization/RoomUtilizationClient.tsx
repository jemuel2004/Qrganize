'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useVisibilityAwareInterval } from '@/client/hooks/useVisibilityAwareInterval';
import dynamic from 'next/dynamic';
import { useToast } from '@/client/context/ToastContext';
import {
  XCircle,
  RefreshCw, Users, Loader2, History,
  ArrowRight, AlertCircle, ChevronDown,
} from 'lucide-react';
import { FilterSelect, SearchInput } from '@/components/ui/SearchFilter';
import { ListSkeleton } from '@/client/components/ui/skeletons';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/client/hooks/useMinLoading';

const OVERVIEW_COLORS = {
  available: '#3C91E6',
  inUse: '#22C55E',
  pending: '#F59E0B',
} as const;

const OverviewChart = dynamic(
  () =>
    import('@/client/components/charts/RoomUtilizationAnalyticsCharts').then(
      m => m.RoomUtilizationOverviewChart,
    ),
  {
    ssr: false,
    loading: () => <div className="h-[200px] rounded-lg bg-[#F8FAFC] animate-pulse" />,
  },
);

const TrendChart = dynamic(
  () =>
    import('@/client/components/charts/RoomUtilizationAnalyticsCharts').then(
      m => m.RoomUtilizationTrendChart,
    ),
  {
    ssr: false,
    loading: () => <div className="h-[220px] rounded-lg bg-[#F8FAFC] animate-pulse" />,
  },
);

/* ─── Types ──────────────────────────────────────────────────── */
interface Faculty {
  id: number; name: string; employee_id: string;
  position: string; employment_status: string;
}
interface AvailableRoom {
  id: number; room_name: string; room_type: string;
  building: string; capacity: number;
}
interface OccupancyRecord {
  id: number; room_id: number; faculty_id: number;
  status: 'Pending' | 'Occupied';
  reserved_at: string; expires_at: string; occupied_at?: string;
  scheduled_start?: string; scheduled_end?: string;
  room_name: string; room_type: string; building: string;
  faculty_name: string; employee_id: string;
  current_subject?: string;
}
interface AnalyticsData {
  available:  { count: number; rooms:   AvailableRoom[]    };
  pending:    { count: number; records: OccupancyRecord[]  };
  occupied:   { count: number; records: OccupancyRecord[]  };
  expired:    { count: number; records: OccupancyRecord[]  };
  most_utilized: { rooms: MostUtilizedRoom[] };
  peak_hours: { hourly: HourlyData[]; heatmap: HeatmapCell[] };
  summary:    { total_active_rooms: number; utilization_rate: number };
}
interface MostUtilizedRoom {
  id: number; room_name: string; room_type: string;
  building: string; capacity: number;
  usage_count: number; total_hours: number; utilization_pct: number;
}
interface HourlyData { hour: number; count: number; }
interface HeatmapCell { day_of_week: number; hour: number; scan_count: number; }

/* ─── Helpers ────────────────────────────────────────────────── */
function Countdown({ expiresAt, onExpired }: { expiresAt: string; onExpired: () => void }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
    setSecs(remaining);
    if (remaining <= 0) { onExpired(); return; }
    const t = setInterval(() => {
      setSecs(s => {
        if (s <= 1) { onExpired(); clearInterval(t); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [expiresAt, onExpired]);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  const urgent = secs < 120;
  return (
    <span className={`font-mono font-bold tabular-nums text-sm ${urgent ? 'text-red-500 animate-pulse' : 'text-amber-600'}`}>
      {m}:{String(s).padStart(2, '0')}
    </span>
  );
}

function StatusPill({ status }: { status: 'Available' | 'Pending' | 'Occupied' | 'Expired' }) {
  const cfg = {
    Available: 'text-green-700 bg-green-50 border-green-200',
    Pending:   'text-amber-700 bg-amber-50 border-amber-200',
    Occupied:  'text-red-700 bg-red-50 border-red-200',
    Expired:   'text-slate-600 bg-slate-100 border-slate-200',
  } as const;
  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border whitespace-nowrap ${cfg[status]}`}>
      {status}
    </span>
  );
}

function fmtTime(iso: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function fmtTimeStr(timeStr: string | undefined | null): string {
  if (!timeStr) return '—';
  const [h, m] = timeStr.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtDateTime(iso: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ─── Summary card ───────────────────────────────────────────── */
function SummaryCard({
  label, value, sub, onClick,
}: {
  label: string;
  value: string | number;
  sub?: string;
  onClick?: () => void;
}) {
  const className = [
    'bg-white border border-[#E2E8F0] rounded-xl p-4 sm:p-5 text-left w-full h-full min-w-0',
    'shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
    onClick ? 'hover:border-[#3C91E6]/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3C91E6]/30' : '',
  ].join(' ');
  const body = (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: '#94A3B8' }}>
        {label}
      </p>
      <p className="text-2xl font-bold tabular-nums mt-0.5 leading-tight" style={{ color: '#0F172A' }}>
        {value}
      </p>
      {sub && (
        <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>{sub}</p>
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}

/* ─── Status section shell ───────────────────────────────────── */
function StatusPanel({
  title, count, accent, children, toolbar, headerMeta, sectionRef,
  expanded, onToggle,
}: {
  title: string;
  count: number;
  accent: 'green' | 'amber' | 'red';
  children: React.ReactNode;
  /** Shown in the header always (e.g. “15-min window”). */
  headerMeta?: React.ReactNode;
  /** Shown only when expanded (e.g. Available filters). */
  toolbar?: React.ReactNode;
  sectionRef?: React.RefObject<HTMLDivElement | null>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const accentBar = {
    green: 'bg-green-500',
    amber: 'bg-amber-500',
    red:   'bg-red-500',
  }[accent];
  const countCls = {
    green: 'text-green-700 bg-green-50 border-green-200',
    amber: 'text-amber-700 bg-amber-50 border-amber-200',
    red:   'text-red-700 bg-red-50 border-red-200',
  }[accent];

  return (
    <div
      ref={sectionRef}
      className={[
        'bg-white border border-[#E2E8F0] rounded-xl overflow-hidden flex flex-col shadow-[0_1px_2px_rgba(15,23,42,0.04)]',
        expanded ? 'max-h-[420px]' : '',
      ].join(' ')}
    >
      <div className={`h-0.5 w-full flex-shrink-0 ${accentBar}`} />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
        className={[
          'w-full px-4 py-3 flex items-center gap-2 text-left transition-colors',
          'hover:bg-[#F8FAFC] focus-visible:outline-none focus-visible:bg-[#F8FAFC]',
          expanded ? 'border-b border-[#F1F5F9]' : '',
        ].join(' ')}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h2 className="text-sm font-bold truncate" style={{ color: '#1E3A5F' }}>{title}</h2>
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border tabular-nums flex-shrink-0 ${countCls}`}>
            {count}
          </span>
          {headerMeta && (
            <span className="inline-flex flex-shrink min-w-0 truncate">
              {headerMeta}
            </span>
          )}
        </div>
        <span
          className="flex-shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-md"
          style={{ color: '#94A3B8' }}
          aria-hidden
        >
          <ChevronDown
            className={`w-4 h-4 transition-transform duration-200 ${expanded ? 'rotate-180' : 'rotate-0'}`}
          />
        </span>
      </button>

      <div
        aria-hidden={!expanded}
        className="transition-[grid-template-rows,opacity] duration-200 ease-out"
        style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
          opacity: expanded ? 1 : 0,
        }}
      >
        <div className="overflow-hidden min-h-0">
          {toolbar && (
            <div className="px-4 py-2.5 border-b border-[#F1F5F9] flex items-center gap-2 flex-wrap">
              {toolbar}
            </div>
          )}
          <div className="overflow-y-auto overscroll-contain max-h-[340px]">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyList({ message }: { message: string }) {
  return (
    <div className="px-4 py-12 text-center text-sm" style={{ color: '#94A3B8' }}>
      {message}
    </div>
  );
}

function RoomMeta({ type, building, capacity }: { type: string; building?: string; capacity?: number }) {
  const parts = [type, building || null, capacity != null ? `${capacity} seats` : null].filter(Boolean);
  return (
    <p className="text-xs mt-0.5 break-words" style={{ color: '#64748B' }}>
      {parts.join(' · ')}
    </p>
  );
}

/* ─── Main ───────────────────────────────────────────────────── */
export default function RoomUtilizationClient() {
  const toast = useToast();

  const [faculty, setFaculty] = useState<Faculty[]>([]);
  const [selectedFaculty, setSelectedFaculty] = useState('');
  const [facultyLoading, setFacultyLoading] = useState(true);

  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<'weekly' | 'monthly' | 'semester'>('weekly');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [reserving, setReserving] = useState<number | null>(null);
  const [releasing, setReleasing] = useState(false);

  const [historyLoading, setHistoryLoading] = useState(false);

  const [searchBuilding, setSearchBuilding] = useState('');
  const [searchType, setSearchType] = useState('');
  const [panelOpen, setPanelOpen] = useState({
    available: true,
    pending: false,
    occupied: false,
  });

  const availableRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<HTMLDivElement>(null);
  const occupiedRef = useRef<HTMLDivElement>(null);

  const togglePanel = (key: keyof typeof panelOpen) => {
    setPanelOpen(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const openPanelAndScroll = (
    key: keyof typeof panelOpen,
    ref: React.RefObject<HTMLDivElement | null>,
  ) => {
    setPanelOpen(prev => ({ ...prev, [key]: true }));
    requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  useEffect(() => {
    fetch('/api/faculty')
      .then(r => r.json())
      .then(d => {
        const list: Faculty[] = (d.faculty || d || []).map((f: Record<string, string | number>) => ({
          id:                f.id,
          name:              f.name || `${f.first_name ?? ''} ${f.last_name ?? ''}`.trim(),
          employee_id:       String(f.employee_id || f.faculty_code || ''),
          position:          String(f.position || ''),
          employment_status: String(f.employment_status || ''),
        })).filter((f: Faculty) => f.name);
        setFaculty(list);
      })
      .catch(() => {})
      .finally(() => setFacultyLoading(false));
  }, []);

  const fetchAnalytics = useCallback(() => {
    setLoading(true);
    fetch(`/api/rooms/analytics?period=${period}`)
      .then(r => r.json())
      .then(d => {
        if (!d.error) {
          setAnalytics(d);
          setLastUpdated(new Date());
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => { fetchAnalytics(); }, [fetchAnalytics]);
  useVisibilityAwareInterval(fetchAnalytics, 30_000);

  const showUtilSkeleton = useMinLoading(loading && !analytics, PAGE_SKELETON_MIN_MS);

  const fetchHistory = useCallback(() => {
    if (!selectedFaculty) return;
    setHistoryLoading(true);
    fetch(`/api/rooms/occupancy?faculty_id=${selectedFaculty}&include_history=true`)
      .then(r => r.json())
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  }, [selectedFaculty]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const myOccupancy = analytics
    ? [...(analytics.pending.records || []), ...(analytics.occupied.records || [])]
        .find(r => String(r.faculty_id) === String(selectedFaculty))
    : null;

  async function reserveRoom(roomId: number) {
    if (!selectedFaculty) { toast.error('Select an instructor first.'); return; }
    setReserving(roomId);
    try {
      const res  = await fetch('/api/rooms/occupancy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: roomId, faculty_id: Number(selectedFaculty) }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Room reservation failed.');
      } else {
        toast.success('Room reserved! You have 15 minutes to scan the QR code.');
        fetchAnalytics(); fetchHistory();
      }
    } catch { toast.error('Connection error. Please try again.'); }
    finally { setReserving(null); }
  }

  async function releaseRoom(roomId: number) {
    if (!selectedFaculty) return;
    setReleasing(true);
    try {
      const res = await fetch('/api/rooms/occupancy', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: roomId, faculty_id: Number(selectedFaculty) }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error || 'Release failed.'); }
      else { toast.success('Room released successfully.'); fetchAnalytics(); fetchHistory(); }
    } catch { toast.error('Connection error.'); }
    finally { setReleasing(false); }
  }

  const filteredAvailable = useMemo(() => {
    return (analytics?.available.rooms || []).filter(r => {
      const bOk = !searchBuilding || r.building?.toLowerCase().includes(searchBuilding.toLowerCase());
      const tOk = !searchType || r.room_type === searchType;
      return bOk && tOk;
    });
  }, [analytics?.available.rooms, searchBuilding, searchType]);

  const totalRooms = analytics?.summary.total_active_rooms ?? 0;
  const availableCount = analytics?.available.count ?? 0;
  const pendingCount = analytics?.pending.count ?? 0;
  const occupiedCount = analytics?.occupied.count ?? 0;
  const utilizationRate = analytics?.summary.utilization_rate ?? 0;

  const byTypeRows = useMemo(() => {
    type Agg = { type: string; total: number; inUse: number; available: number; pending: number };
    const map = new Map<string, Agg>();
    const bump = (type: string, field: 'available' | 'pending' | 'inUse') => {
      const key = type || 'Other';
      const row = map.get(key) ?? { type: key, total: 0, inUse: 0, available: 0, pending: 0 };
      row[field] += 1;
      row.total += 1;
      map.set(key, row);
    };
    for (const r of analytics?.available.rooms || []) bump(r.room_type, 'available');
    for (const r of analytics?.pending.records || []) bump(r.room_type, 'pending');
    for (const r of analytics?.occupied.records || []) bump(r.room_type, 'inUse');
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [analytics]);

  const overviewSegments = useMemo(() => [
    { name: 'Available', value: availableCount, color: OVERVIEW_COLORS.available },
    { name: 'In Use', value: occupiedCount, color: OVERVIEW_COLORS.inUse },
    { name: 'Pending', value: pendingCount, color: OVERVIEW_COLORS.pending },
  ], [availableCount, occupiedCount, pendingCount]);

  const trendData = useMemo(() => {
    // Source of truth: QR scan counts from peak_hours.heatmap (Valid/Late),
    // aggregated by day-of-week. Rate = relative share of the busiest day in view (0–100%).
    const scansByDay = Array.from({ length: 7 }, () => 0);
    for (const cell of analytics?.peak_hours.heatmap || []) {
      const dow = Number(cell.day_of_week);
      if (dow >= 0 && dow <= 6) scansByDay[dow] += Number(cell.scan_count) || 0;
    }

    // Weekly: Mon–Fri only. Monthly/Semester keep prior Mon–Sun axis.
    const order = period === 'weekly'
      ? [1, 2, 3, 4, 5]
      : [1, 2, 3, 4, 5, 6, 0];

    const scoped = order.map(dow => scansByDay[dow]);
    const max = Math.max(0, ...scoped);
    const denom = max > 0 ? max : 1;

    return order.map((dow, i) => {
      const scans = scoped[i];
      const raw = (scans / denom) * 100;
      const rate = max === 0 ? 0 : Math.min(100, Math.round(raw * 100) / 100);
      return {
        day: DAYS_SHORT[dow],
        scans,
        rate,
      };
    });
  }, [analytics?.peak_hours.heatmap, period]);

  // All active rooms from analytics (incl. 0%); sorted high → low utilization.
  const sortedTopRooms = useMemo(() => {
    const list = [...(analytics?.most_utilized.rooms || [])];
    list.sort((a, b) => {
      const ua = Number(a.utilization_pct) || 0;
      const ub = Number(b.utilization_pct) || 0;
      if (ub !== ua) return ub - ua;
      const ca = Number(a.usage_count) || 0;
      const cb = Number(b.usage_count) || 0;
      if (cb !== ca) return cb - ca;
      return String(a.room_name).localeCompare(String(b.room_name), undefined, { sensitivity: 'base' });
    });
    return list;
  }, [analytics?.most_utilized.rooms]);

  const trendHasActivity = trendData.some(d => d.scans > 0 || d.rate > 0);

  /* ─── Render ───────────────────────────────────────────────── */
  return (
    <div className="w-full min-w-0 p-4 sm:p-6 space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold" style={{ color: '#1E3A5F' }}>Room Utilization</h1>
          <p className="text-sm mt-0.5" style={{ color: '#64748B' }}>
            Overview of room usage and availability
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-lg border border-[#E2E8F0] overflow-hidden bg-white">
            {(['weekly', 'monthly', 'semester'] as const).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`px-3.5 py-2 text-xs font-semibold capitalize transition ${
                  period === p ? 'text-white' : 'hover:bg-[#F8FAFC]'
                }`}
                style={period === p ? { backgroundColor: '#3C91E6', color: '#ffffff' } : { color: '#64748B' }}
              >
                {p}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={fetchAnalytics}
            className="p-2 rounded-lg border border-[#E2E8F0] bg-white hover:bg-[#F8FAFC] transition"
            aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} style={{ color: '#64748B' }} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-72 max-w-full">
          <label htmlFor="room-util-instructor" className="block text-xs font-semibold text-[#64748B] mb-1.5">
            Instructor
          </label>
          {facultyLoading ? (
            <div className="h-[42px] flex items-center">
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#94A3B8' }} />
            </div>
          ) : (
            <div className="relative">
              <select
                id="room-util-instructor"
                value={selectedFaculty}
                onChange={e => setSelectedFaculty(e.target.value)}
                className="w-full appearance-none bg-white border border-[#CBD5E1] rounded-xl pl-3 pr-9 py-2.5 text-sm text-[#1E3A5F] cursor-pointer hover:border-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/25 focus:border-[#3C91E6]"
              >
                <option value="">Choose an instructor</option>
                {faculty.map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#64748B]"
              />
            </div>
          )}
        </div>
        {myOccupancy && (
          <div className="flex items-center gap-2 pb-1 text-sm text-[#475569]">
            <span>
              {myOccupancy.room_name} · {myOccupancy.status}
              {myOccupancy.status === 'Pending' && (
                <> · <Countdown expiresAt={myOccupancy.expires_at} onExpired={fetchAnalytics} /> left</>
              )}
            </span>
            <button
              type="button"
              onClick={() => releaseRoom(myOccupancy.room_id)}
              disabled={releasing}
              className="text-sm font-medium text-[#3C91E6] hover:text-[#2563EB] disabled:opacity-50"
            >
              Release
            </button>
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4 w-full">
        <SummaryCard
          label="Total Rooms"
          value={totalRooms}
          sub="All active rooms"
        />
        <SummaryCard
          label="In Use"
          value={occupiedCount}
          sub="Currently used"
          onClick={() => openPanelAndScroll('occupied', occupiedRef)}
        />
        <SummaryCard
          label="Available"
          value={availableCount}
          sub="Ready to use"
          onClick={() => openPanelAndScroll('available', availableRef)}
        />
        <SummaryCard
          label="Pending"
          value={pendingCount}
          sub="Reserved soon"
          onClick={() => openPanelAndScroll('pending', pendingRef)}
        />
        <SummaryCard
          label="Utilization Rate"
          value={`${utilizationRate}%`}
          sub="Pending + occupied now"
        />
      </div>

      {/* Room status sections */}
      <PageLoadTransition
        showSkeleton={showUtilSkeleton}
        skeleton={<ListSkeleton rows={8} />}
      >
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 w-full min-w-0">
            {/* Available */}
            <StatusPanel
              sectionRef={availableRef}
              title="Available Rooms"
              count={filteredAvailable.length}
              accent="green"
              expanded={panelOpen.available}
              onToggle={() => togglePanel('available')}
              toolbar={
                <div className="flex items-center gap-1.5 w-full sm:w-auto">
                  <SearchInput
                    value={searchBuilding}
                    onChange={setSearchBuilding}
                    placeholder="Building…"
                    className="w-full sm:w-28 text-xs"
                  />
                  <FilterSelect
                    value={searchType}
                    onChange={setSearchType}
                    label="Type"
                    className="min-w-[7.5rem] text-xs"
                  >
                    <option value="">All types</option>
                    <option value="Lecture">Lecture</option>
                    <option value="Laboratory">Laboratory</option>
                    <option value="Computer Lab">Computer Lab</option>
                  </FilterSelect>
                </div>
              }
            >
              {filteredAvailable.length === 0 ? (
                <EmptyList message="No available rooms match the current filters." />
              ) : (
                <ul className="divide-y divide-[#F1F5F9]">
                  {filteredAvailable.map(room => (
                    <li key={room.id} className="px-4 py-3 hover:bg-[#F8FAFC] transition-colors">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-sm break-words leading-snug" style={{ color: '#0F172A' }}>
                            {room.room_name}
                          </p>
                          <RoomMeta type={room.room_type} building={room.building} capacity={room.capacity} />
                        </div>
                        <StatusPill status="Available" />
                      </div>
                      {selectedFaculty && (
                        <button
                          type="button"
                          onClick={() => reserveRoom(room.id)}
                          disabled={reserving === room.id || !!myOccupancy}
                          className="mt-2.5 w-full py-1.5 rounded-lg text-white text-xs font-semibold transition flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
                          style={{ backgroundColor: '#3C91E6', color: '#ffffff' }}
                        >
                          {reserving === room.id
                            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reserving…</>
                            : myOccupancy
                              ? 'Already reserved'
                              : <><ArrowRight className="w-3.5 h-3.5" /> Reserve</>
                          }
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </StatusPanel>

            {/* Pending */}
            <StatusPanel
              sectionRef={pendingRef}
              title="Pending Rooms"
              count={pendingCount}
              accent="amber"
              expanded={panelOpen.pending}
              onToggle={() => togglePanel('pending')}
              headerMeta={
                <span className="text-[11px] flex items-center gap-1" style={{ color: '#94A3B8' }}>
                  <AlertCircle className="w-3 h-3" /> 15-min window
                </span>
              }
            >
              {(analytics?.pending.records || []).length === 0 ? (
                <EmptyList message="No pending reservations." />
              ) : (
                <ul className="divide-y divide-[#F1F5F9]">
                  {(analytics?.pending.records || []).map(rec => (
                    <li key={rec.id} className="px-4 py-3 hover:bg-[#F8FAFC] transition-colors">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold text-sm break-words leading-snug" style={{ color: '#0F172A' }}>
                            {rec.room_name}
                          </p>
                          <RoomMeta type={rec.room_type} building={rec.building} />
                          <p className="text-xs mt-1 flex items-center gap-1" style={{ color: '#64748B' }}>
                            <Users className="w-3 h-3 flex-shrink-0" />
                            <span className="break-words">{rec.faculty_name}</span>
                          </p>
                          <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>
                            Expires in <Countdown expiresAt={rec.expires_at} onExpired={fetchAnalytics} />
                          </p>
                        </div>
                        <StatusPill status="Pending" />
                      </div>
                      {selectedFaculty && String(rec.faculty_id) === String(selectedFaculty) && (
                        <button
                          type="button"
                          onClick={() => releaseRoom(rec.room_id)}
                          disabled={releasing}
                          className="mt-2.5 w-full py-1.5 rounded-lg border border-red-200 text-red-600 text-xs font-semibold hover:bg-red-50 transition"
                        >
                          Cancel reservation
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </StatusPanel>

            {/* Occupied */}
            <StatusPanel
              sectionRef={occupiedRef}
              title="Occupied Rooms"
              count={occupiedCount}
              accent="red"
              expanded={panelOpen.occupied}
              onToggle={() => togglePanel('occupied')}
            >
              {(analytics?.occupied.records || []).length === 0 ? (
                <EmptyList message="No rooms currently occupied." />
              ) : (
                <ul className="divide-y divide-[#F1F5F9]">
                  {(analytics?.occupied.records || []).map(rec => {
                    const occupiedSince = rec.occupied_at ? fmtTime(rec.occupied_at) : fmtTime(rec.reserved_at);
                    const endsAt = rec.scheduled_end
                      ? fmtTimeStr(rec.scheduled_end)
                      : fmtTime(rec.expires_at);
                    return (
                      <li key={rec.id} className="px-4 py-3 hover:bg-[#F8FAFC] transition-colors">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold text-sm break-words leading-snug" style={{ color: '#0F172A' }}>
                              {rec.room_name}
                            </p>
                            <RoomMeta type={rec.room_type} building={rec.building} />
                            <p className="text-xs mt-1 flex items-center gap-1" style={{ color: '#64748B' }}>
                              <Users className="w-3 h-3 flex-shrink-0" />
                              <span className="break-words">{rec.faculty_name}</span>
                            </p>
                            {rec.current_subject && (
                              <p className="text-xs mt-0.5 break-words" style={{ color: '#3C91E6' }}>
                                {rec.current_subject}
                              </p>
                            )}
                            <p className="text-xs mt-1" style={{ color: '#94A3B8' }}>
                              Since {occupiedSince} · Ends {endsAt}
                            </p>
                          </div>
                          <StatusPill status="Occupied" />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </StatusPanel>
          </div>

          {/* Analytics */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 w-full min-w-0">
            <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 sm:p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <h2 className="text-sm font-bold mb-1" style={{ color: '#1E3A5F' }}>
                Room Utilization Overview
              </h2>
              <p className="text-xs mb-4" style={{ color: '#94A3B8' }}>
                Current status across active rooms
              </p>
              <OverviewChart segments={overviewSegments} total={totalRooms} />
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 sm:p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <h2 className="text-sm font-bold mb-1" style={{ color: '#1E3A5F' }}>
                Room Utilization by Type
              </h2>
              <p className="text-xs mb-4" style={{ color: '#94A3B8' }}>
                Breakdown from live room status
              </p>
              {byTypeRows.length === 0 ? (
                <EmptyList message="No room type data." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[420px]">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide border-b border-[#F1F5F9]" style={{ color: '#94A3B8' }}>
                        <th className="pb-2 font-semibold">Room Type</th>
                        <th className="pb-2 font-semibold text-right">Total</th>
                        <th className="pb-2 font-semibold text-right">In Use</th>
                        <th className="pb-2 font-semibold text-right">Available</th>
                        <th className="pb-2 font-semibold pl-3">Utilization</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9]">
                      {byTypeRows.map(row => {
                        const rate = row.total > 0
                          ? Math.round(((row.inUse + row.pending) / row.total) * 100)
                          : 0;
                        return (
                          <tr key={row.type}>
                            <td className="py-2.5 font-medium break-words" style={{ color: '#0F172A' }}>{row.type}</td>
                            <td className="py-2.5 text-right tabular-nums" style={{ color: '#64748B' }}>{row.total}</td>
                            <td className="py-2.5 text-right tabular-nums" style={{ color: '#64748B' }}>{row.inUse}</td>
                            <td className="py-2.5 text-right tabular-nums" style={{ color: '#64748B' }}>{row.available}</td>
                            <td className="py-2.5 pl-3 min-w-[120px]">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-1.5 rounded-full bg-[#F1F5F9] overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-green-500"
                                    style={{ width: `${rate}%` }}
                                  />
                                </div>
                                <span className="text-xs font-semibold tabular-nums w-9 text-right" style={{ color: '#1E3A5F' }}>
                                  {rate}%
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      <tr className="border-t border-[#E2E8F0]">
                        <td className="py-2.5 font-bold" style={{ color: '#1E3A5F' }}>Total</td>
                        <td className="py-2.5 text-right font-bold tabular-nums" style={{ color: '#1E3A5F' }}>{totalRooms}</td>
                        <td className="py-2.5 text-right font-bold tabular-nums" style={{ color: '#1E3A5F' }}>{occupiedCount}</td>
                        <td className="py-2.5 text-right font-bold tabular-nums" style={{ color: '#1E3A5F' }}>{availableCount}</td>
                        <td className="py-2.5 pl-3">
                          <span className="text-xs font-bold tabular-nums" style={{ color: '#1E3A5F' }}>
                            {utilizationRate}%
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 sm:p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] h-full flex flex-col min-h-[280px]">
              <h2 className="text-sm font-bold mb-1" style={{ color: '#1E3A5F' }}>
                Utilization Trend
              </h2>
              <p className="text-xs" style={{ color: '#94A3B8' }}>
                Relative scan activity by day ({period})
              </p>
              {!trendHasActivity && (
                <p className="text-[11px] mt-1 mb-1" style={{ color: '#CBD5E1' }}>
                  No usage recorded yet
                </p>
              )}
              <div className={`flex-1 min-h-[220px] ${trendHasActivity ? 'mt-2' : 'mt-1'}`}>
                <TrendChart data={trendData} />
              </div>
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 sm:p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] h-full flex flex-col min-h-[280px]">
              <div className="flex-shrink-0">
                <h2 className="text-sm font-bold mb-1" style={{ color: '#1E3A5F' }}>
                  Top Room Usage
                </h2>
                <p className="text-xs mb-3" style={{ color: '#94A3B8' }}>
                  Most used rooms this {period}
                </p>
              </div>
              {sortedTopRooms.length === 0 ? (
                <p className="text-sm py-6" style={{ color: '#94A3B8' }}>
                  No rooms available.
                </p>
              ) : (
                <ul
                  className="divide-y divide-[#F1F5F9] overflow-y-auto overscroll-contain -mx-1 px-1 flex-1"
                  style={{ maxHeight: 260 }}
                >
                  {sortedTopRooms.map(room => {
                    const displayPct = Math.min(100, Math.max(0, Number(room.utilization_pct) || 0));
                    const sessions = Number(room.usage_count) || 0;
                    return (
                      <li key={room.id} className="py-2.5 first:pt-0">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold break-words leading-snug" style={{ color: '#0F172A' }}>
                              {room.room_name}
                            </p>
                            <p className="text-xs break-words mt-0.5" style={{ color: '#94A3B8' }}>
                              {room.room_type}{room.building ? ` · ${room.building}` : ''}
                              {' · '}{sessions} session{sessions === 1 ? '' : 's'}
                            </p>
                          </div>
                          <span className="text-xs font-bold tabular-nums flex-shrink-0" style={{ color: '#1E3A5F' }}>
                            {displayPct}%
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-[#F1F5F9] overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${displayPct}%`, backgroundColor: '#3C91E6' }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* Expired (compact) */}
          {(analytics?.expired.records || []).length > 0 && (
            <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <div className="px-4 py-3 border-b border-[#F1F5F9] flex items-center gap-2">
                <XCircle className="w-4 h-4" style={{ color: '#94A3B8' }} />
                <h2 className="text-sm font-bold" style={{ color: '#1E3A5F' }}>Expired Reservations</h2>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md border border-slate-200 bg-slate-50 text-slate-600">
                  Last 24 hours · {analytics?.expired.count ?? 0}
                </span>
              </div>
              <div className="overflow-x-auto max-h-56 overflow-y-auto">
                <table className="w-full text-sm min-w-[560px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide border-b border-[#F1F5F9] bg-[#F8FAFC]" style={{ color: '#94A3B8' }}>
                      <th className="px-4 py-2 font-semibold">Room</th>
                      <th className="px-4 py-2 font-semibold">Instructor</th>
                      <th className="px-4 py-2 font-semibold">Reserved</th>
                      <th className="px-4 py-2 font-semibold">Expired</th>
                      <th className="px-4 py-2 font-semibold text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1F5F9]">
                    {(analytics?.expired.records || []).map(rec => (
                      <tr key={rec.id} className="hover:bg-[#F8FAFC]">
                        <td className="px-4 py-2">
                          <div className="font-medium break-words" style={{ color: '#0F172A' }}>{rec.room_name}</div>
                          <div className="text-xs" style={{ color: '#94A3B8' }}>{rec.building}</div>
                        </td>
                        <td className="px-4 py-2" style={{ color: '#64748B' }}>{rec.faculty_name}</td>
                        <td className="px-4 py-2" style={{ color: '#64748B' }}>{fmtDateTime(rec.reserved_at)}</td>
                        <td className="px-4 py-2 text-red-500 font-mono text-xs">{fmtDateTime(rec.expires_at)}</td>
                        <td className="px-4 py-2 text-center"><StatusPill status="Expired" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Personal history when instructor selected */}
          {selectedFaculty && (
            <div className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              <div className="px-4 py-3 border-b border-[#F1F5F9] flex items-center gap-2 flex-wrap">
                <History className="w-4 h-4" style={{ color: '#64748B' }} />
                <h2 className="text-sm font-bold" style={{ color: '#1E3A5F' }}>Instructor Room History</h2>
                <span className="text-xs px-2 py-0.5 rounded-md bg-[#F8FAFC] border border-[#E2E8F0]" style={{ color: '#64748B' }}>
                  {faculty.find(f => String(f.id) === selectedFaculty)?.name}
                </span>
              </div>
              {historyLoading ? (
                <div className="py-10 flex justify-center">
                  <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#94A3B8' }} />
                </div>
              ) : (analytics?.expired.records || []).filter(r => String(r.faculty_id) === selectedFaculty).length === 0 && !myOccupancy ? (
                <EmptyList message="No room usage history for this instructor." />
              ) : (
                <ul className="divide-y divide-[#F1F5F9]">
                  {myOccupancy && (
                    <li className="px-4 py-3 flex items-center justify-between gap-3 bg-[#F8FAFC]">
                      <div className="min-w-0">
                        <p className="font-semibold text-sm break-words" style={{ color: '#0F172A' }}>{myOccupancy.room_name}</p>
                        <p className="text-xs" style={{ color: '#94A3B8' }}>
                          {myOccupancy.building} · Reserved at {fmtTime(myOccupancy.reserved_at)}
                        </p>
                      </div>
                      <StatusPill status={myOccupancy.status} />
                    </li>
                  )}
                  {(analytics?.expired.records || [])
                    .filter(r => String(r.faculty_id) === selectedFaculty)
                    .slice(0, 8)
                    .map(rec => (
                      <li key={rec.id} className="px-4 py-3 flex items-center justify-between gap-3 hover:bg-[#F8FAFC]">
                        <div className="min-w-0">
                          <p className="font-medium text-sm break-words" style={{ color: '#64748B' }}>{rec.room_name}</p>
                          <p className="text-xs" style={{ color: '#94A3B8' }}>{rec.building} · {fmtDateTime(rec.reserved_at)}</p>
                        </div>
                        <StatusPill status="Expired" />
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </>
      </PageLoadTransition>

      <div className="flex items-center justify-between gap-3 flex-wrap pb-1 pt-1">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-xs" style={{ color: '#94A3B8' }}>Auto-refreshes every 30 seconds</span>
        </div>
        {lastUpdated && (
          <span className="text-xs" style={{ color: '#94A3B8' }}>
            Last updated {lastUpdated.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
      </div>
    </div>
  );
}
