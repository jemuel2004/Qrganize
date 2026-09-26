import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';

/**
 * Fallback when `/` is rendered (proxy usually redirects first).
 * Must be role-aware — never send Dept Chair / Instructor to /dashboard.
 */
export default async function Home() {
  const role = await getPageAuthRole();
  if (!role) redirect('/login');
  if (role === 'instructor') redirect('/instructor');
  if (role === 'program_chair') redirect('/dept-chair');
  redirect('/dashboard');
}
