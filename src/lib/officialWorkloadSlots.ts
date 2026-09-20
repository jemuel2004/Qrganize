/**
 * Official Instructor Workload Form timetable.
 * Fixed day/time rows match the printed school workload document.
 */

export type OfficialDayGroup = 'mth' | 'tf' | 'wed' | 'other';

export interface OfficialSlot {
  id: string;
  timeLabel: string;
  startMin: number;
  endMin: number;
}

export interface OfficialGroup {
  id: string;
  label: string;
  dayGroup: Exclude<OfficialDayGroup, 'other'>;
  slots: OfficialSlot[];
}

/**
 * 12-hour clock with AM/PM from minutes-since-midnight.
 * Derived from the actual time value — not from Morning/Afternoon section labels.
 */
export function formatOfficialClock(mins: number): string {
  const day = 24 * 60;
  const normalized = ((Math.floor(mins) % day) + day) % day;
  const h24 = Math.floor(normalized / 60);
  const m = normalized % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** e.g. 780–960 → "1:00 PM–4:00 PM" */
export function formatOfficialMinutesRange(startMin: number, endMin: number): string {
  return `${formatOfficialClock(startMin)}–${formatOfficialClock(endMin)}`;
}

function makeSlot(groupId: string, startMin: number, endMin: number): OfficialSlot {
  return {
    id: `${groupId}::${startMin}-${endMin}`,
    timeLabel: formatOfficialMinutesRange(startMin, endMin),
    startMin,
    endMin,
  };
}

export const OFFICIAL_GROUPS: OfficialGroup[] = [
  {
    id: 'mth-am',
    label: 'MTh/Morning',
    dayGroup: 'mth',
    slots: [
      makeSlot('mth-am', 7 * 60, 10 * 60),
      makeSlot('mth-am', 7 * 60, 8 * 60),
      makeSlot('mth-am', 8 * 60 + 30, 10 * 60),
      makeSlot('mth-am', 10 * 60, 11 * 60 + 30),
    ],
  },
  {
    id: 'mth-pm',
    label: 'MTh/Afternoon',
    dayGroup: 'mth',
    slots: [
      makeSlot('mth-pm', 13 * 60, 14 * 60),
      makeSlot('mth-pm', 14 * 60, 15 * 60 + 30),
      makeSlot('mth-pm', 14 * 60 + 30, 16 * 60),
      makeSlot('mth-pm', 16 * 60, 17 * 60 + 30),
    ],
  },
  {
    id: 'tf-am',
    label: 'TF/Morning',
    dayGroup: 'tf',
    slots: [
      makeSlot('tf-am', 7 * 60, 10 * 60),
      makeSlot('tf-am', 8 * 60 + 30, 10 * 60),
      makeSlot('tf-am', 10 * 60, 11 * 60 + 30),
    ],
  },
  {
    id: 'tf-pm',
    label: 'TF/Afternoon',
    dayGroup: 'tf',
    slots: [
      makeSlot('tf-pm', 13 * 60, 14 * 60 + 30),
      makeSlot('tf-pm', 14 * 60 + 30, 16 * 60),
      makeSlot('tf-pm', 16 * 60, 17 * 60 + 30),
    ],
  },
  {
    id: 'wed-am',
    label: 'Wed/Morning',
    dayGroup: 'wed',
    slots: [
      makeSlot('wed-am', 8 * 60, 12 * 60),
    ],
  },
  {
    id: 'wed-pm',
    label: 'Wed/Afternoon',
    dayGroup: 'wed',
    slots: [
      makeSlot('wed-pm', 13 * 60, 17 * 60),
    ],
  },
];

function normalizeDayToken(tok: string): string {
  const t = tok.toLowerCase().replace(/\./g, '');
  if (['m', 'mon', 'monday'].includes(t)) return 'mon';
  if (['t', 'tue', 'tues', 'tuesday'].includes(t)) return 'tue';
  if (['w', 'wed', 'weds', 'wednesday'].includes(t)) return 'wed';
  if (['th', 'thu', 'thur', 'thurs', 'thursday'].includes(t)) return 'thu';
  if (['f', 'fri', 'friday'].includes(t)) return 'fri';
  if (['s', 'sat', 'saturday'].includes(t)) return 'sat';
  if (['su', 'sun', 'sunday'].includes(t)) return 'sun';
  return t;
}

export function classifyOfficialDayGroup(dayPattern: string | null | undefined): OfficialDayGroup {
  if (!dayPattern) return 'other';
  const raw = dayPattern.toLowerCase().replace(/\s+/g, '');
  if (!raw || raw === 'tba' || raw === 'unscheduled') return 'other';
  if (raw === 'sat' || raw === 'saturday' || raw.startsWith('sat')) return 'other';
  if (raw === 'w' || raw === 'wed' || raw === 'wednesday' || raw === 'weds') return 'wed';
  if (
    raw === 'tf' || raw === 't/f' ||
    raw === 'tth' || raw === 't/th' ||
    raw === 'fri' || raw === 'friday' || raw === 'f' ||
    /^t(ue|ues)?\/?f(ri)?$/.test(raw) ||
    /^t(ue|ues)?\/?th(u|ur|urs)?$/.test(raw)
  ) return 'tf';
  if (
    raw === 'mth' || raw === 'm/th' || raw === 'mt' || raw === 'm/t' ||
    raw === 'mw' || raw === 'm/w' || raw === 'mwf' || raw === 'm/w/f'
  ) return 'mth';

  const tokens = raw.split(/[/,+&-]+/).filter(Boolean).map(normalizeDayToken);
  const set = new Set(tokens);
  if (set.has('sat') && !set.has('mon') && !set.has('tue') && !set.has('wed') && !set.has('thu') && !set.has('fri')) {
    return 'other';
  }
  if (set.size === 1 && set.has('wed')) return 'wed';
  if (set.has('tue') && set.has('fri')) return 'tf';
  if (set.has('tue') && set.has('thu')) return 'tf';
  if (set.has('fri') && !set.has('mon') && !set.has('wed') && !set.has('thu')) return 'tf';
  if (set.has('mon') || set.has('thu')) return 'mth';
  if (set.has('wed')) return 'mth';
  return 'other';
}

export function parseTimeMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const parts = t.trim().split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1] || '0', 10);
  if (Number.isNaN(h)) return null;
  return h * 60 + (Number.isNaN(m) ? 0 : m);
}

