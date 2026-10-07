import { CHAIR_BLOCKED_PAGES } from '@/lib/roleAccess';

export interface NavChild {
  href: string;
  label: string;
}

export type NavBadgeKey = 'workload' | 'scheduleClasses' | 'masterSchedule' | 'facultySchedule';

export interface NavItem {
  href: string;
  label: string;
  children?: NavChild[];
  /** Key into the pending-counts map — renders a small count badge when > 0. */
  badgeKey?: NavBadgeKey;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

export const FACULTY_ACCOUNTS_CHILDREN: NavChild[] = [
  { href: '/instructor-accounts', label: 'Faculty Accounts' },
  { href: '/department-chair-accounts', label: 'Department Chair Accounts' },
  { href: '/dept-chair-accounts', label: 'Program Chair Accounts' },
];

export const ALL_NAV_SECTIONS: NavSection[] = [
  {
    id: 'main',
    label: 'Main',
    items: [
      { href: '/dashboard', label: 'Dashboard' },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    items: [
      { href: '/program/curriculum', label: 'Curriculum Setup' },
      { href: '/program/faculty', label: 'Faculty' },
      { href: '/program/blocks', label: 'Block Creation' },
    ],
  },
  {
    id: 'scheduling',
    label: 'Scheduling',
    items: [
      { href: '/workload', label: 'Faculty Workload', badgeKey: 'workload' },
      { href: '/scheduling', label: 'Schedule Classes', badgeKey: 'scheduleClasses' },
      { href: '/program/class-program', label: 'Class Program' },
      { href: '/master-schedule', label: 'Master Schedule', badgeKey: 'masterSchedule' },
      { href: '/faculty-schedules', label: 'Faculty Schedule', badgeKey: 'facultySchedule' },
    ],
  },
  {
    id: 'rooms',
    label: 'Rooms',
    items: [
      { href: '/room-monitoring', label: 'Room Monitoring' },
      { href: '/room-utilization', label: 'Room Utilization' },
      { href: '/room-requests', label: 'Room Requests' },
      { href: '/rooms', label: 'Room Management' },
      { href: '/qr-generator', label: 'QR Generator' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      {
        href: '/instructor-accounts',
        label: 'Faculty Accounts',
        children: FACULTY_ACCOUNTS_CHILDREN,
      },
      { href: '/analytics', label: 'Analytics' },
      { href: '/reports', label: 'Reports' },
      { href: '/audit-logs', label: 'Audit Logs' },
      { href: '/error-logs', label: 'Error Logs' },
      { href: '/settings', label: 'Settings' },
    ],
  },
];

/**
 * Both chair roles have the Admin's menu without the System administration
 * pages — Faculty / Department Chair / Program Chair Accounts, Audit Logs,
 * Error Logs and system Settings (lib/roleAccess.ts CHAIR_BLOCKED_PAGES; the
 * backend refuses them too). Their own account settings stay in "Account".
 * For a Program Chair, Faculty is view-only and Block Creation shows only
 * their own program.
 */
const CHAIR_HIDDEN = new Set<string>(CHAIR_BLOCKED_PAGES);
const PROGRAM_CHAIR_HIDDEN = CHAIR_HIDDEN;
const DEPARTMENT_CHAIR_HIDDEN = CHAIR_HIDDEN;

const PROGRAM_CHAIR_ACCOUNT_SECTION: NavSection = {
  id: 'account',
  label: 'Account',
  items: [{ href: '/dept-chair/account', label: 'My Account' }],
};

const DEPARTMENT_CHAIR_ACCOUNT_SECTION: NavSection = {
  id: 'account',
  label: 'Account',
  items: [{ href: '/department-chair/account', label: 'Settings' }],
};

export function getNavSections(role: string): NavSection[] {
  if (role === 'department_chair') {
    const filtered = ALL_NAV_SECTIONS
      .map(section => ({
        ...section,
        items: section.items.filter(item => {
          if (DEPARTMENT_CHAIR_HIDDEN.has(item.href)) return false;
          if (item.children?.every(c => DEPARTMENT_CHAIR_HIDDEN.has(c.href))) return false;
          return true;
        }),
      }))
      .filter(section => section.items.length > 0);
    return [...filtered, DEPARTMENT_CHAIR_ACCOUNT_SECTION];
  }

  if (role !== 'program_chair') return ALL_NAV_SECTIONS;

  const filtered = ALL_NAV_SECTIONS.map(section => ({
    ...section,
    items: section.items
      .filter(item => {
        if (PROGRAM_CHAIR_HIDDEN.has(item.href)) return false;
        if (item.children?.some(c => PROGRAM_CHAIR_HIDDEN.has(c.href))) return false;
        return true;
      })
      .map(item =>
        item.href === '/dashboard' ? { ...item, href: '/dept-chair' } : item
      ),
  })).filter(section => section.items.length > 0);
  return [...filtered, PROGRAM_CHAIR_ACCOUNT_SECTION];
}

export const PRIORITY_PREFETCH = new Set([
  '/program/curriculum',
  '/program/faculty',
  '/program/blocks',
  '/workload',
  '/scheduling',
  '/room-utilization',
  '/dept-chair',
  '/dashboard',
]);

export function isPathActive(pathname: string, href: string): boolean {
  if (href === '/dashboard' || href === '/dept-chair') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isChildPathActive(pathname: string, child: NavChild): boolean {
  return pathname === child.href || pathname.startsWith(`${child.href}/`);
}

export function isItemActive(pathname: string, item: NavItem): boolean {
  if (item.children?.length) {
    return item.children.some(c => isChildPathActive(pathname, c));
  }
  return isPathActive(pathname, item.href);
}

export function isSectionActive(pathname: string, section: NavSection): boolean {
  return section.items.some(item => isItemActive(pathname, item));
}
