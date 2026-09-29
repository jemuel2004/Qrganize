import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import DeptChairAccountsClient from './DeptChairAccountsClient';

export default async function DeptChairAccountsPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin' && role !== 'program_chair') redirect('/login');
  return <DeptChairAccountsClient />;
}
