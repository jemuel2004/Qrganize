import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';
import DepartmentChairAccountsClient from './DepartmentChairAccountsClient';

export default async function DepartmentChairAccountsPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin') redirect('/login');
  return <DepartmentChairAccountsClient />;
}
