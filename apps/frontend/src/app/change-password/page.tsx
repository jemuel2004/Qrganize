import type { Metadata } from 'next';
import ChangePasswordClient from './ChangePasswordClient';

export const metadata: Metadata = { title: 'Change Password — QRganize' };

/*
 * Accounts signed in on a default or common password land here (proxy.ts sends
 * every page here) and replace it before anything else opens.
 */
export default function ChangePasswordPage() {
  return <ChangePasswordClient />;
}
