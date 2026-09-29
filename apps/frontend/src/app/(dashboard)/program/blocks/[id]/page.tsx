import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import BlockDetailClient from './BlockDetailClient';

export default async function BlockDetailPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  // Program Chair: allowed, limited to their own program (locked in the page, enforced by the API)
  return <BlockDetailClient />;
}
