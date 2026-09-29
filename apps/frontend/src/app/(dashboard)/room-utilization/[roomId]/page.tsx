import { Suspense } from 'react';
import type { Metadata } from 'next';
import RoomUsageClient from './RoomUsageClient';

export const metadata: Metadata = { title: 'Room Usage History' };

export default function RoomUsagePage() {
  return (
    <Suspense>
      <RoomUsageClient />
    </Suspense>
  );
}
