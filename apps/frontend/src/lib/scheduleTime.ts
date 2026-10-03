/**
 * Class-time display helpers shared by Scheduling and the subject faculty
 * preview (Scheduling eye, Master Schedule subject).
 */

/** "13:30" → "1:30 PM". An hour-mark midnight (24:00) reads as 12:00 AM. */
export function fmt12(t: string): string {
  if (!t) return '—';
  const [hRaw, m] = t.split(':').map(Number);
  if (isNaN(hRaw)) return '—';
  /* Hour-mark midnight uses 24:00; treat as 12:00 AM. */
  if (hRaw === 24) return `12:${String(m).padStart(2, '0')} AM`;
  const h = hRaw;
  return `${h === 0 ? 12 : h > 12 ? h - 12 : h}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** A stored day pattern ("M/W/F", "Mon/Thu", "Monday/Thursday") → full day names. */
export function parseDays(pattern: string | null): string[] {
  if (!pattern) return [];
  const map: Record<string, string> = {
    M: 'Monday', T: 'Tuesday', W: 'Wednesday', TH: 'Thursday', F: 'Friday', S: 'Saturday', SU: 'Sunday',
    Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
    Monday: 'Monday', Tuesday: 'Tuesday', Wednesday: 'Wednesday',
    Thursday: 'Thursday', Friday: 'Friday', Saturday: 'Saturday', Sunday: 'Sunday',
  };
  return pattern.split('/').map(p => map[p.trim()] || '').filter(Boolean);
}

/** Normalize Postgres time text (HH:MM:SS) to HH:MM for display/positioning. */
export function normTime(t: string | null | undefined): string {
  if (!t) return '00:00';
  const parts = String(t).split(':');
  return `${parts[0].padStart(2, '0')}:${(parts[1] || '00').padStart(2, '0')}`;
}

/** A class's sessions as the API sends them (an array, or JSON text) → an array. */
export function asSessionList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}
