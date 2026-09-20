import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';
import InstructorAccountsClient from './InstructorAccountsClient';

export default async function InstructorAccountsPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin') redirect('/login');
  return <InstructorAccountsClient />;
}
