import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getPageAuthRole } from '@/lib/pageAuth';
import { isQrCode, qrLinkPath } from '@shared/qrLink';
import RoomPageClient from './RoomPageClient';

export const metadata: Metadata = { title: 'Room' };

/*
 * A room's page — what a room QR opens with a phone's own camera
 * (https://<site>/room/<qr_code_id>). Signed out → sign in, then back here
 * (the proxy does the same). Scanning only opens the page: checking in is a
 * button, and it goes through the same check as Scan Room QR.
 */
export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  let code = raw;
  try { code = decodeURIComponent(raw); } catch { /* keep as is */ }

  const role = await getPageAuthRole();
  if (!role) redirect(`/login?next=${encodeURIComponent(qrLinkPath(code))}`);
  return <RoomPageClient code={isQrCode(code) ? code : null} role={role} />;
}
