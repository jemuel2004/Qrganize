import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';
import DepartmentChairAccountClient from './DepartmentChairAccountClient';

export default async function DepartmentChairAccountPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  if (role === 'admin') redirect('/settings');
  if (role === 'program_chair') redirect('/dept-chair/account');
  if (role !== 'department_chair') redirect('/login');
  return <DepartmentChairAccountClient />;
}
