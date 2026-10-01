/**
 * Short year + block code used across QRganize: ("2nd Year", "G") → "2G".
 * When the year level has no number, it falls back to "Block G" so the label
 * is never ambiguous.
 */
export function blockCode(yearLevel: string | null | undefined, blockName: string | null | undefined): string {
  const name = String(blockName ?? '').trim();
  const year = String(yearLevel ?? '').match(/\d+/)?.[0] ?? '';
  if (!name) return year;
  return year ? `${year}${name}` : `Block ${name}`;
}
