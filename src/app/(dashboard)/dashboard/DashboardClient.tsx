'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useVisibilityAwareInterval } from '@/client/hooks/useVisibilityAwareInterval';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';
import { DashboardSkeleton } from '@/client/components/ui/skeletons';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import Link from 'next/link';
import {
  RefreshCw,
  AlertTriangle,
  ChevronRight,
  Clock,
  DoorOpen,
  Users,
  ClipboardList,
  CalendarRange,
  CheckCircle2,
  Activity,
} from 'lucide-react';

/* ─── Types ──────────────────────────────────────────────────── */
interface Stats {
  available_rooms: number;
  occupied_rooms: number;
  pending_occupancy?: number;
  total_rooms?: number;
  utilization_rate?: number;
  pending_requests: number;
  today_schedules: number;
  late_scans_today: number;
  overuse_today: number;
}

interface RecentScan {
  id: number;
  room_name: string;
  faculty_name: string | null;
  scan_time: string;
  scan_date: string;
  status: string;
}

interface DashboardData {
  user: { username: string; role: string } | null;
  stats: Stats;
  recent_scans: RecentScan[];
}

interface MonitoringData {
  incomplete_instructor_count: number;
  unassigned_subject_count: number;
  complete_instructor_count?: number;
  incomplete_instructors: {
    faculty_id: number;
    name: string;
    employment_status: string;
    current_load: number;
    regular_load_limit: number;
    remaining_load: number;
    unit?: 'units' | 'hours';
    message: string;
  }[];
  incomplete_blocks: {
    block_id: number;
    block_name: string;
    program_id: number;
    program_code: string;
    program_name?: string;
    year_level?: string;
    unassigned_count: number;
    message: string;
  }[];
  overload_review_instructors?: {
    faculty_id: number;
    name: string;
    message: string;
  }[];
}

interface ActionRow {
  key: string;
  title: string;
  description: string;
  count: number;
  href: string;
  tone: 'amber' | 'red' | 'blue';
}

const WORKLOAD_ISSUE_PREVIEW = 4;
const ACTIVITY_PREVIEW = 5;

/* ─── Helpers ────────────────────────────────────────────────── */
function parseScanDate(timeStr: string, dateStr: string): Date | null {
  if (timeStr && timeStr.includes('T')) {
    const iso = new Date(timeStr);
    if (!Number.isNaN(iso.getTime())) return iso;
  }
  const [datePart] = (dateStr || '').split('T');
  const [timePart] = (timeStr || '').split('.');
  if (!datePart || !timePart) return null;
  const combined = new Date(timePart.includes('T') ? timePart : `${datePart}T${timePart}`);
  return Number.isNaN(combined.getTime()) ? null : combined;
}

