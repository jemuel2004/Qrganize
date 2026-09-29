import type { Metadata } from 'next';
import RoomUtilizationClient from './RoomUtilizationClient';

export const metadata: Metadata = { title: 'Room Utilization' };

export default function RoomUtilizationPage() {
  return <RoomUtilizationClient />;
}
