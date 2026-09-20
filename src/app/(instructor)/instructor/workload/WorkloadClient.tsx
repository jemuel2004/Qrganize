'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useVisibilityAwareInterval } from '@/client/hooks/useVisibilityAwareInterval';
import {
  AlertTriangle, Printer, ChevronDown, RefreshCw,
} from 'lucide-react';
import OfficialWorkloadFormTable, { type OfficialFormRow } from '@/client/components/OfficialWorkloadFormTable';
import { matchOfficialSlot, formatOfficialNumber, formatOfficialTimeRange, occupiedRangeFromScheduleTimes } from '@/lib/officialWorkloadSlots';
import { printRegularLoadDocument } from '@/lib/instructorWorkloadPrintDocument';
import { openWorkloadPrintableVersion } from '@/lib/openPrintHtmlDocument';
import { REGULAR_LOAD_MAX_UNITS } from '@/lib/regularLoad';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { CardSkeleton, PageBodySkeleton } from '@/client/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';

/** Smooth expand/collapse via CSS grid (0fr→1fr) — no fixed max-height, variable content safe. */
function WorkloadCollapsible({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <div
      aria-hidden={!open}
      style={{
        display: 'grid',
        gridTemplateRows: open ? '1fr' : '0fr',
        transition: 'grid-template-rows 260ms ease-in-out',
      }}
    >
      <div style={{ overflow: 'hidden', minHeight: 0 }}>
        <div
          style={{
            opacity: open ? 1 : 0,
            transform: open ? 'translateY(0)' : 'translateY(-4px)',
            transition: 'opacity 240ms ease-in-out, transform 240ms ease-in-out',
            pointerEvents: open ? 'auto' : 'none',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/* ─── Types (mirrored from admin WorkloadClient) ─────────────────────────── */
interface WorkloadLoad {
  id: number; load_category: string; units: number; hours: number;
  academic_year: string; semester: string;
  subject_code: string; subject_name: string;
  curriculum_units: number; curriculum_total_hours: number;
  lecture_hours: number; laboratory_hours: number;
  block_name: string; year_level: string;
  block_semester: string; block_academic_year: string;
  number_of_students: number;
  program_code: string; ms_id: number;
  schedule_status: string; room_name: string | null;
  lec_room_name: string | null; lab_room_name: string | null;
  day_pattern: string | null; start_time: string | null; end_time: string | null;
  split_overload_units?: number; split_overload_hours?: number;
  overload_component?: string;
  lec_scheduled?: boolean; lab_scheduled?: boolean;
  lec_start_time?: string | null; lec_end_time?: string | null;
  lab_start_time?: string | null; lab_end_time?: string | null;
  lec_day_pattern?: string | null; lab_day_pattern?: string | null;
}
interface WorkloadDeduction {
  id: number; deduction_type: string; description: string; deducted_units: number;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface PraiseRecord { id: number; praise_type: string; description: string; equivalent_units: number; equivalent_hours: number; semester: string; academic_year: string; remarks: string; [key: string]: any; }
interface FacultyInfo {
  id: number; name: string; first_name: string; last_name: string;
  position: string; employment_status: string; employee_id: string;
  designation_type?: string;
  years_in_service?: number | null;
  educational_qualification?: string | null;
  major?: string | null;
  eligibility?: string | null;
}
interface WorkloadSummary {
  faculty: FacultyInfo;
  loads: WorkloadLoad[];
  praise: PraiseRecord[];
  deductions: WorkloadDeduction[];
  summary: {
    regular_load_limit: number; remaining_regular_load: number;
    current_regular_load: number; total_regular_units: number;
    total_regular_hours: number; total_deduction_units: number;
    total_overload_units: number; total_overload_hours: number;
    total_praise_units?: number; total_praise_hours?: number;
    total_instructor_units: number; load_status: string;
  };
}
interface SplitRow {
  key: string; load: WorkloadLoad; type: 'lec' | 'lab';
  hours: number; wu: number; description: string; room_name: string | null;
}

/* ─── Helpers (exact copies from admin WorkloadClient) ──────────────────── */
function getDaySection(dayPattern: string | null, startTime: string | null): string {
  if (!dayPattern || !startTime) return 'unscheduled';
  const h  = parseInt(startTime.split(':')[0]);
  const isAM = h < 12;
  const dp = dayPattern.toLowerCase().trim();
  if (dp === 'm/w/f' || dp === 'mwf')               return isAM ? 'mwf-am' : 'mwf-pm';
  if (dp === 'mon/wed' || dp === 'mw' || dp === 'm/w') return isAM ? 'mw-am'  : 'mw-pm';
  if (dp === 'tue/thu' || dp === 'tth' || dp === 't/th') return isAM ? 'tth-am' : 'tth-pm';
  if (dp === 'fri' || dp === 'friday')                return isAM ? 'fri-am' : 'fri-pm';
  if (dp === 'sat' || dp === 'saturday')              return 'sat';
  return 'other';
}

function timeToMins(t: string | null | undefined): number {
  if (!t) return 9999;
  const parts = t.split(':');
  return (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
}
function extractYearNum(yearLevel: string): string {
  const m = yearLevel.match(/\d+/);
  return m ? m[0] : yearLevel;
}
function calcWorkloadUnits(lec: number, lab: number): number {
  return lec + lab * 0.75;
}

function computeRegularRowValues(
  load: WorkloadLoad, row: SplitRow, isP: boolean
): { displayWU: number; displayHours: number } {
  const splitOvU    = parseFloat(String(load.split_overload_units)) || 0;
  const splitOvH    = parseFloat(String(load.split_overload_hours)) || 0;
  const isSplitLoad = isP ? splitOvU > 0.001 : splitOvH > 0.001;
  const oc          = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
  const lec2        = parseFloat(String(load.lecture_hours))   || 0;
  const lab2        = parseFloat(String(load.laboratory_hours)) || 0;
  const hasBoth2    = lec2 > 0 && lab2 > 0;
  const isCompSplit = isSplitLoad && hasBoth2 && oc !== 'full';
  const totalStored = isP ? parseFloat(String(load.units)) || 0 : parseFloat(String(load.hours)) || 0;
  const otherCompVal = isCompSplit ? (oc === 'lab' ? lec2 : (isP ? lab2 * 0.75 : lab2)) : 0;
  const splitCompReg = isCompSplit ? Math.max(0, totalStored - otherCompVal) : 0;
  const totalCurrH  = lec2 + lab2;
  let displayWU: number;
  let displayHours: number;
  if (!isSplitLoad) {
    displayWU = row.wu; displayHours = row.hours;
  } else if (isCompSplit) {
    if (row.type === oc) {
      displayWU    = splitCompReg;
      displayHours = !isP ? splitCompReg : row.type === 'lab' ? Math.round(splitCompReg / 0.75) : splitCompReg;
    } else {
      displayWU = row.wu; displayHours = row.hours;
    }
  } else {
    displayWU    = totalStored;
    displayHours = !isP ? totalStored
      : (totalStored + splitOvU > 0.001
        ? parseFloat(((totalStored / (totalStored + splitOvU)) * totalCurrH).toFixed(2))
        : totalCurrH);
  }
  return { displayWU, displayHours };
}

function splitLoad(load: WorkloadLoad, isPermanent = false): SplitRow[] {
  const lec     = parseFloat(String(load.lecture_hours))   || 0;
  const lab     = parseFloat(String(load.laboratory_hours)) || 0;
  const storedU = parseFloat(String(load.units))  || 0;
  const storedH = parseFloat(String(load.hours))  || 0;
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
    const stored   = isPermanent ? storedU : storedH;
    const labH     = isSplit && oc !== 'lec' ? splitLabHours(stored) : lab;
    const rows: SplitRow[] = [];
    if (lecSched) rows.push({ key: `${load.id}-lec`, load, type: 'lec', hours: lec,  wu: lec,         description: `${load.subject_name} (Lec)`, room_name: load.lec_room_name });
    if (labSched) rows.push({ key: `${load.id}-lab`, load, type: 'lab', hours: labH, wu: labH * 0.75, description: `${load.subject_name} (Lab)`, room_name: load.lab_room_name });
    if (rows.length > 0) return rows;
    return [
      { key: `${load.id}-lec`, load, type: 'lec', hours: lec,  wu: lec,         description: `${load.subject_name} (Lec)`, room_name: load.lec_room_name },
      { key: `${load.id}-lab`, load, type: 'lab', hours: labH, wu: labH * 0.75, description: `${load.subject_name} (Lab)`, room_name: load.lab_room_name },
    ];
  }
  const isLab = lab > 0 && lec === 0;
  const stored = isPermanent ? storedU : storedH;
  const labH   = isLab && isSplit && stored > 0
    ? isPermanent ? Math.round(stored / 0.75) : stored
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

/* ─── Main Component ─────────────────────────────────────────────────────── */
export default function InstructorWorkloadClient() {
  const [semester,     setSemester]     = useState('');
  const [academicYear, setAcademicYear] = useState('');
  const [periodReady,  setPeriodReady]  = useState(false);
  const [noPeriod,     setNoPeriod]     = useState(false);
  const [data,         setData]         = useState<WorkloadSummary | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [activeTab,    setActiveTab]    = useState<'regular' | 'overload' | 'praise'>('regular');
  const [printError,   setPrintError]   = useState('');
  const [printOfferFallback, setPrintOfferFallback] = useState(false);
  /** Whether the currently selected workload table is visible. */
  const [tableVisible, setTableVisible] = useState(true);

  function selectTab(key: 'regular' | 'overload' | 'praise') {
    setActiveTab(key);
    setTableVisible(true);
  }

  const fetchWorkload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    setNoPeriod(false);
    try {
      const periodRes = await fetch('/api/settings/school-year');
      const period = periodRes.ok ? await periodRes.json() : null;
      const year = String(period?.schoolYear ?? '').trim();
      const sem = String(period?.semester ?? '').trim();
      if (!year || !sem) {
        setSemester('');
        setAcademicYear('');
        setPeriodReady(true);
        setNoPeriod(true);
        setData(null);
        return;
      }
      setSemester(sem);
      setAcademicYear(year);
      setPeriodReady(true);

      const res = await fetch('/api/instructor/workload');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        if (res.status === 409) {
          setNoPeriod(true);
          setData(null);
          return;
        }
        throw new Error(body.error || `Error ${res.status}`);
      }
      const json = await res.json();
      if (json.period?.semester) setSemester(json.period.semester);
      if (json.period?.schoolYear) setAcademicYear(json.period.schoolYear);
      setData(json);
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchWorkload(); }, [fetchWorkload]);

  useVisibilityAwareInterval(() => fetchWorkload(true), 30_000);

  /* ── Derived values (mirrors admin WorkloadClient modal logic) ─────────── */
  const workload = data;
  const isP = workload?.faculty?.employment_status === 'Permanent';
  const s   = workload?.summary;

  const regularPrintLoads  = workload?.loads.filter(l => l.load_category === 'Regular') ?? [];
  const overloadPrintLoads = workload?.loads.filter(l => l.load_category === 'Overload') ?? [];
  const praiseSubjectLoads = workload?.loads.filter(l => l.load_category === 'Praise') ?? [];
  const splitPrintLoads    = workload?.loads.filter(l =>
    l.load_category === 'Regular' && (
      isP
        ? (parseFloat(String(l.split_overload_units)) || 0) > 0.001
        : (parseFloat(String(l.split_overload_hours)) || 0) > 0.001
    )
  ) ?? [];

  const hasOverloadSection = overloadPrintLoads.length > 0 || splitPrintLoads.length > 0;
  const hasPraiseSection = (workload?.praise ?? []).length > 0 || praiseSubjectLoads.length > 0;
  const effectiveTab: 'regular' | 'overload' | 'praise' =
    (activeTab === 'overload' && !hasOverloadSection)
    || (activeTab === 'praise' && !hasPraiseSection)
      ? 'regular'
      : activeTab;

  useEffect(() => {
    if (activeTab !== effectiveTab) setActiveTab(effectiveTab);
  }, [activeTab, effectiveTab]);

  const totalDeductionUnits = isP ? (s?.total_deduction_units || 0) : 0;
  const olVal  = isP ? (s?.total_overload_units || 0) : (s?.total_overload_hours || 0);
  const praiseSubjectVal = isP ? (s?.total_praise_units || 0) : (s?.total_praise_hours || 0);
  const praiseTotal = praiseSubjectVal + (workload?.praise.reduce((sum, p) => sum + (parseFloat(String(p.equivalent_units)) || 0), 0) ?? 0);
  const distinctSubjects = new Set(workload?.loads.map(l => l.ms_id) ?? []).size;

  /* Regular Load WU/hours totals — computed after grouped is built below */
  let totalRegularWU           = 0;
  let totalRegularHoursDisplay = 0;

  /* Overload contact hours */
  const overloadContactHours = (() => {
    let total = 0;
    for (const l of overloadPrintLoads) {
      total += (parseFloat(String(l.lecture_hours)) || 0) + (parseFloat(String(l.laboratory_hours)) || 0);
    }
    for (const l of splitPrintLoads) {
      const lec = parseFloat(String(l.lecture_hours))   || 0;
      const lab = parseFloat(String(l.laboratory_hours)) || 0;
      const ovU = parseFloat(String(l.split_overload_units)) || 0;
      const ovH = parseFloat(String(l.split_overload_hours)) || 0;
      if (!isP) { total += ovH; continue; }
      const oc = (l.overload_component || 'full') as 'lec' | 'lab' | 'full';
      const hasBoth = lec > 0 && lab > 0;
      if (hasBoth && oc !== 'full') {
        if (oc === 'lab') {
          const regularWU = lab * 0.75 - ovU;
          total += Math.max(0, lab - Math.round(regularWU / 0.75));
        } else { total += ovU; }
      } else {
        const ru = parseFloat(String(l.units)) || 0;
        const tot = ru + ovU;
        total += tot > 0.001 ? parseFloat(((ovU / tot) * (lec + lab)).toFixed(2)) : 0;
      }
    }
    return total;
  })();

  /* Group regular loads by day section */
  type PrintRow = { load: WorkloadLoad; row: SplitRow };
  const grouped: Record<string, PrintRow[]> = {};
  for (const load of regularPrintLoads) {
    const oc        = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
    const splitOvU  = parseFloat(String(load.split_overload_units)) || 0;
    const isSplit   = isP ? splitOvU > 0.001 : (parseFloat(String(load.split_overload_hours)) || 0) > 0.001;
    const lec2 = parseFloat(String(load.lecture_hours)) || 0;
    const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
    const hasBoth2  = lec2 > 0 && lab2 > 0;
    const isCompSplit = isSplit && hasBoth2 && oc !== 'full';
    const totalStored = isP ? parseFloat(String(load.units)) || 0 : parseFloat(String(load.hours)) || 0;
    const otherCompVal = isCompSplit ? (oc === 'lab' ? lec2 : (isP ? lab2 * 0.75 : lab2)) : 0;
    const splitCompReg = isCompSplit ? Math.max(0, totalStored - otherCompVal) : 0;
    for (const row of splitLoad(load, isP)) {
      if (isCompSplit && row.type === oc && splitCompReg < 0.001) continue;
      const startTime = row.type === 'lec'
        ? (load.lec_start_time ?? load.start_time)
        : (load.lab_start_time ?? load.start_time);
      const sec = getDaySection(load.day_pattern, startTime);
      if (!grouped[sec]) grouped[sec] = [];
      grouped[sec].push({ load, row });
    }
  }
  for (const sec of Object.keys(grouped)) {
    grouped[sec].sort((a, b) => {
      const aT = a.row.type === 'lec' ? (a.load.lec_start_time ?? a.load.start_time) : (a.load.lab_start_time ?? a.load.start_time);
      const bT = b.row.type === 'lec' ? (b.load.lec_start_time ?? b.load.start_time) : (b.load.lab_start_time ?? b.load.start_time);
      return timeToMins(aT) - timeToMins(bT);
    });
  }

  /* Compute regular load totals from the same rows that will be rendered */
  for (const rows of Object.values(grouped)) {
    for (const { load, row } of rows) {
      const { displayWU, displayHours } = computeRegularRowValues(load, row, isP);
      totalRegularWU           += displayWU;
      totalRegularHoursDisplay += displayHours;
    }
  }

  const officialRegularRows: OfficialFormRow[] = [];
  for (const list of Object.values(grouped)) {
    for (const { load, row } of list) {
      const { displayWU, displayHours } = computeRegularRowValues(load, row, isP);
      const isSplitRow = (parseFloat(String(load.split_overload_units)) || 0) > 0.001 ||
        (parseFloat(String(load.split_overload_hours)) || 0) > 0.001;
      if (isSplitRow && (isP ? displayWU < 0.001 : displayHours < 0.001)) continue;
      const start = row.type === 'lec' ? (load.lec_start_time ?? load.start_time) : (load.lab_start_time ?? load.start_time);
      const end   = row.type === 'lec' ? (load.lec_end_time ?? load.end_time) : (load.lab_end_time ?? load.end_time);
      const day   = row.type === 'lec' ? (load.lec_day_pattern ?? load.day_pattern) : (load.lab_day_pattern ?? load.day_pattern);
      const yearNum = extractYearNum(load.year_level);
      const occupied = occupiedRangeFromScheduleTimes(start, end);
      officialRegularRows.push({
        key: row.key,
        slotId: matchOfficialSlot(day, start, end),
        timeLabel: formatOfficialTimeRange(start, end),
        rangeStartMin: occupied?.startMin,
        rangeEndMin: occupied?.endMin,
        subjectCode: load.subject_code,
        description: row.description,
        course: `${load.program_code} ${yearNum}${load.block_name}`,
        students: load.number_of_students > 0 ? String(load.number_of_students) : '',
        units: formatOfficialNumber(displayWU),
        hours: formatOfficialNumber(displayHours),
        room: row.room_name || '',
      });
    }
  }
  const designationText = (() => {
    const t = (workload?.faculty.designation_type || '').trim();
    if (!t || /^none$/i.test(t) || /^no designation$/i.test(t)) return 'No Designation';
    return t;
  })();
  const officialRegularSummary = {
    unitsText: formatOfficialNumber(totalRegularWU),
    hoursText: formatOfficialNumber(totalRegularHoursDisplay),
    designation: designationText,
    specialAssignments: (workload?.praise ?? []).map((p, i) => ({
      key: String(p.id ?? i),
      description: String(p.praise_type || p.description || ''),
      units: formatOfficialNumber(parseFloat(String(p.equivalent_units)) || 0),
    })),
    preparations: String(distinctSubjects),
    totalUnitsText: formatOfficialNumber(
      isP ? totalRegularWU + totalDeductionUnits + praiseTotal : totalRegularHoursDisplay + praiseTotal
    ),
  };

  /* Group overload loads by section (same placement as official Regular slots) */
  const overloadGrouped: Record<string, PrintRow[]> = {};
  for (const load of overloadPrintLoads) {
    for (const row of splitLoad(load, isP)) {
      const startTime = row.type === 'lec'
        ? (load.lec_start_time ?? load.start_time)
        : (load.lab_start_time ?? load.start_time);
      const sec = getDaySection(load.day_pattern, startTime);
      if (!overloadGrouped[sec]) overloadGrouped[sec] = [];
      overloadGrouped[sec].push({ load, row });
    }
  }

  const sortedSplitLoads = [...splitPrintLoads].sort((a, b) => {
    const ocA = (a.overload_component || 'full') as 'lec' | 'lab' | 'full';
    const ocB = (b.overload_component || 'full') as 'lec' | 'lab' | 'full';
    const aT  = ocA === 'lec' ? (a.lec_start_time ?? a.start_time) : ocA === 'lab' ? (a.lab_start_time ?? a.start_time) : a.start_time;
    const bT  = ocB === 'lec' ? (b.lec_start_time ?? b.start_time) : ocB === 'lab' ? (b.lab_start_time ?? b.start_time) : b.start_time;
    return timeToMins(aT) - timeToMins(bT);
  });

  const officialOverloadRows: OfficialFormRow[] = [];
  for (const list of Object.values(overloadGrouped)) {
    for (const { load, row } of list) {
      const lec2 = parseFloat(String(load.lecture_hours)) || 0;
      const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
      const hasBoth2 = lec2 > 0 && lab2 > 0;
      const olWU = hasBoth2
            ? (row.type === 'lec' ? lec2 : lab2 * 0.75)
            : (isP ? parseFloat(String(load.units)) || 0 : parseFloat(String(load.hours)) || 0);
      const start = row.type === 'lec' ? (load.lec_start_time ?? load.start_time) : (load.lab_start_time ?? load.start_time);
      const end   = row.type === 'lec' ? (load.lec_end_time ?? load.end_time) : (load.lab_end_time ?? load.end_time);
      const day   = row.type === 'lec' ? (load.lec_day_pattern ?? load.day_pattern) : (load.lab_day_pattern ?? load.day_pattern);
      const yearNum = extractYearNum(load.year_level);
      const occupied = occupiedRangeFromScheduleTimes(start, end);
      officialOverloadRows.push({
        key: `${row.key}-ol`,
        slotId: matchOfficialSlot(day, start, end),
        timeLabel: formatOfficialTimeRange(start, end),
        rangeStartMin: occupied?.startMin,
        rangeEndMin: occupied?.endMin,
        subjectCode: load.subject_code,
        description: row.description,
        course: `${load.program_code} ${yearNum}${load.block_name}`,
        students: load.number_of_students > 0 ? String(load.number_of_students) : '',
        units: formatOfficialNumber(olWU),
        hours: formatOfficialNumber(row.hours),
        room: row.room_name || '',
      });
    }
  }
        for (const load of sortedSplitLoads) {
    const allOlRows = splitLoad(load, isP);
    const ocOl = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
    const lecOl = parseFloat(String(load.lecture_hours)) || 0;
    const labOl = parseFloat(String(load.laboratory_hours)) || 0;
    const hasBothOl = lecOl > 0 && labOl > 0;
    const rows = (hasBothOl && ocOl !== 'full')
      ? allOlRows.filter(r => r.type === ocOl)
      : allOlRows;
    const ovU = parseFloat(String(load.split_overload_units)) || 0;
    const olV = isP ? ovU : parseFloat(String(load.split_overload_hours)) || 0;
    const totalCurrH = lecOl + labOl;
    const olHours = (() => {
      if (hasBothOl && ocOl !== 'full') {
        if (!isP) return parseFloat(String(load.split_overload_hours)) || 0;
        const compRow   = allOlRows.find(r => r.type === ocOl);
        const compHours = compRow ? compRow.hours : 0;
        const compWU    = compRow ? compRow.wu    : 0;
        if (ocOl === 'lab') {
          const regularWU    = compWU - ovU;
          const regularHours = Math.round(regularWU / 0.75);
          return Math.max(0, compHours - regularHours);
        }
        return ovU;
      }
      if (!isP) return parseFloat(String(load.split_overload_hours)) || 0;
      const ru = parseFloat(String(load.units)) || 0;
      const total = ru + ovU;
      return total > 0.001 ? parseFloat(((ovU / total) * totalCurrH).toFixed(2)) : 0;
    })();
    for (const row of rows) {
      const start = row.type === 'lec' ? (load.lec_start_time ?? load.start_time) : (load.lab_start_time ?? load.start_time);
      const end   = row.type === 'lec' ? (load.lec_end_time ?? load.end_time) : (load.lab_end_time ?? load.end_time);
      const day   = row.type === 'lec' ? (load.lec_day_pattern ?? load.day_pattern) : (load.lab_day_pattern ?? load.day_pattern);
      const yearNum = extractYearNum(load.year_level);
      const occupied = occupiedRangeFromScheduleTimes(start, end);
      officialOverloadRows.push({
        key: `${row.key}-split-ol`,
        slotId: matchOfficialSlot(day, start, end),
        timeLabel: formatOfficialTimeRange(start, end),
        rangeStartMin: occupied?.startMin,
        rangeEndMin: occupied?.endMin,
        subjectCode: load.subject_code,
        description: row.description,
        course: `${load.program_code} ${yearNum}${load.block_name}`,
        students: load.number_of_students > 0 ? String(load.number_of_students) : '',
        units: formatOfficialNumber(olV),
        hours: formatOfficialNumber(olHours),
        room: row.room_name || '',
      });
    }
  }

  const officialOverloadSummary = {
    unitsText: formatOfficialNumber(olVal),
    hoursText: formatOfficialNumber(overloadContactHours),
    designation: '',
    specialAssignments: [] as { key: string; description: string; units: string }[],
    preparations: '',
    totalUnitsText: formatOfficialNumber(olVal),
    totalDescription: 'Overload',
  };

  const praiseHoursSum = praiseSubjectLoads.reduce((sum, l) => {
    return sum + (parseFloat(String(l.lecture_hours)) || 0) + (parseFloat(String(l.laboratory_hours)) || 0);
  }, 0) + (workload?.praise ?? []).reduce(
    (sum, p) => sum + (parseFloat(String(p.equivalent_hours)) || 0),
    0,
  );
  const officialPraiseRows: OfficialFormRow[] = [
    ...praiseSubjectLoads.flatMap((load) =>
      splitLoad(load, isP).map((row) => {
        const lec2 = parseFloat(String(load.lecture_hours)) || 0;
        const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
        const hasBoth2 = lec2 > 0 && lab2 > 0;
        const wu = hasBoth2
          ? (row.type === 'lec' ? lec2 : lab2 * 0.75)
          : (isP ? parseFloat(String(load.units)) || 0 : parseFloat(String(load.hours)) || 0);
        const start = row.type === 'lec' ? (load.lec_start_time ?? load.start_time) : (load.lab_start_time ?? load.start_time);
        const end   = row.type === 'lec' ? (load.lec_end_time ?? load.end_time) : (load.lab_end_time ?? load.end_time);
        const day   = row.type === 'lec' ? (load.lec_day_pattern ?? load.day_pattern) : (load.lab_day_pattern ?? load.day_pattern);
        const yearNum = extractYearNum(load.year_level);
        const occupied = occupiedRangeFromScheduleTimes(start, end);
        return {
          key: `${row.key}-praise`,
          slotId: matchOfficialSlot(day, start, end),
          timeLabel: formatOfficialTimeRange(start, end),
          rangeStartMin: occupied?.startMin,
          rangeEndMin: occupied?.endMin,
          subjectCode: load.subject_code,
          description: `${row.description} · Source: Overload`,
          course: `${load.program_code} ${yearNum}${load.block_name}`,
          students: load.number_of_students > 0 ? String(load.number_of_students) : '',
          units: formatOfficialNumber(wu),
          hours: formatOfficialNumber(row.hours),
          room: row.room_name || '',
        };
      })
    ),
    ...(workload?.praise ?? []).map(p => ({
    key: `praise-${p.id}`,
    slotId: null,
    timeLabel: '',
    subjectCode: String(p.praise_type || ''),
    description: String(p.description || p.remarks || ''),
    course: '',
    students: '',
    units: formatOfficialNumber(parseFloat(String(p.equivalent_units)) || 0),
    hours: formatOfficialNumber(parseFloat(String(p.equivalent_hours)) || 0),
    room: p.description && p.remarks ? String(p.remarks) : '',
  })),
  ];
  const officialPraiseSummary = {
    unitsText: formatOfficialNumber(praiseTotal),
    hoursText: formatOfficialNumber(praiseHoursSum),
    designation: '',
    specialAssignments: [] as { key: string; description: string; units: string }[],
    preparations: '',
    totalUnitsText: formatOfficialNumber(praiseTotal),
    totalDescription: 'Praise Load',
  };

  /* ── Print (official NEMSU template — same for Regular / Overload / Praise) ── */
  async function handlePrint() {
    if (!workload) return;
    setPrintError('');
    setPrintOfferFallback(false);
    const kind = effectiveTab;
    const result = await printRegularLoadDocument({
      faculty: workload.faculty,
      loads: kind === 'overload'
        ? [...overloadPrintLoads, ...splitPrintLoads]
        : kind === 'praise'
          ? praiseSubjectLoads
          : (workload.loads ?? []),
      praise: kind === 'praise' ? (workload.praise ?? []) : (kind === 'regular' ? (workload.praise ?? []) : []),
      deductions: kind === 'regular' ? (workload.deductions ?? []) : [],
      semester,
      academicYear,
      documentKind: kind,
      printablePath: '/instructor/workload/print',
    });
    if (!result.ok) {
      setPrintError(
        'Printing is not supported directly in this browser. Open the printable version, or use Chrome / Safari.',
      );
      setPrintOfferFallback(true);
    } else if (result.offerPrintableFallback) {
      setPrintError(
        'If the print dialog did not open, use Open Printable Version below.',
      );
      setPrintOfferFallback(true);
    }
  }

  function handleOpenPrintableVersion() {
    const opened = openWorkloadPrintableVersion('/instructor/workload/print');
    if (!opened) {
      setPrintError(
        'Unable to open the printable version. Please open this page in Chrome or Safari and try again.',
      );
      setPrintOfferFallback(true);
    }
  }

  const showSkeleton = useMinLoading(loading && !data, LOADING_DELAY);

  /* ── Render ─────────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-full bg-[#F8FAFC] p-5 md:p-6 lg:p-8">
      {/* ── Page header ───────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-5">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[#1E3A5F]">My Workload</h1>
          <p className="text-[#64748B] text-sm mt-0.5">
            Read-only view of your teaching load and assignments
          </p>
        </div>
        {workload && (
          <button
            onClick={handlePrint}
            className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold text-white transition-colors flex-shrink-0 self-start"
            style={{ backgroundColor: '#3C91E6' }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#2E7DD1'; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#3C91E6'; }}
          >
            <Printer className="w-4 h-4" />
            Print {effectiveTab === 'regular' ? 'Regular Load' : effectiveTab === 'overload' ? 'Overload' : 'Praise Load'}
          </button>
        )}
      </div>
      {printError || printOfferFallback ? (
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" role="status">
          {printError ? (
            <p className="text-sm text-amber-700 leading-snug">{printError}</p>
          ) : null}
          {printOfferFallback ? (
            <button
              type="button"
              onClick={handleOpenPrintableVersion}
              className="inline-flex items-center justify-center gap-2 self-start sm:self-auto min-h-10 px-3 rounded-lg border border-amber-600/40 text-amber-800 text-xs font-semibold hover:bg-amber-50 transition"
            >
              Open Printable Version
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ── Active academic period (Admin-controlled, read-only) ──────── */}
      <div className="bg-white rounded-lg border border-[#E2E8F0] px-4 py-3 mb-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[#64748B] uppercase tracking-wide">
              Active academic period
            </p>
            <p className="text-sm font-semibold text-[#1E3A5F] mt-0.5">
              {semester && academicYear
                ? `${semester} — A.Y. ${academicYear}`
                : periodReady
                  ? 'No active academic period is currently configured.'
                  : 'Loading period…'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => fetchWorkload()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-[#64748B] hover:text-[#1E3A5F] hover:bg-[#F8FAFC] border border-[#E2E8F0] transition-colors disabled:opacity-50 self-start"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Loading ───────────────────────────────────────────────────── */}
      <PageLoadTransition
        showSkeleton={showSkeleton}
        skeleton={
          <div className="space-y-4">
            <PageBodySkeleton />
            <CardSkeleton className="min-h-[200px]" />
          </div>
        }
      >
      {/* ── Error ─────────────────────────────────────────────────────── */}
      {!showSkeleton && error && (
        <div className="bg-white border border-[#E2E8F0] rounded-lg px-4 py-6">
          <p className="text-sm font-semibold text-[#1E3A5F] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[#DC2626]" />
            Failed to load workload data
          </p>
          <p className="text-sm text-[#64748B] mt-1">{error}</p>
          <button
            type="button"
            onClick={() => fetchWorkload()}
            className="mt-3 px-3.5 py-2 bg-[#3C91E6] hover:bg-[#2E7DD1] text-white rounded-lg text-sm font-semibold transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {!showSkeleton && !error && noPeriod && (
        <div className="bg-white border border-[#E2E8F0] rounded-lg px-4 py-6">
          <p className="text-sm font-semibold text-[#1E3A5F]">No active academic period is currently configured.</p>
          <p className="text-sm text-[#64748B] mt-1">
            Workload will appear here once an administrator sets the active school year and semester.
          </p>
        </div>
      )}

      {/* ── Workload content ──────────────────────────────────────────── */}
      {!showSkeleton && !error && !noPeriod && workload && (() => {
        const modalRegVal  = isP ? totalRegularWU : totalRegularHoursDisplay;
        const modalTotal   = modalRegVal + olVal + praiseTotal;
        const modalExceeded = Math.max(0, modalRegVal - (s?.regular_load_limit || REGULAR_LOAD_MAX_UNITS));
        const modalIsExceeded = modalExceeded > 0.001;
        const overloadCount = overloadPrintLoads.length + splitPrintLoads.length;
        const praiseCount = (workload.praise ?? []).length + praiseSubjectLoads.length;

        return (
          <>
            {/* ── Summary cards (Faculty-page style) ─────────────────── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
              <div className="bg-white border border-[#E2E8F0] rounded-2xl p-4 sm:p-5 text-center shadow-sm">
                <div
                  className="text-2xl sm:text-3xl font-black mb-1.5 tabular-nums"
                  style={{ color: '#1E3A5F' }}
                >
                  {modalRegVal.toFixed(2)}
                  <span className="text-base sm:text-lg font-bold text-[#94A3B8]"> / {s?.regular_load_limit}</span>
                </div>
                <div className="text-sm font-medium" style={{ color: '#64748B' }}>
                  {isP ? 'Regular Load' : 'Regular Hours'}
                </div>
                <div className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                  {isP ? 'units' : 'hours'}
                </div>
              </div>

              <div className="bg-white border border-[#E2E8F0] rounded-2xl p-4 sm:p-5 text-center shadow-sm">
                <div
                  className="text-2xl sm:text-3xl font-black mb-1.5 tabular-nums"
                  style={{ color: '#1E3A5F' }}
                >
                  {olVal.toFixed(2)}
                </div>
                <div className="text-sm font-medium" style={{ color: '#64748B' }}>Overload</div>
                <div className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                  {isP ? 'units' : 'hours'}
                </div>
              </div>

              <div className="bg-white border border-[#E2E8F0] rounded-2xl p-4 sm:p-5 text-center shadow-sm">
                <div
                  className="text-2xl sm:text-3xl font-black mb-1.5 tabular-nums"
                  style={{ color: '#1E3A5F' }}
                >
                  {modalTotal.toFixed(2)}
                </div>
                <div className="text-sm font-medium" style={{ color: '#64748B' }}>
                  {isP ? 'Total Units' : 'Total Hours'}
                </div>
                <div className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                  {isP ? 'units' : 'hours'} · {distinctSubjects} subject{distinctSubjects !== 1 ? 's' : ''}
                </div>
              </div>

              <div className="bg-white border border-[#E2E8F0] rounded-2xl p-4 sm:p-5 text-center shadow-sm">
                <div
                  className="text-2xl sm:text-3xl font-black mb-1.5 tabular-nums"
                  style={{ color: modalIsExceeded ? '#DC2626' : '#1E3A5F' }}
                >
                  {modalExceeded.toFixed(2)}
                </div>
                <div className="text-sm font-medium" style={{ color: '#64748B' }}>
                  {modalIsExceeded ? 'Exceeded Load' : 'Within Limit'}
                </div>
                <div className="text-xs mt-0.5" style={{ color: '#94A3B8' }}>
                  {isP ? 'units' : 'hours'}
                </div>
              </div>
            </div>

            {/* ── Printable area ────────────────────────────────────── */}
            <div id="workload-print-area" className="space-y-3">
              <div className="print-header hidden">
                <h3 className="font-bold">INSTRUCTOR WORKLOAD FORM</h3>
                <div className="meta-row">
                  <div>
                    <strong>Name:</strong> {workload.faculty.name} &nbsp;|&nbsp;
                    <strong>Status:</strong> {workload.faculty.position} ({workload.faculty.employment_status})
                  </div>
                  <div>
                    <strong>Semester:</strong> {semester} &nbsp;|&nbsp;
                    <strong>A.Y.:</strong> {academicYear}
                  </div>
                </div>
              </div>

              {/* Tab navigation — Regular always; Overload/Praise only with data */}
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <button
                  type="button"
                  onClick={() => selectTab('regular')}
                  className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold border transition-colors ${
                    effectiveTab === 'regular'
                      ? 'bg-[#3C91E6] text-white border-[#3C91E6]'
                      : 'bg-white text-[#64748B] border-[#E2E8F0] hover:text-[#1E3A5F] hover:border-[#CBD5E1]'
                  }`}
                >
                  Regular Load
                  <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                    effectiveTab === 'regular' ? 'bg-white/20' : 'bg-[#F1F5F9] text-[#64748B]'
                  }`}>
                    {regularPrintLoads.length}
                  </span>
                </button>

                {hasOverloadSection && (
                  <button
                    type="button"
                    onClick={() => selectTab('overload')}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold border transition-colors ${
                      effectiveTab === 'overload'
                        ? 'bg-[#3C91E6] text-white border-[#3C91E6]'
                        : 'bg-white text-[#64748B] border-[#E2E8F0] hover:text-[#1E3A5F] hover:border-[#CBD5E1]'
                    }`}
                  >
                    Overload
                    <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                      effectiveTab === 'overload' ? 'bg-white/20' : 'bg-[#F1F5F9] text-[#64748B]'
                    }`}>
                      {overloadCount}
                    </span>
                  </button>
                )}

                {hasPraiseSection && (
                  <button
                    type="button"
                    onClick={() => selectTab('praise')}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold border transition-colors ${
                      effectiveTab === 'praise'
                        ? 'bg-[#3C91E6] text-white border-[#3C91E6]'
                        : 'bg-white text-[#64748B] border-[#E2E8F0] hover:text-[#1E3A5F] hover:border-[#CBD5E1]'
                    }`}
                  >
                    Praise Load
                    <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                      effectiveTab === 'praise' ? 'bg-white/20' : 'bg-[#F1F5F9] text-[#64748B]'
                    }`}>
                      {praiseCount}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  aria-expanded={tableVisible}
                  onClick={() => setTableVisible(v => !v)}
                  className="inline-flex items-center gap-1 ml-auto px-2.5 py-2 text-sm font-semibold text-[#3C91E6] hover:text-[#2E7DD1] transition-colors"
                >
                  <ChevronDown
                    className={`w-4 h-4 transition-transform duration-300 ease-in-out ${tableVisible ? 'rotate-180' : 'rotate-0'}`}
                  />
                  {tableVisible ? 'Hide' : 'Show'}
                </button>
              </div>

              <WorkloadCollapsible open={tableVisible}>
                <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                  {effectiveTab === 'regular' && (
                    regularPrintLoads.length === 0 ? (
                      <div className="px-4 py-8 text-center">
                        <p className="text-sm font-semibold text-[#1E3A5F]">No regular workload assigned</p>
                        <p className="text-sm text-[#64748B] mt-1">
                          No regular load subjects for the active academic period.
                        </p>
                      </div>
                    ) : (
                      <OfficialWorkloadFormTable
                        rows={officialRegularRows}
                        summary={officialRegularSummary}
                      />
                    )
                  )}
                  {effectiveTab === 'overload' && (
                    <OfficialWorkloadFormTable
                      rows={officialOverloadRows}
                      summary={officialOverloadSummary}
                      variant="overload"
                    />
                  )}
                  {effectiveTab === 'praise' && (
                    <OfficialWorkloadFormTable
                      rows={officialPraiseRows}
                      summary={officialPraiseSummary}
                      variant="praise"
                    />
                  )}
                </div>
              </WorkloadCollapsible>
            </div>
          </>
        );
      })()}
      </PageLoadTransition>
    </div>
  );
}
