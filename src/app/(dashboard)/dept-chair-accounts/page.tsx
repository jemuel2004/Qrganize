import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';
import DeptChairAccountsClient from './DeptChairAccountsClient';

export default async function DeptChairAccountsPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin') redirect('/login');
  return <DeptChairAccountsClient />;
}
