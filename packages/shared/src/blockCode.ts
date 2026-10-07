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

/** Lower-case letters and digits only — "BSIT 2-D" → "bsit2d" (how block searches are compared) */
export function squashSearch(value: string | null | undefined): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A search that names a block rather than a subject: a year number and a
 * block letter, maybe with the program first — "2D", "BSIT 2D", "IT2D",
 * "2nd Year Block D", "Block D". "IT 416" or "Animation" are not.
 */
export function isBlockQuery(query: string | null | undefined): boolean {
  return /^([a-z]{2,6})?(\d(st|nd|rd|th)?(year)?(block)?[a-z]{1,2}|block[a-z]{1,2})$/.test(squashSearch(query));
}

/** True when a block search names this block — "2D" finds 2D of every program, "BSIT 2D" only BSIT's */
export function matchesBlockQuery(
  query: string | null | undefined,
  programCode: string | null | undefined,
  yearLevel: string | null | undefined,
  blockName: string | null | undefined,
): boolean {
  const q = squashSearch(query);
  const b = squashSearch(blockName);
  if (!q || !b) return false;
  const year = String(yearLevel ?? '').match(/\d+/)?.[0] ?? '';
  const yearLabel = squashSearch(yearLevel); // "2ndyear"
  const program = squashSearch(programCode); // "bsit"
  const short = squashSearch(programShortCode(programCode)); // "it"
  // Every way the block may be typed: 2d · 2ndyeard · 2ndyearblockd · 2blockd · blockd — each also with BSIT / IT first
  const forms = [`${year}${b}`, `${yearLabel}${b}`, `${yearLabel}block${b}`, `${year}block${b}`, `block${b}`];
  return forms.some(f => q === f || (!!program && q === program + f) || (!!short && q === short + f));
}
