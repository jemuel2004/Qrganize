/*
 * Program Chair access policy (mirrors backend services/programScope.ts).
 *
 * Program Chair has the same access as the Admin across ALL programs, with two
 * exceptions: Faculty is view-only (no add/edit/delete), and Block Creation is
 * limited to the chair's own program. Set PROGRAM_CHAIR_SCOPED to true (here
 * and in the backend) to limit chairs to their own program everywhere.
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

/** Pages a Program Chair cannot open (none — Faculty is view-only, Block
 *  Creation is limited to their program). */
export const PROGRAM_CHAIR_BLOCKED_PAGES: readonly string[] = [];
