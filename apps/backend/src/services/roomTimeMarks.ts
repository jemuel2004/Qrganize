import { BORROW_MIN_LEFT } from '@/services/borrowedRoom';
import { SCAN_WITHIN_MIN } from '@shared/roomRequestWindow';

/*
 * The minutes of a day when a room's state changes by itself — no one saves anything, the
 * clock just reaches a class's turning point (pure — services/roomClock.ts announces them):
 *   start − 15  its faculty may scan; a reservation's hold starts
 *   start       a freed class time opens to others
 *   start + 15  not scanned → its room is free to others; a reservation's scan time ends
 *   end − 30    the last 30 minutes of free time: no one can take the room any more
 *   end         the class ends (a freed time / borrowed room ends)
 *   end + 30    its faculty's after-class hold ends
 */

const EARLY_MIN = 15;
const TAIL_MIN = 30;

const toMin = (t: string) => {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Minutes after midnight (0–1439) when any of these class times reaches a turning point */
export function roomTimeMarks(times: { start: string; end: string }[]): Set<number> {
  const marks = new Set<number>();
  for (const t of times) {
    const s = toMin(t.start);
    const e = toMin(t.end);
    for (const m of [s - EARLY_MIN, s, s + SCAN_WITHIN_MIN, e - BORROW_MIN_LEFT, e, e + TAIL_MIN]) {
      if (m >= 0 && m < 24 * 60) marks.add(m);
    }
  }
  return marks;
}

/** 'HH:MM[:SS]' → minutes after midnight */
export const minuteOfDay = toMin;
