import { parseId } from '@/database/ids';

/*
 * Request input as a browser sent it — or as anyone calling the API by hand.
 * A malformed value must be answered with a 400 / 404 here, never reach the
 * database and fail there (a 500 and an Error Log entry). Single ids:
 * database/ids.ts parseId.
 */

/** The JSON object a write sent; null when the body is not JSON or not an object */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null);
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

/** The valid ids in a list (e.g. master_schedule_ids), each once; anything else in it is left out */
export function parseIdList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(parseId).filter((id): id is number => id !== null))];
}

/**
 * A text value as stored: trimmed, and '' when it was left out. Null when it
 * is not text, holds a NUL character (Postgres refuses those) or is longer
 * than `max` characters (its column's limit).
 */
export function cleanText(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string' || raw.includes('\u0000')) return null;
  const text = raw.trim();
  return text.length <= max ? text : null;
}
