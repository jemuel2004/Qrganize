import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import ErrorLogsClient from './ErrorLogsClient';

export default async function ErrorLogsPage() {
  const role = await getPageAuthRole();
  // Administrator only — the chairs' menus don't show it (lib/roleAccess CHAIR_BLOCKED_PAGES)
  if (role !== 'admin') redirect('/login');
  return <ErrorLogsClient />;
}
