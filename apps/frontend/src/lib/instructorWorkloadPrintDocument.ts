/**
 * Official NEMSU Faculty Workload — Regular Load print document.
 * Shared by Admin (Instructor Workload) and Instructor (My Workload).
 * Paper: long bond 8.5 × 13 in portrait — do not invent a second template.
 */

import type { WeekDay } from '@shared/dayCombination';
import { isSplitLoad, loadParts, partOf } from '@shared/loadSplit';
import { fetchDayCombinations } from '@/lib/dayCombinations';
import type { WorkloadDocumentKind } from '@/lib/workloadPrintStorage';
import {
  buildOfficialGroups,
  loadDayPatterns,
  matchOfficialSlot,
  formatOfficialTimeRange,
  occupiedRangeFromScheduleTimes,
  isEmptySlotCoveredByOccupied,
  type OccupiedTimeRange,
} from '@/lib/officialWorkloadSlots';
import {
  footerHtml,
  DEFAULT_FOOTER_CONFIG,
  officialPrintDocumentCss,
  officialPrintHeaderHtml,
  officialPrintPagedHtml,
  semesterHeading,
  formatAy,
  escapePrintHtml,
  NEMSU_OFFICIAL_DEPT,
} from '@/lib/nemsuOfficialPrintChrome';
import {
  openBlankPrintWindow,
  openPrintHtmlDocument,
  type OpenPrintHtmlResult,
} from '@/lib/openPrintHtmlDocument';
import { mergeSameSubjects } from '@shared/subjectCode';
import type {
  WorkloadFormCell, WorkloadFormModel, WorkloadFormRow, WorkloadFormSection, WorkloadFormSummaryRow,
} from '@shared/workloadFormExport';

export type PrintWorkloadLoad = {
  id: number;
  load_category: string;
  units: number;
  hours: number;
  subject_code: string;
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  block_name: string;
  year_level: string;
  number_of_students: number;
  program_code: string;
  ms_id: number;
  room_name: string | null;
  lec_room_name: string | null;
  lab_room_name: string | null;
  day_pattern: string | null;
  start_time: string | null;
  end_time: string | null;
  split_overload_units?: number;
  split_overload_hours?: number;
  /** Split-off Lec/Lab portion is Praise Load (not Overload). */
  split_is_praise?: boolean;
  overload_component?: string;
  /** The Lecture's share of the moved part (overloads.lec_part) — see @shared/loadSplit */
  split_lec_part?: number | string | null;
  lec_scheduled?: boolean;
  lab_scheduled?: boolean;
  lec_start_time?: string | null;
  lec_end_time?: string | null;
  lab_start_time?: string | null;
  lab_end_time?: string | null;
  lec_day_pattern?: string | null;
  lab_day_pattern?: string | null;
};

export type PrintFaculty = {
  name: string;
  position: string;
  employment_status: string;
  designation_type?: string | null;
  years_in_service?: number | null;
  educational_qualification?: string | null;
  major?: string | null;
  eligibility?: string | null;
};

export type PrintPraise = {
  id?: number;
  praise_type?: string;
  description?: string;
  equivalent_units: unknown;
  equivalent_hours?: unknown;
};

export type PrintDeduction = {
  id: number;
  deduction_type: string;
  description: string;
  deducted_units: number;
};

/** Research / Extension types go on the form's "Add: Research/Extension" line — for
 *  Praise records and for load deductions alike (official form). */
export function isResearchExtensionType(type: string | null | undefined): boolean {
  return /^(research|extension|research\s*\/\s*extension)$/i.test(String(type ?? '').trim());
}

export type DesignationFooterLine = {
  key: string;
  /** "Designation", or "Add: <type>" — exactly the Deloading type selected */
  label: string;
  description: string;
  units: number;
};

/** Deloading types in the order they appear on the form (others after) */
const DELOADING_ORDER = ['Designation', 'Extension', 'Research/Extension'];
const rank = (type: string) => {
  const i = DELOADING_ORDER.indexOf(type);
  return i < 0 ? DELOADING_ORDER.length : i;
};

/** Workload form lines for Deloading (Special Assignment has its own line): one line
 *  per deduction with its own units, labelled with the type that was selected —
 *  "Designation", "Add: Extension", "Add: Research/Extension". With none, the
 *  template's blank "Designation" line stays. */
export function designationFooterLines(
  deductions: (Pick<PrintDeduction, 'deduction_type' | 'description' | 'deducted_units'> & { id?: number })[],
): DesignationFooterLine[] {
  const lines = deductions
    .filter(d => d.deduction_type !== 'Special Assignment')
    // Form order: Designation, Extension, Research/Extension, then any other type
    .sort((a, b) => rank(a.deduction_type) - rank(b.deduction_type))
    .map((d, i): DesignationFooterLine => ({
      key: `ded-${d.id ?? i}`,
      label: d.deduction_type === 'Designation' ? 'Designation' : `Add: ${d.deduction_type}`,
      description: (d.description ?? '').trim() || d.deduction_type,
      units: Number(d.deducted_units) || 0,
    }));
  return lines.length > 0
    ? lines
    : [{ key: 'designation-none', label: 'Designation', description: 'No Designation', units: 0 }];
}

