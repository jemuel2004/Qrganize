import { Suspense } from 'react';
import BlocksClient from './BlocksClient';

export default function BlocksPage() {
  return (
    <Suspense fallback={null}>
      <BlocksClient />
    </Suspense>
  );
}