function withAfternoonGuess(startMin: number, endMin: number | null): { start: number; end: number | null } {
  if (startMin >= 60 && startMin < 7 * 60) {
    return {
      start: startMin + 12 * 60,
      end: endMin != null && endMin < 7 * 60 ? endMin + 12 * 60 : endMin,
    };
  }
  return { start: startMin, end: endMin };
}

function pickSlot(slots: OfficialSlot[], startMin: number, endMin: number | null): OfficialSlot | null {
  if (endMin != null) {
    const exact = slots.find(
      s => Math.abs(s.startMin - startMin) <= 2 && Math.abs(s.endMin - endMin) <= 2,
    );
    if (exact) return exact;
  }
  const sameStart = slots.filter(s => Math.abs(s.startMin - startMin) <= 2);
  if (sameStart.length === 1) return sameStart[0];
  if (sameStart.length > 1 && endMin != null) {
    return sameStart.reduce((best, s) =>
      Math.abs(s.endMin - endMin) < Math.abs(best.endMin - endMin) ? s : best,
    );
  }
  if (endMin != null) {
    let best: OfficialSlot | null = null;
    let bestOverlap = 0;
    for (const s of slots) {
      const ov = Math.max(0, Math.min(s.endMin, endMin) - Math.max(s.startMin, startMin));
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = s;
      }
    }
    if (best && bestOverlap >= 20) return best;
  }
  const containing = slots.filter(s => startMin >= s.startMin && startMin < s.endMin);
  if (containing.length === 1) return containing[0];
  if (containing.length > 1) {
    return containing.reduce((a, b) =>
      (b.endMin - b.startMin) < (a.endMin - a.startMin) ? b : a,
    );
  }
  return sameStart[0] ?? null;
}

export function matchOfficialSlot(
  dayPattern: string | null | undefined,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): string | null {
  const dayGroup = classifyOfficialDayGroup(dayPattern);
  if (dayGroup === 'other') return null;
  const startMin = parseTimeMinutes(startTime);
  if (startMin == null) return null;
  const endMin = parseTimeMinutes(endTime);
  const slots = OFFICIAL_GROUPS.filter(g => g.dayGroup === dayGroup).flatMap(g => g.slots);
  const first = pickSlot(slots, startMin, endMin);
  if (first) return first.id;
  const alt = withAfternoonGuess(startMin, endMin);
  if (alt.start !== startMin) {
    const second = pickSlot(slots, alt.start, alt.end);
    if (second) return second.id;
  }
  return null;
}

export function formatOfficialNumber(n: number): string {
  if (!Number.isFinite(n)) return '';
  return Math.abs(n % 1) < 0.001 ? String(Math.round(n)) : n.toFixed(2);
}

/**
 * Official form TIME/DAY cell — uses saved DB start/end (24h → 12h with AM/PM).
 * Example: 13:00–16:00 → "1:00 PM–4:00 PM"; 11:00–13:00 → "11:00 AM–1:00 PM".
 */
export function formatOfficialTimeRange(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): string {
  const startMin = parseTimeMinutes(startTime);
  if (startMin == null) return '';
  const endMin = parseTimeMinutes(endTime);
  if (endMin == null) return formatOfficialClock(startMin);
  return formatOfficialMinutesRange(startMin, endMin);
}

/** Actual occupied schedule interval (minutes from midnight). */
export type OccupiedTimeRange = { startMin: number; endMin: number };

/**
 * Half-open overlap: [aStart, aEnd) vs [bStart, bEnd).
 * Touching at an endpoint (e.g. class ends 4:00, next slot starts 4:00) is NOT overlap.
 */
export function officialRangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** True when an empty template slot lies inside any occupied schedule range. */
export function isEmptySlotCoveredByOccupied(
  slot: OfficialSlot,
  occupied: OccupiedTimeRange[],
): boolean {
  if (occupied.length === 0) return false;
  return occupied.some(r =>
    officialRangesOverlap(slot.startMin, slot.endMin, r.startMin, r.endMin),
  );
}

/**
 * Build occupied ranges from saved schedule times (DB source of truth).
 * Applies the same afternoon 12h guess used by slot matching when needed.
 */
export function occupiedRangeFromScheduleTimes(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): OccupiedTimeRange | null {
  let startMin = parseTimeMinutes(startTime);
  if (startMin == null) return null;
  let endMin = parseTimeMinutes(endTime);
  const alt = withAfternoonGuess(startMin, endMin);
  startMin = alt.start;
  endMin = alt.end;
  if (endMin == null || endMin <= startMin) return null;
  return { startMin, endMin };
}
