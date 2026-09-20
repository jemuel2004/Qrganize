import type { Metadata } from 'next';
import InstructorWorkloadClient from './WorkloadClient';

export const metadata: Metadata = {
  title: 'My Workload — QRganize Instructor',
};

export default function InstructorWorkloadPage() {
  return <InstructorWorkloadClient />;
}
