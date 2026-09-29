import type { Metadata } from 'next';
import WorkloadPrintFallbackClient from '@/components/WorkloadPrintFallbackClient';

export const metadata: Metadata = {
  title: 'Print Workload — QRganize Faculty',
};

/** Auth-gated via proxy (instructor). HTML comes from sessionStorage. */
export default function InstructorWorkloadPrintPage() {
  return (
    <WorkloadPrintFallbackClient
      backHref="/instructor/workload"
      backLabel="Back to My Workload"
    />
  );
}
