import type { Metadata } from 'next';
import WorkloadPrintFallbackClient from '@/client/components/WorkloadPrintFallbackClient';

export const metadata: Metadata = {
  title: 'Print Workload — QRganize',
};

/** Auth-gated via proxy (admin / department chair). HTML comes from sessionStorage. */
export default function WorkloadPrintPage() {
  return (
    <WorkloadPrintFallbackClient
      backHref="/workload"
      backLabel="Back to Instructor Workload"
    />
  );
}
