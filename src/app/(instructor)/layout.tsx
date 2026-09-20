import type { Metadata } from 'next';
import InstructorShell from './InstructorShell';

export const metadata: Metadata = {
  title: 'QRganize',
};

export default function InstructorLayout({ children }: { children: React.ReactNode }) {
  return <InstructorShell>{children}</InstructorShell>;
}
