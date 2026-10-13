import type { Metadata } from 'next';
import { ROOM_POOLS, type RoomPool } from '@shared/roomPlanning';
import RoomUtilizationClient from './RoomUtilizationClient';

export const metadata: Metadata = { title: 'Room Utilization' };

export default async function RoomUtilizationPage({
  searchParams,
}: {
  /** `?tab=planning` opens Room Planning (e.g. from Analytics), `&type=laboratory` on that kind of room */
  searchParams: Promise<{ tab?: string | string[]; type?: string | string[] }>;
}) {
  const { tab, type } = await searchParams;
  const first = Array.isArray(tab) ? tab[0] : tab;
  const kind = Array.isArray(type) ? type[0] : type;
  const pool = ROOM_POOLS.find((p): p is RoomPool => p === kind);
  return <RoomUtilizationClient initialSection={first === 'planning' ? 'planning' : 'usage'} initialPool={pool} />;
}
