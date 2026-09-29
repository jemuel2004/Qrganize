import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import BlocksClient from './BlocksClient';

export default async function BlocksPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  // Program Chair: allowed, limited to their own program (locked in the page, enforced by the API)
  return (
    <Suspense fallback={null}>
      <BlocksClient />
    </Suspense>
  );
}
