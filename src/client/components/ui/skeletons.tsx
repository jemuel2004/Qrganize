/**
 * Shared skeleton placeholders. CSS-only shimmer (see .qr-skeleton).
 * Safe in Server Components — no client hooks.
 */

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`qr-skeleton ${className}`} aria-hidden />;
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

/** Matches Dashboard MetricCard dimensions. */
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

/** Matches Dashboard SectionShell (title, optional badge, rows, optional footer). */
export function DashboardSkeletonPanel({
  rows = 5,
  footer = false,
  badge = false,
  className = '',
}: {
  rows?: number;
  footer?: boolean;
  badge?: boolean;
  className?: string;
}) {
  return (
    <div
      className={[
        'bg-[var(--surface-elevated)] border border-[color:var(--border)] rounded-xl overflow-hidden flex flex-col min-w-0 shadow-[0_1px_3px_rgba(15,23,42,0.06)]',
        className,
      ].join(' ')}
    >
      <div className="px-4 sm:px-5 py-3.5 border-b border-[color:var(--border-subtle)] flex items-center gap-2 flex-shrink-0">
        <Skeleton className="h-5 w-40 rounded" />
        {badge ? <Skeleton className="h-5 w-5 rounded-full flex-shrink-0" /> : null}
      </div>
      <div className="divide-y divide-[color:var(--border-subtle)]">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="px-4 sm:px-5 py-3.5 flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0 space-y-2">
              <Skeleton className="h-3.5 w-[72%] rounded" />
              <Skeleton className="h-3 w-[48%] rounded" />
            </div>
            <Skeleton className="h-7 w-8 rounded-md flex-shrink-0" />
          </div>
        ))}
      </div>
      {footer ? (
        <div className="px-4 sm:px-5 py-3 border-t border-[color:var(--border-subtle)] flex-shrink-0">
          <Skeleton className="h-4 w-36 rounded" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Full dashboard body skeleton (greeting through panels).
 * Does not include the app navbar — only content below navigation.
 */
export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-live="polite" aria-label="Loading dashboard">
      {/* Greeting + Refresh */}
      <div className="flex items-start sm:items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0 space-y-2 flex-1">
          <Skeleton className="h-7 sm:h-8 w-[min(100%,22rem)] max-w-full rounded-md" />
          <Skeleton className="h-4 w-[min(100%,20rem)] max-w-full rounded" />
          <Skeleton className="h-3.5 w-[min(100%,16rem)] max-w-full rounded" />
        </div>
        <Skeleton className="h-10 w-[6.75rem] rounded-lg flex-shrink-0" />
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 flex-shrink-0">
        {Array.from({ length: 4 }, (_, i) => (
          <DashboardSkeletonCard key={i} />
        ))}
      </div>

      {/* Content: 2-col main + sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        <div className="lg:col-span-2 flex flex-col gap-5 min-w-0">
          <DashboardSkeletonPanel rows={4} badge footer />
          <DashboardSkeletonPanel rows={3} badge footer />
          <DashboardSkeletonPanel rows={4} footer />
        </div>
        <div className="flex flex-col gap-5 min-w-0">
          <DashboardSkeletonPanel rows={3} footer />
          <DashboardSkeletonPanel rows={4} footer />
        </div>
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

/** Form fields: label + input rows. */
export function FormSkeleton({ fields = 6 }: { fields?: number }) {
  return (
    <div className="bg-white border border-[#E5E7EB] rounded-lg p-5 space-y-4">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3.5 w-28 rounded" />
          <Skeleton className="h-10 w-full rounded-xl" />
        </div>
      ))}
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
