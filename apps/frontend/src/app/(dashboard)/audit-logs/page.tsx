import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import AuditLogsClient from './AuditLogsClient';

export default async function AuditLogsPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin' && role !== 'program_chair') redirect('/login');
  return <AuditLogsClient />;
}
