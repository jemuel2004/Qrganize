/**
 * Real-time sync contract shared by the API and the app.
 *
 * The database stays the only source of truth. When a write succeeds, the API
 * bumps the version of each *topic* (a coarse area of data) it touched. Every
 * open tab checks the versions it is allowed to see and, when one moves on,
 * re-fetches its data through the normal, authorised API routes. A topic
 * carries no records — only "this area changed".
 *
 * Versions only ever move forward and are cumulative, so a tab that was
 * offline compares against the last versions it saw and catches up on
 * everything it missed with one check.
 */

export const REALTIME_TOPICS = [
  'term',          // active school year / semester, school-year list
  'settings',      // system logo, day combinations
  'programs',
  'curriculum',
  'faculty',       // faculty records, designations, assigned blocks
  'accounts',      // sign-in accounts (faculty, program / department chairs)
  'rooms',         // rooms and their QR codes
  'blocks',        // blocks and block subjects
  'schedule',      // class schedules and room assignments
  'workload',      // faculty loads, overload, PRAISE, deloading
  'occupancy',     // live room use (QR check-ins, releases)
  'room-requests',
  'notifications', // the reader's own inbox (stored per recipient)
  'audit',         // audit trail
] as const;

export type RealtimeTopic = (typeof REALTIME_TOPICS)[number];

/** Versions as a tab receives them — a topic that never changed is 0. */
export type RealtimeVersions = Partial<Record<RealtimeTopic, number>>;

const EVERYTHING_SHARED: readonly RealtimeTopic[] = REALTIME_TOPICS.filter(t => t !== 'notifications');
/** Faculty loads and schedules show block, subject and room details from these areas. */
const CLASSES: readonly RealtimeTopic[] = ['blocks', 'schedule', 'workload'];

interface WriteRule {
  re: RegExp;
  topics: readonly RealtimeTopic[];
}

/**
 * Successful write (POST / PUT / PATCH / DELETE) → topics it changes.
 * First match wins, so specific paths come before general ones. Every write
 * route must match a rule (an empty list means "nothing others can see"),
 * which a test checks against the backend's route files.
 */
const WRITE_RULES: readonly WriteRule[] = [
  // Reads sent as POST, sign-in and personal preferences
  { re: /^\/api\/(scheduling\/check-conflicts|settings\/verify-password|curriculum\/export)(\/|$)/, topics: [] },
  { re: /^\/api\/auth\/verify-email-google(\/|$)/, topics: ['accounts'] },
  { re: /^\/api\/auth\//, topics: [] },
  { re: /^\/api\/account\/(change-password|security)(\/|$)/, topics: [] },
  { re: /^\/api\/instructor\/profile\/(password|password-otp|theme)(\/|$)/, topics: [] },
  // Personal inbox — those routes bump the reader's own notifications topic
  { re: /^\/api\/notifications(\/|$)/, topics: [] },

  // System
  { re: /^\/api\/(settings\/reset|setup)(\/|$)/, topics: EVERYTHING_SHARED },
  { re: /^\/api\/(settings\/school-year|school-years)(\/|$)/, topics: ['term'] },
  { re: /^\/api\/settings\/(logo|day-combinations)(\/|$)/, topics: ['settings'] },

  // Accounts and faculty (deactivating or deleting a faculty releases their classes)
  { re: /^\/api\/(instructor\/profile\/picture|instructor-accounts\/[^/]+\/picture)(\/|$)/, topics: ['accounts', 'faculty'] },
  { re: /^\/api\/(account\/me|instructor\/verify-google|dept-chair\/verify-google|department-chair-accounts|dept-chair-accounts)(\/|$)/, topics: ['accounts'] },
  { re: /^\/api\/faculty\/[^/]+\/deductions(\/|$)/, topics: ['workload', 'faculty'] },
  { re: /^\/api\/(faculty|instructor-accounts)(\/|$)/, topics: ['faculty', 'accounts', ...CLASSES] },

  // Setup and scheduling
  { re: /^\/api\/programs(\/|$)/, topics: ['programs'] },
  { re: /^\/api\/curriculum(\/|$)/, topics: ['curriculum', ...CLASSES] },
  { re: /^\/api\/(blocks|scheduling|workload)(\/|$)/, topics: CLASSES },
  { re: /^\/api\/praise(-loads)?(\/|$)/, topics: ['workload'] },

  // Rooms (approving, scanning and releasing move classes between rooms)
  { re: /^\/api\/(qr\/scan|rooms\/occupancy)(\/|$)/, topics: ['occupancy', 'room-requests', 'schedule', 'workload'] },
  { re: /^\/api\/admin\/room-requests(\/|$)/, topics: ['room-requests', 'occupancy', 'schedule', 'workload'] },
  { re: /^\/api\/instructor\/room-requests(\/|$)/, topics: ['room-requests', 'occupancy'] },
  { re: /^\/api\/rooms\/qr-codes(\/|$)/, topics: ['rooms'] },
  { re: /^\/api\/rooms(\/|$)/, topics: ['rooms', 'schedule', 'workload'] },
];

/** The rule for a write route, or null when no rule covers it. */
export function realtimeWriteRule(path: string): { topics: readonly RealtimeTopic[] } | null {
  return WRITE_RULES.find(r => r.re.test(path)) ?? null;
}

/** Topics a successful request changed (reads change nothing). */
export function topicsForWrite(method: string, path: string): RealtimeTopic[] {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return [];
  return [...(realtimeWriteRule(path)?.topics ?? [])];
}

/** Faculty only hear about the areas their own pages show. */
const FACULTY_TOPICS: readonly RealtimeTopic[] = [
  'term', 'settings', 'faculty', 'rooms', 'schedule', 'workload', 'occupancy', 'room-requests', 'notifications',
];

/** Topics a role may receive — mirrors which pages each role can open. */
export function topicsForRole(role: string | null | undefined): RealtimeTopic[] {
  switch (role) {
    case 'admin':
    case 'program_chair':
      return [...REALTIME_TOPICS];
    case 'department_chair': // no account management or audit trail
      return REALTIME_TOPICS.filter(t => t !== 'accounts' && t !== 'audit');
    case 'instructor':
      return [...FACULTY_TOPICS];
    default:
      return [];
  }
}

/**
 * Storage key of one inbox. Admins share one inbox, as do department chairs;
 * program chairs (user id) and faculty (faculty id) each have their own.
 */
export function notificationTopicKey(role: string | null | undefined, recipientId?: number | null): string | null {
  if (role === 'admin' || role === 'department_chair') return `notifications:${role}`;
  if ((role === 'program_chair' || role === 'instructor') && recipientId != null && Number.isInteger(recipientId) && recipientId > 0) {
    return `notifications:${role}:${recipientId}`;
  }
  return null;
}

/** Topics whose version differs between two snapshots (also catches resets). */
export function changedTopics(before: RealtimeVersions, after: RealtimeVersions): RealtimeTopic[] {
  return REALTIME_TOPICS.filter(t => (before[t] ?? 0) !== (after[t] ?? 0));
}
