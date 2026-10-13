import type { Metadata } from 'next';
import LoginClient from './LoginClient';

export const metadata: Metadata = { title: 'Login — QRganize' };

export default function LoginPage() {
  return <LoginClient />;
}
