import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import DashboardClient from './DashboardClient';

export default async function DashboardPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  if (role === 'program_chair') redirect('/dept-chair');
  if (role !== 'admin' && role !== 'department_chair') redirect('/login');
  return <DashboardClient />;
}
