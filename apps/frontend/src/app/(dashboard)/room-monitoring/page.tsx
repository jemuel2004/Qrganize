import type { Metadata } from 'next';
import RoomMonitoringClient from './RoomMonitoringClient';

export const metadata: Metadata = { title: 'Room Monitoring' };

export default function RoomMonitoringPage() {
  return <RoomMonitoringClient />;
}