/** "Designation" row text on the workload form: each deduction's description
 *  (e.g. "ICT Coordinator"), falling back to its type when none was typed.
 *  Special Assignment has its own row, so it is left out here. */
export function designationRowText(deductions: Pick<PrintDeduction, 'deduction_type' | 'description'>[]): string {
  const rows = deductions.filter(d => d.deduction_type !== 'Special Assignment');
  return rows.length > 0
    ? rows.map(d => (d.description ?? '').trim() || d.deduction_type).join(' + ')
    : 'No Designation';
}

type SplitRow = {
  key: string;
  load: PrintWorkloadLoad;
  type: 'lec' | 'lab';
  hours: number;
  wu: number;
  description: string;
  room_name: string | null;
};

function calcWorkloadUnits(lec: number, lab: number): number {
  return lec + lab * 0.75;
}

/** The subject's Lec / Lab lines at their full values (split amounts: loadParts). */
function splitLoad(load: PrintWorkloadLoad): SplitRow[] {
  const lec = parseFloat(String(load.lecture_hours)) || 0;
  const lab = parseFloat(String(load.laboratory_hours)) || 0;

  if (lec > 0 && lab > 0) {
    const lecRow: SplitRow = {
      key: `${load.id}-lec`, load, type: 'lec', hours: lec, wu: lec,
      description: `${load.subject_name} (Lec)`, room_name: load.lec_room_name,
    };
    const labRow: SplitRow = {
      key: `${load.id}-lab`, load, type: 'lab', hours: lab, wu: lab * 0.75,
      description: `${load.subject_name} (Lab)`, room_name: load.lab_room_name,
    };
    const rows = [
      ...(load.lec_scheduled !== false ? [lecRow] : []),
      ...(load.lab_scheduled !== false ? [labRow] : []),
    ];
    return rows.length > 0 ? rows : [lecRow, labRow];
  }

  const isLab = lab > 0 && lec === 0;
  return [{
    key: `${load.id}`,
    load,
    type: lec > 0 ? 'lec' : 'lab',
    hours: lec > 0 ? lec : lab,
    wu: calcWorkloadUnits(lec, lab),
    description: lec > 0 ? `${load.subject_name} (Lec)` : `${load.subject_name} (Lab)`,
    room_name: isLab ? (load.lab_room_name ?? load.room_name) : (load.lec_room_name ?? load.room_name),
  }];
}

/** A Regular line's units / hours — only what stays Regular of a split subject. */
function computeRegularRowValues(
  load: PrintWorkloadLoad,
  row: SplitRow,
  isP: boolean
): { displayWU: number; displayHours: number } {
  if (!isSplitLoad(load, isP)) return { displayWU: row.wu, displayHours: row.hours };
  const part = partOf(loadParts(load, isP), row.type);
  return part ? { displayWU: part.regularUnits, displayHours: part.regularHours } : { displayWU: 0, displayHours: 0 };
}

/** An Overload / Praise line's units / hours — all of a whole subject, or its moved part. */
function movedRowValues(load: PrintWorkloadLoad, row: SplitRow, isP: boolean): { wu: number; hours: number } {
  const part = partOf(loadParts(load, isP), row.type);
  return part ? { wu: part.movedUnits, hours: part.movedHours } : { wu: 0, hours: 0 };
}

/** Work units of `hours` of one component — Lecture 1 : 1, Laboratory × 0.75. */
export function hoursToUnits(hours: number, type: 'lec' | 'lab'): number {
  return type === 'lab' ? hours * 0.75 : hours;
}

/** One Lec/Lab line of the Actual Load form, at its full value. */
export type ActualLoadLine<L extends PrintWorkloadLoad = PrintWorkloadLoad> = {
  row: Omit<SplitRow, 'load'> & { load: L };
  startTime: string | null;
  endTime: string | null;
  dayPattern: string | null;
};

/**
 * Actual Load: every subject of the term (Regular, Overload and Praise alike), each
 * Lec/Lab at its full value — no split between forms. Shared by the print/Excel form
 * and the on-screen Actual Load section, so both always show the same lines.
 */
