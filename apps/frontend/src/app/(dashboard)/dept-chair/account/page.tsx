import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import DeptChairAccountClient from './DeptChairAccountClient';

export default async function DeptChairAccountPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  if (role === 'admin') redirect('/settings');
  if (role === 'department_chair') redirect('/department-chair/account');
  if (role !== 'program_chair') redirect('/login');
  return <DeptChairAccountClient />;
}
