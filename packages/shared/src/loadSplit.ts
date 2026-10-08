/**
 * A subject's Lecture and Laboratory, split between Regular Load and the part
 * moved to Overload or Praise Load. The official forms list each part on its
 * own line, with any split the department chooses — e.g. CS 111 (Lec 2 h,
 * Lab 3 h): the Lecture all in Praise, the Laboratory 1 unit Regular +
 * 1.25 units Praise.
 *
 * Storage: the instructor_loads row keeps the Regular part (units / hours) and
 * one overloads row holds the moved part (is_praise = Praise Load).
 * overloads.lec_part says how much of the moved part is Lecture; the rest is
 * Laboratory. Rows saved before lec_part existed leave it empty: the moved part
 * is then the component in overload_component ('lec' / 'lab'), or the Lecture
 * first for a whole-subject split.
 *
 * Permanent faculty count work units (Lab hours × 0.75); Contractual faculty
 * count contact hours.
 */

export type LoadPart = 'lec' | 'lab';

/** The load fields the split is read from (as the workload APIs return them) */
export interface LoadSplitFields {
  load_category?: string | null;
  lecture_hours?: unknown;
  laboratory_hours?: unknown;
  overload_component?: string | null;
  split_overload_units?: unknown;
  split_overload_hours?: unknown;
  /** overloads.lec_part — the Lecture's share of the moved part (empty on older rows) */
  split_lec_part?: unknown;
}

/** One part of a subject: what stays Regular and what is moved */
export interface PartShare {
  regularUnits: number;
  regularHours: number;
  /** In Overload / Praise Load — all of it for a whole Overload or Praise subject */
  movedUnits: number;
  movedHours: number;
}

export interface LoadParts {
  lec: PartShare | null;
  lab: PartShare | null;
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), Math.max(max, 0));

/** A part's value in the faculty's measure: work units (Permanent) or contact hours (Contractual) */
export function partValue(hours: number, part: LoadPart, isPermanent: boolean): number {
  return part === 'lab' && isPermanent ? hours * 0.75 : hours;
}

/** A Regular subject with part of it in Overload / Praise Load */
export function isSplitLoad(load: LoadSplitFields, isPermanent: boolean): boolean {
  return (load.load_category ?? 'Regular') === 'Regular'
    && num(isPermanent ? load.split_overload_units : load.split_overload_hours) > 0.001;
}

/** overload_component for a moved Lecture / Laboratory amount ('full' = some of both) */
export function movedComponent(lecMoved: number, labMoved: number): 'lec' | 'lab' | 'full' {
  if (lecMoved > 0.001 && labMoved <= 0.001) return 'lec';
  if (labMoved > 0.001 && lecMoved <= 0.001) return 'lab';
  return 'full';
}

/** How much of each part is in the moved part, in the faculty's measure */
export function movedParts(load: LoadSplitFields, isPermanent: boolean): { lec: number; lab: number } {
  const lecH = num(load.lecture_hours);
  const labH = num(load.laboratory_hours);
  const lecV = partValue(lecH, 'lec', isPermanent);
  const labV = partValue(labH, 'lab', isPermanent);
  const category = load.load_category ?? 'Regular';
  if (category === 'Overload' || category === 'Praise') return { lec: lecV, lab: labV };
  if (!isSplitLoad(load, isPermanent)) return { lec: 0, lab: 0 };

  const moved = num(isPermanent ? load.split_overload_units : load.split_overload_hours);
  if (lecH <= 0) return { lec: 0, lab: clamp(moved, labV) };
  if (labH <= 0) return { lec: clamp(moved, lecV), lab: 0 };
  const lecPart = load.split_lec_part;
  let lec: number;
  if (lecPart !== null && lecPart !== undefined && String(lecPart).trim() !== '') lec = clamp(num(lecPart), lecV);
  else if (load.overload_component === 'lab') lec = clamp(moved - labV, lecV);
  else lec = clamp(moved, lecV); // 'lec', or an older whole-subject split: the Lecture first
  return { lec: round2(lec), lab: round2(clamp(moved - lec, labV)) };
}

