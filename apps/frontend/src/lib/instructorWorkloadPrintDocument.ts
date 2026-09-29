/**
 * Official NEMSU Faculty Workload — Regular Load print document.
 * Shared by Admin (Instructor Workload) and Instructor (My Workload).
 * Paper: long bond 8.5 × 13 in portrait — do not invent a second template.
 */

import type { WeekDay } from '@shared/dayCombination';
import { fetchDayCombinations } from '@/lib/dayCombinations';
import {
  buildOfficialGroups,
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

function splitLoad(load: PrintWorkloadLoad, isPermanent = false): SplitRow[] {
  const lec     = parseFloat(String(load.lecture_hours)) || 0;
  const lab     = parseFloat(String(load.laboratory_hours)) || 0;
  const storedU = parseFloat(String(load.units)) || 0;
  const storedH = parseFloat(String(load.hours)) || 0;
  const oc      = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
  const isSplit = isPermanent
    ? (parseFloat(String(load.split_overload_units)) || 0) > 0.001
    : (parseFloat(String(load.split_overload_hours)) || 0) > 0.001;

  function splitLabHours(stored: number): number {
    if (stored <= 0) return lab;
    const labPortion = Math.max(0, stored - lec);
    return isPermanent ? Math.round(labPortion / 0.75) : labPortion;
  }

  if (lec > 0 && lab > 0) {
    const lecSched = load.lec_scheduled !== false;
    const labSched = load.lab_scheduled !== false;
    const stored = isPermanent ? storedU : storedH;
    const labH = isSplit && oc !== 'lec' ? splitLabHours(stored) : lab;
    const rows: SplitRow[] = [];
    if (lecSched) {
      rows.push({
        key: `${load.id}-lec`, load, type: 'lec', hours: lec, wu: lec,
        description: `${load.subject_name} (Lec)`, room_name: load.lec_room_name,
      });
    }
    if (labSched) {
      rows.push({
        key: `${load.id}-lab`, load, type: 'lab', hours: labH, wu: labH * 0.75,
        description: `${load.subject_name} (Lab)`, room_name: load.lab_room_name,
      });
    }
    if (rows.length > 0) return rows;
    return [
      {
        key: `${load.id}-lec`, load, type: 'lec', hours: lec, wu: lec,
        description: `${load.subject_name} (Lec)`, room_name: load.lec_room_name,
      },
      {
        key: `${load.id}-lab`, load, type: 'lab', hours: labH, wu: labH * 0.75,
        description: `${load.subject_name} (Lab)`, room_name: load.lab_room_name,
      },
    ];
  }

  const isLab = lab > 0 && lec === 0;
  const stored = isPermanent ? storedU : storedH;
  const labH = isLab && isSplit && stored > 0
    ? (isPermanent ? Math.round(stored / 0.75) : stored)
    : lab;
  return [{
    key: `${load.id}`,
    load,
    type: lec > 0 ? 'lec' : 'lab',
    hours: lec > 0 ? lec : labH,
    wu: calcWorkloadUnits(lec, isLab ? labH : lab),
    description: lec > 0 ? `${load.subject_name} (Lec)` : `${load.subject_name} (Lab)`,
    room_name: isLab ? (load.lab_room_name ?? load.room_name) : (load.lec_room_name ?? load.room_name),
  }];
}

function computeRegularRowValues(
  load: PrintWorkloadLoad,
  row: SplitRow,
  isP: boolean
): { displayWU: number; displayHours: number } {
  const splitOvU = parseFloat(String(load.split_overload_units)) || 0;
  const splitOvH = parseFloat(String(load.split_overload_hours)) || 0;
  const isSplitLoad = isP ? splitOvU > 0.001 : splitOvH > 0.001;
  const oc = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
  const lec2 = parseFloat(String(load.lecture_hours)) || 0;
  const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
  const hasBoth2 = lec2 > 0 && lab2 > 0;
  const isCompSplit = isSplitLoad && hasBoth2 && oc !== 'full';
  const totalStored = isP ? parseFloat(String(load.units)) || 0 : parseFloat(String(load.hours)) || 0;
  const otherCompVal = isCompSplit ? (oc === 'lab' ? lec2 : (isP ? lab2 * 0.75 : lab2)) : 0;
  const splitCompReg = isCompSplit ? Math.max(0, totalStored - otherCompVal) : 0;
  const totalCurrH = lec2 + lab2;
  let displayWU: number;
  let displayHours: number;
  if (!isSplitLoad) {
    displayWU = row.wu;
    displayHours = row.hours;
  } else if (isCompSplit) {
    if (row.type === oc) {
      displayWU = splitCompReg;
      displayHours = !isP ? splitCompReg : row.type === 'lab' ? Math.round(splitCompReg / 0.75) : splitCompReg;
    } else {
      displayWU = row.wu;
      displayHours = row.hours;
    }
  } else {
    displayWU = totalStored;
    displayHours = !isP
      ? totalStored
      : (totalStored + splitOvU > 0.001
        ? parseFloat(((totalStored / (totalStored + splitOvU)) * totalCurrH).toFixed(2))
        : totalCurrH);
  }
  return { displayWU, displayHours };
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
  documentKind?: 'regular' | 'overload' | 'praise';
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
  const groups = buildOfficialGroups(input.dayCombinations);

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
    const regularLoads = loads.filter(l => l.load_category !== 'Overload');
    for (const load of regularLoads) {
      for (const row of splitLoad(load, isP)) {
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
      for (const row of splitLoad(load, isP)) {
        const startTime = row.type === 'lec'
          ? (load.lec_start_time ?? load.start_time)
          : (load.lab_start_time ?? load.start_time);
        const endTime = row.type === 'lec'
          ? (load.lec_end_time ?? load.end_time)
          : (load.lab_end_time ?? load.end_time);
        const dayPat = row.type === 'lec'
          ? (load.lec_day_pattern ?? load.day_pattern)
          : (load.lab_day_pattern ?? load.day_pattern);
        const lec = parseFloat(String(load.lecture_hours)) || 0;
        const lab = parseFloat(String(load.laboratory_hours)) || 0;
        const hasBoth = lec > 0 && lab > 0;
        const isSplit = isP
          ? (parseFloat(String(load.split_overload_units)) || 0) > 0.001
          : (parseFloat(String(load.split_overload_hours)) || 0) > 0.001;
        const oc = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
        if (isSplit && hasBoth && oc !== 'full' && row.type !== oc) continue;
        let wu = hasBoth
          ? (row.type === 'lec' ? lec : lab * 0.75)
          : (isP ? parseFloat(String(load.units)) || 0 : parseFloat(String(load.hours)) || 0);
        let hrs = row.hours;
        if (isSplit) {
          wu = isP
            ? (parseFloat(String(load.split_overload_units)) || 0)
            : (parseFloat(String(load.split_overload_hours)) || 0);
          hrs = isP ? (oc === 'lab' ? Math.max(0, Math.round(wu / 0.75)) : wu) : wu;
        }
        if (isP ? wu < 0.001 : hrs < 0.001) continue;
        totalRegularWU += isP ? wu : 0;
        totalRegularHours += hrs;
        if (!isP) totalRegularWU += hrs;
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
  } else if (documentKind === 'praise') {
    /* Praise subjects in their schedule slots: whole subjects, or only the
       Lec/Lab portion when just one component was moved to Praise. */
    for (const load of loads) {
      const lec = parseFloat(String(load.lecture_hours)) || 0;
      const lab = parseFloat(String(load.laboratory_hours)) || 0;
      const hasBoth = lec > 0 && lab > 0;
      const oc = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
      const isPart = load.load_category !== 'Praise' && Boolean(load.split_is_praise);
      const partVal = isP
        ? (parseFloat(String(load.split_overload_units)) || 0)
        : (parseFloat(String(load.split_overload_hours)) || 0);
      for (const row of splitLoad(load, isP)) {
        if (isPart && hasBoth && oc !== 'full' && row.type !== oc) continue;
        let wu: number;
        let hrs: number;
        if (isPart) {
          wu = partVal;
          hrs = !isP ? partVal : (row.type === 'lab' ? lab : lec);
        } else {
          wu = hasBoth ? (row.type === 'lec' ? lec : lab * 0.75) : calcWorkloadUnits(lec, lab);
          hrs = hasBoth ? (row.type === 'lec' ? lec : lab) : lec + lab;
        }
        if (isP ? wu < 0.001 : hrs < 0.001) continue;
        praiseSubjectWU += isP ? wu : hrs;
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
    const wu = isP ? (displayWU % 1 === 0 ? displayWU.toFixed(0) : displayWU.toFixed(2)) : '';
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
    const other: WorkloadFormRow[] = unmatchedPrint.map(loadRow);
    if (praiseArr.length === 0 && unmatchedPrint.length === 0) {
      other.push({ kind: 'blank', time: '' });
    } else {
      for (const p of praiseArr) {
        const units = parseFloat(String(p.equivalent_units)) || 0;
        const hours = parseFloat(String(p.equivalent_hours ?? '')) || 0;
        other.push({
          kind: 'praise',
          code: p.praise_type || '',
          description: p.description || '',
          units: units % 1 === 0 ? units.toFixed(0) : units.toFixed(2),
          hours: hours > 0.001 ? (hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(2)) : '',
        });
      }
    }
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
  // printed total always matches what's actually shown on the form.
  const netTotal = isP
    ? totalRegularWU + designationUnitsTotal + specialAssignmentUnitsTotal
    : totalRegularHours;
  // No. of Preparation: the same subject (code + title) taught to several blocks counts once
  const distinctSubjects = mergeSameSubjects(loads).length;

  const row = (bold: boolean, cells: WorkloadFormCell[]): WorkloadFormSummaryRow => ({ bold, cells });

  const designationText = designationDeds.length > 0
    ? designationDeds.map(d => d.deduction_type).join(' + ')
    : 'No Designation';
  const designationUnitsStr = designationUnitsTotal > 0
    ? (designationUnitsTotal % 1 === 0 ? designationUnitsTotal.toFixed(0) : designationUnitsTotal.toFixed(2))
    : '';

  /* Label spans TIME/DAY + Subject Code (colspan 2) so print matches the on-screen form width.
     Remaining cells keep Description / Course / Students / Units / Hours / Room alignment. */
  const noOfUnitsRow = row(true, [
    { text: 'No. of Units', labelPad: true, colspan: 2 },
    {}, {}, {},
    { text: totalRegularWU.toFixed(2), center: true },
    { text: String(Math.round(totalRegularHours)), center: true },
    {},
  ]);

  const designationRow = row(false, [
    { text: 'Designation', labelPad: true, colspan: 2 },
    { text: designationText, center: true },
    {}, {},
    { text: designationUnitsStr, center: true, bold: true },
    {}, {},
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
    { text: 'Regular Load', center: true },
    {}, {},
    { text: netTotal.toFixed(2), center: true },
    {}, {},
  ]);

  const praiseUnitsTotal = praiseSubjectWU + praiseArr.reduce(
    (s, p) => s + (parseFloat(String(p.equivalent_units)) || 0),
    0,
  );
  const praiseHoursTotal = praiseSubjectHours + praiseArr.reduce(
    (s, p) => s + (parseFloat(String(p.equivalent_hours ?? '')) || 0),
    0,
  );

  let summary: WorkloadFormSummaryRow[];
  if (documentKind === 'regular') {
    /* Keep Regular summary identical to the approved official form. */
    summary = [noOfUnitsRow, designationRow, ...specialRows, noOfPrepRow, totalUnitsRow];
  } else {
    /* Overload / Praise: same row skeleton as Regular; only values + load label differ. */
    const loadLabel = documentKind === 'overload' ? 'Overload' : 'Praise Load';
    const unitsVal = documentKind === 'overload'
      ? (isP ? totalRegularWU : totalRegularHours)
      : praiseUnitsTotal;
    const hoursVal = documentKind === 'overload' ? totalRegularHours : praiseHoursTotal;
    const prepCount = documentKind === 'praise' ? 0 : distinctSubjects;
    summary = [
      row(true, [
        { text: 'No. of Units', labelPad: true, colspan: 2 },
        {}, {}, {},
        { text: unitsVal.toFixed(2), center: true },
        { text: String(Math.round(hoursVal)), center: true },
        {},
      ]),
      designationRow,
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
        {}, {},
      ]),
    ];
  }

  return {
    title: documentKind === 'overload' ? 'FACULTY WORKLOAD — OVERLOAD'
      : documentKind === 'praise' ? 'FACULTY WORKLOAD — PRAISE LOAD'
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
      position: fac.position,
    },
    sections,
    summary,
    signatures: {
      preparedBy: { name: 'NELYNE LOURDES Y. PLAZA, Ph.D.', title: 'Chair, Dept. Computer Studies' },
      conformed: { name: fac.name.toUpperCase(), title: fac.position },
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

${officialPrintHeaderHtml({
  logoSrc: `${origin}/nemlogo/NEMSU-logo.png`,
  department: m.department,
  title: m.title,
  semesterHeading: m.semesterHeading,
  academicYear: input.academicYear,
})}

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
