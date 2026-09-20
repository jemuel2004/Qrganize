import type { Metadata } from 'next';
import AvailableRoomsClient from './AvailableRoomsClient';

export const metadata: Metadata = {
  title: 'Find Available Rooms — QRganize Instructor',
};

export default function AvailableRoomsPage() {
  return <AvailableRoomsClient />;
}
