'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useVisibilityAwareInterval } from '@/client/hooks/useVisibilityAwareInterval';
import { PAGE_SKELETON_MIN_MS, useMinLoading } from '@/client/hooks/useMinLoading';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { CardSkeleton, TableSkeleton } from '@/client/components/ui/skeletons';
import Link from 'next/link';
import {
  BarChart3, ChevronRight, RefreshCw,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Monitoring {
  total_rooms: number; scanned_today: number;
  issues_today: number; total_scans: number; vacant_today: number;
}
interface ProgramRow {
  program_name: string;
  program_code: string;
  total_subjects: string | number;
  instructor_count: string | number;
}
interface RoomUtilRow {
  id: number;
  room_name: string;
  room_type: string;
  building: string;
  status: string;
  scheduled_count: string | number;
  scanned_count: string | number;
}
interface DayRow { day_of_week: string; count: string | number }
interface ActivityRow {
  id: number;
  room_name: string;
  room_type: string;
  actor_name: string;
  status: string;
  event_date: string;
  event_time: string;
}

interface AnalyticsData {
  monitoring: Monitoring;
  workload_by_program: ProgramRow[];
  room_utilization: RoomUtilRow[];
  schedules_by_day: DayRow[];
  recent_activity: ActivityRow[];
  meta?: {
    school_year?: string | null;
    semester?: string | null;
    section_errors?: string[];
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT: Record<string, string> = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed',
  Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat',
};

const SCAN_STYLE: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  Valid:   { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500', label: 'Valid' },
  Late:    { bg: 'bg-amber-50',   text: 'text-amber-700',   dot: 'bg-amber-500',   label: 'Late' },
  Overuse: { bg: 'bg-red-50',     text: 'text-red-700',     dot: 'bg-red-500',     label: 'Overuse' },
  Invalid: { bg: 'bg-slate-100',  text: 'text-slate-600',   dot: 'bg-slate-400',   label: 'Invalid' },
};

const PROGRAM_COLORS = ['#3C91E6', '#3074B8', '#1E3A5F', '#64748B', '#94A3B8', '#60A5FA'];

function num(v: string | number | undefined): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtActivityTime(timeStr: string, dateStr: string) {
  try {
    const datePart = String(dateStr).split('T')[0];
    const timePart = String(timeStr).split('.')[0];
    const dt = new Date(`${datePart}T${timePart}`);
    if (isNaN(dt.getTime())) return timeStr;
    const dateLabel = dt.toLocaleDateString('en-PH', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timeLabel = dt.toLocaleTimeString('en-PH', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return `${dateLabel} · ${timeLabel}`;
  } catch {
    return timeStr;
  }
}

function CompactEmpty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="py-10 text-center">
      <p className="text-sm text-[#475569]">{message}</p>
      {hint ? <p className="text-xs text-[#94A3B8] mt-1">{hint}</p> : null}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-xl border border-[#E2E8F0] bg-white px-4 py-3.5">
      <p className="text-xs text-[#64748B] font-medium truncate">{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight text-[#1E3A5F]">{value}</p>
    </div>
  );
}

// ─── Vertical Bar Chart ───────────────────────────────────────────────────────

function VerticalBars({ bars, barColor = 'bg-[#3C91E6]', height = 'h-28' }: {
  bars: { label: string; value: number; sublabel?: string }[];
  barColor?: string;
  height?: string;
}) {
  const max = Math.max(...bars.map(b => b.value), 1);
  const total = bars.reduce((s, b) => s + b.value, 0);

  if (total === 0) {
    return (
      <CompactEmpty
        message="No schedule data available."
        hint="Scheduled classes will appear here by day."
      />
    );
  }

  return (
    <div className={`flex items-end gap-1.5 sm:gap-2 ${height}`}>
      {bars.map((b, i) => {
        const pct = (b.value / max) * 100;
        return (
          <div key={i} className="flex-1 flex flex-col items-center gap-1 h-full min-w-0">
            <div className="flex-1 w-full flex items-end justify-center">
              <div
                title={`${b.label}: ${b.value}`}
                className={`w-full max-w-[36px] ${barColor} rounded-t-md transition-all duration-500 opacity-80 hover:opacity-100`}
                style={{ height: b.value > 0 ? `${Math.max(pct, 6)}%` : '0%' }}
              />
            </div>
            {b.value > 0 && (
              <span className="text-[10px] font-semibold text-[#1E3A5F] tabular-nums leading-none">{b.value}</span>
            )}
            <span
              className="text-[10px] font-medium text-slate-500 text-center leading-tight w-full truncate"
              title={b.sublabel ?? b.label}
            >
              {b.sublabel ?? b.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Panel Shell ─────────────────────────────────────────────────────────────

function Panel({ title, subtitle, action, children, className = '', bodyClassName = '' }: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`bg-white rounded-xl border border-[#E2E8F0] flex flex-col min-w-0 ${className}`}>
      <div className="flex items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[#1E3A5F] leading-tight">{title}</h2>
          {subtitle ? <p className="text-xs text-[#64748B] mt-1">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      <div className={`px-5 pb-5 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [mounted, setMounted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (silent = false) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const res = await fetch('/api/analytics', { signal: ac.signal });
      if (!res.ok) {
        if (!silent) setError('Unable to load analytics.');
        return;
      }
      setData(await res.json());
      setLastUpdated(new Date());
      setError('');
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return;
      if (!silent) setError('Unable to load analytics.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setMounted(true);
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  useVisibilityAwareInterval(() => load(true), 60_000);

  const showSkeleton = useMinLoading(loading && !data, PAGE_SKELETON_MIN_MS);

  const workloadRows = data?.workload_by_program ?? [];
  const workloadTotal = workloadRows.reduce((s, r) => s + num(r.total_subjects), 0);
  const workloadSegments = workloadRows.map((r, i) => ({
    value: num(r.total_subjects),
    color: PROGRAM_COLORS[i % PROGRAM_COLORS.length],
    label: r.program_code,
  }));

  const dayMap = new Map((data?.schedules_by_day ?? []).map(r => [r.day_of_week, num(r.count)]));
  const dayBars = DAY_ORDER.map(d => ({
    label: d,
    sublabel: DAY_SHORT[d],
    value: dayMap.get(d) ?? 0,
  }));

  const mon = data?.monitoring;

  const sectionErrors = new Set(data?.meta?.section_errors ?? []);
  const workloadFailed = sectionErrors.has('workload_by_program');

  if (error && !data) {
    return (
      <div className="p-8 flex items-center justify-center">
        <div className="text-center max-w-sm">
          <BarChart3 className="w-10 h-10 text-slate-300 mx-auto mb-3" />
          <p className="text-[#1E3A5F] font-semibold text-base">{error}</p>
          <button
            type="button"
            onClick={() => load()}
            className="mt-4 inline-flex items-center gap-2 text-sm text-[#3C91E6] hover:text-[#2E7DD1] font-semibold"
          >
            <RefreshCw className="w-4 h-4" /> Try again
          </button>
        </div>
      </div>
    );
  }

  if (!showSkeleton && !data) return null;

  const metaHint = [data?.meta?.semester, data?.meta?.school_year ? `A.Y. ${data.meta.school_year}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <PageLoadTransition
      showSkeleton={showSkeleton}
      skeleton={
        <div className="p-4 sm:p-6 lg:p-8 space-y-4" role="status" aria-label="Loading analytics">
          <CardSkeleton className="h-8 w-48 max-w-full" />
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            {Array.from({ length: 5 }, (_, i) => (
              <CardSkeleton key={i} className="h-20" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CardSkeleton className="h-56" />
            <CardSkeleton className="h-56" />
          </div>
          <TableSkeleton rows={5} cols={5} />
        </div>
      }
    >
    {data ? (
    <div className="w-full min-w-0 p-4 sm:p-6 lg:p-8 space-y-6">

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-[#1E3A5F]">Analytics</h1>
          <p className="text-sm text-[#64748B] mt-1">
            {metaHint || 'System overview'}
            {mounted && lastUpdated ? (
              <span className="text-[#94A3B8]">
                {' '}· Updated {lastUpdated.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}
              </span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={() => load()}
          className="inline-flex items-center gap-2 border border-[#E2E8F0] bg-white hover:bg-[#F8FAFC] text-[#475569] px-3 py-2 rounded-lg text-sm font-medium transition-colors self-start sm:self-auto"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
        <StatCard label="Rooms monitored" value={mon?.total_rooms ?? 0} />
        <StatCard label="Scanned today" value={mon?.scanned_today ?? 0} />
        <StatCard label="Issues today" value={mon?.issues_today ?? 0} />
        <StatCard label="Vacant today" value={mon?.vacant_today ?? 0} />
        <StatCard label="Total scans" value={mon?.total_scans ?? 0} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <Panel
          title="Workload by program"
          subtitle="Assigned subjects from Instructor Workload"
          action={
            <Link href="/workload" className="text-xs font-medium text-[#64748B] hover:text-[#1E3A5F] inline-flex items-center gap-0.5 flex-shrink-0">
              Workload <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          }
        >
          {workloadFailed ? (
            <CompactEmpty
              message="Unable to load workload distribution."
              hint="Try Refresh. If it persists, check Instructor Workload data."
            />
          ) : workloadRows.length === 0 || workloadTotal === 0 ? (
            <CompactEmpty
              message="No workload distribution data available."
              hint="Assign subjects in Instructor Workload to see program totals."
            />
          ) : (
            <div className="space-y-4">
              <div className="h-2 w-full rounded-full overflow-hidden flex bg-[#F1F5F9]">
                {workloadSegments.filter(sg => sg.value > 0).map((sg, i) => (
                  <div
                    key={`${sg.label}-${i}`}
                    className="h-full"
                    style={{
                      width: `${(sg.value / workloadTotal) * 100}%`,
                      backgroundColor: sg.color,
                    }}
                    title={`${sg.label}: ${sg.value}`}
                  />
                ))}
              </div>
              <div className="space-y-2.5">
                {workloadRows.map((r, i) => {
                  const count = num(r.total_subjects);
                  const pct = workloadTotal > 0 ? ((count / workloadTotal) * 100) : 0;
                  return (
                    <div key={r.program_code} className="flex items-center gap-3 text-sm">
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: PROGRAM_COLORS[i % PROGRAM_COLORS.length] }}
                      />
                      <span className="font-medium text-[#1E3A5F] w-14 truncate" title={r.program_code}>
                        {r.program_code}
                      </span>
                      <span className="text-[#64748B] truncate flex-1 min-w-0 hidden sm:inline" title={r.program_name}>
                        {r.program_name}
                      </span>
                      <span className="font-medium text-[#1E3A5F] tabular-nums">{count}</span>
                      <span className="text-[#94A3B8] tabular-nums w-12 text-right">{`${pct.toFixed(0)}%`}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Panel>

        <Panel
          title="Schedules by day"
          subtitle="Active classes per weekday"
          action={
            <Link href="/scheduling" className="text-xs font-medium text-[#64748B] hover:text-[#1E3A5F] inline-flex items-center gap-0.5 flex-shrink-0">
              Schedule <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          }
        >
          <VerticalBars bars={dayBars} barColor="bg-[#3C91E6]" height="h-32" />
        </Panel>
      </div>

      <Panel
        title="Room utilization"
        subtitle="Scheduled sessions vs scans in the last 7 days"
        action={
          <Link href="/rooms" className="text-xs font-medium text-[#64748B] hover:text-[#1E3A5F] inline-flex items-center gap-0.5 flex-shrink-0">
            Rooms <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        }
        bodyClassName="!px-0 !pb-0"
      >
        <div className="overflow-x-auto max-h-[280px] overflow-y-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="sticky top-0 z-[1] bg-[#F8FAFC] border-y border-[#E2E8F0]">
              <tr>
                <th className="text-left px-5 py-2.5 text-xs font-medium text-[#64748B]">Room</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-[#64748B]">Type</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-[#64748B] hidden sm:table-cell">Building</th>
                <th className="text-right px-3 py-2.5 text-xs font-medium text-[#64748B]">Scheduled</th>
                <th className="text-right px-3 py-2.5 text-xs font-medium text-[#64748B]">Scanned</th>
                <th className="px-3 py-2.5 text-xs font-medium text-[#64748B]">Utilization</th>
                <th className="text-right px-5 py-2.5 text-xs font-medium text-[#64748B]">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {data.room_utilization.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4">
                    <CompactEmpty message="No room data available." />
                  </td>
                </tr>
              ) : data.room_utilization.map(room => {
                const scheduled = num(room.scheduled_count);
                const scannedCnt = num(room.scanned_count);
                const utilPct = scheduled > 0
                  ? Math.min(100, Math.round((scannedCnt / scheduled) * 100))
                  : scannedCnt > 0 ? 100 : 0;
                const usageLabel = scannedCnt > 0
                  ? 'Active'
                  : scheduled > 0
                    ? 'Unused'
                    : 'Idle';
                return (
                  <tr key={room.id} className="hover:bg-[#F8FAFC]">
                    <td className="px-5 py-2.5 font-medium text-[#1E3A5F] whitespace-nowrap">{room.room_name}</td>
                    <td className="px-3 py-2.5 text-[#475569] whitespace-nowrap">{room.room_type}</td>
                    <td className="px-3 py-2.5 text-[#64748B] hidden sm:table-cell">{room.building}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[#1E3A5F]">{scheduled}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-[#1E3A5F]">{scannedCnt}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2 min-w-[100px]">
                        <div className="flex-1 h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full bg-[#3C91E6]"
                            style={{ width: `${utilPct}%` }}
                          />
                        </div>
                        <span className="text-xs text-[#64748B] tabular-nums w-8 text-right">{`${utilPct}%`}</span>
                      </div>
                    </td>
                    <td className="px-5 py-2.5 text-right text-xs text-[#64748B]">{usageLabel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Recent activity"
        subtitle="Latest QR scan events"
        action={
          <Link href="/room-utilization" className="text-xs font-medium text-[#64748B] hover:text-[#1E3A5F] inline-flex items-center gap-0.5 flex-shrink-0">
            Scan history <ChevronRight className="w-3.5 h-3.5" />
          </Link>
        }
        bodyClassName="!px-0 !pb-0"
      >
        {data.recent_activity.length === 0 ? (
          <div className="px-5">
            <CompactEmpty
              message="No recent activity recorded."
              hint="QR scan events will appear here."
            />
          </div>
        ) : (
          <div className="max-h-[280px] overflow-y-auto divide-y divide-[#E2E8F0] border-t border-[#E2E8F0]">
            {data.recent_activity.map(act => {
              const style = SCAN_STYLE[act.status] ?? SCAN_STYLE.Invalid;
              return (
                <div key={act.id} className="flex items-center gap-3 px-5 py-3 hover:bg-[#F8FAFC]">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${style.dot}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[#1E3A5F] truncate">
                      <span className="font-medium">{act.room_name}</span>
                      <span className="text-[#64748B]"> · {act.actor_name}</span>
                    </p>
                  </div>
                  <span className="text-xs text-[#64748B] flex-shrink-0">{style.label}</span>
                  <span className="text-xs text-[#94A3B8] tabular-nums flex-shrink-0 hidden sm:inline">
                    {mounted ? fmtActivityTime(act.event_time, act.event_date) : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <p className="text-xs text-[#94A3B8] pb-1">
        Auto-refreshes every 60 seconds while this tab is visible.
      </p>
    </div>
    ) : null}
    </PageLoadTransition>
  );
}