function fmtScanTime(timeStr: string, dateStr: string): string {
  const dt = parseScanDate(timeStr, dateStr);
  if (!dt) return timeStr || '—';
  const today = new Date();
  const sameDay =
    dt.getFullYear() === today.getFullYear() &&
    dt.getMonth() === today.getMonth() &&
    dt.getDate() === today.getDate();
  if (sameDay) {
    return dt.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  return dt.toLocaleString('en-PH', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function fmtQty(n: number): string {
  const v = Number(n) || 0;
  if (Math.abs(v - Math.round(v)) < 0.001) return String(Math.round(v));
  return v.toFixed(2);
}

function facultySchedulesHref(facultyId: number): string {
  return `/faculty-schedules?facultyId=${facultyId}`;
}

function tickNow() {
  return new Date();
}

/** 5:00 AM–11:59 AM morning, 12:00 PM–5:59 PM afternoon, otherwise evening. */
function dayGreeting(d: Date): 'Good morning' | 'Good afternoon' | 'Good evening' {
  const mins = d.getHours() * 60 + d.getMinutes();
  if (mins >= 5 * 60 && mins < 12 * 60) return 'Good morning';
  if (mins >= 12 * 60 && mins < 18 * 60) return 'Good afternoon';
  return 'Good evening';
}

function displayNameFromUsername(username: string | null | undefined): string {
  const raw = username?.trim();
  if (!raw) return 'Admin';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function utilizationFromStats(stats: Stats): number {
  if (typeof stats.utilization_rate === 'number') return stats.utilization_rate;
  const total = stats.total_rooms
    ?? (stats.available_rooms + stats.occupied_rooms + (stats.pending_occupancy ?? 0));
  if (total <= 0) return 0;
  return Math.round(((stats.occupied_rooms + (stats.pending_occupancy ?? 0)) / total) * 100);
}

/* ─── UI atoms ───────────────────────────────────────────────── */
const CARD_SURFACE =
  'bg-[var(--surface-elevated)] border border-[color:var(--border)] rounded-xl shadow-[0_1px_3px_rgba(15,23,42,0.06)]';

const MetricCard = memo(function MetricCard({
  label,
  value,
  sub,
  href,
  icon: Icon,
  accent = 'blue',
  valueSuffix,
}: {
  label: string;
  value: number | string;
  sub: string;
  href: string;
  icon: React.ElementType;
  accent?: 'blue' | 'amber' | 'green' | 'slate';
  valueSuffix?: string;
}) {
  const accentCls = {
    blue:  'text-[#3C91E6] bg-[#EFF6FF]',
    amber: 'text-[#D97706] bg-[#FFFBEB]',
    green: 'text-[#059669] bg-[#ECFDF5]',
    slate: 'text-[#475569] bg-[#F1F5F9]',
  }[accent];

  return (
    <Link
      href={href}
      className={`block min-w-0 ${CARD_SURFACE} qr-hover-card transition-colors duration-150 hover:border-[#3C91E6]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3C91E6]/35`}
    >
      <div className="px-4 sm:px-5 py-4 flex flex-col gap-3 min-h-[132px]">
        <div className="flex items-start justify-between gap-3">
          <p className="text-[14px] sm:text-[15px] font-semibold text-[color:var(--foreground-secondary)] leading-snug">
            {label}
          </p>
          <span className={`inline-flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0 ${accentCls}`}>
            <Icon className="w-[18px] h-[18px]" aria-hidden />
          </span>
        </div>
        <p className="text-[28px] sm:text-[32px] font-semibold tabular-nums leading-none tracking-tight text-[color:var(--foreground)]">
          {typeof value === 'number' ? value.toLocaleString() : value}
          {valueSuffix ? (
            <span className="text-[18px] font-semibold text-[color:var(--foreground-muted)] ml-0.5">
              {valueSuffix}
            </span>
          ) : null}
        </p>
        <p className="text-[13px] sm:text-[14px] text-[color:var(--foreground-muted)] mt-auto">
          {sub}
        </p>
      </div>
    </Link>
  );
});

function SectionShell({
  title,
  children,
  footer,
  badge,
  className = '',
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  badge?: number;
  className?: string;
}) {
  return (
    <section className={`${CARD_SURFACE} flex flex-col min-w-0 overflow-hidden ${className}`}>
      <div className="px-4 sm:px-5 py-3.5 border-b border-[color:var(--border-subtle)] flex items-center gap-2.5 flex-shrink-0">
        <h2 className="text-[16px] sm:text-[17px] font-semibold text-[color:var(--foreground)] truncate">
          {title}
        </h2>
        {typeof badge === 'number' && badge > 0 ? (
          <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-[#DBEAFE] text-[#1D4ED8] text-[11px] font-bold tabular-nums">
            {badge}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
      {footer ? (
        <div className="px-4 sm:px-5 py-3 border-t border-[color:var(--border-subtle)] flex-shrink-0">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 min-h-10 text-[14px] font-semibold text-[#3C91E6] hover:text-[#2563EB] hover:underline underline-offset-2"
    >
      {children}
      <ChevronRight className="w-4 h-4" />
    </Link>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="px-4 sm:px-5 py-8 text-center text-[14px] sm:text-[15px] text-[color:var(--foreground-muted)]">
      {message}
    </div>
  );
}

function UtilizationRing({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent));
  const r = 42;
  const c = 2 * Math.PI * r;
  const offset = c - (p / 100) * c;

  return (
    <div className="relative w-[112px] h-[112px] flex-shrink-0" aria-hidden>
      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          className="text-[color:var(--border-subtle)]"
        />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="#3C91E6"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[22px] font-bold tabular-nums text-[color:var(--foreground)] leading-none">
          {p}%
        </span>
        <span className="text-[11px] font-medium text-[color:var(--foreground-muted)] mt-1">
          Utilized
        </span>
      </div>
    </div>
  );
}

function ScanStatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    Valid:   'bg-[#ECFDF5] text-[#15803D]',
    Late:    'bg-[#FFFBEB] text-[#B45309]',
    Overuse: 'bg-[#FEF2F2] text-[#B91C1C]',
    Invalid: 'bg-[#F1F5F9] text-[#64748B]',
  };
  return (
    <span className={`text-[12px] font-semibold px-2 py-0.5 rounded-md whitespace-nowrap ${map[status] ?? map.Invalid}`}>
      {status}
    </span>
  );
}

const DashboardHeader = memo(function DashboardHeader({
  displayName,
  onRefresh,
  refreshing,
}: {
  displayName: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(tickNow());
  }, []);
  useVisibilityAwareInterval(() => setNow(tickNow()), 1_000);

  const greeting = now ? `${dayGreeting(now)}, ${displayName}` : null;
  const dateStr = now?.toLocaleDateString('en-PH', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = now?.toLocaleTimeString('en-PH', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });

  return (
    <div className="flex items-start sm:items-center justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-[24px] sm:text-[28px] font-semibold tracking-tight text-[color:var(--foreground)] leading-tight">
          {greeting ?? '\u00a0'}
        </h1>
        <p className="text-[14px] sm:text-[15px] text-[color:var(--foreground-muted)] mt-1.5 leading-6">
          Here&apos;s what&apos;s happening with your system today.
        </p>
        <p
          className="text-[13px] text-[color:var(--foreground-muted)] mt-1 tabular-nums truncate"
          aria-live="polite"
          aria-atomic="true"
        >
          {now && dateStr && timeStr ? `${dateStr} · ${timeStr}` : '\u00a0'}
        </p>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        className="inline-flex items-center gap-2 h-10 px-3.5 text-[14px] font-medium text-[color:var(--foreground-secondary)] bg-[var(--surface-elevated)] border border-[color:var(--border)] rounded-lg hover:border-[#3C91E6] hover:text-[#2563EB] transition-colors flex-shrink-0 cursor-pointer"
        title="Refresh"
        aria-label="Refresh dashboard"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </div>
  );
});

/* ─── Main ───────────────────────────────────────────────────── */
export default function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [monitoring, setMonitoring] = useState<MonitoringData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [dashRes, monRes] = await Promise.all([
        fetch('/api/dashboard', { cache: 'no-store', signal }),
        fetch('/api/workload/monitoring', { cache: 'no-store', signal }),
      ]);
      if (dashRes.ok) setData(await dashRes.json());
      if (monRes.ok) setMonitoring(await monRes.json());
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  useVisibilityAwareInterval(() => load(undefined, true), 30_000);

  const incompleteCount = monitoring?.incomplete_instructor_count ?? 0;
  const unassignedCount = monitoring?.unassigned_subject_count ?? 0;
  const overloadCount = monitoring?.overload_review_instructors?.length ?? 0;
  const completeCount = monitoring?.complete_instructor_count ?? 0;
  const incompleteBlocks = monitoring?.incomplete_blocks ?? [];

  const pendingActions = useMemo(() => {
    if (!data && !monitoring) return [] as ActionRow[];
    const rows: ActionRow[] = [];
    const pendingReq = data?.stats.pending_requests ?? 0;

    if (pendingReq > 0) {
      rows.push({
        key: 'room-requests',
        title: 'Room Requests',
        description: 'New room booking requests awaiting approval',
        count: pendingReq,
        href: '/room-requests',
        tone: 'amber',
      });
    }
    if (unassignedCount > 0) {
      rows.push({
        key: 'unassigned',
        title: 'Unassigned Subjects / Blocks',
        description: 'Subjects without an assigned instructor',
        count: unassignedCount,
        href: '/program/blocks',
        tone: 'amber',
      });
    }
    if (incompleteCount > 0) {
      rows.push({
        key: 'workload-incomplete',
        title: 'Incomplete Faculty Workload',
        description: 'Instructors with remaining regular load',
        count: incompleteCount,
        href: '/workload',
        tone: 'amber',
      });
    }
    if (overloadCount > 0) {
      rows.push({
        key: 'overload',
        title: 'Overload Review',
        description: 'Faculty with overload subjects needing review',
        count: overloadCount,
        href: '/overload',
        tone: 'amber',
      });
    }
    if (data?.stats.late_scans_today) {
      rows.push({
        key: 'late',
        title: 'Late QR Scans',
        description: 'Late room entry scans recorded today',
        count: data.stats.late_scans_today,
        href: '/room-utilization',
        tone: 'amber',
      });
    }
    if (data?.stats.overuse_today) {
      rows.push({
        key: 'overuse',
        title: 'Room Overuse Alerts',
        description: 'Overuse events recorded today',
        count: data.stats.overuse_today,
        href: '/room-utilization',
        tone: 'red',
      });
    }
    return rows;
  }, [data, monitoring, incompleteCount, unassignedCount, overloadCount]);

  const pendingActionsTotal = pendingActions.reduce((sum, r) => sum + r.count, 0);
  const workloadIssues = incompleteCount + overloadCount;
  const schedulingIssues = unassignedCount;
  const utilization = data ? utilizationFromStats(data.stats) : 0;
  const totalRooms = data?.stats.total_rooms
    ?? (data ? data.stats.available_rooms + data.stats.occupied_rooms + (data.stats.pending_occupancy ?? 0) : 0);

  const workloadIssueRows = useMemo(() => {
    if (!monitoring) return [];
    const rows: { key: string; name: string; detail: string; href: string }[] = [];
    for (const row of monitoring.incomplete_instructors.slice(0, WORKLOAD_ISSUE_PREVIEW)) {
      const unit = row.unit || (row.employment_status === 'Permanent' ? 'units' : 'hours');
      rows.push({
        key: `inc-${row.faculty_id}`,
        name: row.name,
        detail: `Remaining ${fmtQty(row.remaining_load)} ${unit}`,
        href: facultySchedulesHref(row.faculty_id),
      });
    }
    const remainingSlots = Math.max(0, WORKLOAD_ISSUE_PREVIEW - rows.length);
    for (const row of (monitoring.overload_review_instructors ?? []).slice(0, remainingSlots)) {
      rows.push({
        key: `ol-${row.faculty_id}`,
        name: row.name,
        detail: 'Overload review',
        href: facultySchedulesHref(row.faculty_id),
      });
    }
    return rows;
  }, [monitoring]);

  const displayName = displayNameFromUsername(data?.user?.username);
  const showSkeleton = useMinLoading(loading && !data, LOADING_DELAY);
  const activity = data?.recent_scans.slice(0, ACTIVITY_PREVIEW) ?? [];

  return (
    <div className="flex flex-col px-4 sm:px-6 py-6 gap-5 min-w-0 w-full max-w-7xl mx-auto">
      <PageLoadTransition
        showSkeleton={showSkeleton}
        skeleton={<DashboardSkeleton />}
        className="flex flex-col gap-5"
      >
        {data ? (
          <>
            <DashboardHeader
              displayName={displayName}
              onRefresh={() => load(undefined)}
              refreshing={loading}
            />

            {/* Primary metric cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 flex-shrink-0">
              <MetricCard
                label="Pending Actions"
                value={pendingActionsTotal}
                sub="Requires your attention"
                href={pendingActions[0]?.href ?? '/workload'}
                icon={ClipboardList}
                accent={pendingActionsTotal > 0 ? 'amber' : 'blue'}
              />
              <MetricCard
                label="Room Utilization"
                value={utilization}
                valueSuffix="%"
                sub={`${data.stats.occupied_rooms} occupied · ${data.stats.available_rooms} available`}
                href="/room-utilization"
                icon={DoorOpen}
                accent="blue"
              />
              <MetricCard
                label="Faculty Workload"
                value={workloadIssues}
                sub={workloadIssues === 1 ? 'With workload issues' : 'With workload issues'}
                href="/workload"
                icon={Users}
                accent={workloadIssues > 0 ? 'amber' : 'green'}
              />
              <MetricCard
                label="Scheduling Issues"
                value={schedulingIssues}
                sub="Unassigned subjects"
                href="/program/blocks"
                icon={CalendarRange}
                accent={schedulingIssues > 0 ? 'amber' : 'slate'}
              />
            </div>

            {/* Main content */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
              {/* Left / larger column */}
              <div className="lg:col-span-2 flex flex-col gap-5 min-w-0">
                <SectionShell
                  title="Pending Actions"
                  badge={pendingActions.length}
                  footer={
                    pendingActions.length > 0 ? (
                      <FooterLink href={pendingActions[0]?.href || '/room-requests'}>
                        Review actions
                      </FooterLink>
                    ) : undefined
                  }
                >
                  {pendingActions.length === 0 ? (
                    <EmptyState message="No pending actions. Your system is clear." />
                  ) : (
                    <ul className="divide-y divide-[color:var(--border-subtle)]">
                      {pendingActions.map(row => (
                        <li key={row.key}>
                          <Link
                            href={row.href}
                            className="flex items-start gap-3 px-4 sm:px-5 py-3.5 hover:bg-[color:var(--surface)] transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#3C91E6]/35"
                          >
                            <span
                              className={`mt-0.5 inline-flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0 ${
                                row.tone === 'red'
                                  ? 'bg-[#FEF2F2] text-[#B91C1C]'
                                  : 'bg-[#FFFBEB] text-[#B45309]'
                              }`}
                            >
                              <AlertTriangle className="w-4 h-4" aria-hidden />
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="flex items-center justify-between gap-3">
                                <span className="text-[15px] font-semibold text-[color:var(--foreground)] truncate">
                                  {row.title}
                                </span>
                                <span className="inline-flex items-center justify-center min-w-7 h-7 px-2 rounded-md bg-[#EFF6FF] text-[#1D4ED8] text-[13px] font-bold tabular-nums flex-shrink-0">
                                  {row.count}
                                </span>
                              </span>
                              <span className="block text-[13px] sm:text-[14px] text-[color:var(--foreground-muted)] mt-0.5">
                                {row.description}
                              </span>
                            </span>
                            <ChevronRight className="w-4 h-4 text-[color:var(--foreground-disabled)] flex-shrink-0 mt-2" aria-hidden />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </SectionShell>

                <SectionShell
                  title="Scheduling Issues"
                  badge={schedulingIssues}
                  footer={<FooterLink href="/scheduling">Open Scheduling</FooterLink>}
                >
                  {schedulingIssues === 0 && incompleteBlocks.length === 0 ? (
                    <EmptyState message="No scheduling issues detected." />
                  ) : (
                    <ul className="divide-y divide-[color:var(--border-subtle)]">
                      {unassignedCount > 0 ? (
                        <li>
                          <Link
                            href="/program/blocks"
                            className="flex items-center gap-3 px-4 sm:px-5 py-3.5 hover:bg-[color:var(--surface)] transition-colors cursor-pointer"
                          >
                            <CalendarRange className="w-4 h-4 text-[#3C91E6] flex-shrink-0" aria-hidden />
                            <span className="flex-1 min-w-0">
                              <span className="block text-[15px] font-semibold text-[color:var(--foreground)]">
                                Unassigned subjects
                              </span>
                              <span className="block text-[13px] text-[color:var(--foreground-muted)] mt-0.5">
                                Subjects without an assigned instructor
                              </span>
                            </span>
                            <span className="text-[15px] font-bold tabular-nums text-[#1D4ED8]">
                              {unassignedCount}
                            </span>
                            <ChevronRight className="w-4 h-4 text-[color:var(--foreground-disabled)]" aria-hidden />
                          </Link>
                        </li>
                      ) : null}
                      {incompleteBlocks.slice(0, 4).map(block => {
                        const programCode = block.program_code?.trim() || 'Program';
                        const noun = block.unassigned_count === 1 ? 'subject' : 'subjects';
                        return (
                          <li key={block.block_id}>
                            <Link
                              href={`/program/blocks/${block.block_id}`}
                              className="flex items-center gap-3 px-4 sm:px-5 py-3.5 hover:bg-[color:var(--surface)] transition-colors cursor-pointer"
                            >
                              <AlertTriangle className="w-4 h-4 text-[#B45309] flex-shrink-0" aria-hidden />
                              <span className="flex-1 min-w-0">
                                <span className="block text-[15px] font-semibold text-[color:var(--foreground)] truncate">
                                  {programCode} — Block {block.block_name}
                                </span>
                                <span className="block text-[13px] text-[color:var(--foreground-muted)] mt-0.5">
                                  {block.unassigned_count} unassigned {noun}
                                </span>
                              </span>
                              <ChevronRight className="w-4 h-4 text-[color:var(--foreground-disabled)]" aria-hidden />
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </SectionShell>

                <SectionShell
                  title="Recent System Activity"
                  footer={
                    activity.length > 0
                      ? <FooterLink href="/room-utilization">View scan history</FooterLink>
                      : undefined
                  }
                >
                  {activity.length === 0 ? (
                    <EmptyState message="No QR activity recorded today." />
                  ) : (
                    <ul className="divide-y divide-[color:var(--border-subtle)]">
                      {activity.map(scan => (
                        <li key={scan.id} className="px-4 sm:px-5 py-3 flex items-start gap-3">
                          <span className="mt-0.5 inline-flex items-center justify-center w-8 h-8 rounded-lg bg-[#EFF6FF] text-[#3C91E6] flex-shrink-0">
                            <Activity className="w-4 h-4" aria-hidden />
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-[14px] sm:text-[15px] font-semibold text-[color:var(--foreground)] truncate">
                                QR scan · {scan.room_name}
                              </p>
                              <ScanStatusChip status={scan.status} />
                            </div>
                            <p className="text-[13px] text-[color:var(--foreground-muted)] mt-0.5 truncate">
                              {scan.faculty_name || 'Unknown'}
                            </p>
                            <p className="text-[12px] text-[color:var(--foreground-muted)] mt-1 flex items-center gap-1.5">
                              <Clock className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
                              {fmtScanTime(scan.scan_time, scan.scan_date)}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </SectionShell>
              </div>

              {/* Right column */}
              <div className="flex flex-col gap-5 min-w-0">
                <SectionShell
                  title="Room Utilization"
                  footer={<FooterLink href="/room-utilization">View room utilization</FooterLink>}
                >
                  <div className="px-4 sm:px-5 py-5 flex flex-col sm:flex-row lg:flex-col items-center gap-5">
                    <UtilizationRing percent={utilization} />
                    <div className="w-full grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-3 py-2.5">
                        <p className="text-[12px] text-[color:var(--foreground-muted)]">Occupied</p>
                        <p className="text-[18px] font-bold tabular-nums text-[color:var(--foreground)] mt-0.5">
                          {data.stats.occupied_rooms}
                        </p>
                      </div>
                      <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-3 py-2.5">
                        <p className="text-[12px] text-[color:var(--foreground-muted)]">Available</p>
                        <p className="text-[18px] font-bold tabular-nums text-[color:var(--foreground)] mt-0.5">
                          {data.stats.available_rooms}
                        </p>
                      </div>
                      {(data.stats.pending_occupancy ?? 0) > 0 ? (
                        <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-3 py-2.5">
                          <p className="text-[12px] text-[color:var(--foreground-muted)]">Pending</p>
                          <p className="text-[18px] font-bold tabular-nums text-[color:var(--foreground)] mt-0.5">
                            {data.stats.pending_occupancy}
                          </p>
                        </div>
                      ) : null}
                      <div className="rounded-lg border border-[color:var(--border-subtle)] bg-[color:var(--surface)] px-3 py-2.5">
                        <p className="text-[12px] text-[color:var(--foreground-muted)]">Total rooms</p>
                        <p className="text-[18px] font-bold tabular-nums text-[color:var(--foreground)] mt-0.5">
                          {totalRooms}
                        </p>
                      </div>
                    </div>
                  </div>
                </SectionShell>

                <SectionShell
                  title="Faculty Workload"
                  footer={<FooterLink href="/workload">View Workload</FooterLink>}
                >
                  <div className="px-4 sm:px-5 pt-4 pb-2">
                    <div className="grid grid-cols-3 gap-2">
                      <div className="rounded-lg border border-[color:var(--border-subtle)] px-2.5 py-2.5 text-center">
                        <p className="text-[11px] font-medium text-[color:var(--foreground-muted)] uppercase tracking-wide">
                          Incomplete
                        </p>
                        <p className="text-[18px] font-bold tabular-nums text-[#B45309] mt-1">
                          {incompleteCount}
                        </p>
                      </div>
                      <div className="rounded-lg border border-[color:var(--border-subtle)] px-2.5 py-2.5 text-center">
                        <p className="text-[11px] font-medium text-[color:var(--foreground-muted)] uppercase tracking-wide">
                          Overload
                        </p>
                        <p className="text-[18px] font-bold tabular-nums text-[#B91C1C] mt-1">
                          {overloadCount}
                        </p>
                      </div>
                      <div className="rounded-lg border border-[color:var(--border-subtle)] px-2.5 py-2.5 text-center">
                        <p className="text-[11px] font-medium text-[color:var(--foreground-muted)] uppercase tracking-wide">
                          Complete
                        </p>
                        <p className="text-[18px] font-bold tabular-nums text-[#059669] mt-1">
                          {completeCount}
                        </p>
                      </div>
                    </div>
                  </div>

                  {workloadIssueRows.length === 0 ? (
                    <div className="px-4 sm:px-5 py-4 flex items-center gap-2 text-[14px] text-[color:var(--foreground-muted)]">
                      <CheckCircle2 className="w-4 h-4 text-[#059669] flex-shrink-0" aria-hidden />
                      No faculty workload issues right now.
                    </div>
                  ) : (
                    <ul className="divide-y divide-[color:var(--border-subtle)] border-t border-[color:var(--border-subtle)] mt-2">
                      {workloadIssueRows.map(row => (
                        <li key={row.key}>
                          <Link
                            href={row.href}
                            className="flex items-center gap-3 px-4 sm:px-5 py-3 hover:bg-[color:var(--surface)] transition-colors cursor-pointer"
                          >
                            <span className="flex-1 min-w-0">
                              <span className="block text-[14px] font-semibold text-[color:var(--foreground)] truncate">
                                {row.name}
                              </span>
                              <span className="block text-[12px] text-[color:var(--foreground-muted)] mt-0.5">
                                {row.detail}
                              </span>
                            </span>
                            <ChevronRight className="w-4 h-4 text-[color:var(--foreground-disabled)]" aria-hidden />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </SectionShell>
              </div>
            </div>
          </>
        ) : (
          <div className={`${CARD_SURFACE} px-5 py-16 text-center`}>
            <AlertTriangle className="w-8 h-8 mx-auto mb-3 text-[color:var(--foreground-disabled)]" />
            <p className="font-semibold text-[color:var(--foreground)]">Could not load dashboard</p>
            <p className="text-[15px] mt-1 text-[color:var(--foreground-muted)]">
              Check your connection and try again.
            </p>
            <button
              type="button"
              onClick={() => load(undefined)}
              className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-[#3C91E6] hover:text-[#2563EB] cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
          </div>
        )}
      </PageLoadTransition>
    </div>
  );
}
