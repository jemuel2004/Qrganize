/**
 * Shared skeleton placeholders. CSS-only shimmer (see .qr-skeleton).
 * Safe in Server Components — no client hooks.
 */

import type { CSSProperties, ReactNode } from 'react';

export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <div className={`qr-skeleton ${className}`} style={style} aria-hidden />;
}

export function CardSkeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-white border border-[#E5E7EB] rounded-lg overflow-hidden ${className}`}>
      <Skeleton className="h-full min-h-[140px] w-full rounded-lg" />
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="bg-white border border-[#E5E7EB] rounded-lg overflow-hidden divide-y divide-[#F3F4F6]">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="px-4 py-3.5 flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-md flex-shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton className="h-3.5 w-[55%] rounded" />
            <Skeleton className="h-3 w-[35%] rounded" />
          </div>
          <Skeleton className="h-7 w-16 rounded-md flex-shrink-0 hidden sm:block" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({
  rows = 8,
  cols = 6,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div className="bg-white border border-[#E5E7EB] rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-[#E5E7EB] flex gap-3">
        {Array.from({ length: Math.min(cols, 4) }, (_, i) => (
          <Skeleton key={i} className="h-3 w-20 rounded" />
        ))}
      </div>
      <div className="divide-y divide-[#F3F4F6]">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="px-4 py-3.5 grid gap-3" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {Array.from({ length: cols }, (_, c) => (
              <Skeleton
                key={c}
                className={`h-3 rounded ${c === 1 ? 'w-[85%]' : 'w-[70%]'}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A small stat card (label, icon tile, value) — used by the generic page skeleton */
export function DashboardSkeletonCard() {
  return (
    <div className="bg-[var(--surface-elevated)] border border-[color:var(--border)] rounded-xl h-[132px] overflow-hidden shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
      <div className="h-full px-5 py-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <Skeleton className="h-4 w-28 rounded" />
          <Skeleton className="h-9 w-9 rounded-lg" />
        </div>
        <Skeleton className="h-8 w-16 rounded" />
        <Skeleton className="h-3.5 w-32 rounded mt-auto" />
      </div>
    </div>
  );
}

/** One Dashboard card (Section): title + link pill, then its body */
function DashboardSkeletonSection({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] p-5 sm:p-6 min-w-0 overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 mb-5">
        <Skeleton className="h-5 w-44 rounded" />
        <Skeleton className="h-9 w-40 rounded-full hidden sm:block" />
      </div>
      {children}
    </div>
  );
}

/** Donut + its three legend rows (Room Status, Workload Overview) */
function DashboardSkeletonDonut({ size }: { size: number }) {
  return (
    <div className="flex flex-col sm:flex-row items-center justify-center gap-6">
      <Skeleton className="rounded-full flex-shrink-0" style={{ width: size, height: size }} />
      <div className="w-full max-w-[260px] space-y-5">
        {[0, 1, 2].map(i => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-full rounded" />
            <Skeleton className="h-1.5 w-full rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Admin Dashboard body, shaped like the real page: greeting (first load only —
 * on Refresh the real header stays), Today strip, Room Status, Today's
 * Schedule, then Workload Overview beside Scheduling Alerts.
 */
export function DashboardSkeleton({ header = true }: { header?: boolean }) {
  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite" aria-label="Loading dashboard">
      {header && (
        <div className="flex items-start sm:items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0 space-y-2.5 flex-1">
            <Skeleton className="h-8 w-[min(100%,20rem)] rounded-md" />
            <Skeleton className="h-4 w-[min(100%,22rem)] rounded" />
            <Skeleton className="h-3.5 w-[min(100%,17rem)] rounded" />
          </div>
          <div className="flex items-center gap-2.5">
            <Skeleton className="h-11 w-56 rounded-xl hidden sm:block" />
            <Skeleton className="h-[42px] w-[110px] rounded-xl" />
          </div>
        </div>
      )}

      {/* Today strip — three figures */}
      <div className="bg-white rounded-2xl border border-[#D6E4FA] p-5 sm:p-6">
        <Skeleton className="h-4 w-20 rounded mb-5" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-y-5">
          {[0, 1, 2].map(i => (
            <div key={i} className="flex items-center gap-3.5 px-2 sm:px-5">
              <Skeleton className="w-12 h-12 rounded-2xl flex-shrink-0" />
              <div className="space-y-2">
                <Skeleton className="h-3.5 w-28 rounded" />
                <Skeleton className="h-7 w-14 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Room Status — donut · room table */}
      <DashboardSkeletonSection>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,9fr)_minmax(0,11fr)] gap-6 lg:gap-8 items-center">
          <DashboardSkeletonDonut size={180} />
          <div className="min-w-0">
            <Skeleton className="h-4 w-2/3 rounded mb-3" />
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 py-3.5 border-t border-[#F1F5F9]">
                <Skeleton className="h-4 w-24 rounded flex-shrink-0" />
                <Skeleton className="h-6 w-20 rounded-full flex-shrink-0" />
                <Skeleton className="h-4 flex-1 rounded" />
              </div>
            ))}
          </div>
        </div>
      </DashboardSkeletonSection>

      {/* Today's Schedule — five rows */}
      <DashboardSkeletonSection>
        <Skeleton className="h-4 w-full rounded mb-3" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-14 flex items-center gap-4 border-t border-[#F1F5F9]">
            <Skeleton className="h-4 w-[20%] rounded" />
            <Skeleton className="h-4 w-[12%] rounded" />
            <Skeleton className="h-4 w-[15%] rounded" />
            <Skeleton className="h-4 w-[12%] rounded" />
            <Skeleton className="h-4 flex-1 rounded" />
          </div>
        ))}
      </DashboardSkeletonSection>

      {/* Workload Overview · Scheduling Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <DashboardSkeletonSection>
          <DashboardSkeletonDonut size={176} />
        </DashboardSkeletonSection>
        <DashboardSkeletonSection>
          <div className="space-y-2.5">
            {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[62px] w-full rounded-xl" />)}
          </div>
        </DashboardSkeletonSection>
      </div>
    </div>
  );
}

/** Filter bar: search + dropdown placeholders matching FilterBar height. */
export function FiltersSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <div className="bg-white border border-[#E5E7EB] rounded-2xl p-5 flex flex-col sm:flex-row gap-3">
      <Skeleton className="h-[42px] flex-1 rounded-xl" />
      {Array.from({ length: fields }, (_, i) => (
        <Skeleton key={i} className="h-[42px] w-full sm:w-40 rounded-xl" />
      ))}
    </div>
  );
}

/** Form fields: label + input rows. `columns={2}` lays fields side by side (sm+);
 *  `bare` drops the card frame for use inside an existing panel. */
export function FormSkeleton({ fields = 6, columns = 1, bare = false }: {
  fields?: number;
  columns?: 1 | 2;
  bare?: boolean;
}) {
  return (
    <div
      className={`${bare ? '' : 'bg-white border border-[#E5E7EB] rounded-lg p-5'} ${
        columns === 2 ? 'grid grid-cols-1 sm:grid-cols-2 gap-3' : 'space-y-4'
      }`}
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3.5 w-28 rounded" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ))}
    </div>
  );
}

/** Row of filter chips / count tabs (same height as CountFilterTabs and chips). */
export function PillsSkeleton({ count = 4, className = '' }: { count?: number; className?: string }) {
  const widths = ['w-24', 'w-28', 'w-32', 'w-24', 'w-28', 'w-20', 'w-32', 'w-24'];
  return (
    <div className={`flex flex-wrap gap-2.5 ${className}`} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={`h-11 ${widths[i % widths.length]} rounded-xl`} />
      ))}
    </div>
  );
}

/** Printed-form preview (Class Program): page with logo, centred header lines,
 *  info rows and a schedule table — the shape of the document that loads. */
export function DocumentSkeleton() {
  return (
    <div className="bg-white border border-[#E5E7EB] rounded-lg px-5 sm:px-10 py-8 max-w-[900px] mx-auto w-full" role="status" aria-label="Loading document">
      <div className="flex flex-col items-center gap-2">
        <Skeleton className="h-16 w-16 rounded-full mb-1" />
        <Skeleton className="h-3 w-40 rounded" />
        <Skeleton className="h-4 w-72 max-w-full rounded" />
        <Skeleton className="h-3.5 w-56 max-w-full rounded" />
        <Skeleton className="h-4 w-36 rounded mt-1" />
        <Skeleton className="h-3 w-28 rounded" />
      </div>
      <div className="mt-6 grid grid-cols-2 gap-x-8 gap-y-2">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-3.5 w-[70%] rounded" />)}
      </div>
      <div className="mt-5 border border-[#E5E7EB] rounded-md overflow-hidden">
        <Skeleton className="h-9 w-full rounded-none" />
        <div className="divide-y divide-[#F3F4F6]">
          {Array.from({ length: 7 }, (_, r) => (
            <div key={r} className="px-3 py-3 grid grid-cols-6 gap-3">
              {Array.from({ length: 6 }, (_, c) => <Skeleton key={c} className={`h-3 rounded ${c === 1 ? 'w-[85%]' : 'w-[60%]'}`} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Chart / empty-state block. */
export function ChartSkeleton({ className = 'h-56' }: { className?: string }) {
  return (
    <div className={`bg-white border border-[#E5E7EB] rounded-lg p-4 ${className}`}>
      <Skeleton className="h-4 w-36 rounded mb-4" />
      <Skeleton className="h-[calc(100%-2rem)] w-full rounded-md" />
    </div>
  );
}

/** In-page body skeleton (no outer padding — page shell already pads). */
export function PageBodySkeleton() {
  return (
    <div className="space-y-5 w-full min-w-0" role="status" aria-live="polite" aria-label="Loading page">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="space-y-2 min-w-0">
          <Skeleton className="h-7 w-48 max-w-full rounded-md" />
          <Skeleton className="h-4 w-64 max-w-full rounded" />
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <Skeleton className="h-10 w-28 rounded-md" />
          <Skeleton className="h-10 w-24 rounded-md" />
        </div>
      </div>
      <FiltersSkeleton />
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {Array.from({ length: 4 }, (_, i) => (
          <DashboardSkeletonCard key={i} />
        ))}
      </div>
      <TableSkeleton />
    </div>
  );
}

/**
 * Route-level loading.tsx shell only — locks the content column width/padding
 * to match Setup pages (max-w-7xl) without painting a tall fake page layout.
 *
 * Detailed skeletons belong to each page via PageLoadTransition. Showing a full
 * PageBodySkeleton here first caused: large route skeleton → shrink → page skeleton.
 */
export function RouteLoadingShell({
  fullWidth = false,
}: {
  /** Admin/Instructor dashboard home — no max-w-7xl */
  fullWidth?: boolean;
} = {}) {
  return (
    <div
      className={
        fullWidth
          ? 'flex flex-col px-4 sm:px-6 py-6 min-w-0 w-full'
          : 'p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0'
      }
      role="status"
      aria-live="polite"
      aria-label="Loading page"
    >
      <div className="space-y-3 w-full min-w-0">
        <Skeleton className="h-7 w-44 max-w-full rounded-md" />
        <Skeleton className="h-3.5 w-64 max-w-full rounded" />
        <Skeleton className="h-[38px] w-full max-w-md rounded-xl mt-1" />
      </div>
    </div>
  );
}

/**
 * @deprecated Prefer RouteLoadingShell for loading.tsx — kept for any in-page imports.
 * Matches Setup shell width; still a full body mock (use only when intentional).
 */
export function PageSkeleton() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <PageBodySkeleton />
    </div>
  );
}
