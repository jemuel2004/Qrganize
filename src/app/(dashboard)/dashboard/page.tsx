import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';
import DashboardClient from './DashboardClient';

export default async function DashboardPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  if (role === 'department_chair') redirect('/dept-chair');
  if (role !== 'admin') redirect('/login');
  return <DashboardClient />;
}
