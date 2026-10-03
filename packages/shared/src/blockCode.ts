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

/** Program's short name, degree prefix dropped: "BSIT" → "IT", "BSCS" → "CS", "BSCpE" → "CPE" */
export function programShortCode(programCode: string | null | undefined): string {
  return String(programCode ?? '').trim().replace(/^BS(?=[A-Za-z])/i, '').toUpperCase();
}

/**
 * Program + year + block, as on the timetable: ("BSIT", "4th Year", "B") → "IT4B",
 * ("BSCpE", "2nd Year", "A") → "CPE2A". Without a program it is the plain block code.
 */
export function programBlockCode(
  programCode: string | null | undefined,
  yearLevel: string | null | undefined,
  blockName: string | null | undefined,
): string {
  const block = blockCode(yearLevel, blockName);
  const program = programShortCode(programCode);
  if (!program || !block) return block || program;
  return block.startsWith('Block ') ? `${program} ${block}` : `${program}${block}`;
}
