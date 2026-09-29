import { headers } from 'next/headers';

/**
 * Header set by `src/proxy.ts` after the backend confirmed the session.
 * The proxy always overwrites it, so a browser cannot supply its own value.
 */
export const ROLE_HEADER = 'x-qrganize-role';

/** Role of the signed-in user for server components (null when signed out). */
export async function getPageAuthRole(): Promise<string | null> {
  try {
    return (await headers()).get(ROLE_HEADER) || null;
  } catch {
    return null;
  }
}
