import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import SettingsClient from './SettingsClient';

export default async function SettingsPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin' && role !== 'program_chair') redirect('/login');
  return <SettingsClient />;
}
