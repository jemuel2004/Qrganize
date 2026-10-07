import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import AuditLogsClient from './AuditLogsClient';

export default async function AuditLogsPage() {
  const role = await getPageAuthRole();
  // Administrator only — the chairs' menus don't show it (lib/roleAccess CHAIR_BLOCKED_PAGES)
  if (role !== 'admin') redirect('/login');
  return <AuditLogsClient />;
}
