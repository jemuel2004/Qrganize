import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import InstructorAccountsClient from './InstructorAccountsClient';

export default async function InstructorAccountsPage() {
  const role = await getPageAuthRole();
  // Administrator only — the chairs' menus don't show it (lib/roleAccess CHAIR_BLOCKED_PAGES)
  if (role !== 'admin') redirect('/login');
  return <InstructorAccountsClient />;
}
