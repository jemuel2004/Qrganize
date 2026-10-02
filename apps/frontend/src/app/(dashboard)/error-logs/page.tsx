import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import ErrorLogsClient from './ErrorLogsClient';

export default async function ErrorLogsPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin' && role !== 'program_chair') redirect('/login');
  return <ErrorLogsClient />;
}
