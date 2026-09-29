import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import ReportsClient from './ReportsClient';

export default async function ReportsPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  // Same staff roles that can open the workload / class program / curriculum pages
  if (!['admin', 'department_chair', 'program_chair'].includes(role)) redirect('/dashboard');
  return <ReportsClient />;
}