export function actualLoadLines<L extends PrintWorkloadLoad>(loads: L[], isP: boolean): ActualLoadLine<L>[] {
  const lines: ActualLoadLine<L>[] = [];
  for (const load of loads) {
    const lec = parseFloat(String(load.lecture_hours)) || 0;
    const lab = parseFloat(String(load.laboratory_hours)) || 0;
    const hasBoth = lec > 0 && lab > 0;
    for (const row of splitLoad(load)) {
      const wu = hasBoth ? (row.type === 'lec' ? lec : lab * 0.75) : calcWorkloadUnits(lec, lab);
      const hours = hasBoth ? (row.type === 'lec' ? lec : lab) : lec + lab;
      if (isP ? wu < 0.001 : hours < 0.001) continue;
      const isLec = row.type === 'lec';
      lines.push({
        row: { ...row, load, wu, hours },
        startTime: isLec ? (load.lec_start_time ?? load.start_time) : (load.lab_start_time ?? load.start_time),
        endTime: isLec ? (load.lec_end_time ?? load.end_time) : (load.lab_end_time ?? load.end_time),
        dayPattern: isLec ? (load.lec_day_pattern ?? load.day_pattern) : (load.lab_day_pattern ?? load.day_pattern),
      });
    }
  }
  return lines;
}

function escHtml(s: string | null | undefined): string {
  return escapePrintHtml(s);
}

export type BuildRegularLoadPrintInput = {
  faculty: PrintFaculty;
  loads: PrintWorkloadLoad[];
  praise?: PrintPraise[];
  deductions?: PrintDeduction[];
  semester: string;
  academicYear: string;
  logoOrigin?: string;
  /** Which official form to print — same layout, different title/summary. */
  documentKind?: WorkloadDocumentKind;
  /** The semester's day combinations (Settings); none → the fixed MTh/TF/Wed groups */
  dayCombinations?: readonly { days: readonly WeekDay[]; is_active?: boolean }[] | null;
};

