import {
  LayoutDashboard, CalendarDays, QrCode,
  DoorOpen, Settings, BookOpen, Search,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface InstructorNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Optional dynamic badge (e.g. pending room requests). */
  badge?: number;
}

export interface InstructorNavSection {
  id: string;
  label: string;
  items: InstructorNavItem[];
}

export function getInstructorNavSections(requestsBadge = 0): InstructorNavSection[] {
  return [
    {
      id: 'main',
      label: 'Main',
      items: [
        { href: '/instructor', label: 'Dashboard', icon: LayoutDashboard },
      ],
    },
    {
      id: 'schedule',
      label: 'Schedule & Workload',
      items: [
        { href: '/instructor/schedule', label: 'My Schedule', icon: CalendarDays },
        { href: '/instructor/workload', label: 'My Workload', icon: BookOpen },
      ],
    },
    {
      id: 'rooms',
      label: 'Rooms',
      items: [
        { href: '/instructor/available-rooms', label: 'Find Available Rooms', icon: Search },
        {
          href: '/instructor/room-requests',
          label: 'Room Requests',
          icon: DoorOpen,
          badge: requestsBadge > 0 ? requestsBadge : undefined,
        },
        { href: '/instructor/scan', label: 'Scan QR Code', icon: QrCode },
      ],
    },
    {
      id: 'account',
      label: 'Account',
      items: [
        { href: '/instructor/profile', label: 'Profile Settings', icon: Settings },
      ],
    },
  ];
}

export function isInstructorPathActive(pathname: string, href: string): boolean {
  if (href === '/instructor') return pathname === '/instructor';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isInstructorSectionActive(pathname: string, section: InstructorNavSection): boolean {
  return section.items.some(item => isInstructorPathActive(pathname, item.href));
}
