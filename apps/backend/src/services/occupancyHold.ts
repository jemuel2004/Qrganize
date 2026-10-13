import { APP_TIMEZONE, manilaDateAtSql } from '@/services/appTimezone';

/** SQL: when occupancy `ro` stops holding its room for a class — a class check-in when
 *  its class ends (not the 30-minute tail after it), anything else when it expires.
 *  Kept free of database and auth imports so pure SQL helpers (roomReleases.ts) can use it. */
export function holdEndSql(ro: string): string {
  return `(CASE WHEN ${ro}.scheduled_end IS NOT NULL
                THEN LEAST(${ro}.expires_at,
                           ${manilaDateAtSql(`(${ro}.reserved_at AT TIME ZONE '${APP_TIMEZONE}')::date`, `${ro}.scheduled_end`)})
                ELSE ${ro}.expires_at END)`;
}