/**
 * Each part of a subject — Lecture and Laboratory — with what stays Regular and
 * what is moved, in work units and contact hours. A part the subject does not
 * have is null.
 */
export function loadParts(load: LoadSplitFields, isPermanent: boolean): LoadParts {
  const lecH = num(load.lecture_hours);
  const labH = num(load.laboratory_hours);
  const moved = movedParts(load, isPermanent);

  const share = (part: LoadPart, hours: number, movedValue: number): PartShare | null => {
    if (hours <= 0) return null;
    const value = partValue(hours, part, isPermanent);
    const regularValue = round2(Math.max(0, value - movedValue));
    let regularHours: number;
    if (!isPermanent || part === 'lec') regularHours = regularValue;
    else if (regularValue >= value - 0.001) regularHours = hours;
    else if (regularValue <= 0.001) regularHours = 0;
    // Laboratory work units back to contact hours, in whole hours as on the forms
    else regularHours = clamp(Math.round(regularValue / 0.75), hours);
    const movedHours = round2(Math.max(0, hours - regularHours));
    const toUnits = (h: number) => round2(part === 'lab' ? h * 0.75 : h);
    return isPermanent
      ? { regularUnits: regularValue, regularHours, movedUnits: round2(value - regularValue), movedHours }
      : { regularUnits: toUnits(regularHours), regularHours, movedUnits: toUnits(movedHours), movedHours };
  };

  return { lec: share('lec', lecH, moved.lec), lab: share('lab', labH, moved.lab) };
}

/** The part a form line shows: Lecture / Laboratory, or the only part of a single-part subject */
export function partOf(parts: LoadParts, type: LoadPart): PartShare | null {
  return parts[type] ?? (parts.lec && !parts.lab ? parts.lec : !parts.lec && parts.lab ? parts.lab : null);
}

/** Sum of the parts (both Lecture and Laboratory) */
export function sumParts(parts: LoadParts): PartShare {
  const all = [parts.lec, parts.lab].filter((p): p is PartShare => !!p);
  const add = (k: keyof PartShare) => round2(all.reduce((s, p) => s + p[k], 0));
  return { regularUnits: add('regularUnits'), regularHours: add('regularHours'), movedUnits: add('movedUnits'), movedHours: add('movedHours') };
}

/** Whether each part has its class time (schedule_sessions), as the workload APIs return it */
export interface LoadScheduleFields {
  lec_scheduled?: boolean | null;
  lab_scheduled?: boolean | null;
}

/**
 * The parts of a subject the official forms list: a Lecture + Laboratory
 * subject shows each part that has its class time (both while neither has one
 * yet); a one-part subject shows that part.
 */
export function formParts(load: LoadSplitFields & LoadScheduleFields): LoadPart[] {
  const hasLec = num(load.lecture_hours) > 0;
  const hasLab = num(load.laboratory_hours) > 0;
  if (hasLec && hasLab) {
    const shown: LoadPart[] = [];
    if (load.lec_scheduled !== false) shown.push('lec');
    if (load.lab_scheduled !== false) shown.push('lab');
    return shown.length > 0 ? shown : ['lec', 'lab'];
  }
  return hasLab ? ['lab'] : ['lec'];
}

/**
 * A subject's value as the official forms count it, over the parts they list:
 * what stays Regular, or the moved part (all of it for a whole Overload or
 * Praise subject). Work units for Permanent faculty, contact hours for Contractual.
 */
export function formLoadValue(
  load: LoadSplitFields & LoadScheduleFields,
  isPermanent: boolean,
  share: 'regular' | 'moved',
): number {
  const parts = loadParts(load, isPermanent);
  return round2(formParts(load).reduce((sum, type) => {
    const p = partOf(parts, type);
    if (!p) return sum;
    if (share === 'regular') return sum + (isPermanent ? p.regularUnits : p.regularHours);
    return sum + (isPermanent ? p.movedUnits : p.movedHours);
  }, 0));
}
