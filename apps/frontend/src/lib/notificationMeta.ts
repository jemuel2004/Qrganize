/*
 * Notification presentation rules — priority, grouping, action label and
 * destination for each notification type. The server decides *whether* a
 * notification exists (condition-based alerts come and go with the data, see
 * server/workloadMonitoring.ts); this file decides how it is shown.
 */

interface NotificationLike {
  type: string;
  related_module: string | null;
  related_id?: number | null;
  is_read?: boolean;
  created_at?: string;
}

type Role = 'admin' | 'department_chair' | 'program_chair' | 'instructor';

export type NotificationPriority = 'high' | 'medium' | 'low';
export type NotificationCategory = 'workload' | 'schedule' | 'room';
export type NotificationFilter = 'all' | 'unread' | NotificationCategory;

/** Tabs: everything, unread, then one per area so the admin can jump straight to it */
export const NOTIFICATION_TABS: { id: NotificationFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'workload', label: 'Workload' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'room', label: 'Rooms' },
];

export function notificationCategory(n: Pick<NotificationLike, 'type' | 'related_module'>): NotificationCategory {
  if (n.type.startsWith('workload_')) return 'workload';
  if (n.type.startsWith('room_') || n.type.startsWith('qr_scan_') || n.related_module === 'room' || n.related_module === 'room_request') return 'room';
  return 'schedule';
}

/**
 * Each actionable kind gets its own group (in this order); everything
 * informational is collected under "Recent Activity".
 */
const TYPE_GROUPS: { type: string; label: string }[] = [
  // Faculty: class reminders (services/classReminders on the server)
  { type: 'class_starting', label: 'Class Now' },
  { type: 'class_today', label: 'Classes Today' },
  { type: 'room_request_pending', label: 'Room Requests Pending' },
  { type: 'block_schedule_incomplete', label: 'Incomplete Block Schedule' },
  { type: 'schedule_needed', label: 'Faculty Schedule Needed' },
  { type: 'workload_incomplete', label: 'Faculty Workload Incomplete' },
  { type: 'workload_overload', label: 'Workload Review Required' },
  { type: 'block_unassigned', label: 'Subjects Need a Faculty' },
  { type: 'schedule_pending', label: 'Schedule Pending' },
  { type: 'qr_scan_pending', label: 'Waiting for QR Scan' },
];

export interface NotificationGroup<T> { key: string; label: string; priority: NotificationPriority; items: T[] }

/** Split into labelled groups: actionable kinds first (by priority), then Recent Activity */
export function groupNotifications<T extends NotificationLike>(list: T[]): NotificationGroup<T>[] {
  const groups: NotificationGroup<T>[] = TYPE_GROUPS.map(g => ({
    key: g.type, label: g.label, priority: notificationPriority({ type: g.type }),
    items: sortNotifications(list.filter(n => n.type === g.type)),
  }));
  const known = new Set(TYPE_GROUPS.map(g => g.type));
  groups.push({ key: 'recent', label: 'Recent Activity', priority: 'low', items: sortNotifications(list.filter(n => !known.has(n.type))) });
  const rank: Record<NotificationPriority, number> = { high: 0, medium: 1, low: 2 };
  return groups.filter(g => g.items.length > 0).sort((a, b) => rank[a.priority] - rank[b.priority]);
}

const PRIORITY: Record<string, NotificationPriority> = {
  // Faculty: a class starting / in session, then the day's classes
  class_starting: 'high',
  class_today: 'medium',
  // Needs attention
  workload_incomplete: 'high',
  schedule_needed: 'high',
  block_schedule_incomplete: 'high',
  room_request_pending: 'high',
  // Pending / action required
  workload_overload: 'medium',
  block_unassigned: 'medium',
  schedule_pending: 'medium',
  qr_scan_pending: 'medium', // faculty: scan the QR to confirm a reserved room
};

export function notificationPriority(n: Pick<NotificationLike, 'type'>): NotificationPriority {
  return PRIORITY[n.type] ?? 'low';
}

export function matchesNotificationFilter(n: NotificationLike, filter: NotificationFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'unread') return !n.is_read;
  return notificationCategory(n) === filter;
}

/** Unread first, then newest */
export function sortNotifications<T extends NotificationLike>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    Number(!!a.is_read) - Number(!!b.is_read) ||
    new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
}

/** Where a notification leads and what the link says */
export function notificationAction(n: NotificationLike, role: Role): { href: string; label: string } | null {
  const id = n.related_id ?? null;
  const faculty = role === 'instructor';

  if (faculty) {
    if (n.type === 'class_starting') return { href: '/instructor/scan', label: 'Scan Room QR' };
    if (n.type === 'class_today') return { href: '/instructor/schedule', label: 'View Schedule' };
    if (n.type.startsWith('room_request_')) return { href: '/instructor/room-requests', label: 'View Request' };
    if (n.type.startsWith('qr_scan_') || n.related_module === 'room') return { href: '/instructor/available-rooms', label: 'View Rooms' };
    if (n.type === 'schedule_updated') return { href: '/instructor/schedule', label: 'View Schedule' };
    if (n.type.startsWith('workload_')) return { href: '/instructor/workload', label: 'View Workload' };
    return null;
  }

  switch (n.type) {
    case 'workload_incomplete':
      return { href: id ? `/workload?facultyId=${id}` : '/workload', label: 'View Workload' };
    case 'schedule_needed':
    case 'workload_completed':
      return { href: id ? `/faculty-schedules?facultyId=${id}` : '/faculty-schedules', label: 'View Faculty Schedule' };
    case 'block_schedule_incomplete':
    case 'schedule_completed':
      return { href: id ? `/program/blocks/${id}` : '/program/blocks', label: 'View Block Schedule' };
    case 'block_unassigned':
      return { href: id ? `/program/blocks/${id}` : '/program/blocks', label: 'Assign Faculty' };
    case 'schedule_pending':
      return { href: '/scheduling', label: 'Open Scheduling' };
    case 'workload_overload':
      return { href: '/overload', label: 'Review Overload' };
    case 'room_request_pending':
      return { href: '/room-requests', label: 'Review Request' };
    case 'room_request_approved':
    case 'room_request_rejected':
    case 'room_request_expired':
      return { href: '/room-requests', label: 'View Requests' };
    case 'schedule_updated':
      return { href: '/scheduling', label: 'View Schedule' };
  }
  if (n.type.startsWith('qr_scan_') || n.type === 'room_occupied' || n.type === 'room_released' || n.related_module === 'room') {
    return { href: '/room-utilization', label: 'View Room Utilization' };
  }
  return null;
}

export function emptyFilterMessage(filter: NotificationFilter): string {
  switch (filter) {
    case 'unread': return 'You have read everything.';
    case 'workload': return 'No workload notifications.';
    case 'schedule': return 'No schedule notifications.';
    case 'room': return 'No room request notifications.';
    default: return 'No notifications right now.';
  }
}
