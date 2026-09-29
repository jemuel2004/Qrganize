import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import DepartmentChairAccountsClient from './DepartmentChairAccountsClient';

export default async function DepartmentChairAccountsPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin' && role !== 'program_chair') redirect('/login');
  return <DepartmentChairAccountsClient />;
}
