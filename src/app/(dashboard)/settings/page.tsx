import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/server/auth';
import SettingsClient from './SettingsClient';

export default async function SettingsPage() {
  const role = await getPageAuthRole();
  if (role !== 'admin') redirect('/login');
  return <SettingsClient />;
}
