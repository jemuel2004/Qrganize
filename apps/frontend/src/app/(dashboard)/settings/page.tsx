import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import SettingsClient from './SettingsClient';

export default async function SettingsPage() {
  const role = await getPageAuthRole();
  // Administrator only — the chairs' menus don't show it (lib/roleAccess CHAIR_BLOCKED_PAGES)
  if (role !== 'admin') redirect('/login');
  return <SettingsClient />;
}
