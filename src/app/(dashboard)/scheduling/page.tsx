import { Suspense } from 'react';
import SchedulingClient from './SchedulingClient';

export default function SchedulingPage() {
  return (
    <Suspense fallback={null}>
      <SchedulingClient />
    </Suspense>
  );
}
