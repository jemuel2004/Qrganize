import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';
import DashboardClient from '../dashboard/DashboardClient';

export default async function DeptChairPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  if (role === 'admin') redirect('/dashboard');
  if (role !== 'department_chair') redirect('/login');
  return <DashboardClient />;
}