/** Official form as data — the single source for the print HTML and the Excel export. */
export function buildWorkloadFormModel(input: BuildRegularLoadPrintInput): WorkloadFormModel {
  const {
    faculty: fac,
    loads,
    praise: praiseArr = [],
    deductions: wDeds = [],
    semester,
    academicYear,
  } = input;
  const documentKind = input.documentKind ?? 'regular';
  const isP = fac.employment_status === 'Permanent';
  /** Day/time groups of the form — follow the semester's day combinations */
  const groups = buildOfficialGroups(input.dayCombinations, loadDayPatterns(loads));

  type PRow = {
    load: PrintWorkloadLoad;
    row: SplitRow;
    startTime: string | null;
    endTime: string | null;
  };
  const placed: Record<string, PRow[]> = {};
  const unmatchedPrint: PRow[] = [];
  let totalRegularWU = 0;
  let totalRegularHours = 0;
  let praiseSubjectWU = 0;
  let praiseSubjectHours = 0;

  if (documentKind === 'regular') {
    // Regular subjects only, as on screen — Overload and Praise have their own forms
    const regularLoads = loads.filter(l => l.load_category === 'Regular');
    for (const load of regularLoads) {
      for (const row of splitLoad(load)) {
        const startTime = row.type === 'lec'
          ? (load.lec_start_time ?? load.start_time)
          : (load.lab_start_time ?? load.start_time);
        const endTime = row.type === 'lec'
          ? (load.lec_end_time ?? load.end_time)
          : (load.lab_end_time ?? load.end_time);
        const dayPat = row.type === 'lec'
          ? (load.lec_day_pattern ?? load.day_pattern)
          : (load.lab_day_pattern ?? load.day_pattern);
        const { displayWU, displayHours } = computeRegularRowValues(load, row, isP);
        if (isP ? displayWU < 0.001 : displayHours < 0.001) continue;
        totalRegularWU += displayWU;
        totalRegularHours += displayHours;
        const pr: PRow = { load, row, startTime, endTime };
        const slotId = matchOfficialSlot(dayPat, startTime, endTime, groups);
        if (slotId) {
          if (!placed[slotId]) placed[slotId] = [];
          placed[slotId].push(pr);
        } else {
          unmatchedPrint.push(pr);
        }
      }
    }
  } else if (documentKind === 'overload') {
    for (const load of loads) {
      for (const row of splitLoad(load)) {
        const startTime = row.type === 'lec'
          ? (load.lec_start_time ?? load.start_time)
          : (load.lab_start_time ?? load.start_time);
        const endTime = row.type === 'lec'
          ? (load.lec_end_time ?? load.end_time)
          : (load.lab_end_time ?? load.end_time);
        const dayPat = row.type === 'lec'
          ? (load.lec_day_pattern ?? load.day_pattern)
          : (load.lab_day_pattern ?? load.day_pattern);
        // A whole Overload subject at its full Lec / Lab values; a split subject only its moved part
        const { wu, hours: hrs } = movedRowValues(load, row, isP);
        if (isP ? wu < 0.001 : hrs < 0.001) continue;
        totalRegularWU += wu;
        totalRegularHours += hrs;
        const adjustedRow: SplitRow = { ...row, wu, hours: hrs };
        const pr: PRow = { load, row: adjustedRow, startTime, endTime };
        const slotId = matchOfficialSlot(dayPat, startTime, endTime, groups);
        if (slotId) {
          if (!placed[slotId]) placed[slotId] = [];
          placed[slotId].push(pr);
        } else {
          unmatchedPrint.push(pr);
        }
      }
    }
  } else if (documentKind === 'deload') {
    /* Actual Load: every subject of the term on one form, each at its full Lec/Lab value
       (Regular, Overload and Praise alike — no split between documents). */
    for (const { row, startTime, endTime, dayPattern } of actualLoadLines(loads, isP)) {
      totalRegularWU += row.wu;
      totalRegularHours += row.hours;
      const pr: PRow = { load: row.load, row, startTime, endTime };
      const slotId = matchOfficialSlot(dayPattern, startTime, endTime, groups);
      if (slotId) {
        if (!placed[slotId]) placed[slotId] = [];
        placed[slotId].push(pr);
      } else {
        unmatchedPrint.push(pr);
      }
    }
  } else if (documentKind === 'praise') {
    /* Praise subjects in their schedule slots: whole subjects, or the part of the
       Lecture / Laboratory moved to Praise (the rest stays Regular). */
    for (const load of loads) {
      for (const row of splitLoad(load)) {
        const { wu, hours: hrs } = movedRowValues(load, row, isP);
        if (isP ? wu < 0.001 : hrs < 0.001) continue;
        praiseSubjectWU += wu;
        praiseSubjectHours += hrs;
        const startTime = row.type === 'lec' ? (load.lec_start_time ?? load.start_time) : (load.lab_start_time ?? load.start_time);
        const endTime = row.type === 'lec' ? (load.lec_end_time ?? load.end_time) : (load.lab_end_time ?? load.end_time);
        const dayPat = row.type === 'lec' ? (load.lec_day_pattern ?? load.day_pattern) : (load.lab_day_pattern ?? load.day_pattern);
        const pr: PRow = { load, row: { ...row, wu, hours: hrs }, startTime, endTime };
        const slotId = matchOfficialSlot(dayPat, startTime, endTime, groups);
        if (slotId) {
          if (!placed[slotId]) placed[slotId] = [];
          placed[slotId].push(pr);
        } else {
          unmatchedPrint.push(pr);
        }
      }
    }
  }

  /** Class line exactly as printed. */
  function loadRow(pr: PRow): WorkloadFormRow {
    const { load, row, startTime, endTime } = pr;
    const yl = load.year_level ?? '';
    const yearNum = (yl.match(/\d+/) ?? [''])[0] || yl;
    const course = [load.program_code ?? '', `${yearNum}${load.block_name ?? ''}`].join(' ').trim();
    const { displayWU, displayHours } = documentKind === 'regular'
      ? computeRegularRowValues(load, row, isP)
      : { displayWU: row.wu, displayHours: row.hours };
    // Units under Units and hours under Hours for every faculty (as on screen)
    const wu = displayWU % 1 === 0 ? displayWU.toFixed(0) : displayWU.toFixed(2);
    const hrs = displayHours % 1 === 0 ? displayHours.toFixed(0) : displayHours.toFixed(2);
    return {
      kind: 'load',
      /* Saved DB start/end only — never the template slot duration. */
      time: formatOfficialTimeRange(startTime, endTime),
      code: load.subject_code,
      description: row.description,
      boldDescription: /consultation\s*period/i.test(row.description ?? ''),
      course,
      students: load.number_of_students > 0 ? String(load.number_of_students) : '',
      units: wu,
      hours: hrs,
      room: row.room_name ?? '',
    };
  }

  /* Same OFFICIAL_GROUPS template for Regular, Overload, and Praise.
     Overload must NOT omit empty groups/slots — that compresses the page. */
  const sections: WorkloadFormSection[] = [];
  for (const group of groups) {
    const occupied: OccupiedTimeRange[] = [];
    for (const slot of group.slots) {
      for (const pr of placed[slot.id] || []) {
        const r = occupiedRangeFromScheduleTimes(pr.startTime, pr.endTime);
        if (r) occupied.push(r);
      }
    }
    /* Every row of the group in time order — classes sharing a template block
       (e.g. 7:00 and 9:00 inside 7:00–10:00) and empty template rows alike. */
    const entries: { start: number; isRow: boolean; row: WorkloadFormRow }[] = [];
    for (const slot of group.slots) {
      const rows = placed[slot.id] || [];
      if (rows.length === 0) {
        /* Hide predefined empties inside an occupied range; keep touching endpoints. */
        if (isEmptySlotCoveredByOccupied(slot, occupied)) continue;
        entries.push({ start: slot.startMin, isRow: false, row: { kind: 'blank', time: slot.timeLabel } });
      } else {
        for (const pr of rows) {
          const r = occupiedRangeFromScheduleTimes(pr.startTime, pr.endTime);
          entries.push({ start: r ? r.startMin : slot.startMin, isRow: true, row: loadRow(pr) });
        }
      }
    }
    entries.sort((a, b) => a.start - b.start || Number(b.isRow) - Number(a.isRow));
    sections.push({ label: group.label, rows: entries.map(e => e.row) });
  }

  /* Praise entries live under Other; schedule slots stay as the full template above. */
  if (documentKind === 'praise') {
    // Praise records are listed on the footer lines (Add: Research/Extension,
    // Add: Special Assignment), as on the official form — not repeated here.
    const other: WorkloadFormRow[] = unmatchedPrint.map(loadRow);
    if (other.length === 0) other.push({ kind: 'blank', time: '' });
    sections.push({ label: 'Other', rows: other });
  } else if (unmatchedPrint.length > 0) {
    sections.push({ label: 'Other', rows: unmatchedPrint.map(loadRow) });
  }

  /* Deductions split by type — "Special Assignment" gets its own summary line
   * (matching the paper form's separate "Add: Special Assignment" row); every
   * other type (Designation/Extension/Research-Extension) rolls up into the
   * combined "Designation" row. Both are real capacity deductions from
   * instructor_load_deductions — NOT the unrelated Praise Load records,
   * which stay in their own "praise" document and never reduce Regular Load
   * capacity here. */
  const specialAssignmentDeds = isP ? wDeds.filter(d => d.deduction_type === 'Special Assignment') : [];
  const designationDeds = isP ? wDeds.filter(d => d.deduction_type !== 'Special Assignment') : [];
  const designationUnitsTotal = designationDeds.reduce((s, d) => s + Number(d.deducted_units), 0);
  const specialAssignmentUnitsTotal = specialAssignmentDeds.reduce((s, d) => s + Number(d.deducted_units), 0);
  // Total No. of Units = actual teaching + Designation credit + Special
  // Assignment credit — every visible row above added together, so the
  // printed total always matches what's actually shown on the form. It is
  // units for everyone; the hours total goes under Hours beside it.
  const netTotal = totalRegularWU + designationUnitsTotal + specialAssignmentUnitsTotal;
  // No. of Preparation: the same subject (code + title) taught to several blocks counts once
  const distinctSubjects = mergeSameSubjects(loads).length;

  const row = (bold: boolean, cells: WorkloadFormCell[]): WorkloadFormSummaryRow => ({ bold, cells });

  /* Label spans TIME/DAY + Subject Code (colspan 2) so print matches the on-screen form width.
     Remaining cells keep Description / Course / Students / Units / Hours / Room alignment.
     Totals are written with two decimals (28.25, 32.00), as on the official form. */
  const noOfUnitsRow = row(true, [
    { text: 'No. of Units', labelPad: true, colspan: 2 },
    {}, {}, {},
    { text: totalRegularWU.toFixed(2), center: true },
    { text: totalRegularHours.toFixed(2), center: true },
    {},
  ]);

  const specialRows: WorkloadFormSummaryRow[] = specialAssignmentDeds.length > 0
    ? specialAssignmentDeds.map(d => {
        const pu = Number(d.deducted_units) || 0;
        const puStr = pu % 1 === 0 ? pu.toFixed(0) : pu.toFixed(2);
        return row(false, [
          { text: 'Add: Special Assignment', labelPad: true, colspan: 2 },
          { text: d.description || 'Special Assignment', center: true },
          {}, {},
          { text: puStr, center: true, bold: true },
          {}, {},
        ]);
      })
    : [row(false, [
        { text: 'Add: Special Assignment', labelPad: true, colspan: 2 },
        {}, {}, {}, {}, {}, {},
      ])];

  const noOfPrepRow = row(false, [
    { text: 'No. of Preparation', labelPad: true, colspan: 2 },
    { text: String(distinctSubjects), center: true },
    {}, {}, {}, {}, {},
  ]);

  const totalUnitsRow = row(true, [
    { text: 'Total No. of Units', labelPad: true, colspan: 2 },
    { text: documentKind === 'deload' ? 'Actual Load' : 'Regular Load', center: true },
    {}, {},
    { text: netTotal.toFixed(2), center: true },
    { text: totalRegularHours.toFixed(2), center: true },
    {},
  ]);

  const praiseUnitsTotal = praiseSubjectWU + praiseArr.reduce(
    (s, p) => s + (parseFloat(String(p.equivalent_units)) || 0),
    0,
  );

  /* Deloading lines — one per deduction, labelled with its type (Regular form) */
  const designationRows = designationFooterLines(designationDeds).map(l => row(false, [
    { text: l.label, labelPad: true, colspan: 2 },
    { text: l.description, center: true },
    {}, {},
    l.units > 0 ? { text: l.units % 1 === 0 ? l.units.toFixed(0) : l.units.toFixed(2), center: true, bold: true } : {},
    {}, {},
  ]));

  let summary: WorkloadFormSummaryRow[];
  let totals: NonNullable<WorkloadFormModel['totals']>;
  if (documentKind === 'regular' || documentKind === 'deload') {
    totals = { teachingUnits: totalRegularWU, units: netTotal, hours: totalRegularHours };
    /* Keep Regular summary identical to the approved official form (Actual Load reuses it). */
    summary = [noOfUnitsRow, ...designationRows, ...specialRows, noOfPrepRow, totalUnitsRow];
  } else if (documentKind === 'praise') {
    /* Praise: the official form's lines — teaching units, each Research/Extension
       record, each other record as Special Assignment, preparations, total. */
    const fmtN = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(2));
    const recordRow = (label: string, p?: PrintPraise) => row(false, [
      { text: label, labelPad: true, colspan: 2 },
      p ? { text: p.description || p.praise_type || '', center: true } : {},
      {}, {},
      p ? { text: fmtN(parseFloat(String(p.equivalent_units)) || 0), center: true, bold: true } : {},
      {}, {},
    ]);
    totals = { teachingUnits: praiseSubjectWU, units: praiseUnitsTotal, hours: praiseSubjectHours };
    const research = praiseArr.filter(p => isResearchExtensionType(p.praise_type));
    const special = praiseArr.filter(p => !isResearchExtensionType(p.praise_type));
    const hasTeaching = praiseSubjectWU > 0.001;
    summary = [
      row(true, [
        { text: 'No. of Units', labelPad: true, colspan: 2 },
        {}, {}, {},
        hasTeaching ? { text: praiseSubjectWU.toFixed(2), center: true } : {},
        hasTeaching ? { text: praiseSubjectHours.toFixed(2), center: true } : {},
        {},
      ]),
      ...(research.length > 0 ? research.map(p => recordRow('Add: Research/Extension', p)) : [recordRow('Add: Research/Extension')]),
      ...(special.length > 0 ? special.map(p => recordRow('Add: Special Assignment', p)) : [recordRow('Add: Special Assignment')]),
      row(false, [
        { text: 'No. of Preparation', labelPad: true, colspan: 2 },
        hasTeaching && distinctSubjects > 0 ? { text: String(distinctSubjects), center: true } : {},
        {}, {}, {}, {}, {},
      ]),
      row(true, [
        { text: 'Total No. of Units', labelPad: true, colspan: 2 },
        { text: 'Praise Load', center: true },
        {}, {},
        { text: praiseUnitsTotal.toFixed(2), center: true },
        hasTeaching ? { text: praiseSubjectHours.toFixed(2), center: true } : {},
        {},
      ]),
    ];
  } else {
    /* Overload: same row skeleton as Regular; only values + load label differ. */
    const loadLabel = 'Overload';
    const unitsVal = totalRegularWU;
    const hoursVal = totalRegularHours;
    const prepCount = distinctSubjects;
    totals = { teachingUnits: unitsVal, units: unitsVal, hours: hoursVal };
    summary = [
      row(true, [
        { text: 'No. of Units', labelPad: true, colspan: 2 },
        {}, {}, {},
        { text: unitsVal.toFixed(2), center: true },
        { text: hoursVal.toFixed(2), center: true },
        {},
      ]),
      // Same row format as the Regular form — Designation / Special Assignment left blank
      row(false, [
        { text: 'Designation', labelPad: true, colspan: 2 },
        {}, {}, {}, {}, {}, {},
      ]),
      row(false, [
        { text: 'Add: Special Assignment', labelPad: true, colspan: 2 },
        {}, {}, {}, {}, {}, {},
      ]),
      row(false, [
        { text: 'No. of Preparation', labelPad: true, colspan: 2 },
        { text: String(prepCount), center: true },
        {}, {}, {}, {}, {},
      ]),
      row(true, [
        { text: 'Total No. of Units', labelPad: true, colspan: 2 },
        { text: loadLabel, center: true },
        {}, {},
        { text: unitsVal.toFixed(2), center: true },
        { text: hoursVal.toFixed(2), center: true },
        {},
      ]),
    ];
  }

  return {
    title: documentKind === 'praise' ? 'FACULTY WORKLOAD — PRAISE LOAD'
      : documentKind === 'deload' ? 'FACULTY WORKLOAD — ACTUAL LOAD'
      : 'FACULTY WORKLOAD',
    department: NEMSU_OFFICIAL_DEPT,
    semesterHeading: semesterHeading(semester),
    academicYear: formatAy(academicYear),
    faculty: {
      name: fac.name,
      yearsInService: fac.years_in_service != null ? String(fac.years_in_service) : '',
      status: fac.employment_status,
      qualification: fac.educational_qualification ?? '',
      major: fac.major ?? '',
      eligibility: fac.eligibility ?? '',
      position: fac.position ?? '',
    },
    sections,
    summary,
    signatures: {
      preparedBy: { name: 'NELYNE LOURDES Y. PLAZA, Ph.D.', title: 'Chair, Dept. Computer Studies' },
      conformed: { name: fac.name.toUpperCase(), title: fac.position ?? '' },
      certifiedCorrect: { name: 'RAMONA LIZA A. ESPENIDO, MST-SS', title: 'Registrar III' },
      recommending: [
        { name: 'JUANCHO A. INTANO, Ph.D.', title: 'Campus Director' },
        { name: 'BORN CHRISTIAN A. ISIP, DTE', title: 'Dean, CITE' },
      ],
      approved: { name: 'MARIA LADY SOL A. SUAZO, Ph.D.', title: 'VP - Academic Affairs' },
    },
    footer: {
      address: DEFAULT_FOOTER_CONFIG.address,
      phone: DEFAULT_FOOTER_CONFIG.phone,
      website: DEFAULT_FOOTER_CONFIG.website,
    },
    totals,
  };
}

