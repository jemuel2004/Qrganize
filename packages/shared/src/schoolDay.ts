/**
 * The school day for classes: 7:00 AM to 6:00 PM — faculty are out by 6 PM —
 * with a 12:00–1:00 PM lunch break no class may overlap. One definition for
 * Scheduling (time picker, timetable), the server's schedule check, the Excel
 * import check, Analytics and Classroom Demand, so they always agree.
 */

export const SCHOOL_DAY_START_MIN = 7 * 60;
export const SCHOOL_DAY_END_MIN = 18 * 60;
export const LUNCH_START_MIN = 12 * 60;
export const LUNCH_END_MIN = 13 * 60;

/** Minutes of class one room can hold in a school day (lunch excluded) — 600 = 10 hours */
export const SCHOOL_DAY_CLASS_MIN =
  SCHOOL_DAY_END_MIN - SCHOOL_DAY_START_MIN - (LUNCH_END_MIN - LUNCH_START_MIN);

/** 1080 → "6:00 PM" */
export function minutesLabel(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** 1080 → "18:00" (for SQL TIME comparisons) */
export function minutesHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** "7:00 AM–6:00 PM" */
export const SCHOOL_DAY_LABEL = `${minutesLabel(SCHOOL_DAY_START_MIN)}–${minutesLabel(SCHOOL_DAY_END_MIN)}`;
