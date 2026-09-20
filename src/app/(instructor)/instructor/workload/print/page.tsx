import type { Metadata } from 'next';
import WorkloadPrintFallbackClient from '@/client/components/WorkloadPrintFallbackClient';

export const metadata: Metadata = {
  title: 'Print Workload — QRganize Instructor',
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
