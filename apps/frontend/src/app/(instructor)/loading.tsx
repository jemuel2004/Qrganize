import { RouteLoadingShell } from '@/components/ui/skeletons';

/**
 * Shared for all Instructor segment navigations.
 * Compact width-stable shell only — destination pages own detailed skeletons.
 */
export default function InstructorLoading() {
  return <RouteLoadingShell />;
}
