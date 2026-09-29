/*
 * Academic rank order, highest first:
 *   Professor › Associate Professor › Assistant Professor › Instructor
 *   (within a title, the higher roman numeral first — Professor VI › Professor I)
 *   › Temporary Permanent › anything else (e.g. Contractual).
 * Derived from the title + numeral, so every step (Professor VI, …) ranks correctly.
 */

const TITLES = ['Professor', 'Associate Professor', 'Assistant Professor', 'Instructor'];
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

/** Lower = higher rank */
export function positionRank(position: string | null | undefined): number {
  const p = String(position ?? '').trim();
  const m = p.match(/^(.*?)\s+([IVX]+)$/);
  const title = m ? m[1] : p;
  const t = TITLES.indexOf(title);
  if (t === -1) return p === 'Temporary Permanent' ? 1000 : 2000;
  return t * 100 - (m ? ROMAN[m[2]] ?? 0 : 0);
}

/** Sort comparator: highest rank first, then by name */
export function byPosition<T extends { position?: string | null; name: string }>(a: T, b: T): number {
  return positionRank(a.position) - positionRank(b.position) || a.name.localeCompare(b.name);
}
