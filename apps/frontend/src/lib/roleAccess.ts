/*
 * Program Chair access policy (mirrors backend services/programScope.ts).
 *
 * Program Chair works like the Admin across ALL programs, except: Faculty is
 * view-only (no add/edit/delete), Block Creation is limited to the chair's own
 * program, and the System administration pages are the Admin's only (see
 * CHAIR_BLOCKED_PAGES). Set PROGRAM_CHAIR_SCOPED to true (here and in the
 * backend) to limit chairs to their own program everywhere.
 */
const PROGRAM_CHAIR_SCOPED = false;

/** True when this role must be locked to its own assigned program in the UI. */
export function isScopedChairRole(role: string | null | undefined): boolean {
  return PROGRAM_CHAIR_SCOPED && role === 'program_chair';
}

/** Display name of each account role — one list for the whole UI */
export const ROLE_LABEL: Record<string, string> = {
  admin: 'Administrator',
  department_chair: 'Department Chair',
  program_chair: 'Program Chair',
  instructor: 'Faculty',
};

/** "program_chair" → "Program Chair"; unknown roles are title-cased */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return '';
  return ROLE_LABEL[role] ?? role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** System pages only the Administrator opens — both chair roles lose them
 *  (accounts, logs and system Settings; each chair keeps its own account
 *  settings). The backend refuses their APIs to chairs as well. */
export const CHAIR_BLOCKED_PAGES: readonly string[] = [
  '/instructor-accounts',
  '/department-chair-accounts',
  '/dept-chair-accounts',
  '/audit-logs',
  '/error-logs',
  '/settings',
];

/** @deprecated Same list as CHAIR_BLOCKED_PAGES (kept for older imports). */
export const PROGRAM_CHAIR_BLOCKED_PAGES = CHAIR_BLOCKED_PAGES;
