import { RouteLoadingShell } from '@/client/components/ui/skeletons';

/** Dashboard home is full-bleed — keep shell full width, still compact. */
export default function DashboardRouteLoading() {
  return <RouteLoadingShell fullWidth />;
}
