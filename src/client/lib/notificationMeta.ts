interface NotificationLike {
  type: string;
  related_module: string | null;
  is_read?: boolean;
}

export type NotificationFilter =
  | 'all'
  | 'unread'
  | 'room_requests'
  | 'schedule'
  | 'announcements';

export type NotificationCategory = 'room_requests' | 'schedule' | 'announcements';

export const NOTIFICATION_TABS: { id: NotificationFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'room_requests', label: 'Room Requests' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'announcements', label: 'Announcements' },
];

export function getNotificationCategory(
  n: Pick<NotificationLike, 'type' | 'related_module'>,
): NotificationCategory {
  const type = n.type ?? '';
  const relatedModule = n.related_module ?? '';

  if (
    type.startsWith('room_request_') ||
    type.startsWith('qr_scan_') ||
    type === 'room_occupied' ||
    type === 'room_released' ||
    relatedModule === 'room_request' ||
    relatedModule === 'room'
  ) {
    return 'room_requests';
  }

  if (type === 'schedule_updated' || relatedModule === 'schedule') {
    return 'schedule';
  }

  return 'announcements';
}

export function matchesNotificationFilter(
  n: NotificationLike,
  filter: NotificationFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'unread') return !n.is_read;
  return getNotificationCategory(n) === filter;
}

export function notificationHref(
  n: Pick<NotificationLike, 'type' | 'related_module'>,
  role: 'admin' | 'department_chair' | 'program_chair' | 'instructor',
): string | null {
  const category = getNotificationCategory(n);
  const instructor = role === 'instructor';

  if (category === 'room_requests') {
    if (n.related_module === 'room' || n.type.startsWith('qr_scan_')) {
      return instructor ? '/instructor/available-rooms' : '/room-utilization';
    }
    return instructor ? '/instructor/room-requests' : '/room-requests';
  }

  if (category === 'schedule') {
    return instructor ? '/instructor/schedule' : '/scheduling';
  }

  if (n.type.startsWith('workload_') || n.type === 'block_unassigned') {
    return instructor ? '/instructor/workload' : '/workload';
  }

  return null;
}

export function emptyFilterMessage(filter: NotificationFilter): string {
  switch (filter) {
    case 'unread':
      return 'No unread notifications';
    case 'room_requests':
      return 'No room request notifications';
    case 'schedule':
      return 'No schedule notifications';
    case 'announcements':
      return 'No announcements';
    default:
      return 'No notifications';
  }
}
