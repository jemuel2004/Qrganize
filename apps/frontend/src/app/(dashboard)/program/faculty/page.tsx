import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import FacultyClient from './FacultyClient';

export default async function FacultyPage() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  // Program Chair may view Faculty; add/edit/delete stay admin-only (page + API)
  if (!['admin', 'department_chair', 'program_chair'].includes(role)) redirect('/dashboard');
  return <FacultyClient />;
}