/** Build the official Regular Load HTML document (Admin + Instructor shared). */
export function buildRegularLoadPrintHtml(input: BuildRegularLoadPrintInput): string {
  const m = buildWorkloadFormModel(input);
  const origin = input.logoOrigin
    ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const fac = m.faculty;
  const sg = m.signatures;

  /** TIME/DAY cell HTML — controlled wrap after en-dash so AM/PM never clips mid-token. */
  function timeTdHtml(label: string, extraStyle = ''): string {
    const styleAttr = extraStyle ? ` style="${extraStyle}"` : '';
    const mm = label.match(/^(.+?)([–-])\s*(.+)$/);
    if (!mm) {
      return `<td class="t-time"${styleAttr}><span class="t-time-a">${escHtml(label)}</span></td>`;
    }
    return `<td class="t-time"${styleAttr}><span class="t-time-a">${escHtml(mm[1] + mm[2])}</span><wbr><span class="t-time-b">${escHtml(mm[3])}</span></td>`;
  }

  function rowHtml(r: WorkloadFormRow): string {
    if (r.kind === 'blank') {
      return `<tr style="height:20px">${timeTdHtml(r.time, 'color:#bbb;font-size:7pt')}<td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`;
    }
    if (r.kind === 'praise') {
      return `<tr>
            <td class="t-time"></td>
            <td class="t-code">${escHtml(r.code)}</td>
            <td class="t-desc">${escHtml(r.description)}</td>
            <td class="t-course"></td>
            <td class="t-stu"></td>
            <td class="t-units">${r.units}</td>
            <td class="t-hours">${r.hours}</td>
            <td class="t-room"></td>
          </tr>`;
    }
    return `<tr>
      ${timeTdHtml(r.time)}
      <td class="t-code">${escHtml(r.code)}</td>
      <td class="t-desc"${r.boldDescription ? ' style="font-weight:bold"' : ''}>${escHtml(r.description)}</td>
      <td class="t-course">${escHtml(r.course)}</td>
      <td class="t-stu">${r.students}</td>
      <td class="t-units">${r.units}</td>
      <td class="t-hours">${r.hours}</td>
      <td class="t-room">${escHtml(r.room)}</td>
    </tr>`;
  }

  function summaryRowHtml(r: WorkloadFormSummaryRow): string {
    const tds = r.cells.map(c => {
      const st: string[] = [];
      if (c.center) st.push('text-align:center');
      if (c.bold) st.push('font-weight:bold');
      if (c.labelPad) st.push('padding-left:4px');
      const span = c.colspan && c.colspan > 1 ? ` colspan="${c.colspan}"` : '';
      return `<td${span}${st.length ? ` style="${st.join(';')}"` : ''}>${escHtml(c.text ?? '')}</td>`;
    }).join('');
    return `<tr style="font-size:8pt${r.bold ? ';font-weight:bold' : ''}">${tds}</tr>`;
  }

  const tableHtml = m.sections
    .map(sec => `<tr class="sec-hdr"><td colspan="8">${sec.label}</td></tr>` + sec.rows.map(rowHtml).join(''))
    .join('');
  const summaryHtml = m.summary.map(summaryRowHtml).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Faculty Workload — ${escHtml(fac.name)}</title>
<style>
${officialPrintDocumentCss()}
</style>
</head>
<body>
<div class="page">

${officialPrintPagedHtml(officialPrintHeaderHtml({
  logoSrc: `${origin}/nemlogo/NEMSU-logo.png`,
  department: m.department,
  title: m.title,
  semesterHeading: m.semesterHeading,
  academicYear: input.academicYear,
}), `
<div class="info">
  <div class="info-left">
    <div class="hf"><span class="i-lbl">Name:</span><span class="i-val"><strong>${escHtml(fac.name)}</strong></span></div>
    <div class="hf"><span class="i-lbl">Years in Service:</span><span class="i-val">${fac.yearsInService}</span></div>
    <div class="hf"><span class="i-lbl">Status:</span><span class="i-val"><strong>${escHtml(fac.status)}</strong></span></div>
  </div>
  <div class="info-right">
    <div class="hf"><span class="i-lbl">Educt&#39;l Qualification:</span><span class="i-val">${escHtml(fac.qualification)}</span></div>
    <div class="hf"><span class="i-lbl">Major:</span><span class="i-val">${escHtml(fac.major)}</span></div>
    <div class="hf"><span class="i-lbl">Eligibility/PRC:</span><span class="i-val">${escHtml(fac.eligibility)}</span></div>
  </div>
</div>

<table class="wl">
  <colgroup>
    <col class="t-time"><col class="t-code"><col class="t-desc">
    <col class="t-course"><col class="t-stu"><col class="t-units">
    <col class="t-hours"><col class="t-room">
  </colgroup>
  <thead>
    <tr>
      <th>TIME/DAY</th><th>Subject Code</th><th>Description</th><th>Course</th>
      <th>No. of<br>Students</th><th>Units</th><th>No. of<br>Hours</th><th>Room No.</th>
    </tr>
  </thead>
  <tbody>
    ${tableHtml}
    ${summaryHtml}
  </tbody>
</table>

<table class="sig">
  <tr>
    <td style="width:50%;padding-right:20px" class="lbl">Prepared by:</td>
    <td style="width:50%;padding-left:20px" class="blk lbl">
      <span class="cfm-wrap">
        <span class="cfm-ghost">${escHtml(sg.conformed.name)}</span>
        <span class="cfm-lbl">Conformed:</span>
      </span>
    </td>
  </tr>
  <tr class="sp"><td></td><td></td></tr>
  <tr>
    <td style="padding:0 20px 0 0" class="blk">
      <div class="nm">${escHtml(sg.preparedBy.name)}</div>
      <div class="tt">${escHtml(sg.preparedBy.title)}</div>
    </td>
    <td style="padding:0 0 0 20px" class="blk">
      <div class="nm">${escHtml(sg.conformed.name)}</div>
      <div class="tt">${escHtml(sg.conformed.title)}</div>
    </td>
  </tr>
  <tr><td colspan="2" class="lbl sec" style="text-align:center">Certified Correct:</td></tr>
  <tr class="sp"><td colspan="2"></td></tr>
  <tr>
    <td colspan="2" class="blk" style="padding:0 25%">
      <div class="nm">${escHtml(sg.certifiedCorrect.name)}</div>
      <div class="tt">${escHtml(sg.certifiedCorrect.title)}</div>
    </td>
  </tr>
  <tr><td colspan="2" class="lbl sec">Recommending Approval:</td></tr>
  <tr class="sp"><td colspan="2"></td></tr>
  <tr>
    <td style="padding:0 20px 0 0" class="blk">
      <div class="nm">${escHtml(sg.recommending[0].name)}</div>
      <div class="tt">${escHtml(sg.recommending[0].title)}</div>
    </td>
    <td style="padding:0 0 0 20px" class="blk">
      <div class="nm">${escHtml(sg.recommending[1].name)}</div>
      <div class="tt">${escHtml(sg.recommending[1].title)}</div>
    </td>
  </tr>
  <tr><td colspan="2" class="lbl sec" style="text-align:center">Approved:</td></tr>
  <tr class="sp"><td colspan="2"></td></tr>
  <tr>
    <td colspan="2" class="blk" style="padding:0 25%">
      <div class="nm">${escHtml(sg.approved.name)}</div>
      <div class="tt">${escHtml(sg.approved.title)}</div>
    </td>
  </tr>
</table>
`)}
</div>

${footerHtml({
  address: m.footer.address,
  phone: m.footer.phone,
  website: m.footer.website,
  logoOrigin: origin,
})}

</body>
</html>`;
}

export type PrintDocumentResult = OpenPrintHtmlResult;

/**
 * Open the official Regular / Overload / Praise Load document and trigger print.
 *
 * Opens a blank window immediately (user-gesture safe), then writes the existing
 * official HTML. Falls back via iframe → dedicated printable route → HTML download.
 * Does not change the official template.
 */
export async function printRegularLoadDocument(
  input: BuildRegularLoadPrintInput & {
    /** Auth-gated page that reads session-stashed HTML, e.g. /workload/print */
    printablePath?: string;
  },
): Promise<PrintDocumentResult> {
  const documentKind = input.documentKind ?? 'regular';
  const printablePath = input.printablePath;
  const downloadFilename =
    documentKind === 'overload'
      ? 'faculty-workload-overload.html'
      : documentKind === 'praise'
        ? 'faculty-workload-praise-load.html'
        : documentKind === 'deload'
          ? 'faculty-workload-actual-load.html'
          : 'faculty-workload-regular-load.html';

  /* Open first — before HTML build — so mobile browsers still treat it as a gesture. */
  const preOpened = openBlankPrintWindow('width=860,height=1150');
  // Group rows by the semester's configured day combinations (cached per term)
  const dayCombinations = input.dayCombinations !== undefined
    ? input.dayCombinations
    : (await fetchDayCombinations(input.semester, input.academicYear)).combinations;
  const html = buildRegularLoadPrintHtml({ ...input, dayCombinations });
  const result = await openPrintHtmlDocument(html, {
    windowFeatures: 'width=860,height=1150',
    preOpenedWindow: preOpened,
    printablePath,
    downloadFilename,
    documentKind,
  });
  if (!result.ok) {
    console.error('[printRegularLoadDocument] Unable to launch print via popup, iframe, route, or download.');
  }
  return result;
}
