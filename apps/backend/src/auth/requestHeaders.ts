/**
 * Request headers the API gate (proxy.ts) sets on every /api request, so code
 * deep inside a route — e.g. the error log — knows which route is running and
 * who is signed in. The gate always overwrites or removes them, so a browser
 * can never supply its own values.
 */
export const ROUTE_HEADER = 'x-qrganize-route';
export const ACTOR_HEADER = 'x-qrganize-actor';

export interface RequestActor {
  id: number | null;
  role: string | null;
  name: string | null;
}

/** Signed-in user from a verified session payload → header value (ASCII-safe). */
export function encodeActor(payload: Record<string, unknown>): string {
  const id = Number(payload.id);
  return encodeURIComponent(JSON.stringify({
    id: Number.isFinite(id) ? id : null,
    role: typeof payload.role === 'string' ? payload.role : null,
    name: typeof payload.name === 'string' ? payload.name : typeof payload.username === 'string' ? payload.username : null,
  }));
}

export function decodeActor(value: string | null | undefined): RequestActor | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(decodeURIComponent(value)) as Record<string, unknown>;
    return {
      id: typeof raw.id === 'number' && Number.isFinite(raw.id) ? raw.id : null,
      role: typeof raw.role === 'string' ? raw.role.slice(0, 40) : null,
      name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : null,
    };
  } catch {
    return null;
  }
}

/** "GET /api/scheduling" → { method, path } */
export function decodeRoute(value: string | null | undefined): { method: string; path: string } | null {
  const m = /^([A-Z]+) (\/\S*)$/.exec(value ?? '');
  return m ? { method: m[1], path: m[2] } : null;
}
