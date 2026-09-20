export interface NavChild {
  href: string;
  label: string;
}

export interface NavItem {
  href: string;
  label: string;
  children?: NavChild[];
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

export const FACULTY_ACCOUNTS_CHILDREN: NavChild[] = [
  { href: '/instructor-accounts', label: 'Instructor Accounts' },
  { href: '/dept-chair-accounts', label: 'Department Chair Accounts' },
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
      { href: '/workload', label: 'Instructor Workload' },
      { href: '/scheduling', label: 'Schedule Classes' },
      { href: '/program/class-program', label: 'Class Program' },
      { href: '/master-schedule', label: 'Master Schedule' },
      { href: '/faculty-schedules', label: 'Faculty Schedules' },
    ],
  },
  {
    id: 'rooms',
    label: 'Rooms',
    items: [
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
      { href: '/settings', label: 'Settings' },
    ],
  },
];

const DEPT_CHAIR_HIDDEN = new Set([
  '/program/faculty',
  '/instructor-accounts',
  '/dept-chair-accounts',
  '/settings',
]);

const DEPT_CHAIR_ACCOUNT_SECTION: NavSection = {
  id: 'account',
  label: 'Account',
  items: [{ href: '/dept-chair/account', label: 'Settings' }],
};

export function getNavSections(role: string): NavSection[] {
  if (role !== 'department_chair') return ALL_NAV_SECTIONS;
  const filtered = ALL_NAV_SECTIONS.map(section => ({
    ...section,
    items: section.items
      .filter(item => {
        if (DEPT_CHAIR_HIDDEN.has(item.href)) return false;
        if (item.children?.some(c => DEPT_CHAIR_HIDDEN.has(c.href))) return false;
        return true;
      })
      .map(item =>
        item.href === '/dashboard' ? { ...item, href: '/dept-chair' } : item
      ),
  })).filter(section => section.items.length > 0);
  return [...filtered, DEPT_CHAIR_ACCOUNT_SECTION];
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
