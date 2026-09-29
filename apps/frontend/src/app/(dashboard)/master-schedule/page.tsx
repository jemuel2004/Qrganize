import { Suspense } from 'react';
import MasterScheduleClient from './MasterScheduleClient';

export default function MasterSchedulePage() {
  return (
    <Suspense fallback={null}>
      <MasterScheduleClient />
    </Suspense>
  );
}
