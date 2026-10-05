/** Largest value a Postgres INTEGER / SERIAL id column holds */
export const PG_INT_MAX = 2_147_483_647;

/**
 * A row id taken from a URL, query string or request body: a whole number from
 * 1 to 2147483647, otherwise null. Anything else ("abc", "1.5", "-1", 1e20)
 * makes Postgres throw (22P02 / 22003), which used to come back as a 500 and
 * an Error Log entry — callers answer 400 / 404 instead.
 */
export function parseId(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,10}$/.test(text)) return null;
  const id = Number(text);
  return id >= 1 && id <= PG_INT_MAX ? id : null;
}
