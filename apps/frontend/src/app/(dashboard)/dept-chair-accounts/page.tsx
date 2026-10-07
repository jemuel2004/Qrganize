import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import DeptChairAccountsClient from './DeptChairAccountsClient';

export default async function DeptChairAccountsPage() {
  const role = await getPageAuthRole();
  // Administrator only — the chairs' menus don't show it (lib/roleAccess CHAIR_BLOCKED_PAGES)
  if (role !== 'admin') redirect('/login');
  return <DeptChairAccountsClient />;
}
