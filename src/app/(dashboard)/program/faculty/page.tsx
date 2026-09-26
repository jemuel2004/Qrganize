import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';
import FacultyClient from './FacultyClient';

export default async function FacultyPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  if (!['admin', 'department_chair', 'program_chair'].includes(role)) redirect('/dashboard');
  return <FacultyClient />;
}
