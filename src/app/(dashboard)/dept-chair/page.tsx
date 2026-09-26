import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';
import DashboardClient from '../dashboard/DashboardClient';

export default async function DeptChairPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  if (role === 'admin' || role === 'department_chair') redirect('/dashboard');
  if (role !== 'program_chair') redirect('/login');
  return <DashboardClient />;
}
