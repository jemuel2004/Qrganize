/**
 * Clock times as people read them: 12-hour with AM/PM ("1:30 PM"). The one
 * format every screen, print, export and message shows. Display only — times
 * are still stored, sent, compared and saved as 24-hour "HH:MM".
 */

/** "13:30", "13:30:00" or minutes after midnight (810) → "1:30 PM"; "" when there is no valid time. 24:00 reads as 12:00 AM. */
export function clock12(t: string | number | null | undefined): string {
  let min: number;
  if (typeof t === 'number') {
    min = t;
  } else {
    const m = String(t ?? '').match(/^\s*(\d{1,2}):(\d{2})/);
    if (!m) return '';
    min = Number(m[1]) * 60 + Number(m[2]);
  }
  if (!Number.isFinite(min)) return '';
  const day = ((Math.floor(min) % 1440) + 1440) % 1440;
  const h = Math.floor(day / 60);
  return `${h % 12 || 12}:${String(day % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** "13:00", "14:30" → "1:00 PM – 2:30 PM" (AM/PM on both ends); just one end when the other is missing; "" when neither */
export function clockRange12(
  start: string | number | null | undefined,
  end: string | number | null | undefined,
  separator = ' – ',
): string {
  const a = clock12(start);
  const b = clock12(end);
  return a && b ? `${a}${separator}${b}` : a || b;
}

/** Text saved before this format ("ended at 14:30", "13:00–14:30") → 12-hour times; times that already have AM/PM stay */
export function times12InText(text: string): string {
  return text.replace(
    /(^|[^\w:])([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?(?![\d:])(?!\s?[AaPp]\.?[Mm])/g,
    (_, before: string, h: string, m: string) => `${before}${clock12(`${h}:${m}`)}`,
  );
}
