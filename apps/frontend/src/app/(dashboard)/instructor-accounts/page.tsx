import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import InstructorAccountsClient from './InstructorAccountsClient';

export default async function InstructorAccountsPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin' && role !== 'program_chair') redirect('/login');
  return <InstructorAccountsClient />;
}
