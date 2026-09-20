import { RouteLoadingShell } from '@/client/components/ui/skeletons';

/**
 * Shared for all Admin segment navigations (dropdowns, sidebar, deep links).
 * Compact width-stable shell only — destination pages own detailed skeletons.
 */
export default function DashboardLoading() {
  return <RouteLoadingShell />;
}
