import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';
import FacultyClient from './FacultyClient';

export default async function FacultyPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin') redirect('/dept-chair');
  return <FacultyClient />;
}
