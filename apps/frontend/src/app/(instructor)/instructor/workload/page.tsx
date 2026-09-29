import type { Metadata } from 'next';
import InstructorWorkloadClient from './WorkloadClient';

export const metadata: Metadata = {
  title: 'My Workload — QRganize Faculty',
};

export default function InstructorWorkloadPage() {
  return <InstructorWorkloadClient />;
}
