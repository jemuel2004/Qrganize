import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import DashboardClient from '@/app/(dashboard)/dashboard/DashboardClient';

export default async function DeptChairPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  if (role === 'admin' || role === 'department_chair') redirect('/dashboard');
  if (role !== 'program_chair') redirect('/login');
  return <DashboardClient />;
}
