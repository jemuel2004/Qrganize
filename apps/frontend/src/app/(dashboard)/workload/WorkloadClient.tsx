'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import { useToast } from '@/context/ToastContext';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { SearchInput, FilterBar } from '@/components/ui/SearchFilter';
import Modal from '@/components/ui/Modal';
import FriendlySelect from '@/components/ui/FriendlySelect';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import TrashDropAnimation from '@/components/ui/TrashDropAnimation';
import OfficialWorkloadFormTable, { type OfficialFormRow } from '@/components/OfficialWorkloadFormTable';
import {
  buildOfficialGroups,
  loadDayPatterns,
  matchOfficialSlot,
  formatOfficialNumber,
  formatOfficialTotal,
  formatOfficialTimeRange,
  occupiedRangeFromScheduleTimes,
} from '@/lib/officialWorkloadSlots';
import { useDayCombinations } from '@/lib/dayCombinations';
import { LOAD_INK, LOAD_TONE } from '@/lib/loadTone';
import {
  actualLoadLines, designationFooterLines, designationRowText, hoursToUnits, isResearchExtensionType,
  type PrintDocumentResult,
} from '@/lib/instructorWorkloadPrintDocument';
import WorkloadPrintMenu, { type WorkloadPrintData } from '@/components/WorkloadPrintMenu';
import { openWorkloadPrintableVersion } from '@/lib/openPrintHtmlDocument';
import { coerceSubjectCategory } from '@shared/subjectCategory';
import {
  LOAD_GRACE_UNITS, overloadUnitsCap, regularUnitsCap, canHaveOverloadOrPraise, contractualLimitError,
  formatLoadCap, shownUnitsCap, shownUnitsLeft, shownUnitsOver, isRegularLoadComplete,
} from '@shared/regularLoad';
import { useWorkloadPolicy } from '@/hooks/useWorkloadPolicy';
import { blockCurriculumVersion, curriculumVersionLabel } from '@shared/curriculumVersion';
import { ListSkeleton, Skeleton, TableSkeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { EmploymentBadge } from '@/components/ui/EmploymentBadge';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { positionRank } from '@/lib/positionRank';
import { isSameSubject, mergeSameSubjects } from '@shared/subjectCode';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import CountFilterTabs from '@/components/ui/CountFilterTabs';
import Pagination from '@/components/ui/Pagination';
import {
  Plus, X, AlertTriangle, Check, Minus,
  Eye, Award, CheckCircle2, Pencil,
  Trash2, ArrowUpCircle, ArrowDownCircle, ArrowRight, ArrowLeft, Ban,
} from 'lucide-react';

interface PrioritySubject { subject_code: string; subject_name: string; }
interface Faculty {
  id: number; name: string; employee_id: string; position: string; employment_status: string;
  designation_type: string; designation_units: number;
  program_id: number | null; program_code: string | null; program_name: string | null;
  years_in_service: number | null;
  educational_qualification: string | null;
  major: string | null;
  eligibility: string | null;
  specialization: string | null;
  /** Blocks this faculty is assigned to teach (Faculty → Blocks to Handle) */
  assigned_block_ids?: number[];
  priority_subjects?: PrioritySubject[];
}
interface FacultySummary {
  current_load: number;
  regular_load_limit: number;
  remaining_load: number;
  has_overload: boolean;
  total_deduction_units: number;
  total_overload_units: number;
  total_overload_hours: number;
  total_praise_units?: number;
  total_praise_hours?: number;
  total_instructor_units: number;
  /** Subjects assigned this term (Regular, Overload or Praise) */
  assigned_count?: number;
  employment_status?: string;
}
interface Block {
  id: number; block_name: string; year_level: string; semester: string;
  academic_year: string; program_id: number; program_code: string;
  subject_count?: number; unassigned_count?: number;
  assigned_count?: number; scheduled_count?: number;
  curriculum_version?: string;
  /** Subjects still unassigned in this block (requested via ?include=unassigned_subjects) */
  unassigned_subjects?: PrioritySubject[];
}

/** A block is complete only when it has subjects and none remain unassigned. 0/0 is not complete. */
function isBlockFullyAssigned(b: Block): boolean {
  return Number(b.subject_count) > 0 && Number(b.unassigned_count) === 0;
}

/** Open subjects in the block — only the faculty's Subjects to Handle when they have any. */
function blockAvailableCount(b: Block, handled: PrioritySubject[]): number {
  if (handled.length === 0 || !b.unassigned_subjects) return Number(b.unassigned_count) || 0;
  return b.unassigned_subjects.filter(s => handled.some(h => isSameSubject(h, s))).length;
}


interface Program { id: number; code: string; name: string; department?: string | null; }

/** Programs ordered by program code. */
function sortPrograms(allPrograms: Program[]): Program[] {
  return [...allPrograms].sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/** Active programs for the selected instructor, ordered by program code. */
function programsAllowedForInstructor(faculty: Faculty | null, allPrograms: Program[]): Program[] {
  if (!faculty) return [];
  return sortPrograms(allPrograms);
}
interface Schedule {
  id: number; subject_code: string; subject_name: string;
  total_hours: number; units: number;
  lecture_hours: number; laboratory_hours: number;
  block_name: string;
  year_level: string; semester: string; academic_year: string;
  program_code: string; status: string; faculty_name: string | null;
  subject_category?: 'Major' | 'Minor';
}
/** The Master Schedule row an admin clicked "Assign" on (same API row, plus its IDs). */
interface AssignTarget extends Schedule {
  program_id: number; block_id: number; faculty_id: number | null;
  block_semester: string; block_academic_year: string;
}
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
  subject_category?: 'Major' | 'Minor' | string;
  lec_room_name: string | null; lab_room_name: string | null;
  day_pattern: string | null; start_time: string | null; end_time: string | null;
  split_overload_units?: number; split_overload_hours?: number;
  /** The split-off Lec/Lab portion is Praise Load, not Overload. */
  split_is_praise?: boolean;
  overload_component?: string;
  lec_scheduled?: boolean; lab_scheduled?: boolean;
  lec_start_time?: string | null; lec_end_time?: string | null;
  lab_start_time?: string | null; lab_end_time?: string | null;
  lec_day_pattern?: string | null; lab_day_pattern?: string | null;
}
interface WorkloadDeduction {
  id: number;
  deduction_type: string;
  description: string;
  deducted_units: number;
}
interface WorkloadSummary {
  faculty: Faculty;
  loads: WorkloadLoad[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  praise: any[];
  deductions: WorkloadDeduction[];
  summary: {
    regular_load_limit: number; remaining_regular_load: number;
    current_regular_load: number; total_regular_units: number;
    total_regular_hours: number; total_deduction_units: number;
    total_overload_units: number; total_overload_hours: number;
    total_praise_units?: number; total_praise_hours?: number;
    total_instructor_units: number;     load_status: string;
  };
}

function subjectLoadValue(load: WorkloadLoad, permanent: boolean): number {
  const lec = parseFloat(String(load.lecture_hours)) || 0;
  const lab = parseFloat(String(load.laboratory_hours)) || 0;
  if (permanent) return lec + lab * 0.75;
  const hours = parseFloat(String(load.curriculum_total_hours)) || 0;
  return hours > 0 ? hours : lec + lab;
}

/** Units/hours currently classified as Overload for this assignment. */
function overloadReturnValue(load: WorkloadLoad, permanent: boolean): number {
  const stored = permanent
    ? (parseFloat(String(load.split_overload_units)) || 0)
    : (parseFloat(String(load.split_overload_hours)) || 0);
  if (stored > 0.001) return stored;
  if (load.load_category === 'Overload') return subjectLoadValue(load, permanent);
  return 0;
}

/* Carries the load + which component the admin is moving to overload */
interface MoveToOverloadContext {
  load: WorkloadLoad;
  /** 'lec' | 'lab' = component-specific; 'full' = entire subject */
  component: 'lec' | 'lab' | 'full';
}

/* Shown when instructor's regular load is full and admin clicks Assign */
interface OverloadConfirmData {
  msId: number;
  subjectCode: string;
  subjectName: string;
  subjectValue: number;
  unit: string;
  loadLimit: number;
  currentLoad: number;
  remaining: number;
}

const SEMESTERS = ['1st Semester', '2nd Semester', 'Summer'];
/** Faculty list rows per page (same as Setup → Faculty) */
const FACULTY_LIST_PAGE_SIZE = 10;

function calcWorkloadUnits(lec: number, lab: number): number {
  return lec + (lab * 0.75);
}

function getDaySection(dayPattern: string | null, startTime: string | null): string {
  if (!dayPattern || !startTime) return 'unscheduled';
  const h = parseInt(startTime.split(':')[0]);
  const isAM = h < 12;
  const dp = dayPattern.toLowerCase().trim();
  if (dp === 'm/w/f' || dp === 'mwf') return isAM ? 'mwf-am' : 'mwf-pm';
  if (dp === 'mon/wed' || dp === 'mw' || dp === 'm/w') return isAM ? 'mw-am' : 'mw-pm';
  if (dp === 'tue/thu' || dp === 'tth' || dp === 't/th') return isAM ? 'tth-am' : 'tth-pm';
  if (dp === 'fri' || dp === 'friday') return isAM ? 'fri-am' : 'fri-pm';
  if (dp === 'sat' || dp === 'saturday') return 'sat';
  return 'other';
}

function timeToMins(t: string | null | undefined): number {
  if (!t) return 9999;
  const parts = t.split(':');
  return (parseInt(parts[0]) || 0) * 60 + (parseInt(parts[1]) || 0);
}

interface SplitRow {
  key: string;
  load: WorkloadLoad;
  type: 'lec' | 'lab';
  hours: number;
  wu: number;
  description: string;
  room_name: string | null;
}

/** Sections of the Faculty Workload form — Actual Load is every subject of the term on one form */
type WorkloadModalTab = 'regular' | 'actual' | 'overload' | 'praise';

function splitLoad(load: WorkloadLoad, isPermanent = false): SplitRow[] {
  const lec     = parseFloat(String(load.lecture_hours))  || 0;
  const lab     = parseFloat(String(load.laboratory_hours)) || 0;
  const storedU = parseFloat(String(load.units))  || 0;
  const storedH = parseFloat(String(load.hours))  || 0;
  const oc      = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
  const isSplit = isPermanent
    ? (parseFloat(String(load.split_overload_units)) || 0) > 0.001
    : (parseFloat(String(load.split_overload_hours)) || 0) > 0.001;

  /* Derive split-adjusted lab display hours for a component.
     Only applies when the lab component was actually split (oc !== 'lec'). */
  function splitLabHours(stored: number): number {
    if (stored <= 0) return lab;
    const labPortion = Math.max(0, stored - lec);
    return isPermanent ? Math.round(labPortion / 0.75) : labPortion;
  }

  if (lec > 0 && lab > 0) {
    const lecSched = load.lec_scheduled !== false;
    const labSched = load.lab_scheduled !== false;
    /* Only adjust lab hours when lab was the split component */
    const stored = isPermanent ? storedU : storedH;
    const labH = (isSplit && oc !== 'lec') ? splitLabHours(stored) : lab;
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
  /* For a pure-lab split, derive hours from stored regular value */
  const stored = isPermanent ? storedU : storedH;
  const labH = (isLab && isSplit && stored > 0)
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
  // Contractual loads are kept in hours: a split part's units are those hours in work units
  if (!isP && isSplitLoad) displayWU = hoursToUnits(displayHours, row.type);
  return { displayWU, displayHours };
}

function extractYearNum(yearLevel: string): string {
  const m = yearLevel.match(/\d+/);
  return m ? m[0] : yearLevel;
}

/* -- Load Deduction types ----------------------------------------------- */
/* Load figures as shown — shared display rule (18.25 reads as 18, 6.25 as 6);
   maths and rules keep the exact values. Contractual hours have no grace. */
const loadDisplay = (units: number) => formatLoadCap(shownUnitsCap(units));
const capText = (cap: number, permanent: boolean) => formatLoadCap(permanent ? shownUnitsCap(cap) : cap);
const leftNum = (left: number, permanent: boolean) => (permanent ? shownUnitsLeft(left) : Math.max(0, left));
/** How far past the cap, as shown, from a remaining balance (negative = over). */
const overFromRemaining = (remaining: number, permanent: boolean) =>
  remaining < -0.001 ? -remaining + (permanent ? LOAD_GRACE_UNITS : 0) : 0;

interface DeductionEntry { type: string; description: string; units: string; }
const DEDUCTION_OPTIONS = ['Designation', 'Extension', 'Research/Extension', 'Special Assignment'] as const;

function deductionsToEntries(deductions: WorkloadDeduction[]): { entries: DeductionEntry[]; isNone: boolean } {
  if (!deductions || deductions.length === 0) return { entries: [], isNone: true };
  return {
    entries: deductions.map(d => ({
      type: d.deduction_type,
      description: d.description || '',
      units: String(d.deducted_units),
    })),
    isNone: false,
  };
}

function designationLabel(f: Faculty): string {
  const t = f.designation_type || '';
  if (!t || t === 'No Designation' || t === 'None') return 'No Deduction';
  const u = Number(f.designation_units);
  if (u > 0) return `${t} (${u} unit${u !== 1 ? 's' : ''} deducted)`;
  return t;
}

/** Praise Load types — picked like Faculty Deloading: tick a type, fill its fields. */
const PRAISE_TYPES = [
  'Research', 'Extension', 'Research/Extension', 'Special Assignment',
  'Administrative Assignment', 'Committee Work', 'Other Non-Teaching Load',
] as const;
/** One praise record in the Praise Load modal — `id` set when it is already saved. */
interface PraiseEntry { key: string; id?: number; type: string; description: string; units: string; }
type PraiseRecordLite = { id: number; praise_type?: string; description?: string; equivalent_units?: unknown };
/** Saved praise records → modal entries (the modal opens with what is already there). */
function praiseEntriesFrom(records: PraiseRecordLite[]): PraiseEntry[] {
  return records.map(p => ({
    key: `saved-${p.id}`, id: p.id,
    type: String(p.praise_type || 'Other Non-Teaching Load'),
    description: String(p.description ?? ''),
    units: String(parseFloat(String(p.equivalent_units)) || 0),
  }));
}
let praiseKeySeq = 0;
const newPraiseEntry = (type: string): PraiseEntry => ({ key: `new-${++praiseKeySeq}`, type, description: '', units: '' });

/** Allow empty and in-progress decimals (e.g. "2.") while typing. */
function isNonNegDecimalDraft(raw: string): boolean {
  if (raw === '') return true;
  if (/[eE+\-]/.test(raw)) return false;
  return /^\d*\.?\d*$/.test(raw);
}

function parseNonNegDecimal(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '.') return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function hasAtMostThreeNumericDigits(raw: unknown): boolean {
  return (String(raw).match(/\d/g) ?? []).length <= 3;
}

export default function WorkloadPage({
  initialFacultyQuery = '',
  assignMsId = null,
  assignBlockId = null,
  assignFrom = 'master-schedule',
}: {
  initialFacultyQuery?: string;
  /** Master Schedule / Block → Assign: the class to assign, and the block it lives in. */
  assignMsId?: number | null;
  assignBlockId?: number | null;
  /** Which page sent the assignment — where "Back" returns to. */
  assignFrom?: 'master-schedule' | 'block';
}) {
  const toast = useToast();
  const router = useRouter();
  const { schoolYear: globalYear, semester: globalSemester, loading: syLoading } = useSchoolYear();
  const syInit = useRef(false);
  const appliedFacultyQuery = useRef<string | null>(null);

  const [faculty, setFaculty] = useState<Faculty[]>([]);
  const [facultyListLoading, setFacultyListLoading] = useState(true);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [allBlocks, setAllBlocks] = useState<Block[]>([]);
  const [search, setSearch] = useState('');
  const [filterEmploymentType, setFilterEmploymentType] = useState('');
  /** Faculty list: everyone, only those with a subject this term, or those still needing one */
  const [assignFilter, setAssignFilter] = useState<'all' | 'assigned' | 'unassigned'>('all');
  /** Faculty list page (from 1) — back to the first page when the search or a filter changes */
  const [facultyPage, setFacultyPage] = useState(1);
  useEffect(() => { setFacultyPage(1); }, [search, filterEmploymentType, assignFilter]);
  const facultyListRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  /* Settings → Workload Limits, as exact caps (published + the 0.25 grace).
     Deloading can take at most the whole Regular cap. */
  const workloadPolicy = useWorkloadPolicy();
  const regularCap = regularUnitsCap(workloadPolicy);
  const overloadCap = overloadUnitsCap(workloadPolicy);

  const [facultySummaries, setFacultySummaries] = useState<Record<number, FacultySummary>>({});
  /* Single global semester/year — drives the instructor list badges, workload
   * details, and the block/subject assignment filters. No second selector needed. */
  const [listSemester, setListSemester] = useState('');
  const [listYear, setListYear] = useState('');
  // Workload form groups follow the term's day combinations (Settings → Day Combinations)
  const { active: dayCombos } = useDayCombinations(listSemester, listYear);

  // Follow the global active term — on load and whenever it changes (Settings,
  // another tab or another admin). Master Schedule → Assign keeps the subject's
  // own term instead (set below), so it is left alone there.
  useEffect(() => {
    if (syLoading || assignMsId) return;
    syInit.current = true;
    setListYear(globalYear);
    setListSemester(globalSemester);
  }, [syLoading, globalYear, globalSemester, assignMsId]);

  const [assignTarget, setAssignTarget] = useState<AssignTarget | null>(null);
  const [assignTargetLoading, setAssignTargetLoading] = useState(assignMsId != null);
  /** Program / Year / Block belong to the subject being assigned, not to the faculty. */
  const keepSubjectContext = assignTarget != null;
  useEffect(() => {
    if (!assignMsId) return;
    if (!assignBlockId) {
      setAssignTargetLoading(false);
      toast.error('Subject details are missing. Pick the subject manually.');
      return;
    }
    const controller = new AbortController();
    fetch(`/api/master-schedule?block_id=${assignBlockId}`, { signal: controller.signal })
      .then(r => r.json())
      .then(d => {
        const row = (d.schedules as AssignTarget[] | undefined)?.find(x => x.id === assignMsId);
        if (!row) { toast.error('This subject could not be found in the Master Schedule.'); return; }
        setAssignTarget(row);
        // Work in the subject's own term, even if another one was last selected.
        syInit.current = true;
        setListSemester(row.block_semester);
        setListYear(row.block_academic_year);
      })
      .catch(() => { if (!controller.signal.aborted) toast.error('Unable to load the subject.'); })
      .finally(() => { if (!controller.signal.aborted) setAssignTargetLoading(false); });
    return () => controller.abort();
  }, [assignMsId, assignBlockId, toast]);

  const [selectedFaculty, setSelectedFaculty] = useState<Faculty | null>(null);
  const [workload, setWorkload] = useState<WorkloadSummary | null>(null);
  /* All-semester loads: same as workload.loads but never semester-filtered.
   * This is the single source of truth for the Workload Form modal and the
   * Handled Subjects overload table — ensures subjects like IT321 are never
   * hidden just because a different semester is selected in the workload tab. */
  const [allWorkloadLoads, setAllWorkloadLoads] = useState<WorkloadLoad[]>([]);
  // Plus any day set this faculty's classes use that isn't configured, so they still show in their time slot
  const formGroups = useMemo(() => buildOfficialGroups(dayCombos, loadDayPatterns(allWorkloadLoads)), [dayCombos, allWorkloadLoads]);

  const [filterProgram, setFilterProgram] = useState('');
  const [filterBlock, setFilterBlock] = useState('');
  const [filterYearLevel, setFilterYearLevel] = useState('');
  // filterSemester and filterAcademicYear are derived from the global selectors —
  // no separate state, so Step 2 always stays in sync with Step 1 automatically.
  const filterSemester    = listSemester;
  const filterAcademicYear = listYear;

  /* A new term has different blocks — drop the old Program / Year / Block picks. */
  const lastTerm = useRef('');
  useEffect(() => {
    const term = `${listSemester}|${listYear}`;
    if (lastTerm.current && lastTerm.current !== term && !assignMsId) {
      setFilterProgram('');
      setFilterYearLevel('');
      setFilterBlock('');
    }
    lastTerm.current = term;
  }, [listSemester, listYear, assignMsId]);

  const [availableSchedules, setAvailableSchedules] = useState<Schedule[]>([]);
  const [availLoading, setAvailLoading] = useState(false);
  const [filtersApplied, setFiltersApplied] = useState(false);

  const [assignMsg, setAssignMsg] = useState('');
  const [assignError, setAssignError] = useState('');

  /* Assignment confirmation modals */
  const [overloadConfirm, setOverloadConfirm] = useState<OverloadConfirmData | null>(null);

  /* Move to Overload modal */
  const [moveToOverloadTarget, setMoveToOverloadTarget] = useState<MoveToOverloadContext | null>(null);
  const [moveToOverloadProcessing, setMoveToOverloadProcessing] = useState(false);
  const [moveToOverloadMode, setMoveToOverloadMode] = useState<'entire' | 'split'>('entire');
  const [splitRegularAmount, setSplitRegularAmount] = useState(0);
  /* Units the admin wants to keep as Regular for the specific component being moved */
  const [componentSplitUnits, setComponentSplitUnits] = useState(0);
  /** What is typed in Move to Overload → Keep as Regular (may be empty; empty counts as 0) */
  const [splitInput, setSplitInput] = useState('');

  const [instructorPanelCollapsed, setInstructorPanelCollapsed] = useState(false);
  const [workloadModalOpen, setWorkloadModalOpen] = useState(false);
  const [workloadModalTab, setWorkloadModalTab] = useState<WorkloadModalTab>('actual');
  /** Slide direction for the form's tab content: 1 = moving right (Workload → Overload), -1 = left */
  const [modalTabDir, setModalTabDir] = useState<1 | -1>(1);
  const MODAL_TAB_ORDER = { actual: 0, regular: 1, overload: 2, praise: 3 } as const;
  function switchModalTab(next: WorkloadModalTab, current: WorkloadModalTab) {
    if (next === current) return;
    setModalTabDir(MODAL_TAB_ORDER[next] > MODAL_TAB_ORDER[current] ? 1 : -1);
    setWorkloadModalTab(next);
  }
  const [printError, setPrintError] = useState('');
  const [printOfferFallback, setPrintOfferFallback] = useState(false);
  const [praiseModalOpen, setPraiseModalOpen] = useState(false);
  const [praiseEntries, setPraiseEntries] = useState<PraiseEntry[]>([]);
  /** What was saved when the modal opened — Save sends only the differences */
  const [praiseOriginal, setPraiseOriginal] = useState<PraiseEntry[]>([]);
  const [praiseError, setPraiseError] = useState('');
  const [praiseLoading, setPraiseLoading] = useState(false);
  const [deletePraiseTarget, setDeletePraiseTarget] = useState<{ id: number; praise_type: string } | null>(null);
  const [deletingPraise, setDeletingPraise]         = useState(false);
  const [deletePraiseSuccess, setDeletePraiseSuccess] = useState(false);
  const [showPraiseDeleteSkeleton, setShowPraiseDeleteSkeleton] = useState(false);

  /* Return to Regular Load modal */
  const [returnToRegularTarget, setReturnToRegularTarget] = useState<WorkloadLoad | null>(null);
  const [returnToRegularMode, setReturnToRegularMode] = useState<'entire' | 'partial'>('entire');
  const [returnToRegularAmount, setReturnToRegularAmount] = useState(0);
  const [returnToRegularProcessing, setReturnToRegularProcessing] = useState(false);
  const [returnToRegularError, setReturnToRegularError] = useState('');

  const [moveToPraiseConfirm, setMoveToPraiseConfirm] = useState<{ ids: number[]; total: number } | null>(null);
  const [moveToPraiseProcessing, setMoveToPraiseProcessing] = useState(false);

  /* Praise Load directly from an unclassified ("Other") subject — chains
     move-to-overload then move-to-praise behind one confirmation, since the
     API only allows reclassifying an existing Overload row as Praise. */
  const [praiseFromOtherTarget, setPraiseFromOtherTarget] = useState<WorkloadLoad | null>(null);
  /** Lec or Lab only (Lec+Lab subject) — like Overload, the other component stays Regular. */
  const [praiseFromOtherComponent, setPraiseFromOtherComponent] = useState<'lec' | 'lab' | 'full'>('full');
  /** The Lec / Lab row whose Praise button was clicked — the dialog can switch between it and the whole subject */
  const [praiseClickedPart, setPraiseClickedPart] = useState<'lec' | 'lab' | 'full'>('full');
  const [praiseFromOtherProcessing, setPraiseFromOtherProcessing] = useState(false);
  const [returnToOverloadConfirm, setReturnToOverloadConfirm] = useState<{ ids: number[]; total: number } | null>(null);
  const [returnToOverloadProcessing, setReturnToOverloadProcessing] = useState(false);

  /* Remove subject from workload — confirmation modal */
  const [removeWorkloadTarget, setRemoveWorkloadTarget] = useState<WorkloadLoad | null>(null);
  const [removingWorkload, setRemovingWorkload] = useState(false);

  /* Load Deduction modal — opened only via the Deloading button */
  const [designationPending, setDesignationPending] = useState<Faculty | null>(null);
  const [deductionEntries, setDeductionEntries] = useState<DeductionEntry[]>([]);
  const [deductionNone, setDeductionNone] = useState(true);
  const [designationError, setDesignationError] = useState('');
  const [designationLoading, setDesignationLoading] = useState(false);
  /** Deloading saved — the animated check shows this note, then the modal closes */
  const [deloadSavedNote, setDeloadSavedNote] = useState<string | null>(null);
  /** Praise Load saved — same animated check */
  const [praiseSavedNote, setPraiseSavedNote] = useState<string | null>(null);
  const [modalDeductionsLoading, setModalDeductionsLoading] = useState(false);
  const [deductionMsg, setDeductionMsg] = useState('');
  const [subjectSearch, setSubjectSearch] = useState('');
  const [subjectCategory, setSubjectCategory] = useState<'Minor' | 'Major'>('Minor');
  const [categorySwitching, setCategorySwitching] = useState(false);
  const categorySwitchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showInstructorDropdown, setShowInstructorDropdown] = useState(false);
  const instructorDropRef = useRef<HTMLDivElement>(null);

  /* Purely client-side filter switch, but a brief skeleton makes the tab feel
     responsive/interactive instead of an instant, jarring swap. */
  function handleSubjectCategoryChange(cat: 'Minor' | 'Major') {
    if (cat === subjectCategory) return;
    setSubjectCategory(cat);
    setCategorySwitching(true);
    if (categorySwitchTimeout.current) clearTimeout(categorySwitchTimeout.current);
    categorySwitchTimeout.current = setTimeout(() => setCategorySwitching(false), 2000);
  }
  useEffect(() => () => {
    if (categorySwitchTimeout.current) clearTimeout(categorySwitchTimeout.current);
  }, []);

  const loadBlocks = useCallback(() => {
    return fetch('/api/blocks?include=unassigned_subjects')
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => {
        if (d && !d.error) setAllBlocks(d.blocks || []);
      })
      .catch(err => {
        console.warn('[workload] loadBlocks failed:', err instanceof Error ? err.message : err);
      });
  }, []);

  /** `silent` = background poll: refresh the data without the page skeleton
   *  (which swaps out the whole page and looked like an auto-refresh). */
  const loadFacultyList = useCallback((opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setFacultyListLoading(true);
    return fetch('/api/faculty')
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => {
        if (d && !d.error) setFaculty(d.faculty || []);
      })
      .catch(err => {
        console.warn('[workload] loadFacultyList failed:', err instanceof Error ? err.message : err);
      })
      .finally(() => setFacultyListLoading(false));
  }, []);

  useEffect(() => {
    loadFacultyList();
    fetch('/api/programs')
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => {
        if (d && !d.error) setPrograms(d.programs || []);
      })
      .catch(err => {
        console.warn('[workload] loadPrograms failed:', err instanceof Error ? err.message : err);
      });
    loadBlocks();
  }, [loadBlocks, loadFacultyList]);

  /* Only the blocks assigned to the selected faculty (Faculty → Blocks to Handle),
     in the active term — Program, Year Level and Block options all come from these. */
  // Read assignments from the latest faculty list (refreshed every 30 s), not the
  // copy taken when the faculty was picked — so blocks saved in Faculty apply here.
  const liveSelectedFaculty = selectedFaculty
    ? faculty.find(f => f.id === selectedFaculty.id) ?? selectedFaculty
    : null;
  const facultyBlockIds = new Set(liveSelectedFaculty?.assigned_block_ids ?? []);
  const handledSubjects = liveSelectedFaculty?.priority_subjects ?? [];
  const termBlocks = allBlocks.filter(b =>
    (!filterSemester     || b.semester      === filterSemester) &&
    (!filterAcademicYear || b.academic_year === filterAcademicYear)
  );
  const assignedTermBlocks = termBlocks.filter(b => facultyBlockIds.has(b.id));
  // No blocks assigned for this term → open: every block is available (same rule as the API)
  const facultyBlocks = assignedTermBlocks.length > 0 ? assignedTermBlocks : termBlocks;
  /* With Subjects to Handle set, only blocks that still offer one of them count —
     so Program and Year Level list just those. The picked block stays listed. */
  const handledBlocks = handledSubjects.length === 0
    ? facultyBlocks
    : facultyBlocks.filter(b => blockAvailableCount(b, handledSubjects) > 0 || String(b.id) === filterBlock);

  /* Master Schedule -> Assign: Program / Year / Block describe the SUBJECT, so their
     options are every block of the term, never narrowed to the faculty's own. */
  const optionBlocks = keepSubjectContext ? termBlocks : handledBlocks;

  /* Year & Block options: the selected program's blocks in the active term,
     ordered 1A, 1B, 2A… (optionBlocks is already narrowed to the term). */
  const programBlocks = optionBlocks
    .filter(b => !filterProgram || String(b.program_id) === filterProgram)
    .sort((a, b) =>
      extractYearNum(a.year_level).localeCompare(extractYearNum(b.year_level), undefined, { numeric: true }) ||
      a.block_name.localeCompare(b.block_name, undefined, { numeric: true }));

  useEffect(() => {
    if (!selectedFaculty || keepSubjectContext) return;
    const allowed = [...new Set(handledBlocks.map(b => String(b.program_id)))];
    if (filterProgram && allowed.includes(filterProgram)) return;
    const next = allowed.length === 1 ? allowed[0] : '';
    if (next !== filterProgram) {
      setFilterProgram(next);
      setFilterYearLevel('');
      setFilterBlock('');
      setAvailableSchedules([]);
      setFiltersApplied(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFaculty?.id, liveSelectedFaculty?.assigned_block_ids?.join(','), handledSubjects.map(s => s.subject_code).join(','), allBlocks, filterSemester, filterAcademicYear, keepSubjectContext]);

  /** Year & Block: one pick (e.g. "1A") fills both the year level and the block. */
  function handleYearBlockChange(blockId: string) {
    const block = blockId ? allBlocks.find(b => String(b.id) === blockId) : undefined;
    if (block && isBlockFullyAssigned(block) && filterBlock !== blockId) return;
    // Unknown id → clear both, so year level and block never disagree
    setFilterYearLevel(block?.year_level ?? '');
    setFilterBlock(block ? blockId : '');
    setAvailableSchedules([]);
    setFiltersApplied(false);
  }

  function handleProgramChange(programId: string) {
    setFilterProgram(programId);
    setFilterBlock('');
    setFilterYearLevel('');
    setAvailableSchedules([]);
    setFiltersApplied(false);
  }

  function clearProgramChain() {
    if (keepSubjectContext) return; // the subject's Program / Year / Block stay put
    setFilterProgram('');
    setFilterBlock('');
    setFilterYearLevel('');
    setAvailableSchedules([]);
    setFiltersApplied(false);
  }

  useEffect(() => {
    setSubjectCategory('Minor');
    setSubjectSearch('');
  }, [filterProgram, filterYearLevel, filterBlock, filterSemester, filterAcademicYear]);

  /* Master Schedule / Block → Assign: Program / Year / Block come from the subject
     as soon as it loads, before any faculty is picked. They are locked (so the
     subject can't land in another block), and picking a faculty never overwrites
     them (see selectFaculty). */
  const prefilledAssign = useRef(false);
  useEffect(() => {
    if (!assignTarget || prefilledAssign.current) return;
    prefilledAssign.current = true;
    setFilterProgram(String(assignTarget.program_id));
    setFilterYearLevel(assignTarget.year_level);
    setFilterBlock(String(assignTarget.block_id));
  }, [assignTarget]);
  /** The picked faculty may teach the subject's block (Faculty → Blocks to Handle, the assign API's rule). */
  const targetBlockAllowed = !!assignTarget && facultyBlocks.some(b => b.id === assignTarget.block_id);

  /* …and open the Minor / Major tab the subject belongs to (runs after the reset above). */
  useEffect(() => {
    if (assignTarget && filterBlock === String(assignTarget.block_id)) {
      setSubjectCategory(coerceSubjectCategory(assignTarget.subject_category, 'Minor'));
    }
  }, [filterProgram, filterYearLevel, filterBlock, filterSemester, filterAcademicYear, assignTarget]);

  /* Keep the picked faculty in the URL so a refresh resumes the same assignment. */
  useEffect(() => {
    if (!assignMsId || facultyListLoading) return;
    const url = new URL(window.location.href);
    if (selectedFaculty) url.searchParams.set('facultyId', String(selectedFaculty.id));
    else url.searchParams.delete('facultyId');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [assignMsId, facultyListLoading, selectedFaculty]);

  // Full reset of instructor selection and all dependent child filters.
  // Called whenever Employment Type changes so no stale data from the
  // previous type leaks into the new context.
  const resetInstructorAndFilters = useCallback(() => {
    setSearch('');
    setShowInstructorDropdown(false);
    setSelectedFaculty(null);
    setWorkload(null);
    setAllWorkloadLoads([]);
    if (!keepSubjectContext) {
      setFilterProgram('');
      setFilterBlock('');
      setFilterYearLevel('');
      setAvailableSchedules([]);
      setFiltersApplied(false);
    }
    setAssignMsg('');
    setAssignError('');
    setOverloadConfirm(null);
    setMoveToOverloadTarget(null);
    setMoveToOverloadMode('entire');
    setSplitRegularAmount(0);
    setComponentSplitUnits(0);
  }, [keepSubjectContext]);

  const allFiltersSet = !!(filterProgram && filterBlock && filterYearLevel && filterSemester && filterAcademicYear);

  const loadWorkload = useCallback((): Promise<WorkloadSummary | null> => {
    if (!selectedFaculty) return Promise.resolve(null);
    if (!listSemester) { setWorkload(null); return Promise.resolve(null); }
    const params = new URLSearchParams({ semester: listSemester, academic_year: listYear });
    return fetch(`/api/workload/${selectedFaculty.id}?` + params)
      .then(r => r.json())
      .then(d => {
        if (d.error) return null;
        setWorkload(d);
        return d as WorkloadSummary;
      })
      .catch(() => null);
  }, [selectedFaculty, listSemester, listYear]);

  useEffect(() => { loadWorkload(); }, [loadWorkload]);

  /* Unfiltered load list — no semester/year param, so ALL assigned subjects appear
   * regardless of which term the workload tab is currently showing. */
  const loadAllFacultyLoads = useCallback((): Promise<WorkloadLoad[]> => {
    if (!selectedFaculty) { setAllWorkloadLoads([]); return Promise.resolve([]); }
    return fetch(`/api/workload/${selectedFaculty.id}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) return [] as WorkloadLoad[];
        const loads = (d.loads || []) as WorkloadLoad[];
        setAllWorkloadLoads(loads);
        return loads;
      })
      .catch(() => [] as WorkloadLoad[]);
  }, [selectedFaculty]);

  useEffect(() => { loadAllFacultyLoads(); }, [loadAllFacultyLoads]);

  /** Count Overload + split-overload subjects from an all-loads snapshot. */
  function countOverloadEntries(loads: WorkloadLoad[], permanent: boolean): number {
    let n = 0;
    for (const l of loads) {
      if (l.load_category === 'Overload') { n += 1; continue; }
      if (l.load_category !== 'Regular') continue;
      const split = permanent
        ? (parseFloat(String(l.split_overload_units)) || 0) > 0.001
        : (parseFloat(String(l.split_overload_hours)) || 0) > 0.001;
      if (split && !l.split_is_praise) n += 1;
    }
    return n;
  }

  function countPraiseEntries(loads: WorkloadLoad[], praiseRows: unknown[]): number {
    return loads.filter(l => l.load_category === 'Praise' || (l.load_category === 'Regular' && l.split_is_praise)).length
      + praiseRows.length;
  }

  /**
   * Keep the Workload Form open; if the active special section became empty,
   * fall back to Regular Load. If it still has records, stay on that section.
   */
  function syncWorkloadModalTab(opts: {
    current: WorkloadModalTab;
    overloadCount: number;
    praiseCount: number;
  }) {
    if (opts.current === 'overload' && opts.overloadCount === 0) {
      setWorkloadModalTab('regular');
      return;
    }
    if (opts.current === 'praise' && opts.praiseCount === 0) {
      setWorkloadModalTab('regular');
    }
  }

  /* If Overload/Praise became empty while that tab was active, fall back to Regular. */
  useEffect(() => {
    if (!workloadModalOpen || !selectedFaculty) return;
    if (workloadModalTab === 'regular') return;
    const isPermanent = selectedFaculty.employment_status === 'Permanent';
    const termLoads = allWorkloadLoads.filter(l =>
      (!listSemester || l.semester === listSemester) &&
      (!listYear || l.academic_year === listYear)
    );
    syncWorkloadModalTab({
      current: workloadModalTab,
      overloadCount: countOverloadEntries(termLoads, isPermanent),
      praiseCount: countPraiseEntries(termLoads, workload?.praise ?? []),
    });
  }, [
    workloadModalOpen,
    workloadModalTab,
    allWorkloadLoads,
    workload?.praise,
    selectedFaculty,
    listSemester,
    listYear,
  ]);

  const loadFacultySummaries = useCallback(() => {
    if (!listSemester) { setFacultySummaries({}); return Promise.resolve(); }
    const params = new URLSearchParams({ semester: listSemester, academic_year: listYear });
    return fetch(`/api/workload/summaries?${params}`)
      .then(r => r.json())
      .then(d => setFacultySummaries(d.summaries || {}))
      .catch(() => {});
  }, [listSemester, listYear]);

  useEffect(() => { loadFacultySummaries(); }, [loadFacultySummaries]);

  // Fallback refresh (live updates below cover changes made elsewhere) — quiet, no skeleton.
  useVisibilityAwareInterval(() => {
    loadBlocks();
    loadFacultyList({ silent: true });
    loadFacultySummaries();
  }, 120_000);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (instructorDropRef.current && !instructorDropRef.current.contains(e.target as Node)) {
        setShowInstructorDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /** Filters of the subject list on screen — a late answer for older filters is dropped. */
  const availKey = useRef('');
  function availParams() {
    return new URLSearchParams({
      status: 'Unassigned',
      program_id: filterProgram,
      block_id: filterBlock,
      year_level: filterYearLevel,
      semester: filterSemester,
      academic_year: filterAcademicYear,
    });
  }

  function loadAvailable() {
    if (!allFiltersSet) return;
    setAvailLoading(true);
    setFiltersApplied(true);
    const params = availParams();
    const key = params.toString();
    availKey.current = key;
    fetch('/api/master-schedule?' + params)
      .then(r => r.json())
      .then(d => {
        if (availKey.current !== key) return;
        setAvailableSchedules(d.schedules || []);
        setAvailLoading(false);
      })
      .catch(() => { if (availKey.current === key) setAvailLoading(false); });
  }

  /** Live updates: re-read the subject list without its loading state. Subjects
   *  someone else just assigned leave the list (and the multi-select). */
  function refreshAvailable(): Promise<void> {
    if (!allFiltersSet || !filtersApplied || availLoading) return Promise.resolve();
    const params = availParams();
    const key = params.toString();
    if (availKey.current !== key) return Promise.resolve();
    return fetch('/api/master-schedule?' + params)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || availKey.current !== key || !Array.isArray(d.schedules)) return;
        const fresh = d.schedules as Schedule[];
        setAvailableSchedules(fresh);
        const stillOpen = new Set(fresh.map(s => s.id));
        setPickedIds(prev => {
          const next = new Set([...prev].filter(id => stillOpen.has(id)));
          return next.size === prev.size ? prev : next;
        });
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (allFiltersSet) loadAvailable();
    else { setAvailableSchedules([]); setFiltersApplied(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterProgram, filterBlock, filterYearLevel, filterSemester, filterAcademicYear]);

  /* -- Assignment flow ------------------------------------------------------
   * First call (no assignCategory): server checks remaining load and returns
   * a requires_confirmation response. The modal captures admin intent.
   * Second call (with assignCategory): admin confirmed — proceed.
   * ----------------------------------------------------------------------- */
  async function assignSubject(
    msId: number,
    assignCategory?: 'regular' | 'overload',
    opts: { fromConfirm?: boolean } = {},
  ): Promise<{ ok: boolean; note?: string }> {
    if (!selectedFaculty) return { ok: false };
    setAssignMsg(''); setAssignError('');
    try {
      const res = await fetch('/api/workload/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_id: selectedFaculty.id,
          master_schedule_id: msId,
          assign_category: assignCategory,
        }),
      });
      const data = await res.json();

      if (data.requires_confirmation) {
        // Fits in the remaining regular load — no need to ask, save it straight away.
        if (data.confirmation_type === 'remaining_balance') {
          return assignSubject(msId, 'regular', opts);
        }
        // Would go past the regular load — this one still needs the admin's OK.
        setOverloadConfirm({
          msId,
          subjectCode:  data.subject_code  || '',
          subjectName:  data.subject_name  || '',
          subjectValue: data.subject_value,
          unit:         data.unit,
          loadLimit:    data.load_limit,
          currentLoad:  data.current_load,
          remaining:    data.remaining ?? 0,
        });
        return { ok: false };
      }

      if (!res.ok) { setAssignError(data.error || 'Failed to assign subject'); toast.error(data.error || 'Failed to assign subject.'); return { ok: false }; }
      setAssignMsg(data.message || 'Subject assigned successfully.');
      const remainingNote = typeof data.remaining === 'number' && data.unit
        ? (data.remaining < -0.001
          ? ` ${overFromRemaining(data.remaining, data.unit === 'units').toFixed(2)} ${data.unit} over the regular limit.`
          : ` ${leftNum(data.remaining, data.unit === 'units').toFixed(2)} ${data.unit} remaining.`)
        : '';
      // From a "Continue Adding" dialog the dialog itself shows the success check.
      if (!opts.fromConfirm) {
        toast.success(`Subject assigned successfully.${remainingNote}`);
        setOverloadConfirm(null);
      }
      loadWorkload(); loadAllFacultyLoads(); loadAvailable(); loadFacultySummaries(); loadBlocks();
      return { ok: true, note: remainingNote.trim() };
    } catch {
      setAssignError('Connection error');
      toast.error('Connection error. Please try again.');
      return { ok: false };
    }
  }

  /* "Continue Adding" — save, then show the success check inside the dialog
     before it closes on its own. */
  const [continueState, setContinueState] = useState<'idle' | 'saving' | 'success'>('idle');
  const [continueNote, setContinueNote] = useState('');
  async function continueAdding(msId: number, closeDialog: () => void) {
    setContinueState('saving');
    const result = await assignSubject(msId, 'regular', { fromConfirm: true });
    if (!result.ok) {
      setContinueState('idle');
      closeDialog();
      return;
    }
    setContinueNote(result.note ?? '');
    setContinueState('success');
    setTimeout(() => {
      closeDialog();
      setContinueState('idle');
    }, 1500);
  }

  async function unassignSubject(msId: number) {
    if (!selectedFaculty) return;
    try {
      const res = await fetch('/api/workload/unassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faculty_id: selectedFaculty.id, master_schedule_id: msId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setAssignError(d.error || 'Failed to unassign subject');
        toast.error(d.error || 'Failed to remove subject.');
        return;
      }
      toast.success('Subject removed successfully.');
      loadWorkload(); loadAllFacultyLoads(); loadAvailable(); loadFacultySummaries(); loadBlocks();
    } catch {
      toast.error('Connection error. Please try again.');
    }
  }

  async function confirmRemoveSubject() {
    if (!selectedFaculty || !removeWorkloadTarget) return;
    setRemovingWorkload(true);
    try {
      await unassignSubject(removeWorkloadTarget.ms_id);
      setRemoveWorkloadTarget(null);
    } finally {
      setRemovingWorkload(false);
    }
  }

  /* -- Move to Overload --------------------------------------------------- */
  function handleMoveToOverload(load: WorkloadLoad, component: 'lec' | 'lab' | 'full') {
    const lec = parseFloat(String(load.lecture_hours)) || 0;
    const lab = parseFloat(String(load.laboratory_hours)) || 0;
    const hasBoth = lec > 0 && lab > 0;

    /* Always open in "entire" mode — the user selects inside the modal */
    setMoveToOverloadMode('entire');

    if (hasBoth && component !== 'full') {
      /* Component-specific: user will choose entire-vs-split in the modal.
         componentSplitUnits tracks the regular portion (in wu/units) for the selected component. */
      setComponentSplitUnits(0);
      setSplitInput('');
    } else {
      /* Full / single-component: keep the existing max-regular pre-fill for the split slider */
      const subjectTotal = isPermanent ? calcWorkloadUnits(lec, lab) : lec + lab;
      const maxRegular = summary
        ? parseFloat(Math.max(0, Math.min(subjectTotal - 0.01, subjectTotal + summary.remaining_regular_load)).toFixed(2))
        : 0;
      setSplitRegularAmount(maxRegular);
      setComponentSplitUnits(0);
      setSplitInput(String(maxRegular));
    }
    setMoveToOverloadTarget({ load, component });
  }

  async function confirmMoveToOverload() {
    if (!selectedFaculty || !moveToOverloadTarget) return;
    setMoveToOverloadProcessing(true);
    setAssignError('');
    try {
      const { load, component } = moveToOverloadTarget;
      const lec = parseFloat(String(load.lecture_hours)) || 0;
      const lab = parseFloat(String(load.laboratory_hours)) || 0;
      const hasBoth = lec > 0 && lab > 0;
      const isComponentSpecific = hasBoth && component !== 'full';

      /* WU values per component (Permanent) or raw hours (Contractual) */
      const lecWU = isPermanent ? lec : lec;
      const labWU = isPermanent ? lab * 0.75 : lab;

      const body: Record<string, unknown> = {
        faculty_id: selectedFaculty.id,
        master_schedule_id: load.ms_id,
        component,
      };

      if (isComponentSpecific) {
        if (moveToOverloadMode === 'entire') {
          /* Move this component fully to overload; other component stays Regular */
          body.split_regular = component === 'lab' ? lecWU : labWU;
        } else {
          /* Split: keep componentSplitUnits of this component as Regular;
             componentSplitUnits is already in wu (permanent) or contact hours (contractual),
             so no further conversion is needed. */
          const otherWU = component === 'lab' ? lecWU : labWU;
          body.split_regular = otherWU + componentSplitUnits;
        }
      } else if (moveToOverloadMode === 'split') {
        /* Full / single-component split: use the manual slider value */
        body.split_regular = splitRegularAmount;
      }

      const res = await fetch('/api/workload/move-to-overload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setAssignError(data.error || 'Failed to move subject to overload');
        toast.error(data.error || 'Failed to move subject to overload.');
        setMoveToOverloadTarget(null);
        return;
      }
      toast.success('Subject moved to overload successfully.');
      setAssignMsg(data.message || 'Subject updated.');
      setMoveToOverloadTarget(null);
      loadWorkload(); loadAllFacultyLoads(); loadFacultySummaries();
    } catch { setAssignError('Connection error'); toast.error('Connection error. Please try again.'); }
    finally { setMoveToOverloadProcessing(false); }
  }

  function requestMoveToPraise(loads: WorkloadLoad[], msIds: number[]) {
    const unique = [...new Set(msIds.filter(id => Number.isInteger(id) && id > 0))];
    const movable = loads.filter(l => unique.includes(l.ms_id) && l.load_category === 'Overload');
    if (movable.length === 0) {
      toast.error('Select one or more Overload subjects first.');
      return;
    }
    const total = movable.reduce((sum, l) => sum + subjectLoadValue(l, selectedFaculty?.employment_status === 'Permanent'), 0);
    setMoveToPraiseConfirm({ ids: movable.map(l => l.ms_id), total });
  }

  async function confirmMoveToPraise() {
    if (!selectedFaculty || !moveToPraiseConfirm) return;
    setMoveToPraiseProcessing(true);
    try {
      const res = await fetch('/api/workload/move-to-praise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_id: selectedFaculty.id,
          master_schedule_ids: moveToPraiseConfirm.ids,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to move subject to Praise Load.');
        return;
      }
      toast.success(data.message || 'Subject moved to Praise Load.');
      setMoveToPraiseConfirm(null);
      const [freshAll, freshWorkload] = await Promise.all([
        loadAllFacultyLoads(),
        loadWorkload(),
      ]);
      loadFacultySummaries();
      const isP = selectedFaculty.employment_status === 'Permanent';
      syncWorkloadModalTab({
        current: workloadModalTab,
        overloadCount: countOverloadEntries(freshAll, isP),
        praiseCount: countPraiseEntries(freshAll, freshWorkload?.praise ?? []),
      });
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setMoveToPraiseProcessing(false);
    }
  }

  /* Unclassified ("Other") subjects are stored as Regular, but move-to-praise
     only accepts subjects already in Overload — so this flags the subject as
     a full Overload first, then immediately reclassifies it as Praise Load. */
  async function confirmPraiseFromOther() {
    if (!selectedFaculty || !praiseFromOtherTarget) return;
    setPraiseFromOtherProcessing(true);
    try {
      const load = praiseFromOtherTarget;
      if (praiseFromOtherComponent !== 'full') {
        const res = await fetch('/api/workload/move-to-praise', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            faculty_id: selectedFaculty.id,
            master_schedule_id: load.ms_id,
            component: praiseFromOtherComponent,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          toast.error(data.error || 'Failed to move to Praise Load.');
          return;
        }
        toast.success(data.message || 'Moved to Praise Load.');
        setPraiseFromOtherTarget(null);
        await Promise.all([loadAllFacultyLoads(), loadWorkload()]);
        loadFacultySummaries();
        return;
      }
      // One step straight to Praise — going through Overload applied the Overload limit to a Praise move
      const praiseRes = await fetch('/api/workload/move-to-praise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_id: selectedFaculty.id,
          master_schedule_id: load.ms_id,
          whole_subject: true,
        }),
      });
      const praiseData = await praiseRes.json().catch(() => ({}));
      if (!praiseRes.ok) {
        toast.error(praiseData.error || 'Failed to move subject to Praise Load.');
        return;
      }

      toast.success(praiseData.message || 'Subject moved to Praise Load.');
      setPraiseFromOtherTarget(null);
      const [freshAll, freshWorkload] = await Promise.all([
        loadAllFacultyLoads(),
        loadWorkload(),
      ]);
      loadFacultySummaries();
      const isP = selectedFaculty.employment_status === 'Permanent';
      syncWorkloadModalTab({
        current: workloadModalTab,
        overloadCount: countOverloadEntries(freshAll, isP),
        praiseCount: countPraiseEntries(freshAll, freshWorkload?.praise ?? []),
      });
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setPraiseFromOtherProcessing(false);
    }
  }

  function requestReturnToOverload(loads: WorkloadLoad[], msIds: number[]) {
    const unique = [...new Set(msIds.filter(id => Number.isInteger(id) && id > 0))];
    const movable = loads.filter(l => unique.includes(l.ms_id) && l.load_category === 'Praise');
    if (movable.length === 0) {
      toast.error('Select one or more Praise Load subjects first.');
      return;
    }
    const total = movable.reduce((sum, l) => sum + subjectLoadValue(l, selectedFaculty?.employment_status === 'Permanent'), 0);
    setReturnToOverloadConfirm({ ids: movable.map(l => l.ms_id), total });
  }

  async function confirmReturnToOverload() {
    if (!selectedFaculty || !returnToOverloadConfirm) return;
    setReturnToOverloadProcessing(true);
    try {
      const res = await fetch('/api/workload/return-to-overload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_id: selectedFaculty.id,
          master_schedule_ids: returnToOverloadConfirm.ids,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to return subject to Overload.');
        return;
      }
      toast.success(data.message || 'Subject returned to Overload.');
      setReturnToOverloadConfirm(null);
      const [freshAll, freshWorkload] = await Promise.all([
        loadAllFacultyLoads(),
        loadWorkload(),
      ]);
      loadFacultySummaries();
      const isP = selectedFaculty.employment_status === 'Permanent';
      syncWorkloadModalTab({
        current: workloadModalTab,
        overloadCount: countOverloadEntries(freshAll, isP),
        praiseCount: countPraiseEntries(freshAll, freshWorkload?.praise ?? []),
      });
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setReturnToOverloadProcessing(false);
    }
  }

  function handleReturnToRegular(load: WorkloadLoad) {
    setReturnToRegularMode('entire');
    setReturnToRegularAmount(0);
    setReturnToRegularError('');
    setReturnToRegularTarget(load);
  }

  async function confirmReturnToRegular() {
    if (!selectedFaculty || !returnToRegularTarget) return;
    const load = returnToRegularTarget;
    setReturnToRegularProcessing(true);
    setReturnToRegularError('');
    try {
      const body: Record<string, unknown> = {
        faculty_id: selectedFaculty.id,
        master_schedule_id: load.ms_id,
      };
      if (returnToRegularMode === 'partial') body.return_units = returnToRegularAmount;
      const res = await fetch('/api/workload/return-to-regular', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setReturnToRegularError(data.error || 'Failed to return subject to regular load.');
        return;
      }
      toast.success('Subject returned to Regular Load successfully.');
      setReturnToRegularTarget(null);

      const [freshAll, freshWorkload] = await Promise.all([
        loadAllFacultyLoads(),
        loadWorkload(),
      ]);
      loadFacultySummaries();

      const isPermanent = selectedFaculty.employment_status === 'Permanent';
      syncWorkloadModalTab({
        current: workloadModalTab,
        overloadCount: countOverloadEntries(freshAll, isPermanent),
        praiseCount: countPraiseEntries(freshAll, freshWorkload?.praise ?? []),
      });
    } catch {
      setReturnToRegularError('Connection error. Please try again.');
    } finally {
      setReturnToRegularProcessing(false);
    }
  }

  /** Differences between the modal and what is saved (empty boxes count as 0). */
  function praiseChanges(entries: PraiseEntry[], original: PraiseEntry[]) {
    const unitsOf = (u: string) => parseNonNegDecimal(u.trim() || '0') ?? 0;
    const rows = entries.map(en => ({ ...en, description: en.description.trim(), units: en.units.trim() || '0' }));
    const toDelete = original.filter(o => !rows.some(r => r.id === o.id));
    const toUpdate = rows.filter(r => {
      if (r.id == null) return false;
      const o = original.find(x => x.id === r.id);
      return !!o && (o.description.trim() !== r.description || unitsOf(o.units) !== unitsOf(r.units));
    });
    const toCreate = rows.filter(r => r.id == null);
    return { rows, toDelete, toUpdate, toCreate, unitsOf, dirty: toDelete.length + toUpdate.length + toCreate.length > 0 };
  }

  async function savePraise(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFaculty) return;
    if (!filterSemester) { setPraiseError('Please select a semester before saving Praise Load.'); return; }
    const { rows, toDelete, toUpdate, toCreate, unitsOf, dirty } = praiseChanges(praiseEntries, praiseOriginal);
    if (!dirty) { setPraiseModalOpen(false); return; }
    for (const r of rows) {
      if (parseNonNegDecimal(r.units) === null) { setPraiseError(`${r.type}: units must be a valid non-negative number.`); return; }
      if (!hasAtMostThreeNumericDigits(r.units)) { setPraiseError(`${r.type}: maximum of 3 digits only (e.g., 1.23).`); return; }
      if (unitsOf(r.units) > 99.99) { setPraiseError(`${r.type}: units can be at most 99.99.`); return; }
    }
    setPraiseLoading(true); setPraiseError('');
    const fid = selectedFaculty.id;
    const headers = { 'Content-Type': 'application/json' };
    const send = async (label: string, url: string, init: RequestInit) => {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${label}: ${data.error || 'could not be saved.'}`);
    };
    try {
      for (const o of toDelete) {
        await send(o.type, `/api/praise-loads/${o.id}?faculty_id=${fid}`, { method: 'DELETE' });
      }
      for (const r of toUpdate) {
        await send(r.type, `/api/praise-loads/${r.id}`, {
          method: 'PUT', headers,
          body: JSON.stringify({ faculty_id: fid, description: r.description, equivalent_units: unitsOf(r.units) }),
        });
      }
      for (const r of toCreate) {
        await send(r.type, '/api/praise', {
          method: 'POST', headers,
          body: JSON.stringify({
            faculty_id: fid, praise_type: r.type, description: r.description, remarks: '',
            equivalent_units: unitsOf(r.units),
            equivalent_hours: 0, // hours aren't asked for Praise Load (API still expects the field)
            academic_year: filterAcademicYear, semester: filterSemester,
          }),
        });
      }
      // Animated check inside the modal, then it closes on its own
      const praiseTotal = rows.reduce((sum, r) => sum + unitsOf(r.units), 0);
      setPraiseSavedNote(rows.length === 0 ? 'All Praise Load removed.' : `Total Praise Load: ${praiseTotal.toFixed(2)} units`);
      setTimeout(() => { setPraiseModalOpen(false); setPraiseSavedNote(null); }, 1500);
      loadWorkload(); loadAllFacultyLoads();
    } catch (err) {
      const msg = err instanceof TypeError ? 'Connection error. Please try again.'
        : err instanceof Error && err.message ? err.message : 'Failed to save Praise Load.';
      // Part of the changes may be saved — reload and show exactly what is saved,
      // so pressing Save again never duplicates anything.
      const fresh = await loadWorkload();
      loadAllFacultyLoads();
      if (fresh) {
        const current = praiseEntriesFrom((fresh.praise ?? []) as PraiseRecordLite[]);
        setPraiseEntries(current);
        setPraiseOriginal(current);
      }
      setPraiseError(`${msg} The list now shows what is saved — check it and save again.`);
      toast.error(msg);
    } finally {
      setPraiseLoading(false);
    }
  }

  const handleDeletePraise = useCallback(async () => {
    if (!deletePraiseTarget || !selectedFaculty) return;
    setDeletingPraise(true);
    try {
      const res = await fetch(
        `/api/praise-loads/${deletePraiseTarget.id}?faculty_id=${selectedFaculty.id}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error || 'Delete failed');
      setDeletingPraise(false);
      setDeletePraiseSuccess(true);
      setShowPraiseDeleteSkeleton(true);

      const [freshAll, freshWorkload] = await Promise.all([
        loadAllFacultyLoads(),
        loadWorkload(),
      ]);
      loadFacultySummaries();

      const isPermanent = selectedFaculty.employment_status === 'Permanent';
      syncWorkloadModalTab({
        current: workloadModalTab,
        overloadCount: countOverloadEntries(freshAll, isPermanent),
        praiseCount: countPraiseEntries(freshAll, freshWorkload?.praise ?? []),
      });

      setTimeout(() => {
        setDeletePraiseSuccess(false);
        setShowPraiseDeleteSkeleton(false);
        setDeletePraiseTarget(null);
        toast.success('Praise Load removed successfully.');
      }, 1300);
      return;
    } catch (err) {
      console.error('[handleDeletePraise]', err);
      toast.error('Failed to remove Praise Load. Please try again.');
    } finally {
      setDeletingPraise(false);
    }
  }, [
    deletePraiseTarget, selectedFaculty, loadWorkload, loadAllFacultyLoads,
    loadFacultySummaries, toast, workloadModalTab,
  ]);

  const selectFaculty = useCallback((f: Faculty) => {
    setAssignMsg(''); setAssignError('');
    setOverloadConfirm(null);
    setMoveToOverloadTarget(null); setMoveToOverloadMode('entire'); setSplitRegularAmount(0); setComponentSplitUnits(0);
    /* The faculty's own program only seeds the filters in the normal flow. From
       Master Schedule → Assign they describe the subject and are left alone. */
    if (!keepSubjectContext) {
      setAvailableSchedules([]);
      setFiltersApplied(false);
      setFilterYearLevel('');
      setFilterBlock('');
      setFilterProgram(f.program_id != null ? String(f.program_id) : '');
    }
    setMoveToPraiseConfirm(null);
    setReturnToOverloadConfirm(null);
    setSelectedFaculty(f);
  }, [keepSubjectContext]);

  useEffect(() => {
    const raw = initialFacultyQuery.trim();
    if (!raw) return;
    if (appliedFacultyQuery.current === raw) return;
    if (faculty.length === 0) return;

    appliedFacultyQuery.current = raw;
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.error('Invalid faculty.');
      return;
    }
    const match = faculty.find(f => f.id === id);
    if (!match) {
      toast.error('Faculty not found or is no longer active.');
      return;
    }
    selectFaculty(match);
    if (match.employment_status === 'Permanent') {
      void openDeductionModal(match);
    }
  }, [faculty, initialFacultyQuery, selectFaculty, toast]);

  async function openDeductionModal(f: Faculty) {
    setDesignationError('');
    setDeductionEntries([]);
    setDeductionNone(true);
    setDesignationPending(f);

    if (!listSemester || !listYear) return;

    setModalDeductionsLoading(true);
    try {
      const params = new URLSearchParams({ semester: listSemester, school_year: listYear });
      const res = await fetch(`/api/faculty/${f.id}/deductions?${params}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.deductions) && data.deductions.length > 0) {
        const entries: DeductionEntry[] = data.deductions.map((d: { deduction_type: string; description: string; deducted_units: number }) => ({
          type: d.deduction_type,
          description: d.description || '',
          units: String(d.deducted_units),
        }));
        setDeductionEntries(entries);
        setDeductionNone(false);
      }
    } catch { /* silently use empty defaults */ }
    finally { setModalDeductionsLoading(false); }
  }

  async function confirmDesignation() {
    if (!designationPending) return;

    if (!listSemester || !listYear) {
      setDesignationError('Please select a semester and school year first.');
      return;
    }

    const deductions: { type: string; description: string; units: number }[] = [];

    if (!deductionNone && deductionEntries.length > 0) {
      for (const e of deductionEntries) {
        const v = parseFloat(e.units);
        if (e.units === '' || isNaN(v)) {
          setDesignationError(`Enter the unit deduction for ${e.type}.`); return;
        }
        if (v <= 0) {
          setDesignationError(`Units for ${e.type} must be greater than 0.`); return;
        }
        deductions.push({ type: e.type, description: e.description.trim(), units: v });
      }
      const total = deductions.reduce((s, e) => s + e.units, 0);
      if (total > regularCap) {
        setDesignationError(`Total deduction cannot exceed ${loadDisplay(regularCap)} units.`); return;
      }
    }

    setDesignationError('');
    setDesignationLoading(true);
    try {
      const res = await fetch(`/api/faculty/${designationPending.id}/deductions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deductions, semester: listSemester, school_year: listYear }),
      });
      const data = await res.json();
      if (!res.ok) { setDesignationError(data.error || 'Failed to save.'); return; }

      const updated: Faculty = {
        ...designationPending,
        designation_type: data.faculty.designation_type,
        designation_units: data.faculty.designation_units,
      };
      setFaculty(prev => prev.map(f => f.id === updated.id ? updated : f));
      setSelectedFaculty(updated);
      setDeductionMsg('Load deduction saved. Workload updated.');
      const availableLoad = Math.max(0, regularCap - (Number(data.total_deduction) || 0));
      // Animated check inside the modal, then it closes on its own
      setDeloadSavedNote(`${loadDisplay(availableLoad)} units regular load available.`);
      setTimeout(() => { setDesignationPending(null); setDeloadSavedNote(null); }, 1500);
      loadWorkload();
      loadAllFacultyLoads();
      loadFacultySummaries();
    } catch { setDesignationError('Connection error. Please try again.'); }
    finally { setDesignationLoading(false); }
  }

  const summary = workload?.summary;
  const isPermanent = selectedFaculty?.employment_status === 'Permanent';
  /** Only Permanent faculty carry Overload / Praise Load — Contractual: Regular only */
  const extraLoads = canHaveOverloadOrPraise(selectedFaculty?.employment_status);
  // Teaching units (what goes into the teaching slot)
  const regularVal   = summary ? (isPermanent ? summary.total_regular_units  : summary.total_regular_hours)  : 0;
  // Overload units
  const overloadVal  = summary ? (isPermanent ? summary.total_overload_units : summary.total_overload_hours) : 0;

  /* Confirm guard for the Move to Overload modal */
  const canConfirmOverload = (() => {
    if (moveToOverloadMode === 'entire') return true;
    if (!moveToOverloadTarget) return false;
    const { load, component } = moveToOverloadTarget;
    const lec = parseFloat(String(load.lecture_hours)) || 0;
    const lab = parseFloat(String(load.laboratory_hours)) || 0;
    const hasBoth = lec > 0 && lab > 0;

    if (hasBoth && component !== 'full') {
      /* Component-specific split: overload portion of that component (in wu) must be > 0 */
      const componentTotalWU = component === 'lec'
        ? (isPermanent ? lec : lec)
        : (isPermanent ? lab * 0.75 : lab);
      return (
        componentSplitUnits >= 0 &&
        componentSplitUnits <= componentTotalWU &&
        (componentTotalWU - componentSplitUnits) > 0.001
      );
    }
    /* Full / single-component split */
    const subjectTotal = isPermanent ? calcWorkloadUnits(lec, lab) : lec + lab;
    return splitRegularAmount >= 0 && (subjectTotal - splitRegularAmount) > 0.001;
  })();

  /* Remaining load available for client-side per-subject warn detection.
   * Only valid when the workload semester matches the assignment filter semester
   * so we don't compare load from one term against subjects from another. */
  const remainingForWarning: number | null =
    summary && listSemester
      ? summary.remaining_regular_load
      : null;

  function getFacultyStatus(s: FacultySummary) {
    /* Exceeded: teaching load (current_load) surpasses the available slot (regular_load_limit = Regular cap - deduction) */
    const exceeded = Math.max(0, s.current_load - s.regular_load_limit);
    if (exceeded > 0.001)          return { label: 'Exceeded',    dot: 'bg-red-500',    text: 'text-red-400'    } as const;
    if (s.has_overload)            return { label: 'Has Overload', dot: 'bg-orange-500', text: 'text-orange-500' } as const;
    if (isRegularLoadComplete(s.remaining_load, s.employment_status === 'Permanent')) return { label: 'Full Load',   dot: 'bg-amber-500',  text: 'text-amber-400'  } as const;
    const pct = s.regular_load_limit > 0 ? s.remaining_load / s.regular_load_limit : 1;
    if (pct <= 0.3)                return { label: 'Near Limit',  dot: 'bg-yellow-400', text: 'text-yellow-400' } as const;
    return                                { label: 'Available',   dot: 'bg-emerald-500', text: 'text-emerald-400' } as const;
  }

  /**
   * Lower = higher priority: instructors whose units/hours are not yet
   * complete come first, then those over the limit. Faculty with no summary
   * data yet sort after those but before "complete".
   */
  function workloadProblemPriority(s: FacultySummary | undefined): number {
    if (!s) return 2;
    const remaining = s.remaining_load;
    if (!isRegularLoadComplete(remaining, s.employment_status === 'Permanent')) return 0; // not yet complete
    if (remaining < -0.001) return 1; // exceeded the limit
    return 3;                          // exactly complete — no problem
  }

  const isAssigned = (f: Faculty) => (facultySummaries[f.id]?.assigned_count ?? 0) > 0;
  /* Search + employment type first, so the Assigned / Unassigned counts match what's searched */
  const searchedFaculty = faculty.filter(f => {
    const matchesSearch = !search ||
      f.name.toLowerCase().includes(search.toLowerCase()) ||
      f.employee_id.toLowerCase().includes(search.toLowerCase());
    const matchesType = !filterEmploymentType ||
      f.employment_status === filterEmploymentType;
    return matchesSearch && matchesType;
  });
  const assignedCount = searchedFaculty.filter(isAssigned).length;
  const filteredFaculty = searchedFaculty
    .filter(f => assignFilter === 'all' || (assignFilter === 'assigned') === isAssigned(f))
    .sort((a, b) => {
      const sa = facultySummaries[a.id];
      const sb = facultySummaries[b.id];
      const pa = workloadProblemPriority(sa);
      const pb = workloadProblemPriority(sb);
      if (pa !== pb) return pa - pb;
      // Permanent (units) before Contractual (hours) within each group
      const permA = a.employment_status === 'Permanent' ? 0 : 1;
      const permB = b.employment_status === 'Permanent' ? 0 : 1;
      if (permA !== permB) return permA - permB;
      if (pa === 0) {
        // Incomplete: lowest current units/hours first
        const loadA = sa?.current_load ?? 0;
        const loadB = sb?.current_load ?? 0;
        if (Math.abs(loadA - loadB) > 0.001) return loadA - loadB;
      }
      const devA = Math.abs(sa?.remaining_load ?? 0);
      const devB = Math.abs(sb?.remaining_load ?? 0);
      if (Math.abs(devA - devB) > 0.001) return devB - devA; // bigger shortfall/excess first
      if (filterEmploymentType === 'Permanent') {
        const rank = positionRank(a.position) - positionRank(b.position);
        if (rank) return rank;
      }
      return a.name.localeCompare(b.name);
    });
  /* The list shows one page at a time (the search dropdown still offers everyone) */
  const facultyPageCount = Math.max(1, Math.ceil(filteredFaculty.length / FACULTY_LIST_PAGE_SIZE));
  const safeFacultyPage = Math.min(facultyPage, facultyPageCount);
  const pagedFaculty = filteredFaculty.slice((safeFacultyPage - 1) * FACULTY_LIST_PAGE_SIZE, safeFacultyPage * FACULTY_LIST_PAGE_SIZE);
  function goToFacultyPage(next: number) {
    setFacultyPage(next);
    // From the pager at the bottom, bring the top of the list back into view
    // (scroll-mt on the list keeps it clear of the sticky top bar)
    const top = facultyListRef.current?.getBoundingClientRect().top ?? 0;
    if (top < 130) facultyListRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  const selectedBlock   = allBlocks.find(b => String(b.id) === filterBlock);
  const selectedProgram = programs.find(p => String(p.id) === filterProgram);
  const instructorSelected = selectedFaculty != null;
  // Only programs that have at least one block assigned to this faculty
  const programsForInstructor = (keepSubjectContext ? sortPrograms(programs) : programsAllowedForInstructor(selectedFaculty, programs))
    .filter(p => optionBlocks.some(b => b.program_id === p.id));
  /** Program select is usable once there's a faculty, or a subject being assigned. */
  const programEnabled = instructorSelected || keepSubjectContext;

  function loadBadge(load: WorkloadLoad, rowType: 'lec' | 'lab') {
    const lec2 = parseFloat(String(load.lecture_hours)) || 0;
    const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
    const hasBoth2 = lec2 > 0 && lab2 > 0;

    if (load.load_category === 'Overload') {
      // For lec+lab overload rows, only show badge on the lec (first) row
      if (hasBoth2 && rowType === 'lab') return null;
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30">
          <ArrowUpCircle className="w-3 h-3" /> Overload
        </span>
      );
    }

    if (load.load_category === 'Praise') {
      if (hasBoth2 && rowType === 'lab') return null;
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-violet-500/20 text-violet-400 border border-violet-500/30">
          <Award className="w-3 h-3" /> Praise Load
        </span>
      );
    }

    const splitOvVal = isPermanent
      ? parseFloat(String(load.split_overload_units)) || 0
      : parseFloat(String(load.split_overload_hours)) || 0;

    if (load.load_category === 'Regular' && splitOvVal > 0.001) {
      const oc = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
      if (hasBoth2 && oc !== 'full') {
        // Component-specific split: show Split only on the split component row, Regular on the other
        if (rowType === oc) {
          return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-500/15 text-orange-600 border border-orange-500/30">
              <ArrowUpCircle className="w-3 h-3" /> Split
            </span>
          );
        }
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-400 border border-blue-500/30">
            <CheckCircle2 className="w-3 h-3" /> Regular
          </span>
        );
      }
      // Full / single-component split: show Split on first (lec) row only
      if (hasBoth2 && rowType === 'lab') return null;
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-500/15 text-orange-600 border border-orange-500/30">
          <ArrowUpCircle className="w-3 h-3" /> Split
        </span>
      );
    }

    // Plain regular: show only on lec (first) row for lec+lab subjects
    if (hasBoth2 && rowType === 'lab') return null;
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-500/20 text-blue-400 border border-blue-500/30">
        <CheckCircle2 className="w-3 h-3" /> Regular
      </span>
    );
  }


  /* Subjects to Handle (Faculty profile): when set, only those subjects are
     offered here. Empty → every subject. A Master Schedule → Assign target stays visible. */
  const prioritySubjects = handledSubjects;
  const isPrioritySubject = (s: { subject_code: string; subject_name: string }) => prioritySubjects.some(p => isSameSubject(p, s));

  /* Subjects offered to this faculty across both tabs. Assigning a specific
     subject (Master Schedule / Block → Assign) offers only that one. */
  const offeredSchedules = availableSchedules.filter(s =>
    assignTarget ? s.id === assignTarget.id
      : prioritySubjects.length === 0 || isPrioritySubject(s)
  );
  const categoryOf = (s: Schedule) => coerceSubjectCategory(s.subject_category, 'Minor');
  const categoryCounts = {
    Minor: offeredSchedules.filter(s => categoryOf(s) === 'Minor').length,
    Major: offeredSchedules.filter(s => categoryOf(s) === 'Major').length,
  };
  /* Subject-table client-side search — scoped to the active Major/Minor tab */
  const categorySchedules = offeredSchedules.filter(s => categoryOf(s) === subjectCategory);

  /* Open the tab that has this faculty's subjects: Minor first, Major only when
     Minor is empty. After each fresh load (e.g. once the last subject of a tab is
     assigned) an empty tab hands over to the other one. A tab the user clicks is
     never overridden — this only reacts to new data. */
  const autoTabKey = useRef('');
  const wasAvailLoading = useRef(false);
  useEffect(() => {
    const justLoaded = wasAvailLoading.current && !availLoading;
    wasAvailLoading.current = availLoading;
    if (!selectedFaculty || !filtersApplied || availLoading || assignTarget) return;
    const key = `${selectedFaculty.id}|${filterBlock}|${filterSemester}|${filterAcademicYear}`;
    const firstLoad = autoTabKey.current !== key;
    if (!firstLoad && !justLoaded) return;
    autoTabKey.current = key;
    const other = subjectCategory === 'Minor' ? 'Major' : 'Minor';
    if (firstLoad) {
      setSubjectCategory(categoryCounts.Minor === 0 && categoryCounts.Major > 0 ? 'Major' : 'Minor');
    } else if (categoryCounts[subjectCategory] === 0 && categoryCounts[other] > 0) {
      setSubjectCategory(other);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFaculty?.id, filtersApplied, availLoading, assignTarget, filterBlock, filterSemester, filterAcademicYear, categoryCounts.Minor, categoryCounts.Major]);

  /* -- Multi-select: pick several subjects (either tab), assign in one save -- */
  const [pickedIds, setPickedIds] = useState<Set<number>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkState, setBulkState] = useState<'idle' | 'saving' | 'success'>('idle');
  const [bulkProgress, setBulkProgress] = useState(0);
  /** Size of the running/finished batch — the picked list empties once the table refreshes */
  const [bulkTotal, setBulkTotal] = useState(0);
  const [bulkNote, setBulkNote] = useState('');
  useEffect(() => { setPickedIds(new Set()); }, [selectedFaculty?.id, filterBlock, filterSemester, filterAcademicYear]);

  /* Live updates: loads, blocks, schedules or faculty changed elsewhere (another
     admin, another tab). Everything reloads quietly — the picked faculty,
     filters, subject tab, search and any open dialog stay as they are. Held
     while a multi-subject save runs. */
  useRealtime(
    ['workload', 'schedule', 'blocks', 'faculty'],
    () => Promise.all([
      loadBlocks(),
      loadFacultyList({ silent: true }),
      loadFacultySummaries(),
      loadWorkload(),
      loadAllFacultyLoads(),
      refreshAvailable(),
    ]),
    { enabled: !facultyListLoading && bulkState !== 'saving' },
  );
  const pickedSchedules = offeredSchedules.filter(s => pickedIds.has(s.id));
  const loadUnit = isPermanent ? 'units' : 'hours';
  const scheduleValue = (s: Schedule) => isPermanent
    ? calcWorkloadUnits(parseFloat(String(s.lecture_hours)) || 0, parseFloat(String(s.laboratory_hours)) || 0)
    : parseFloat(String(s.total_hours)) || 0;
  const pickedTotal = pickedSchedules.reduce((sum, s) => sum + scheduleValue(s), 0);

  function togglePicked(id: number) {
    setPickedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function setPickedMany(ids: number[], on: boolean) {
    setPickedIds(prev => {
      const next = new Set(prev);
      for (const id of ids) { if (on) next.add(id); else next.delete(id); }
      return next;
    });
  }

  /** The picked subjects go past the remaining regular load (e.g. beyond 18 units). */
  const pickedOver = remainingForWarning !== null && pickedTotal > remainingForWarning + 0.001;
  /** Contractual faculty can't go past their hours limit: a subject that doesn't fit can't be picked */
  const blockedOverLimit = (value: number) => !extraLoads && remainingForWarning !== null && value > remainingForWarning + 0.001;
  /** …and the picked subjects together may not go past it either — Assign is blocked */
  const pickedBlocked = !extraLoads && pickedOver;
  /** Why the picked subjects can't be assigned (Contractual, over the limit) */
  const pickedLimitError = (remaining: number | null, limit: number | null) => (
    selectedFaculty && remaining !== null && limit !== null
      ? contractualLimitError({ name: selectedFaculty.name, currentHours: limit - remaining, addHours: pickedTotal, limitHours: limit })
      : null
  );
  const regularLimitLabel = summary ? `${capText(summary.regular_load_limit, isPermanent)} ${loadUnit}` : `the regular ${loadUnit}`;

  /** Selection bar → Assign. Fits the remaining regular load → saved straight away,
   *  no pop-up. Goes past it → the dialog warns first. Checks a fresh load, so a
   *  stale or not-yet-loaded summary never shows the warning by mistake. */
  const [bulkChecking, setBulkChecking] = useState(false);
  async function onAssignPickedClick() {
    if (bulkState !== 'idle' || bulkChecking) return;
    setBulkChecking(true);
    const fresh = await loadWorkload();
    setBulkChecking(false);
    const remaining = fresh ? fresh.summary.remaining_regular_load : remainingForWarning;
    if (remaining != null && pickedTotal <= remaining + 0.001) void assignPicked({ direct: true });
    else if (!extraLoads) {
      // Contractual: nothing past the hours limit is saved
      const why = pickedLimitError(remaining ?? null, fresh?.summary.regular_load_limit ?? summary?.regular_load_limit ?? null);
      if (why) toast.error(why);
      else void assignPicked({ direct: true }); // load not known here — the server checks each subject
    }
    else setBulkOpen(true);
  }

  /** Saves every picked subject as Regular (over-limit ones can be moved to Overload after).
   *  `direct` = started from the bar without the dialog, so report with a toast. */
  async function assignPicked({ direct = false }: { direct?: boolean } = {}) {
    if (!selectedFaculty || pickedSchedules.length === 0 || bulkState !== 'idle') return;
    const list = pickedSchedules;
    setBulkState('saving');
    setBulkProgress(0);
    setBulkTotal(list.length);
    const failed: { id: number; error: string }[] = [];
    let remaining: number | null = null;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      try {
        const res = await fetch('/api/workload/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ faculty_id: selectedFaculty.id, master_schedule_id: s.id, assign_category: 'regular' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) failed.push({ id: s.id, error: `${s.subject_code}: ${data.error || 'could not be assigned.'}` });
        else if (typeof data.remaining === 'number') remaining = data.remaining;
      } catch {
        failed.push({ id: s.id, error: `${s.subject_code}: connection error.` });
      }
      setBulkProgress(i + 1);
    }
    loadWorkload(); loadAllFacultyLoads(); loadAvailable(); loadFacultySummaries(); loadBlocks();

    const done = list.length - failed.length;
    const note = remaining === null ? ''
      : remaining < -0.001 ? `${overFromRemaining(remaining, isPermanent).toFixed(2)} ${loadUnit} over the regular limit.`
      : `${leftNum(remaining, isPermanent).toFixed(2)} ${loadUnit} remaining.`;
    if (failed.length > 0) {
      setBulkState('idle');
      setPickedIds(new Set(failed.map(f => f.id)));
      if (done > 0) toast.success(`${done} subject${done === 1 ? '' : 's'} assigned. ${note}`.trim());
      toast.error(failed.length === 1 ? failed[0].error : `${failed.length} subjects were not assigned. ${failed[0].error}`);
      return;
    }
    if (direct) {
      toast.success(`${done === 1 ? 'Subject' : `${done} subjects`} assigned. ${note}`.trim());
      setBulkState('idle');
      setPickedIds(new Set());
      return;
    }
    setBulkNote(note);
    setBulkState('success');
    setTimeout(() => {
      setBulkOpen(false);
      setBulkState('idle');
      setPickedIds(new Set());
    }, 1500);
  }
  const displaySchedules = categorySchedules
    .filter(s =>
      !subjectSearch ||
      s.subject_code.toLowerCase().includes(subjectSearch.toLowerCase()) ||
      s.subject_name.toLowerCase().includes(subjectSearch.toLowerCase())
    )
    /* Priority subjects surface to the top — stable sort keeps each group's
       original relative order intact, so this only reorders priority vs not. */
    .slice()
    .sort((a, b) => Number(isPrioritySubject(b)) - Number(isPrioritySubject(a)));
  /* Block picked but its subjects not fetched yet counts as loading too — otherwise
     the empty "No available subjects" state flashes for a frame on every switch. */
  const subjectsBusy = availLoading || (allFiltersSet && !filtersApplied);
  const subjectsBusyHeld = useMinLoading(subjectsBusy, LOADING_DELAY);
  const showSubjectsSkeleton = subjectsBusy || subjectsBusyHeld;
  const showFacultyListSkeleton = useMinLoading(facultyListLoading, LOADING_DELAY);
  /* Tab switch is instant client-side filtering — only the list area fakes a
     brief load so it feels responsive; the tabs/search/badge stay visible
     throughout so the tab pill itself doesn't vanish mid-switch. */
  const showListSkeleton = showSubjectsSkeleton || categorySwitching || showPraiseDeleteSkeleton;

  /* Master Schedule → Assign: glide to the subject's row once it is on screen. */
  const assignTargetVisible = !!assignTarget && !showListSkeleton && displaySchedules.some(s => s.id === assignTarget.id);
  const scrolledAssignFor = useRef<number | null>(null);
  useEffect(() => {
    if (!assignTargetVisible || !selectedFaculty) { if (!selectedFaculty) scrolledAssignFor.current = null; return; }
    if (scrolledAssignFor.current === selectedFaculty.id) return;
    scrolledAssignFor.current = selectedFaculty.id;
    document.getElementById('assign-target-row')?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  }, [assignTargetVisible, selectedFaculty, reduceMotion]);
  /** Assigned during this visit (the subject now sits in the picked faculty's workload). */
  const assignTargetDone = !!assignTarget && allWorkloadLoads.some(l => l.ms_id === assignTarget.id);
  /** Someone else already took it — this link is stale. */
  const assignTargetTaken = !!assignTarget && !assignTargetDone && assignTarget.faculty_id != null
    && faculty.some(f => f.id === assignTarget.faculty_id);
  const assignBannerState = assignTargetDone ? 'done'
    : assignTargetTaken ? 'taken'
    : !selectedFaculty ? 'pick'
    : !targetBlockAllowed && allBlocks.length > 0 ? 'blocked'
    : 'ready';
  const assignReturnLabel = assignFrom === 'block' ? 'Back to Block' : 'Back to Master Schedule';
  function backToAssignSource() {
    if (window.history.length > 1) router.back();
    else router.push(assignFrom === 'block' && assignBlockId ? `/program/blocks/${assignBlockId}` : '/master-schedule');
  }

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <PageLoadTransition
        showSkeleton={showFacultyListSkeleton}
        className="space-y-5"
        skeleton={
          <div className="space-y-5" role="status" aria-live="polite" aria-label="Loading faculty workload">
            {/* Header skeleton */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <div className="space-y-2 min-w-0">
                <Skeleton className="h-7 w-48 rounded-md" />
                <Skeleton className="h-4 w-72 max-w-full rounded" />
              </div>
              <Skeleton className="h-10 w-40 rounded-xl flex-shrink-0" />
            </div>

            {/* Filter card skeleton */}
            <div className="bg-white rounded-2xl border border-[#E2E8F0]/70 shadow-sm p-5">
              <div className="mb-4 space-y-1.5">
                <Skeleton className="h-4 w-16 rounded" />
                <Skeleton className="h-3 w-56 rounded" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-4">
                {['lg:col-span-2', 'lg:col-span-3', 'lg:col-span-3', 'lg:col-span-2', 'lg:col-span-2'].map((span, i) => (
                  <div key={i} className={`min-w-0 space-y-1.5 ${span}`}>
                    <Skeleton className="h-3 w-20 rounded" />
                    <Skeleton className="h-[42px] w-full rounded-xl" />
                  </div>
                ))}
              </div>
            </div>

            {/* Select Subject card skeleton */}
            <div className="bg-[var(--surface-elevated)] rounded-2xl border border-[#E2E8F0]/70 shadow-sm overflow-hidden">
              <ListSkeleton rows={6} />
            </div>
          </div>
        }
      >
      {/* -- Page Header ------------------------------------------------------- */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 min-w-0">
        <div className="min-w-0">
          <BackButton />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:flex-shrink-0">
          {selectedFaculty && isPermanent && (
            <button
              type="button"
              onClick={() => openDeductionModal(selectedFaculty)}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 min-h-10 rounded-xl text-sm font-semibold border border-[#E2E8F0] bg-[var(--surface-elevated)] text-[#0B2A5B] hover:bg-[var(--background-secondary)] transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              Deloading
            </button>
          )}
          {selectedFaculty && isPermanent && (
            <button
              type="button"
              onClick={() => {
                const fill = (w: WorkloadSummary | null) => {
                  const current = praiseEntriesFrom((w?.praise ?? []) as PraiseRecordLite[]);
                  setPraiseEntries(current);
                  setPraiseOriginal(current);
                };
                fill(workload);
                // Workload not loaded yet → fill in as soon as it arrives
                if (!workload) void loadWorkload().then(fill);
                setPraiseError('');
                setPraiseModalOpen(true);
              }}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 min-h-10 rounded-xl text-sm font-semibold border border-[#E2E8F0] bg-[var(--surface-elevated)] text-[#0B2A5B] hover:bg-[var(--background-secondary)] transition-colors"
            >
              <Award className="w-3.5 h-3.5" />
              Add Praise Load
            </button>
          )}
          <button
            type="button"
            disabled={!selectedFaculty}
            onClick={() => {
              if (!selectedFaculty) return;
              setWorkloadModalOpen(true);
              setWorkloadModalTab('actual'); // first section; Workload when there are no subjects
            }}
            className={[
              'inline-flex items-center justify-center gap-2 px-4 min-h-10 rounded-xl text-sm font-semibold transition-colors',
              selectedFaculty
                ? 'bg-[#1D5BD6] text-white hover:bg-[#2E7DD1]'
                : 'bg-[#E4E6EB] text-[#64748B] cursor-not-allowed border border-[#D1D5DB]',
            ].join(' ')}
            title={selectedFaculty ? 'View assigned workload' : 'Select a faculty member first'}
          >
            <Eye className="w-4 h-4" aria-hidden />
            View Workload
          </button>
        </div>
      </div>
      <div className="mt-4 sm:mt-7 mb-10">
        <WatermarkTitle>Faculty Workload</WatermarkTitle>
      </div>

      {/* -- Master Schedule / Block → Assign: the subject is already known; only the faculty is picked -- */}
      {assignMsId && (assignTargetLoading ? (
        <Skeleton className="h-[88px] w-full rounded-2xl mb-5" />
      ) : assignTarget && (
        <div className="mb-5 bg-white rounded-2xl border border-[#E2E8F0] border-l-4 border-l-[#22C55E] shadow-sm px-4 sm:px-5 py-4 flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-6">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-[#15803D] uppercase tracking-wide">Assigning subject</div>
            <div className="mt-0.5 text-base sm:text-lg font-bold text-[#0B2A5B] break-words">
              <span className="font-mono">{assignTarget.subject_code}</span> — {assignTarget.subject_name}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs font-semibold">
              <span className="px-2 py-1 rounded-lg bg-[#F1F5F9] text-[#334155]">
                {assignTarget.program_code} · {assignTarget.year_level} · Block {assignTarget.block_name}
              </span>
              <span className="px-2 py-1 rounded-lg bg-[#EFF6FF] text-[#1D5BD6]">
                {coerceSubjectCategory(assignTarget.subject_category, 'Minor')} subject
              </span>
              {(parseFloat(String(assignTarget.lecture_hours)) || 0) > 0 && (
                <span className="px-2 py-1 rounded-lg bg-[#EFF6FF] text-[#1D5BD6]">Lec {parseFloat(String(assignTarget.lecture_hours))} hrs</span>
              )}
              {(parseFloat(String(assignTarget.laboratory_hours)) || 0) > 0 && (
                <span className="px-2 py-1 rounded-lg bg-amber-50 text-amber-700">Lab {parseFloat(String(assignTarget.laboratory_hours))} hrs</span>
              )}
              <span className="px-2 py-1 rounded-lg bg-[#F1F5F9] text-[#334155]">{parseFloat(String(assignTarget.units)).toFixed(2)} units</span>
            </div>
          </div>
          <div className="lg:max-w-sm text-sm font-medium flex-shrink-0">
            <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${assignBannerState}-${selectedFaculty?.id ?? 0}`}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            >
            {assignTargetDone ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[#15803D] font-semibold">
                  <CheckCircle2 className="w-4 h-4" /> Assigned to {selectedFaculty?.name}
                </span>
                <button type="button" onClick={backToAssignSource}
                  className="min-h-10 px-3.5 rounded-xl text-sm font-semibold bg-[#1D5BD6] text-white hover:bg-[#2E7DD1] transition-colors">
                  {assignReturnLabel}
                </button>
              </div>
            ) : assignTargetTaken ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[#B45309]">Already assigned to {assignTarget.faculty_name}.</span>
                <Link href={`/scheduling?step=schedule&faculty=${assignTarget.faculty_id}&ms=${assignTarget.id}`}
                  className="min-h-10 inline-flex items-center px-3.5 rounded-xl text-sm font-semibold bg-[#DCFCE7] text-[#15803D] border border-[#BBF7D0] hover:bg-[#BBF7D0] transition-colors">
                  Schedule
                </Link>
              </div>
            ) : !selectedFaculty ? (
              <span className="text-[#0B2A5B]">Select the faculty to assign it to.</span>
            ) : !targetBlockAllowed && allBlocks.length > 0 ? (
              <span className="inline-flex items-start gap-1.5 text-[#B45309]">
                <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                Block {assignTarget.block_name} is not among {selectedFaculty.name}’s assigned blocks. Choose another faculty.
              </span>
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="inline-flex items-center gap-2 text-[#0B2A5B]">
                  <motion.span
                    initial={reduceMotion ? false : { scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 22, delay: 0.1 }}
                    className="w-9 h-9 rounded-full bg-[#DCFCE7] text-[#15803D] border border-[#BBF7D0] flex items-center justify-center font-bold text-sm flex-shrink-0"
                    aria-hidden
                  >
                    {selectedFaculty.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()}
                  </motion.span>
                  <span className="min-w-0">Assigning to <span className="font-bold">{selectedFaculty.name}</span></span>
                  <EmploymentBadge status={selectedFaculty.employment_status} />
                </span>
                {(() => {
                  // Contractual: a subject past the hours limit can't be assigned — say so instead of "press +"
                  const why = assignTarget && !extraLoads && summary && remainingForWarning !== null
                    ? contractualLimitError({
                        name: selectedFaculty.name, subject: assignTarget.subject_code,
                        currentHours: summary.regular_load_limit - remainingForWarning,
                        addHours: scheduleValue(assignTarget), limitHours: summary.regular_load_limit,
                      })
                    : null;
                  return why
                    ? <span className="text-[#B91C1C] font-semibold">{why}</span>
                    : <span className="text-[#15803D]">Highlighted in green below — press + to assign.</span>;
                })()}
              </div>
            )}
            </motion.div>
            </AnimatePresence>
          </div>
        </div>
      ))}

      {/* -- Filter Card: Instructor → Program → Year & Block ----------------- */}
      <FilterBar className="relative z-20 min-w-0 overflow-visible mb-0">

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-4">

          <div className="min-w-0 order-1 lg:col-span-2">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Employment Type
            </label>
            <FriendlySelect
              value={filterEmploymentType}
              onChange={v => { setFilterEmploymentType(v); resetInstructorAndFilters(); }}
              label="Employment Type"
              minPanelWidth={240}
              options={[
                { value: '', label: 'All Types' },
                { value: 'Permanent', label: 'Permanent', hint: 'Load counted in units' },
                { value: 'Contractual', label: 'Contractual', hint: 'Load counted in hours' },
              ]}
            />
          </div>

          <div className="min-w-0 w-full order-2 lg:col-span-3">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Faculty <span className="text-red-500">*</span>
            </label>
            <div className="relative" ref={instructorDropRef}>
              <div className={`flex items-center gap-2 rounded-xl px-3 min-h-[42px] py-2.5 transition-all duration-200 ${
                selectedFaculty
                  ? 'bg-white shadow-[0_1px_3px_rgba(0,0,0,0.05)] hover:bg-slate-50 focus-within:shadow-[0_2px_12px_rgba(0,0,0,0.09)]'
                  : `bg-slate-100 hover:bg-slate-200/60 focus-within:bg-white focus-within:shadow-[0_2px_12px_rgba(0,0,0,0.09)] ${!search ? 'qr-guide-pulse' : ''}`
              }`}>
                <input
                  value={selectedFaculty ? selectedFaculty.name : search}
                  onChange={e => {
                    setSearch(e.target.value);
                    setSelectedFaculty(null);
                    setWorkload(null);
                    clearProgramChain();
                    setShowInstructorDropdown(true);
                  }}
                  onFocus={() => setShowInstructorDropdown(true)}
                  placeholder="Search faculty by name or ID…"
                  aria-required="true"
                  aria-label="Faculty"
                  className="flex-1 min-w-0 text-sm text-slate-800 placeholder:text-slate-400 bg-transparent border-0 outline-none"
                />
                {selectedFaculty && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFaculty(null);
                      setWorkload(null);
                      setSearch('');
                      clearProgramChain();
                    }}
                    className="text-slate-400 hover:text-slate-600 flex-shrink-0 min-h-8 min-w-8 inline-flex items-center justify-center rounded-full hover:bg-slate-200/80"
                    aria-label="Clear faculty"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
              {showInstructorDropdown && !selectedFaculty && filteredFaculty.length > 0 && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-64 overflow-y-auto overscroll-contain">
                  {filteredFaculty.map(f => {
                    const fSummary = facultySummaries[f.id];
                    const status   = fSummary ? getFacultyStatus(fSummary) : null;
                    const isP      = f.employment_status === 'Permanent';
                    const unit     = isP ? 'units' : 'hrs';
                    const limit    = fSummary?.regular_load_limit ?? 0;
                    const current  = fSummary?.current_load ?? 0;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => {
                          selectFaculty(f);
                          setShowInstructorDropdown(false);
                          if (f.employment_status === 'Permanent') {
                            void openDeductionModal(f);
                          }
                        }}
                        className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-slate-800 text-sm break-words">{f.name}</span>
                              <EmploymentBadge status={f.employment_status} />
                            </div>
                            {f.specialization && (
                              <div className="text-xs text-[#1D5BD6] mt-0.5 break-words">{f.specialization}</div>
                            )}
                            <div className="text-xs text-slate-500 mt-0.5">{f.employee_id}{f.program_code ? ` · ${f.program_code}` : ''}</div>
                          </div>
                          {status && (
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              <span className={`w-2 h-2 rounded-full ${status.dot}`} />
                              <span className={`text-xs font-medium ${status.text}`}>{status.label}</span>
                            </div>
                          )}
                        </div>
                        {fSummary && (
                          <div className="mt-1 text-xs text-slate-400">Current Load: {current.toFixed(2)} / {capText(limit, isP)} {unit}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0 w-full order-3 lg:col-span-4">
            <label
              className={`block text-xs font-semibold uppercase tracking-wide mb-1.5 ${
                programEnabled ? 'text-slate-500' : 'text-slate-400'
              }`}
            >
              Program
            </label>
            <FriendlySelect
              value={programEnabled ? filterProgram : ''}
              onChange={handleProgramChange}
              disabled={!programEnabled || keepSubjectContext /* locked to the subject being assigned */}
              label="Program"
              placeholder="Select Program"
              disabledText="Select a faculty first"
              guide={programEnabled && !filterProgram}
              minPanelWidth={380}
              showHintInTrigger
              options={programsForInstructor.map(p => ({ value: String(p.id), label: p.code, hint: p.name }))}
            />

          </div>

          <div className="min-w-0 order-4 lg:col-span-3">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Year &amp; Block
            </label>
            <FriendlySelect
              value={filterBlock}
              onChange={handleYearBlockChange}
              disabled={!filterProgram || keepSubjectContext /* locked to the subject being assigned */}
              label="Year & Block"
              placeholder="Select Year & Block"
              disabledText={keepSubjectContext ? 'Loading…' : 'Select a program first'}
              guide={!!filterProgram && !filterBlock}
              minPanelWidth={320}
              searchable
              searchPlaceholder="Search, e.g. 1A"
              options={programBlocks.map(b => {
                const complete = isBlockFullyAssigned(b);
                const open = blockAvailableCount(b, handledSubjects);
                return {
                  value: String(b.id),
                  label: `${extractYearNum(b.year_level)}${b.block_name}`,
                  hint: `${b.year_level}, Block ${b.block_name} · ${curriculumVersionLabel(blockCurriculumVersion(b.curriculum_version))}`,
                  badge: complete ? 'All assigned' : `${open} available`,
                  badgeTone: !complete && open > 0 ? 'green' as const : 'muted' as const,
                  disabled: complete,
                };
              })}
            />
          </div>
        </div>
      </FilterBar>


      {/* Select Subject */}
          <div
            key={selectedFaculty ? `faculty-${selectedFaculty.id}` : 'instructor-list'}
            className="bg-[var(--surface-elevated)] rounded-2xl border border-[#E2E8F0]/70 shadow-sm overflow-hidden qr-content-fade-in"
          >
            {selectedFaculty && (
              <div className="bg-[#1D5BD6] px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-base text-white leading-tight break-words">Select Subject</div>
                  <div className="text-sm mt-0.5 font-medium text-white/85">Pick a subject to assign to this faculty</div>
                </div>
                {filtersApplied && !showSubjectsSkeleton && (
                  <span className="self-start sm:self-center bg-white/20 text-white text-xs font-semibold px-3 py-1 rounded-full flex-shrink-0">
                    {categorySchedules.length} available
                  </span>
                )}
              </div>
            )}

            {selectedFaculty && allFiltersSet && !showSubjectsSkeleton && (
              <div className="px-6 pt-3">
                <div
                  role="tablist"
                  aria-label="Subject category"
                  className="grid grid-cols-2 gap-3"
                >
                  {(['Minor', 'Major'] as const).map(cat => {
                    const active = subjectCategory === cat;
                    // Same colours as Lecture / Laboratory (Scheduling): Minor = Lec blue, Major = Lab amber.
                    // Selected tab is filled; the other stays white with a tinted outline.
                    const tone = cat === 'Major'
                      ? active
                        ? 'bg-amber-50 border-amber-500 text-amber-800 shadow-sm ring-2 ring-amber-500/15'
                        : 'bg-white border-amber-200 text-amber-700 hover:bg-amber-50'
                      : active
                        ? 'bg-[#EFF6FF] border-[#1D5BD6] text-[#1D5BD6] shadow-sm ring-2 ring-[#1D5BD6]/15'
                        : 'bg-white border-[#BFDBFE] text-[#1D5BD6] hover:bg-[#EFF6FF]';
                    const count = categoryCounts[cat];
                    const badge = count === 0
                      ? 'bg-[#F1F5F9] text-[#94A3B8]'
                      : cat === 'Major'
                        ? active ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-700'
                        : active ? 'bg-[#1D5BD6] text-white' : 'bg-[#EFF6FF] text-[#1D5BD6]';
                    return (
                      <button
                        key={cat}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-label={`${cat} Subjects, ${count} available`}
                        onClick={() => handleSubjectCategoryChange(cat)}
                        className={`min-h-[44px] px-2 sm:px-3 py-2 rounded-xl border text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors duration-300 inline-flex items-center justify-center gap-2 ${tone}`}
                      >
                        {cat} Subjects
                        <motion.span
                          key={count}
                          initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                          className={`min-w-[24px] h-6 px-1.5 rounded-full text-xs font-bold tabular-nums inline-flex items-center justify-center transition-colors duration-300 ${badge}`}
                        >
                          {count}
                        </motion.span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {selectedFaculty && allFiltersSet && !showSubjectsSkeleton && (
              <div className="px-6 py-3 border-b border-slate-100">
                <SearchInput showIcon={false} value={subjectSearch} onChange={setSubjectSearch} placeholder="Search by code or subject name…" />
              </div>
            )}

            {!selectedFaculty && (
              <CountFilterTabs
                className="px-6 py-4 border-b border-[#E2E8F0]"
                label="Filter by subject assignment"
                layoutId="workload-assign-filter"
                value={assignFilter}
                onChange={setAssignFilter}
                options={[
                  { key: 'all', label: 'All', count: searchedFaculty.length, color: '#0B2A5B' },
                  { key: 'assigned', label: 'Assigned', count: assignedCount, color: '#15803D', dot: '#16A34A' },
                  { key: 'unassigned', label: 'Unassigned', count: searchedFaculty.length - assignedCount, color: '#B91C1C', dot: '#DC2626' },
                ]}
              />
            )}

            {!selectedFaculty ? (
              <>
              {/* All / Assigned / Unassigned, or another page: the old list fades out, the new one fades in */}
              <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`faculty-list-${assignFilter}-${safeFacultyPage}`}
                ref={facultyListRef}
                className="scroll-mt-32"
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.28, ease: [0.4, 0, 0.2, 1] } }}
                exit={reduceMotion ? undefined : { opacity: 0, transition: { duration: 0.14, ease: [0.4, 0, 0.2, 1] } }}
              >
              {filteredFaculty.length === 0 ? (
                <div className="py-14 px-8 text-center">
                  <p className="text-sm text-[#64748B]">
                    {assignFilter === 'unassigned' && searchedFaculty.length > 0
                      ? 'Every faculty member has a subject this term.'
                      : assignFilter === 'assigned' && searchedFaculty.length > 0
                        ? 'No faculty member has a subject yet this term.'
                        : 'No faculty found.'}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#F8FAFC] text-xs font-semibold text-[#64748B] uppercase tracking-wide border-b border-[#E2E8F0]">
                        <th className="px-4 sm:px-6 py-3 text-left">Faculty</th>
                        <th className="hidden sm:table-cell px-6 py-3 text-left">Program</th>
                        <th className="hidden sm:table-cell px-6 py-3 text-left">Status</th>
                        <th className="px-4 sm:px-6 py-3 text-left">Load</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {pagedFaculty.map((f, rowIdx) => {
                        const fSummary = facultySummaries[f.id];
                        const status   = fSummary ? getFacultyStatus(fSummary) : null;
                        const isP      = f.employment_status === 'Permanent';
                        const unit     = isP ? 'units' : 'hrs';
                        const limit    = fSummary?.regular_load_limit ?? 0;
                        const current  = fSummary?.current_load ?? 0;
                        return (
                          <motion.tr
                            // The list remounts per filter (above), so rows ease in once with a light stagger
                            key={f.id}
                            initial={reduceMotion ? false : { opacity: 0 }}
                            animate={{ opacity: 1 }}
                            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1], delay: reduceMotion ? 0 : Math.min(rowIdx, 10) * 0.025 }}
                            onClick={() => {
                              selectFaculty(f);
                              if (f.employment_status === 'Permanent') void openDeductionModal(f);
                            }}
                            className="cursor-pointer hover:bg-slate-50 active:bg-slate-100 transition-colors duration-200"
                          >
                            <td className="px-4 sm:px-6 py-3 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-slate-800 break-words">{f.name}</span>
                                <EmploymentBadge status={f.employment_status} />
                              </div>
                              {f.specialization && (
                                <div className="text-xs text-[#1D5BD6] mt-0.5">{f.specialization}</div>
                              )}
                              <div className="text-xs text-slate-500 mt-0.5">{f.employee_id}</div>
                              {/* Phone: program + status move under the name */}
                              <div className="sm:hidden mt-1 flex items-center gap-2 flex-wrap text-xs text-slate-600">
                                <span>{f.program_code || '—'}</span>
                                {status && (
                                  <span className="inline-flex items-center gap-1.5">
                                    <span className={`w-2 h-2 rounded-full ${status.dot}`} />
                                    <span className={`font-medium ${status.text}`}>{status.label}</span>
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="hidden sm:table-cell px-6 py-3 text-slate-600">{f.program_code || '—'}</td>
                            <td className="hidden sm:table-cell px-6 py-3">
                              {status ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <span className={`w-2 h-2 rounded-full ${status.dot}`} />
                                  <span className={`text-xs font-medium ${status.text}`}>{status.label}</span>
                                </span>
                              ) : (
                                <span className="text-xs text-slate-400">—</span>
                              )}
                            </td>
                            <td className="px-4 sm:px-6 py-3 tabular-nums whitespace-nowrap align-top sm:align-middle">
                              {fSummary ? (() => {
                                const incomplete = workloadProblemPriority(fSummary) !== 3;
                                return (
                                  <span
                                    className={incomplete ? 'qr-attention-dot font-bold text-red-600' : 'text-slate-600'}
                                    title={incomplete ? 'Incomplete workload — needs attention' : undefined}
                                  >
                                    {current.toFixed(2)} / {capText(limit, isP)} {unit}
                                  </span>
                                );
                              })() : (
                                <span className="text-slate-600">—</span>
                              )}
                            </td>
                          </motion.tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              </motion.div>
              </AnimatePresence>
              {/* Outside the fading list, so it stays put and its highlight slides to the new page */}
              <Pagination
                className="px-4 sm:px-6 py-4 border-t border-[#E2E8F0]"
                layoutId="workload-faculty-page"
                page={safeFacultyPage}
                pageCount={facultyPageCount}
                onChange={goToFacultyPage}
                total={filteredFaculty.length}
                pageSize={FACULTY_LIST_PAGE_SIZE}
                noun="faculty"
              />
              </>
            ) : !allFiltersSet ? (
              <div className="py-14 px-8 text-center">
                <p className="text-sm text-[#64748B]">No subjects to display.</p>
              </div>
            ) : showListSkeleton ? (
              <div className="p-4 sm:p-6">
                <ListSkeleton rows={6} />
              </div>
            ) : displaySchedules.length === 0 ? (
              <motion.div
                key={`empty-${filterBlock}-${subjectCategory}`}
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                className="py-14 px-8 text-center"
              >
                <div className="w-14 h-14 bg-[#FEF9C3] rounded-2xl flex items-center justify-center mx-auto mb-4 border border-[#FDE68A]">
                  <AlertTriangle className="w-7 h-7 text-[#CA8A04]" />
                </div>
                <p className="text-[#0B2A5B] font-semibold text-base mb-1">
                  {subjectSearch
                    ? 'No Results Found'
                    : subjectCategory === 'Minor'
                      ? 'No available minor subjects.'
                      : 'No available major subjects.'}
                </p>
                <p className="text-sm text-[#64748B]">
                  {subjectSearch
                    ? 'Try a different search term.'
                    : prioritySubjects.length > 0 && availableSchedules.length > 0
                      ? 'Only this faculty\'s Subjects to Handle are listed. Check the other tab or block, or edit them in Faculty.'
                    : categorySchedules.length === 0 && availableSchedules.length > 0
                      ? `Switch to ${subjectCategory === 'Minor' ? 'Major' : 'Minor'} Subjects to see the remaining unassigned subjects.`
                      : 'All subjects in this block may already be assigned to a faculty member.'}
                </p>
              </motion.div>
            ) : (
              <motion.div
                key={`list-${filterBlock}`}
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                className="overflow-x-auto"
              >
                <table className="w-full">
                  <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                    <tr>
                      <th className="pl-3 sm:pl-5 pr-1 py-3 w-10">
                        {(() => {
                          const tabIds = displaySchedules.filter(s => !blockedOverLimit(scheduleValue(s))).map(s => s.id);
                          const pickedHere = tabIds.filter(id => pickedIds.has(id)).length;
                          const all = pickedHere > 0 && pickedHere === tabIds.length;
                          return (
                            <PickBox
                              checked={all}
                              mixed={pickedHere > 0 && !all}
                              onToggle={() => setPickedMany(tabIds, !all)}
                              label={all ? 'Unselect all subjects in this tab' : 'Select all subjects in this tab'}
                            />
                          );
                        })()}
                      </th>
                      {['Code', 'Subject Name', 'Lec', 'Lab', isPermanent ? 'Units' : 'Hrs', ''].map(h => (
                        <th key={h} className={`text-left px-3 sm:px-5 py-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide ${h === 'Lec' || h === 'Lab' ? 'hidden sm:table-cell' : ''}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1F5F9]">
                    {displaySchedules.map(s => {
                      const lecH = parseFloat(String(s.lecture_hours)) || 0;
                      const labH = parseFloat(String(s.laboratory_hours)) || 0;
                      const wu   = isPermanent ? calcWorkloadUnits(lecH, labH) : parseFloat(String(s.total_hours));
                      const willExceed = remainingForWarning !== null && (
                        remainingForWarning <= 0.001 || wu > remainingForWarning + 0.001
                      );
                      // Contractual: a subject past the hours left can't be picked or assigned
                      const blocked = blockedOverLimit(wu);
                      const isPriority = isPrioritySubject(s);
                      const isPicked = pickedIds.has(s.id);
                      const isAssignTarget = assignTarget?.id === s.id;
                      const animateTarget = isAssignTarget && !reduceMotion;
                      /* Soft ring pulse on the + button so the next step is obvious. */
                      const plusPulse = animateTarget ? {
                        animate: { boxShadow: [`0 0 0 0 ${willExceed ? 'rgba(220,38,38,0.45)' : 'rgba(34,197,94,0.55)'}`, '0 0 0 12px rgba(34,197,94,0)'] },
                        transition: { duration: 1.2, repeat: 2, delay: 1.2, ease: 'easeOut' as const },
                        whileTap: { scale: 0.92 },
                      } : {};
                      return (
                        <motion.tr
                          key={isAssignTarget ? `${s.id}-f${selectedFaculty?.id ?? 0}` : s.id}
                          id={isAssignTarget ? 'assign-target-row' : undefined}
                          initial={animateTarget ? { backgroundColor: '#FFFFFF' } : false}
                          animate={animateTarget ? { backgroundColor: ['#FFFFFF', '#86EFAC', '#DCFCE7'] } : undefined}
                          transition={animateTarget ? { duration: 1.1, ease: 'easeOut', delay: 0.35 } : undefined}
                          onClick={() => { if (!blocked) togglePicked(s.id); }}
                          aria-selected={isPicked}
                          aria-disabled={blocked || undefined}
                          className={`${blocked ? 'cursor-not-allowed' : 'cursor-pointer'} transition-colors duration-300 ${
                            isAssignTarget ? 'bg-[#DCFCE7] border-l-[3px] border-l-[#22C55E] ring-2 ring-inset ring-[#22C55E]'
                              : isPicked ? 'bg-[#DBEAFE] hover:bg-[#CFE0FB] border-l-[3px] border-l-[#1D5BD6]'
                              : willExceed ? 'bg-[#FEF2F2] hover:bg-red-50'
                              : isPriority ? 'bg-[#DCFCE7] hover:bg-[#BBF7D0] border-l-[3px] border-l-[#22C55E]'
                              : 'hover:bg-[#F8FAFC]'
                          }`}
                        >
                          <td className="pl-3 sm:pl-5 pr-1 py-4 align-middle">
                            {blocked && !isPicked
                              ? <span aria-hidden className="block w-6 h-6 rounded-md border-2 border-[#E2E8F0] bg-[#F1F5F9]" />
                              : <PickBox checked={isPicked} onToggle={() => togglePicked(s.id)} label={`Select ${s.subject_code}`} />}
                          </td>
                          <td className="px-3 sm:px-5 py-4 font-mono font-semibold text-[#0B2A5B] text-sm align-middle whitespace-nowrap">{s.subject_code}</td>
                          <td className="px-3 sm:px-5 py-4 align-middle">
                            <div className="min-w-[120px] sm:min-w-[160px]" style={{ maxWidth: 280 }}>
                              <div
                                className="text-[#0B2A5B] text-sm font-medium leading-snug"
                                style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}
                                title={s.subject_name}
                              >
                                {s.subject_name}
                              </div>
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {isAssignTarget && (
                                  <motion.span
                                    initial={reduceMotion ? false : { opacity: 0, x: -6 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    transition={{ duration: 0.3, delay: 0.5 }}
                                    className="px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-[#15803D] text-white"
                                  >
                                    Assigning
                                  </motion.span>
                                )}
                                {lecH > 0 && (
                                  <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-[#EFF6FF] text-[#1D5BD6]">Lec</span>
                                )}
                                {labH > 0 && (
                                  <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-amber-50 text-amber-700">Lab</span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="hidden sm:table-cell px-5 py-4 text-center text-[#64748B] text-sm align-middle">{lecH > 0 ? lecH : '—'}</td>
                          <td className="hidden sm:table-cell px-5 py-4 text-center text-[#64748B] text-sm align-middle">{labH > 0 ? labH : '—'}</td>
                          <td className={`px-3 sm:px-5 py-4 text-center font-bold text-base align-middle ${willExceed ? 'text-[#DC2626]' : 'text-[#1D5BD6]'}`}>
                            {wu.toFixed(2)}
                          </td>
                          <td className="px-3 sm:px-5 py-4 align-middle">
                            {blocked ? (
                              <span
                                title={`Only ${Math.max(0, remainingForWarning ?? 0).toFixed(2)} hours left — Contractual faculty can't go over ${regularLimitLabel}`}
                                className="inline-flex items-center gap-1 h-9 px-2.5 rounded-full bg-[#FEE2E2] text-[#B91C1C] border border-[#FECACA] text-[11px] font-bold whitespace-nowrap"
                              >
                                <Ban className="w-3.5 h-3.5" /> Exceeds limit
                              </span>
                            ) : willExceed ? (
                              <motion.button
                                {...plusPulse}
                                onClick={e => { e.stopPropagation(); assignSubject(s.id); }}
                                title="Exceeds remaining regular load — will require confirmation"
                                className="flex items-center justify-center w-9 h-9 rounded-full bg-[#FEE2E2] text-[#DC2626] border border-[#FECACA] hover:bg-[#FECACA] transition-colors"
                              >
                                <AlertTriangle className="w-4 h-4" />
                              </motion.button>
                            ) : (
                              <motion.button
                                {...plusPulse}
                                onClick={e => { e.stopPropagation(); assignSubject(s.id); }}
                                title="Assign to faculty"
                                className="flex items-center justify-center w-9 h-9 rounded-full transition-colors shadow-sm"
                                style={{ backgroundColor: '#1D5BD6', color: '#ffffff' }}
                                onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#2E7DD1')}
                                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#1D5BD6')}
                              >
                                <Plus className="w-4 h-4" />
                              </motion.button>
                            )}
                          </td>
                        </motion.tr>
                      );
                    })}
                  </tbody>
                </table>
              </motion.div>
            )}
        </div>
        {/* Room for the picked-subjects bar so it never covers the last row */}
        {selectedFaculty && pickedSchedules.length > 0 && <div className="h-36 sm:h-24" aria-hidden="true" />}
      </PageLoadTransition>

      {/* -- Picked subjects bar — slides up once something is ticked -- */}
      <AnimatePresence>
        {selectedFaculty && pickedSchedules.length > 0 && !bulkOpen && (() => {
          const n = pickedSchedules.length;
          const minor = pickedSchedules.filter(x => categoryOf(x) === 'Minor').length;
          const ease = [0.4, 0, 0.2, 1] as const;
          return (
            <motion.div
              key="picked-bar"
              initial={reduceMotion ? false : { opacity: 0, y: 28 }}
              animate={{ opacity: 1, y: 0, transition: { duration: reduceMotion ? 0 : 0.4, ease } }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : 28, transition: { duration: reduceMotion ? 0 : 0.3, ease } }}
              className="fixed inset-x-0 bottom-5 z-40 flex justify-center px-4 pointer-events-none"
            >
              <div className={`pointer-events-auto w-full max-w-2xl bg-white border rounded-2xl shadow-[0_16px_40px_-12px_rgba(11,42,91,0.35)] px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-3 transition-colors duration-300 ${
                pickedOver ? 'border-[#FCA5A5]' : 'border-[#D6E0EF]'
              }`}>
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <motion.span
                    key={n}
                    initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.3, ease }}
                    className="w-10 h-10 rounded-full bg-[#1D5BD6] text-white text-base font-bold flex items-center justify-center tabular-nums flex-shrink-0"
                  >
                    {n}
                  </motion.span>
                  <div className="min-w-0">
                    <p className="font-semibold text-[#0B2A5B] text-[15px] leading-tight">
                      {n} subject{n === 1 ? '' : 's'} selected
                    </p>
                    {/* Over the regular load: one short red line — the pop-up waits for Assign */}
                    {pickedOver && remainingForWarning !== null ? (
                      <p className="flex items-center gap-1.5 text-sm font-semibold text-[#DC2626] tabular-nums mt-0.5">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0" aria-hidden />
                        {overFromRemaining(remainingForWarning - pickedTotal, isPermanent).toFixed(2)} {loadUnit} over the {regularLimitLabel} limit
                        {pickedBlocked && ' — remove a subject'}
                      </p>
                    ) : (
                      <p className="text-sm text-[#64748B] tabular-nums mt-0.5">
                        {pickedTotal.toFixed(2)} {loadUnit}
                        {minor > 0 && ` · ${minor} Minor`}
                        {n - minor > 0 && ` · ${n - minor} Major`}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <motion.button
                    type="button"
                    whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                    onClick={() => setPickedIds(new Set())}
                    className="flex-1 sm:flex-none h-11 px-4 rounded-xl border border-[#E2E8F0] text-[#475569] text-sm font-semibold hover:bg-[#F8FAFC] transition-colors duration-300"
                  >
                    Clear
                  </motion.button>
                  <motion.button
                    type="button"
                    whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                    onClick={() => { void onAssignPickedClick(); }}
                    disabled={bulkState !== 'idle' || bulkChecking || pickedBlocked}
                    title={pickedBlocked ? `Contractual faculty can't go over ${regularLimitLabel}` : undefined}
                    className={`flex-1 sm:flex-none h-11 px-5 rounded-xl bg-[#1D5BD6] hover:bg-[#2E7DD1] text-white text-sm font-bold inline-flex items-center justify-center gap-2 transition-colors duration-300 ${
                      pickedBlocked ? 'opacity-50 cursor-not-allowed' : 'disabled:cursor-wait disabled:opacity-90'
                    }`}
                  >
                    {bulkState === 'saving'
                      ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Assigning {Math.min(bulkProgress + 1, bulkTotal)} of {bulkTotal}…</>
                      : bulkChecking
                      ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Checking load…</>
                      : <><Plus className="w-4 h-4" /> Assign {n === 1 ? 'Subject' : `${n} Subjects`}</>}
                  </motion.button>
                </div>
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>

      {/* -- Assign Selected Subjects — one save for every ticked subject -- */}
      <Modal
        open={bulkOpen}
        onClose={() => { if (bulkState === 'idle') setBulkOpen(false); }}
        title={pickedOver ? `Exceeds ${regularLimitLabel} Regular Load` : 'Assign Selected Subjects'}
        subtitle={selectedFaculty?.name}
        size="lg"
        footer={
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setBulkOpen(false)}
              disabled={bulkState !== 'idle'}
              className="flex-1 border border-[#E2E8F0] text-[#64748B] py-2.5 rounded-xl text-sm font-semibold hover:bg-[#F8FAFC] transition-colors duration-300 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void assignPicked(); }}
              disabled={bulkState !== 'idle' || pickedSchedules.length === 0 || pickedBlocked}
              className="flex-1 bg-[#1D5BD6] hover:bg-[#2E7DD1] text-white py-2.5 rounded-xl text-sm font-bold transition-colors duration-300 flex items-center justify-center gap-2 disabled:cursor-wait disabled:opacity-80"
            >
              {bulkState === 'saving'
                ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Assigning {Math.min(bulkProgress + 1, bulkTotal)} of {bulkTotal}…</>
                : `Assign ${pickedSchedules.length === 1 ? 'Subject' : `${pickedSchedules.length} Subjects`}`}
            </button>
          </div>
        }
      >
        {bulkState === 'success' && (
          <AssignSuccess note={bulkNote} title={bulkTotal === 1 ? 'Subject assigned!' : `${bulkTotal} subjects assigned!`} />
        )}
        <div className="space-y-4">
          <ul className="rounded-xl border border-[#E2E8F0] divide-y divide-[#F1F5F9] max-h-[320px] overflow-y-auto">
            <AnimatePresence initial={false}>
              {pickedSchedules.map(x => {
                const cat = categoryOf(x);
                return (
                  <motion.li
                    key={x.id}
                    initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                    transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-semibold text-sm text-[#0B2A5B]">{x.subject_code}</span>
                          <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${cat === 'Major' ? 'bg-amber-50 text-amber-700' : 'bg-[#EFF6FF] text-[#1D5BD6]'}`}>
                            {cat}
                          </span>
                        </div>
                        <p className="text-sm text-[#475569] truncate mt-0.5" title={x.subject_name}>{x.subject_name}</p>
                      </div>
                      <span className="font-bold text-[#1D5BD6] tabular-nums text-sm">{scheduleValue(x).toFixed(2)}</span>
                      <button
                        type="button"
                        disabled={bulkState !== 'idle'}
                        onClick={() => {
                          togglePicked(x.id);
                          if (pickedSchedules.length === 1) setBulkOpen(false);
                        }}
                        aria-label={`Remove ${x.subject_code}`}
                        className="w-8 h-8 rounded-lg flex items-center justify-center text-[#94A3B8] hover:text-[#DC2626] hover:bg-[#FEF2F2] transition-colors duration-300 disabled:opacity-40"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>

          {remainingForWarning !== null && (() => {
            const after = remainingForWarning - pickedTotal;
            const over = after < -0.001;
            return (
              <>
                <div className="bg-[#F8FAFC] rounded-xl border border-[#E2E8F0] p-4 space-y-2.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-[#64748B]">Remaining regular balance</span>
                    <span className="font-semibold text-[#0B2A5B] tabular-nums">{leftNum(remainingForWarning, isPermanent).toFixed(2)} {loadUnit}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#64748B]">Selected subjects</span>
                    <span className="font-semibold text-[#1D5BD6] tabular-nums">+{pickedTotal.toFixed(2)} {loadUnit}</span>
                  </div>
                  <div className="flex justify-between border-t border-[#E2E8F0] pt-2.5">
                    <span className="text-[#64748B]">After assigning</span>
                    <span className={`font-semibold tabular-nums ${over ? 'text-[#DC2626]' : 'text-[#16A34A]'}`}>
                      {over ? `${overFromRemaining(after, isPermanent).toFixed(2)} ${loadUnit} over the limit` : `${leftNum(after, isPermanent).toFixed(2)} ${loadUnit} left`}
                    </span>
                  </div>
                </div>
                {over && (
                  <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-xl p-3.5 flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-[#DC2626] flex-shrink-0 mt-0.5" />
                    <p className="text-[#0B2A5B] text-sm leading-relaxed">
                      <span className="font-semibold">{selectedFaculty?.name ?? 'This faculty'}</span> will go past the {regularLimitLabel} regular
                      load by <span className="font-semibold text-[#DC2626]">{overFromRemaining(after, isPermanent).toFixed(2)} {loadUnit}</span>.{' '}
                      {extraLoads
                        ? 'You can still assign them, then move any to Overload in View Workload.'
                        : 'Contractual faculty can\'t go over it — remove a subject to continue.'}
                    </p>
                  </div>
                )}
              </>
            );
          })()}

          <AnimatePresence>
            {bulkState === 'saving' && (
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                className="overflow-hidden"
              >
                <div className="h-2 rounded-full bg-[#E2E8F0] overflow-hidden">
                  <motion.div
                    className="h-full rounded-full bg-[#1D5BD6]"
                    initial={{ width: 0 }}
                    animate={{ width: `${(bulkProgress / Math.max(1, bulkTotal)) * 100}%` }}
                    transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Modal>

      {/* -- Overload Warning Modal --------------------------------------------
          Shown when assigning would exceed the regular load limit (fully or
          partially). Admin must explicitly choose to continue or ignore.
          ------------------------------------------------------------------- */}
      <Modal open={!!overloadConfirm} onClose={() => { if (continueState !== 'saving') setOverloadConfirm(null); }} title="Overload Warning">
        {continueState === 'success' && overloadConfirm && <AssignSuccess note={continueNote} />}
        <div className="space-y-4">
          <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[#DC2626] flex-shrink-0 mt-0.5" />
            <p className="text-[#0B2A5B] text-sm leading-relaxed">
              This subject will exceed the regular load limit. You may continue adding it, then manually move a subject to overload using the table below.
            </p>
          </div>
          {overloadConfirm && (
            <div className="bg-[#F8FAFC] rounded-xl border border-[#E2E8F0] p-4 space-y-2.5">
              <div className="flex justify-between text-sm">
                <span className="text-[#64748B]">Subject</span>
                <span className="font-semibold text-[#0B2A5B] text-right ml-4">
                  {overloadConfirm.subjectCode}
                  {overloadConfirm.subjectName ? ` — ${overloadConfirm.subjectName}` : ''}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#64748B]">Load limit</span>
                <span className="font-semibold text-[#0B2A5B]">
                  {capText(overloadConfirm.loadLimit, overloadConfirm.unit === 'units')} {overloadConfirm.unit}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#64748B]">Current load</span>
                <span className="font-semibold text-[#0B2A5B]">
                  {overloadConfirm.currentLoad.toFixed(2)} {overloadConfirm.unit}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#64748B]">Remaining</span>
                <span className={`font-semibold ${leftNum(overloadConfirm.remaining, overloadConfirm.unit === 'units') <= 0.001 ? 'text-[#DC2626]' : 'text-[#16A34A]'}`}>
                  {leftNum(overloadConfirm.remaining, overloadConfirm.unit === 'units').toFixed(2)} {overloadConfirm.unit}
                  {leftNum(overloadConfirm.remaining, overloadConfirm.unit === 'units') <= 0.001 && ' — Full'}
                </span>
              </div>
              <div className="flex justify-between text-sm border-t border-[#E2E8F0] pt-2.5">
                <span className="text-[#64748B]">This subject</span>
                <span className="font-semibold text-[#DC2626]">+{overloadConfirm.subjectValue.toFixed(2)} {overloadConfirm.unit}</span>
              </div>
            </div>
          )}
          <div className="flex gap-3 pt-1">
            <button onClick={() => setOverloadConfirm(null)}
              className="flex-1 border border-[#E2E8F0] text-[#64748B] py-2.5 rounded-xl text-sm font-semibold hover:bg-[#F8FAFC] transition">
              Cancel
            </button>
            <button
              disabled={continueState !== 'idle'}
              onClick={() => {
                const c = overloadConfirm;
                if (c) continueAdding(c.msId, () => setOverloadConfirm(null));
              }}
              className="flex-1 bg-[#DC2626] hover:bg-[#B91C1C] text-white py-2.5 rounded-xl text-sm font-bold transition flex items-center justify-center gap-2 disabled:cursor-wait"
            >
              {continueState === 'saving'
                ? <><span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> Adding…</>
                : 'Continue Adding'}
            </button>
          </div>
        </div>
      </Modal>

      {/* -- Move to Overload Modal -- */}
      <Modal
        open={!!moveToOverloadTarget}
        onClose={() => { setMoveToOverloadTarget(null); setComponentSplitUnits(0); }}
        title="Move to Overload"
        footer={
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setMoveToOverloadTarget(null); setComponentSplitUnits(0); }}
              disabled={moveToOverloadProcessing}
              className="flex-1 border border-[#E2E8F0] text-[#64748B] py-2.5 rounded-xl text-sm font-medium hover:bg-[#F8FAFC] transition disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmMoveToOverload}
              disabled={moveToOverloadProcessing || !canConfirmOverload}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-60 flex items-center justify-center gap-2"
              style={{ backgroundColor: '#1D5BD6', color: '#ffffff' }}
              onMouseEnter={e => { if (!moveToOverloadProcessing && canConfirmOverload) e.currentTarget.style.backgroundColor = '#2E7DD1'; }}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#1D5BD6')}
            >
              {moveToOverloadProcessing
                ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Moving…</>
                : 'Move'}
            </button>
          </div>
        }
      >
        <div className="space-y-3">
          {moveToOverloadTarget && (() => {
            const { load, component } = moveToOverloadTarget;
            const lec = parseFloat(String(load.lecture_hours)) || 0;
            const lab = parseFloat(String(load.laboratory_hours)) || 0;
            const hasBoth = lec > 0 && lab > 0;
            const isComponentSpecific = hasBoth && component !== 'full';

            const unit = isPermanent ? 'units' : 'hrs';

            /* -- Component-specific helpers -- */
            const componentTotalWU    = component === 'lec'
              ? (isPermanent ? lec : lec)
              : (isPermanent ? lab * 0.75 : lab);
            const componentLabel = component === 'lec' ? 'Lecture' : component === 'lab' ? 'Laboratory' : '';
            const otherLabel     = component === 'lec' ? 'Laboratory' : 'Lecture';

            /* split preview for component-specific (input is in units/wu) */
            const compRegularWU  = componentSplitUnits;
            const compOverloadWU = Math.max(0, componentTotalWU - componentSplitUnits);

            /* -- Full / single-component helpers -- */
            const subjectTotal    = isPermanent ? calcWorkloadUnits(lec, lab) : lec + lab;
            const overloadPortion = parseFloat((subjectTotal - splitRegularAmount).toFixed(10));
            const maxRegularPart  = summary
              ? parseFloat(Math.max(0, Math.min(subjectTotal - 0.01, subjectTotal + summary.remaining_regular_load)).toFixed(2))
              : 0;

            function ChoiceBtn({
              mode, label, description, active,
            }: { mode: 'entire' | 'split'; label: string; description: React.ReactNode; active: boolean }) {
              return (
                <button
                  type="button"
                  onClick={() => {
                    setMoveToOverloadMode(mode);
                    if (mode === 'split' && !isComponentSpecific) { setSplitRegularAmount(maxRegularPart); setSplitInput(String(maxRegularPart)); }
                    if (mode === 'split' && isComponentSpecific) { setComponentSplitUnits(0); setSplitInput(''); }
                  }}
                  className={`w-full text-left px-3.5 py-3 rounded-xl border transition ${
                    active
                      ? 'border-[#1D5BD6] bg-[#EFF6FF]'
                      : 'border-[#E2E8F0] bg-white hover:border-[#CBD5E1]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center mt-0.5 ${
                      active ? 'border-[#1D5BD6]' : 'border-[#CBD5E1]'
                    }`}>
                      {active && <div className="w-1.5 h-1.5 rounded-full bg-[#1D5BD6]" />}
                    </div>
                    <div>
                      <div className={`text-sm font-medium ${active ? 'text-[#0B2A5B]' : 'text-[#334155]'}`}>{label}</div>
                      <div className="text-[13px] text-[#64748B] mt-0.5 leading-snug">{description}</div>
                    </div>
                  </div>
                </button>
              );
            }

            /* -- Load impact values -- */
            const impactPreview = summary ? (() => {
              let deltaRegular  = 0;
              let deltaOverload = 0;
              if (isComponentSpecific) {
                if (moveToOverloadMode === 'entire') {
                  deltaRegular  = -componentTotalWU;
                  deltaOverload =  componentTotalWU;
                } else {
                  deltaRegular  = -(compOverloadWU);
                  deltaOverload =   compOverloadWU;
                }
              } else {
                if (moveToOverloadMode === 'entire') {
                  deltaRegular  = -subjectTotal;
                  deltaOverload =  subjectTotal;
                } else {
                  const ol      = Math.max(0, overloadPortion);
                  deltaRegular  = -ol;
                  deltaOverload =  ol;
                }
              }
              const afterRegular    = regularVal + deltaRegular;
              const afterOverload   = overloadVal + deltaOverload;
              const afterRemaining  = Math.max(0, summary.regular_load_limit - afterRegular);
              const isAfterExceeded = (afterRegular + afterOverload - summary.regular_load_limit) > 0.001;
              return { afterRegular, afterOverload, afterRemaining, isAfterExceeded, deltaOverload };
            })() : null;

            /* Keep as Regular box: free text so it can be erased; the number is clamped */
            const splitMax = isComponentSpecific ? parseFloat((componentTotalWU - 0.01).toFixed(2)) : maxRegularPart;
            const onSplitInput = (text: string) => {
              setSplitInput(text);
              const raw = parseFloat(text);
              const v = parseFloat(Math.max(0, Math.min(splitMax, Number.isNaN(raw) ? 0 : raw)).toFixed(2));
              if (isComponentSpecific) setComponentSplitUnits(v); else setSplitRegularAmount(v);
            };
            const splitRegular  = isComponentSpecific ? compRegularWU : splitRegularAmount;
            const splitOverload = isComponentSpecific ? compOverloadWU : Math.max(0, overloadPortion);

            return (
              <>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-bold text-[#0B2A5B]">{load.subject_code}</span>
                    {isComponentSpecific && (
                      <span className="px-2 py-0.5 rounded-md text-xs font-semibold bg-[#F1F5F9] text-[#475569]">{componentLabel}</span>
                    )}
                  </div>
                  <p className="text-sm text-[#64748B] mt-0.5">{load.subject_name}</p>
                </div>

                <ChoiceBtn
                  mode="entire"
                  active={moveToOverloadMode === 'entire'}
                  label={isComponentSpecific ? `Move all of ${componentLabel}` : 'Move all'}
                  description={isComponentSpecific
                    ? `${componentTotalWU.toFixed(2)} ${unit} to Overload · ${otherLabel} stays Regular`
                    : `${subjectTotal.toFixed(2)} ${unit} to Overload`}
                />
                <ChoiceBtn
                  mode="split"
                  active={moveToOverloadMode === 'split'}
                  label="Split"
                  description="Keep part as Regular, move the rest"
                />

                {moveToOverloadMode === 'split' && (
                  <div className="rounded-xl bg-[#F8FAFC] border border-[#E2E8F0] px-3.5 py-3 space-y-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <label htmlFor="keep-regular" className="text-sm font-medium text-[#334155]">Keep as Regular ({unit})</label>
                      <span className="text-xs text-[#94A3B8] tabular-nums">Max {splitMax.toFixed(2)}</span>
                    </div>
                    <input
                      id="keep-regular"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={splitMax}
                      step={0.25}
                      placeholder="0"
                      value={splitInput}
                      onChange={e => onSplitInput(e.target.value)}
                      onBlur={() => { if (splitInput !== '') setSplitInput(String(splitRegular)); }}
                      className="w-full bg-white border border-[#CBD5E1] text-[#0B2A5B] rounded-lg px-3 py-2.5 text-base tabular-nums focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/40 focus:border-[#1D5BD6]"
                    />
                    <p className="text-sm text-[#475569] tabular-nums">
                      Regular <span className="font-semibold text-[#0B2A5B]">{splitRegular.toFixed(2)}</span>
                      <span className="text-[#CBD5E1]"> · </span>
                      Overload <span className="font-semibold text-[#C2410C]">{splitOverload.toFixed(2)}</span> {unit}
                    </p>
                    {splitOverload <= 0.001 && (
                      <p className="text-sm text-[#B91C1C]">Keep less than the full amount so some moves to Overload.</p>
                    )}
                  </div>
                )}

                {impactPreview && summary && (() => {
                  const { afterRegular, afterOverload, afterRemaining, isAfterExceeded } = impactPreview;
                  const overBy = Math.max(0, afterRegular - summary.regular_load_limit);
                  const regularOver = isAfterExceeded && afterRegular > summary.regular_load_limit + 0.001;
                  return (
                    <div className="border-t border-[#E2E8F0] pt-3 space-y-1.5">
                      {/* After the move — before → after, one line each */}
                      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm tabular-nums">
                        <span className="text-[#64748B]">Regular</span>
                        <span className="text-[#0B2A5B]">
                          {regularVal.toFixed(2)} → <span className="font-semibold">{afterRegular.toFixed(2)}</span> {unit}
                        </span>
                        <span className="text-[#64748B]">Overload</span>
                        <span className="text-[#0B2A5B]">
                          {overloadVal.toFixed(2)} → <span className="font-semibold">{afterOverload.toFixed(2)}</span> {unit}
                        </span>
                      </div>
                      {regularOver ? (
                        <p className="flex items-start gap-1.5 text-sm text-[#B45309]">
                          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
                          {(isPermanent ? shownUnitsOver(afterRegular, summary.regular_load_limit) : overBy).toFixed(2)} {unit} over the {capText(summary.regular_load_limit, isPermanent)} limit — you can still move it.
                        </p>
                      ) : !isAfterExceeded && leftNum(afterRemaining, isPermanent) > 0.001 ? (
                        <p className="text-sm text-[#64748B]">
                          {leftNum(afterRemaining, isPermanent).toFixed(2)} {unit} still open in Regular.
                        </p>
                      ) : null}
                    </div>
                  );
                })()}
              </>
            );
          })()}
          <p className="text-xs text-[#64748B]">Its days, times and rooms stay as scheduled — only the workload classification changes.</p>
        </div>
      </Modal>

      {/* View Workload Modal — loading fallback: keeps the modal from opening
          empty/invisible if "View Workload" is clicked before `workload` has
          finished fetching for the newly-selected faculty. */}
      {workloadModalOpen && (!workload || !selectedFaculty) && (
        <Modal
          open={workloadModalOpen}
          onClose={() => setWorkloadModalOpen(false)}
          title="Faculty Workload Form"
          size="form"
        >
          <div className="space-y-4" role="status" aria-live="polite" aria-label="Loading faculty workload">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                  <Skeleton className="h-3 w-16 rounded" />
                  <Skeleton className="h-6 w-12 rounded" />
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Skeleton className="h-9 w-28 rounded-full" />
              <Skeleton className="h-9 w-24 rounded-full" />
              <Skeleton className="h-9 w-24 rounded-full" />
            </div>
            <TableSkeleton rows={6} cols={7} />
          </div>
        </Modal>
      )}

      {/* View Workload Modal */}
      {workloadModalOpen && workload && selectedFaculty && (() => {
        const s = workload.summary;
        const isP = selectedFaculty.employment_status === 'Permanent';

        /* Summary totals from the semester-filtered API response are authoritative.
         * Regular table uses semester-filtered workload.loads.
         * Overload/split tables use allWorkloadLoads so cross-semester overloads appear. */

        // Count only the hours for components that are actually scheduled this semester
        const totalContactHours = workload.loads.reduce((acc, l) => {
          const lec = parseFloat(String(l.lecture_hours)) || 0;
          const lab = parseFloat(String(l.laboratory_hours)) || 0;
          const lecSched = l.lec_scheduled !== false;
          const labSched = l.lab_scheduled !== false;
          const hasBoth = lec > 0 && lab > 0;
          return acc + (hasBoth ? ((lecSched ? lec : 0) + (labSched ? lab : 0)) : lec + lab);
        }, 0);

        const praiseTotal = workload.praise.reduce((sum: number, p) => sum + (parseFloat(p.equivalent_units) || 0), 0);
        // No. of Preparation: distinct subjects — the same subject (code + title)
        // taught to several blocks is one preparation.
        const distinctSubjects = mergeSameSubjects(workload.loads).length;
        const olVal = isP ? s.total_overload_units : s.total_overload_hours;
        const praiseSubjectVal = isP ? (s.total_praise_units ?? 0) : (s.total_praise_hours ?? 0);

        // Regular comes from semester-filtered loads; overload/split from all-semester loads
        const termLoads = allWorkloadLoads.filter(l =>
          (!listSemester || l.semester === listSemester) &&
          (!listYear || l.academic_year === listYear)
        );
        const regularPrintLoads  = workload.loads.filter(l => l.load_category === 'Regular');
        const overloadPrintLoads = termLoads.filter(l => l.load_category === 'Overload');
        const praiseSubjectLoads = termLoads.filter(l => l.load_category === 'Praise');
        const isSplitRegular = (l: WorkloadLoad) => l.load_category === 'Regular' && (
          isP
            ? (parseFloat(String(l.split_overload_units)) || 0) > 0.001
            : (parseFloat(String(l.split_overload_hours)) || 0) > 0.001
        );
        const splitPrintLoads    = termLoads.filter(l => isSplitRegular(l) && !l.split_is_praise);
        /* Only the Lec or Lab moved to Praise — the rest of the subject stays Regular */
        const praiseSplitLoads   = termLoads.filter(l => isSplitRegular(l) && l.split_is_praise);
        const hasOverloadSection = overloadPrintLoads.length > 0 || splitPrintLoads.length > 0;
        const hasPraiseSection = (workload.praise ?? []).length > 0 || praiseSubjectLoads.length > 0 || praiseSplitLoads.length > 0;
        const hasActualSection = termLoads.length > 0;
        /* Never leave the active section pointing at a hidden empty tab. */
        const effectiveModalTab: WorkloadModalTab =
          (workloadModalTab === 'overload' && !hasOverloadSection)
          || (workloadModalTab === 'praise' && !hasPraiseSection)
          || (workloadModalTab === 'actual' && !hasActualSection)
            ? 'regular'
            : workloadModalTab;
        /* Regular load totals — computed after grouped is built below */
        let totalRegularWU    = 0;
        let totalRegularHours = 0;

        /* Overload contact hours — full curriculum hours for whole-overload loads,
           only the overload portion for split loads. Mirrors the per-row olHours logic. */
        const overloadContactHours = (() => {
          let total = 0;
          for (const l of overloadPrintLoads) {
            total += (parseFloat(String(l.lecture_hours)) || 0) + (parseFloat(String(l.laboratory_hours)) || 0);
          }
          for (const l of splitPrintLoads) {
            const lec = parseFloat(String(l.lecture_hours)) || 0;
            const lab = parseFloat(String(l.laboratory_hours)) || 0;
            const ovU = parseFloat(String(l.split_overload_units)) || 0;
            const ovH = parseFloat(String(l.split_overload_hours)) || 0;
            if (!isP) { total += ovH; continue; }
            const oc      = (l.overload_component || 'full') as 'lec' | 'lab' | 'full';
            const hasBoth = lec > 0 && lab > 0;
            if (hasBoth && oc !== 'full') {
              if (oc === 'lab') {
                const regularWU = lab * 0.75 - ovU;
                total += Math.max(0, lab - Math.round(regularWU / 0.75));
              } else {
                total += ovU; // lec: wu = hours (1:1)
              }
            } else {
              const ru  = parseFloat(String(l.units)) || 0;
              const tot = ru + ovU;
              total += tot > 0.001 ? parseFloat(((ovU / tot) * (lec + lab)).toFixed(2)) : 0;
            }
          }
          return total;
        })();

        // Group at the row level so lec and lab get their own per-component times
        type PrintRow = { load: WorkloadLoad; row: SplitRow };
        const grouped: Record<string, PrintRow[]> = {};
        for (const load of regularPrintLoads) {
          const oc = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
          const splitOvU = parseFloat(String(load.split_overload_units)) || 0;
          const isSplit = isP ? splitOvU > 0.001 : (parseFloat(String(load.split_overload_hours)) || 0) > 0.001;
          const lec2 = parseFloat(String(load.lecture_hours)) || 0;
          const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
          const hasBoth2 = lec2 > 0 && lab2 > 0;
          const isCompSplit = isSplit && hasBoth2 && oc !== 'full';
          const totalStored = isP ? parseFloat(String(load.units)) || 0 : parseFloat(String(load.hours)) || 0;
          const otherCompVal = isCompSplit ? (oc === 'lab' ? lec2 : (isP ? lab2 * 0.75 : lab2)) : 0;
          const splitCompReg = isCompSplit ? Math.max(0, totalStored - otherCompVal) : 0;

          for (const row of splitLoad(load, isP)) {
            // Skip a component-split row whose entire value is in overload (zero regular portion)
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
            const diff = timeToMins(aT) - timeToMins(bT);
            if (diff !== 0) return diff;
            return (a.load.subject_code || '').localeCompare(b.load.subject_code || '');
          });
        }

        /* Compute regular load totals from the same rows that will be rendered */
        for (const rows of Object.values(grouped)) {
          for (const { load, row } of rows) {
            const { displayWU, displayHours } = computeRegularRowValues(load, row, isP);
            totalRegularWU    += displayWU;
            totalRegularHours += displayHours;
          }
        }

        // Overload grouped at PrintRow level so each component gets its own per-component time
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
        for (const sec of Object.keys(overloadGrouped)) {
          overloadGrouped[sec].sort((a, b) => {
            const aT = a.row.type === 'lec' ? (a.load.lec_start_time ?? a.load.start_time) : (a.load.lab_start_time ?? a.load.start_time);
            const bT = b.row.type === 'lec' ? (b.load.lec_start_time ?? b.load.start_time) : (b.load.lab_start_time ?? b.load.start_time);
            const diff = timeToMins(aT) - timeToMins(bT);
            if (diff !== 0) return diff;
            if (a.load.subject_code !== b.load.subject_code)
              return (a.load.subject_code || '').localeCompare(b.load.subject_code || '');
            return a.row.type === 'lec' ? -1 : 1; // lec before lab for same subject
          });
        }

        // Split overloads sorted by per-component start time
        const sortedSplitLoads = [...splitPrintLoads].sort((a, b) => {
          const ocA = (a.overload_component || 'full') as 'lec' | 'lab' | 'full';
          const ocB = (b.overload_component || 'full') as 'lec' | 'lab' | 'full';
          const aT = ocA === 'lec' ? (a.lec_start_time ?? a.start_time)
                   : ocA === 'lab' ? (a.lab_start_time ?? a.start_time)
                   : a.start_time;
          const bT = ocB === 'lec' ? (b.lec_start_time ?? b.start_time)
                   : ocB === 'lab' ? (b.lab_start_time ?? b.start_time)
                   : b.start_time;
          const diff = timeToMins(aT) - timeToMins(bT);
          if (diff !== 0) return diff;
          return (a.subject_code || '').localeCompare(b.subject_code || '');
        });

        const actionBtn = 'inline-flex items-center justify-center gap-0.5 px-1.5 py-0.5 rounded-sm text-[9px] font-semibold border transition whitespace-nowrap max-lg:min-h-9 max-lg:px-2.5 max-lg:text-[10px] max-lg:w-full';
        const actionRegular = `${actionBtn} bg-[#E8F4FC] text-[#1E4A7A] border-[#1D5BD6]/50 hover:bg-[#D4E9F8]`;
        const actionOverload = `${actionBtn} bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100`;
        const actionPraise = `${actionBtn} bg-violet-50 text-violet-800 border-violet-300 hover:bg-violet-100`;
        const trashBtn = 'inline-flex items-center justify-center p-0.5 rounded-sm text-red-600 bg-red-50 border border-red-200 hover:bg-red-100 transition max-lg:min-h-9 max-lg:min-w-9';
        function rowDayTime(load: WorkloadLoad, row: SplitRow) {
          const start = row.type === 'lec' ? (load.lec_start_time ?? load.start_time) : (load.lab_start_time ?? load.start_time);
          const end   = row.type === 'lec' ? (load.lec_end_time   ?? load.end_time)   : (load.lab_end_time   ?? load.end_time);
          const day   = row.type === 'lec' ? (load.lec_day_pattern ?? load.day_pattern) : (load.lab_day_pattern ?? load.day_pattern);
          return { start, end, day };
        }
        function toOfficialRow(
          load: WorkloadLoad,
          row: SplitRow,
          units: number,
          hours: number,
          action?: React.ReactNode,
        ): OfficialFormRow {
          const yearNum = extractYearNum(load.year_level);
          const { start, end, day } = rowDayTime(load, row);
          const occupied = occupiedRangeFromScheduleTimes(start, end);
          return {
            key: row.key,
            slotId: matchOfficialSlot(day, start, end, formGroups),
            timeLabel: formatOfficialTimeRange(start, end),
            rangeStartMin: occupied?.startMin,
            rangeEndMin: occupied?.endMin,
            subjectCode: load.subject_code,
            description: row.description,
            course: `${load.program_code} ${yearNum}${load.block_name}`,
            students: load.number_of_students > 0 ? String(load.number_of_students) : '',
            units: formatOfficialNumber(units),
            hours: formatOfficialNumber(hours),
            room: row.room_name || '',
            action,
          };
        }

        const officialRegularRows: OfficialFormRow[] = [];
        for (const list of Object.values(grouped)) {
          for (const { load, row } of list) {
                          const { displayWU, displayHours } = computeRegularRowValues(load, row, isP);
                          const isSplitRow = (parseFloat(String(load.split_overload_units)) || 0) > 0.001 ||
                            (parseFloat(String(load.split_overload_hours)) || 0) > 0.001;
            if (isSplitRow && (isP ? displayWU < 0.001 : displayHours < 0.001)) continue;
            officialRegularRows.push(toOfficialRow(load, row, displayWU, displayHours, (
              <div className="flex items-center justify-center gap-0.5 flex-wrap">
                                  {extraLoads && !isSplitRow && (
                                    <button
                                      type="button"
                                      title="Move to Overload"
                                      onClick={() => {
                                        const lec2 = parseFloat(String(load.lecture_hours)) || 0;
                                        const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
                                        handleMoveToOverload(load, (lec2 > 0 && lab2 > 0) ? row.type : 'full');
                                      }}
                    className={actionOverload}
                                    >
                                      <ArrowRight className="w-3 h-3" />
                                      Overload
                                    </button>
                                  )}
                                  {extraLoads && !isSplitRow && (
                                    <button
                                      type="button"
                                      title="Move to Praise Load"
                                      onClick={() => {
                                        const lec2 = parseFloat(String(load.lecture_hours)) || 0;
                                        const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
                                        setPraiseFromOtherComponent((lec2 > 0 && lab2 > 0) ? row.type : 'full');
                                        setPraiseClickedPart((lec2 > 0 && lab2 > 0) ? row.type : 'full');
                                        setPraiseFromOtherTarget(load);
                                      }}
                                      className={actionPraise}
                                    >
                                      <Award className="w-3 h-3" />
                                      Praise
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    title="Remove subject from workload"
                                    onClick={() => setRemoveWorkloadTarget(load)}
                  className={trashBtn}
                                    aria-label="Remove subject from workload"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
            )));
          }
        }

        /* Official Overload rows — same table component as Regular Load */
        const officialOverloadRows: OfficialFormRow[] = [];
        /** Work units on the Overload lines — the form's units total for Contractual (kept in hours) */
        let overloadRowsWU = 0;
        const seenOverloadMs = new Set<number>();
        for (const list of Object.values(overloadGrouped)) {
          for (const { load, row } of list) {
                            const lec2 = parseFloat(String(load.lecture_hours)) || 0;
                            const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
                            const hasBoth2 = lec2 > 0 && lab2 > 0;
                            // Units column = work units for everyone (Contractual subjects are kept in hours)
                            const olWU = hasBoth2
                              ? (row.type === 'lec' ? lec2 : lab2 * 0.75)
                              : (isP ? parseFloat(String(load.units)) || 0 : lec2 + lab2 * 0.75);
                            const olHrs = row.hours;
            overloadRowsWU += olWU;
            const isFirstOfSubject = !seenOverloadMs.has(load.ms_id);
            seenOverloadMs.add(load.ms_id);
            officialOverloadRows.push(toOfficialRow(load, row, olWU, olHrs, isFirstOfSubject ? (
              <div className="flex items-center justify-center gap-0.5 flex-wrap">
                <button
                  type="button"
                  title="Return to Regular Load"
                  onClick={() => handleReturnToRegular(load)}
                  className={actionRegular}
                >
                  <ArrowLeft className="w-3 h-3" />
                  Regular
                </button>
                {extraLoads && (
                  <button
                    type="button"
                    title="Move to Praise Load"
                    onClick={() => requestMoveToPraise(termLoads, [load.ms_id])}
                    className={actionPraise}
                  >
                    <ArrowRight className="w-3 h-3" />
                    Praise
                  </button>
                )}
              </div>
            ) : undefined));
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
            const rowWU = isP ? olV : hoursToUnits(olHours, row.type);
            overloadRowsWU += rowWU;
            const splitRow = toOfficialRow(load, row, rowWU, olHours, (
                                    <button
                                      type="button"
                                      title="Return overload portion to Regular Load"
                                      onClick={() => handleReturnToRegular(load)}
                className={actionRegular}
                                    >
                                      <ArrowLeft className="w-3 h-3" />
                                      Regular
                                    </button>
            ));
            officialOverloadRows.push({ ...splitRow, key: `${row.key}-split-ol` });
          }
        }

        // Units under Units, hours under Hours — Contractual overloads are stored in hours only
        const overloadUnits = isP ? olVal : overloadRowsWU;
        const officialOverloadSummary = {
          unitsText: formatOfficialTotal(overloadUnits),
          hoursText: formatOfficialTotal(overloadContactHours),
          designation: '',
          // Same row format as the Regular form — Designation / Special Assignment left blank
          designationLines: [{ key: 'designation-blank', label: 'Designation', description: '', units: '' }],
          specialAssignments: [] as { key: string; description: string; units: string }[],
          preparations: String(mergeSameSubjects([...overloadPrintLoads, ...splitPrintLoads]).length),
          totalUnitsText: formatOfficialTotal(overloadUnits),
          totalHoursText: formatOfficialTotal(overloadContactHours),
          totalDescription: 'Overload',
        };

        /** Work units on the Praise lines — the form's units for Contractual (kept in hours) */
        let praiseRowsWU = 0;
        const officialPraiseRows: OfficialFormRow[] = [
          ...(() => {
            const seenPraiseMs = new Set<number>();
            return praiseSubjectLoads.flatMap((load) =>
              splitLoad(load, isP).map((row) => {
                const lec2 = parseFloat(String(load.lecture_hours)) || 0;
                const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
                const hasBoth2 = lec2 > 0 && lab2 > 0;
                const wu = hasBoth2
                  ? (row.type === 'lec' ? lec2 : lab2 * 0.75)
                  : (isP ? parseFloat(String(load.units)) || 0 : lec2 + lab2 * 0.75);
                praiseRowsWU += wu;
                const isFirstOfSubject = !seenPraiseMs.has(load.ms_id);
                seenPraiseMs.add(load.ms_id);
                const base = toOfficialRow(load, row, wu, row.hours, isFirstOfSubject && extraLoads ? (
                    <button
                      type="button"
                      title="Return to Overload"
                      onClick={() => requestReturnToOverload(termLoads, [load.ms_id])}
                      className={actionOverload}
                    >
                      <ArrowLeft className="w-3 h-3" />
                      Overload
                    </button>
                ) : undefined);
                return {
                  ...base,
                  description: `${row.description} · Source: Overload`,
                };
              })
            );
          })(),
          ...praiseSplitLoads.flatMap((load) => {
            const oc = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
            const rows = splitLoad(load, isP).filter(r => oc === 'full' || r.type === oc);
            const val = isP
              ? (parseFloat(String(load.split_overload_units)) || 0)
              : (parseFloat(String(load.split_overload_hours)) || 0);
            return rows.map((row) => {
              const lec2 = parseFloat(String(load.lecture_hours)) || 0;
              const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
              const hrs = !isP ? val : row.type === 'lab' ? lab2 : lec2;
              const rowWU = isP ? val : hoursToUnits(hrs, row.type);
              praiseRowsWU += rowWU;
              const base = toOfficialRow(load, row, rowWU, hrs, (
                <div className="flex items-center justify-center gap-0.5 flex-wrap">
                  <button
                    type="button"
                    title="Return to Regular Load"
                    onClick={() => handleReturnToRegular(load)}
                    className={actionRegular}
                  >
                    <ArrowLeft className="w-3 h-3" />
                    Regular
                  </button>
                  {extraLoads && (
                    <button
                      type="button"
                      title="Move to Overload"
                      onClick={() => setReturnToOverloadConfirm({ ids: [load.ms_id], total: val })}
                      className={actionOverload}
                    >
                      <ArrowRight className="w-3 h-3" />
                      Overload
                    </button>
                  )}
                </div>
              ));
              return { ...base, key: `${row.key}-split-praise`, description: `${row.description} · Source: Regular` };
            });
          }),
        ];
        /* … and go on the official footer lines, each with its own remove button */
        const praiseRecordLine = (p: {
          id: number; praise_type?: string; description?: string; remarks?: string; equivalent_units?: unknown;
        }) => ({
          key: `praise-${p.id}`,
          description: String(p.description || p.remarks || p.praise_type || ''),
          units: formatOfficialNumber(parseFloat(String(p.equivalent_units)) || 0),
          action: (
            <button
              type="button"
              title="Remove Praise Load"
              disabled={deletingPraise}
              onClick={() => setDeletePraiseTarget({ id: p.id, praise_type: String(p.praise_type || '') })}
              className={`${trashBtn} disabled:opacity-40`}
              aria-label="Remove Praise Load"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          ),
        });
        const praiseRecords = (workload.praise ?? []) as {
          id: number; praise_type?: string; description?: string; remarks?: string; equivalent_units?: unknown;
        }[];

        const praiseSubjectHours = praiseSubjectLoads.reduce((sum, l) => {
          return sum + (parseFloat(String(l.lecture_hours)) || 0) + (parseFloat(String(l.laboratory_hours)) || 0);
        }, 0) + praiseSplitLoads.reduce((sum, l) => {
          if (!isP) return sum + (parseFloat(String(l.split_overload_hours)) || 0);
          const oc = l.overload_component;
          return sum + (parseFloat(String(oc === 'lab' ? l.laboratory_hours : l.lecture_hours)) || 0);
        }, 0);
        /* Units under Units, hours under Hours — Contractual praise subjects are stored in hours only */
        const praiseTeachingUnits = isP ? praiseSubjectVal : praiseRowsWU;
        const praiseUnitsSum = praiseTeachingUnits + (workload.praise ?? []).reduce(
          (sum: number, p: { equivalent_units?: unknown }) => sum + (parseFloat(String(p.equivalent_units)) || 0),
          0,
        );
        /* Official Praise Load form: No. of Units is teaching only; records are added below it */
        const praiseTeaching = praiseSubjectVal > 0.001;
        const praisePreparations = mergeSameSubjects([...praiseSubjectLoads, ...praiseSplitLoads]).length;
        const officialPraiseSummary = {
          unitsText: praiseTeaching ? formatOfficialTotal(praiseTeachingUnits) : '',
          hoursText: praiseTeaching ? formatOfficialTotal(praiseSubjectHours) : '',
          designation: '',
          researchExtension: praiseRecords.filter(p => isResearchExtensionType(p.praise_type)).map(praiseRecordLine),
          specialAssignments: praiseRecords.filter(p => !isResearchExtensionType(p.praise_type)).map(praiseRecordLine),
          preparations: praiseTeaching && praisePreparations > 0 ? String(praisePreparations) : '',
          totalUnitsText: formatOfficialTotal(praiseUnitsSum),
          totalHoursText: praiseTeaching ? formatOfficialTotal(praiseSubjectHours) : '',
          totalDescription: 'Praise Load',
        };

        /* Deductions split by type — "Special Assignment" gets its own line on the
         * official form (matching the paper form's separate "Add: Special
         * Assignment" row); every other type (Designation/Extension/Research-
         * Extension) rolls up into the combined "Designation" row. Both are
         * real capacity deductions from instructor_load_deductions — NOT the
         * unrelated Praise Load records, which stay in their own tab/card and
         * never reduce Regular Load capacity. */
        const allDeductions = isP ? (workload.deductions ?? []) : [];
        const specialAssignmentDeductions = allDeductions.filter(d => d.deduction_type === 'Special Assignment');
        const designationDeductions = allDeductions.filter(d => d.deduction_type !== 'Special Assignment');
        const designationUnitsTotal = designationDeductions.reduce(
          (sum, d) => sum + (parseFloat(String(d.deducted_units)) || 0), 0
        );
        const specialAssignmentUnitsTotal = specialAssignmentDeductions.reduce(
          (sum, d) => sum + (parseFloat(String(d.deducted_units)) || 0), 0
        );
        const designationText = designationRowText(designationDeductions);

        const officialRegularSummary = {
          unitsText: formatOfficialTotal(totalRegularWU),
          hoursText: formatOfficialTotal(totalRegularHours),
          designation: designationText,
          designationUnitsText: designationUnitsTotal > 0 ? formatOfficialNumber(designationUnitsTotal) : undefined,
          // One line per deduction, labelled by type (same as print)
          designationLines: designationFooterLines(designationDeductions).map(l => ({
            key: l.key, label: l.label, description: l.description,
            units: l.units > 0 ? formatOfficialNumber(l.units) : '',
          })),
          specialAssignments: specialAssignmentDeductions.map(d => ({
            key: String(d.id),
            description: d.description || 'Special Assignment',
            units: formatOfficialNumber(parseFloat(String(d.deducted_units)) || 0),
          })),
          preparations: String(distinctSubjects),
          // Total No. of Units = actual teaching + Designation credit + Special
          // Assignment credit — every visible row above added together, so the
          // printed total always matches what's actually shown on the form.
          // Units for everyone (no deductions for Contractual); hours go under Hours.
          totalUnitsText: formatOfficialTotal(totalRegularWU + designationUnitsTotal + specialAssignmentUnitsTotal),
          totalHoursText: formatOfficialTotal(totalRegularHours),
        };

        /* Actual Load: every subject of the term at its full Lec/Lab value — the same
           lines as the printed Actual Load form, with the Regular form's summary lines. */
        const actualLines = actualLoadLines(termLoads, isP);
        /* Actual Load lists every subject, so it can move one too — the same buttons as
           its own tab (Workload / Overload / Praise). Moving never touches its days,
           times or rooms. A subject already split between two loads is changed on those tabs. */
        const seenActualMs = new Set<number>();
        function actualRowAction(load: WorkloadLoad, row: SplitRow): React.ReactNode {
          const first = !seenActualMs.has(load.ms_id);
          seenActualMs.add(load.ms_id);
          // Split = a Regular subject with part of it in Overload / Praise (a whole Overload subject has its own row too)
          const isSplit = load.load_category === 'Regular' && (
            (parseFloat(String(load.split_overload_units)) || 0) > 0.001
            || (parseFloat(String(load.split_overload_hours)) || 0) > 0.001);
          if (isSplit || !extraLoads) return undefined;
          const lec2 = parseFloat(String(load.lecture_hours)) || 0;
          const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
          const part = lec2 > 0 && lab2 > 0 ? row.type : 'full';
          if (load.load_category === 'Regular') return (
            <div className="flex items-center justify-center gap-0.5 flex-wrap">
              <button type="button" title="Move to Overload" onClick={() => handleMoveToOverload(load, part)} className={actionOverload}>
                <ArrowRight className="w-3 h-3" /> Overload
              </button>
              <button type="button" title="Move to Praise Load" className={actionPraise}
                onClick={() => { setPraiseFromOtherComponent(part); setPraiseClickedPart(part); setPraiseFromOtherTarget(load); }}>
                <Award className="w-3 h-3" /> Praise
              </button>
            </div>
          );
          if (!first) return undefined;
          if (load.load_category === 'Overload') return (
            <div className="flex items-center justify-center gap-0.5 flex-wrap">
              <button type="button" title="Return to Regular Load" onClick={() => handleReturnToRegular(load)} className={actionRegular}>
                <ArrowLeft className="w-3 h-3" /> Regular
              </button>
              <button type="button" title="Move to Praise Load" onClick={() => requestMoveToPraise(termLoads, [load.ms_id])} className={actionPraise}>
                <ArrowRight className="w-3 h-3" /> Praise
              </button>
            </div>
          );
          if (load.load_category === 'Praise') return (
            <button type="button" title="Return to Overload" onClick={() => requestReturnToOverload(termLoads, [load.ms_id])} className={actionOverload}>
              <ArrowLeft className="w-3 h-3" /> Overload
            </button>
          );
          return undefined;
        }
        const officialActualRows: OfficialFormRow[] = actualLines.map(({ row }) =>
          ({ ...toOfficialRow(row.load, row, row.wu, row.hours, actualRowAction(row.load, row)), key: `${row.key}-actual` }));
        const actualWU = actualLines.reduce((sum, l) => sum + l.row.wu, 0);
        const actualHours = actualLines.reduce((sum, l) => sum + l.row.hours, 0);
        /** The form's Total No. of Units (Actual Load): teaching + deloading */
        const actualTotalUnits = actualWU + designationUnitsTotal + specialAssignmentUnitsTotal;
        /** The Actual Load card's number — units for Permanent, hours for Contractual (like the other cards) */
        const actualTotal = isP ? actualTotalUnits : actualHours;
        const officialActualSummary = {
          ...officialRegularSummary,
          unitsText: formatOfficialTotal(actualWU),
          hoursText: formatOfficialTotal(actualHours),
          totalUnitsText: formatOfficialTotal(actualTotalUnits),
          totalHoursText: formatOfficialTotal(actualHours),
          totalDescription: 'Actual Load',
        };

        /* Print menu: the whole term's workload — each official form picks its own subjects */
        const printData: WorkloadPrintData = {
          faculty: selectedFaculty,
          loads: termLoads,
          praise: workload.praise ?? [],
          deductions: workload.deductions ?? [],
        };

        function handlePrinted(result: PrintDocumentResult) {
          setPrintError('');
          setPrintOfferFallback(false);
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
          const opened = openWorkloadPrintableVersion('/workload/print');
          if (!opened) {
            setPrintError(
              'Unable to open the printable version. Please open this page in Chrome or Safari and try again.',
            );
            setPrintOfferFallback(true);
          }
        }

        return (
          <Modal
            open={workloadModalOpen}
            onClose={() => {
              setWorkloadModalOpen(false);
              setPrintError('');
              setPrintOfferFallback(false);
            }}
            title="Faculty Workload Form"
            size="form"
          >
            {/* Toolbar */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4 pb-4 border-b border-white/10">
              <div className="min-w-0">
                <div className="text-base font-bold text-white break-words">{selectedFaculty.name}</div>
                <div className="text-sm text-slate-400 mt-0.5 break-words">
                  {selectedFaculty.position}
                </div>
                <div className="text-sm text-slate-400 mt-1.5 sm:hidden">
                  {listSemester} · A.Y. {listYear}
                </div>
                        </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 w-full sm:w-auto flex-shrink-0">
                <div className="hidden sm:block text-right text-xs text-slate-400">
                  <div><span className="font-semibold">Semester:</span> {listSemester}</div>
                  <div><span className="font-semibold">A.Y.:</span> {listYear}</div>
                        </div>
                {/* Print → choose the form first (Actual Load / Regular / Overload / Praise) */}
                <WorkloadPrintMenu
                  data={printData}
                  semester={listSemester}
                  academicYear={listYear}
                  look="modal"
                  printablePath="/workload/print"
                  onPrinted={handlePrinted}
                />
                        </div>
                      </div>
            {(printError || printOfferFallback) ? (
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" role="status">
                {printError ? (
                  <p className="text-sm text-amber-300/95 leading-snug">{printError}</p>
                ) : (
                  <span className="sr-only">Printable version available</span>
                )}
                {printOfferFallback ? (
                  <button
                    type="button"
                    onClick={handleOpenPrintableVersion}
                    className="inline-flex items-center justify-center gap-2 self-start sm:self-auto min-h-10 px-3 rounded-lg border border-amber-300/40 text-amber-100 text-xs font-semibold hover:bg-amber-300/10 transition"
                  >
                    Open Printable Version
                  </button>
                ) : null}
                      </div>
            ) : null}

            {/* Summary cards — screen only (plain official style) */}
            {(() => {
              const modalRegVal  = isP ? totalRegularWU : totalRegularHours;
              const modalOlVal   = olVal;
              const modalPraiseVal = praiseSubjectVal + (isP ? praiseTotal : 0);
              const unitLabel = isP ? 'units' : 'hrs';
              const limitStr = capText(Number(s.regular_load_limit), isP);
              const regStr = modalRegVal.toFixed(2);
              const card = 'relative overflow-hidden bg-white border border-slate-200 rounded-xl p-5 min-w-0';
              const labelCls = 'text-xs text-slate-500 uppercase tracking-wide font-semibold mb-1.5';
              const valueCls = 'text-2xl font-bold text-slate-900 tabular-nums';
              const mutedCls = 'text-base font-normal text-slate-500 ml-1.5';
              // Over the regular base load → the card blinks red
              const regOverBy = modalRegVal - Number(s.regular_load_limit || 0);
              const regExceeded = regOverBy > 0.001;
              const regOverShown = (isP ? shownUnitsOver(modalRegVal, Number(s.regular_load_limit || 0)) : regOverBy).toFixed(2);
              /* Each card opens its section below (Actual Load / Workload / Overload / Praise Load) */
              const cardButton = (key: WorkloadModalTab, enabled: boolean) => ({
                type: 'button' as const,
                disabled: !enabled,
                onClick: () => switchModalTab(key, effectiveModalTab),
                'aria-pressed': effectiveModalTab === key,
                whileHover: reduceMotion || !enabled ? undefined : { y: -2 },
                whileTap: reduceMotion || !enabled ? undefined : { scale: 0.98 },
                transition: { duration: 0.25, ease: [0.4, 0, 0.2, 1] as const },
              });
              const cardState = 'w-full text-left transition-[border-color,box-shadow] duration-300 enabled:cursor-pointer disabled:cursor-default';
              /* Each card wears its load colour: top strip, number, and border when open */
              const cardStyle = (key: WorkloadModalTab) => effectiveModalTab === key
                ? { borderColor: LOAD_TONE[key], boxShadow: `0 0 0 3px ${LOAD_TONE[key]}26` }
                : undefined;
              const strip = (color: string) => (
                <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: color }} />
              );
              const showOverloadCard = extraLoads || hasOverloadSection;
              const showPraiseCard = extraLoads || hasPraiseSection;
              const cardCount = 2 + Number(showOverloadCard) + Number(showPraiseCard);
              return (
                <>
                <div className={`grid grid-cols-1 sm:grid-cols-2 ${cardCount === 4 ? 'lg:grid-cols-4' : cardCount === 3 ? 'lg:grid-cols-3' : ''} gap-4 mb-5`}>
                  <motion.button
                    {...cardButton('actual', hasActualSection)}
                    className={`${card} ${cardState}`}
                    style={cardStyle('actual')}
                    title={hasActualSection ? 'Show Actual Load' : undefined}
                  >
                    {/* Theme-aware navy — plain navy is lost on the dark theme */}
                    {strip('var(--load-actual)')}
                    <div className={labelCls}>Actual Load</div>
                    <div className={valueCls} style={{ color: LOAD_INK.actual }}>
                      {actualTotal.toFixed(2)}
                      <span className={mutedCls}>{unitLabel}</span>
                    </div>
                    <div className="mt-1.5 text-sm font-semibold text-slate-500">
                      {termLoads.length} subject{termLoads.length !== 1 ? 's' : ''}
                    </div>
                    {/* With deloading the form's total is teaching + deloading — show how it adds up */}
                    {designationUnitsTotal + specialAssignmentUnitsTotal > 0.001 && (
                      <div className="mt-0.5 text-xs text-slate-500">
                        {actualWU.toFixed(2)} teaching + {(designationUnitsTotal + specialAssignmentUnitsTotal).toFixed(2)} deloading
                      </div>
                    )}
                  </motion.button>
                  <motion.button
                    {...cardButton('regular', true)}
                    className={`${regExceeded ? 'qr-flag-pulse relative overflow-hidden border-2 border-red-400 rounded-xl p-5 min-w-0' : card} ${cardState}`}
                    style={regExceeded ? undefined : cardStyle('regular')}
                    title={regExceeded ? `Regular load is over the limit by ${regOverShown} ${unitLabel}` : 'Show Workload'}
                  >
                    {strip(regExceeded ? '#DC2626' : LOAD_TONE.regular)}
                    <div className={`${labelCls} ${regExceeded ? '!text-red-700' : ''}`}>{isP ? 'Regular Load' : 'Regular Hours'}</div>
                    <div className={`${valueCls} ${regExceeded ? '!text-red-700' : ''}`} style={regExceeded ? undefined : { color: LOAD_INK.regular }}>
                      {regStr} / {limitStr}
                      <span className={`${mutedCls} ${regExceeded ? '!text-red-500' : ''}`}>{unitLabel}</span>
                    </div>
                    {regExceeded && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-sm font-bold text-red-700">
                        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                        Over by {regOverShown} {unitLabel}
                      </div>
                    )}
                  </motion.button>
                  {showOverloadCard && (
                  <motion.button
                    {...cardButton('overload', hasOverloadSection)}
                    className={`${card} ${cardState}`}
                    style={cardStyle('overload')}
                    title={hasOverloadSection ? 'Show Overload' : undefined}
                  >
                    {strip(LOAD_TONE.overload)}
                    <div className={labelCls}>Overload</div>
                    <div className={valueCls} style={{ color: isP && modalOlVal >= overloadCap - 0.001 ? '#B91C1C' : LOAD_INK.overload }}>
                      {modalOlVal.toFixed(2)}{isP && <> / {loadDisplay(overloadCap)}</>}
                      <span className={mutedCls}>{unitLabel}</span>
                    </div>
                    {isP && (
                      <div className={`mt-1.5 text-sm font-semibold ${modalOlVal >= overloadCap - 0.001 ? 'text-red-700' : 'text-slate-500'}`}>
                        {shownUnitsLeft(overloadCap - modalOlVal) <= 0.001
                          ? 'Overload limit reached'
                          : `${shownUnitsLeft(overloadCap - modalOlVal).toFixed(2)} units left`}
                      </div>
                    )}
                  </motion.button>
                  )}
                  {showPraiseCard && (
                  <motion.button
                    {...cardButton('praise', hasPraiseSection)}
                    className={`${card} ${cardState}`}
                    style={cardStyle('praise')}
                    title={hasPraiseSection ? 'Show Praise Load' : undefined}
                  >
                    {strip(LOAD_TONE.praise)}
                    <div className={labelCls}>Praise Load</div>
                    <div className={valueCls} style={{ color: LOAD_INK.praise }}>
                      {modalPraiseVal.toFixed(2)}
                      <span className={mutedCls}>{unitLabel}</span>
                    </div>
                  </motion.button>
                  )}
                </div>
                {/* Written warning (not only colour/icon) — like a notification */}
                <AnimatePresence initial={false}>
                  {regExceeded && (
                    <motion.div
                      key="reg-exceeded-warning"
                      role="alert"
                      initial={reduceMotion ? false : { opacity: 0, y: -8, height: 0 }}
                      animate={{ opacity: 1, y: 0, height: 'auto' }}
                      exit={{ opacity: 0, y: -8, height: 0 }}
                      transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="mb-5 flex items-start gap-3 rounded-xl border-2 border-red-300 border-l-[6px] border-l-red-600 bg-red-50 px-4 py-3.5">
                        <AlertTriangle className="w-6 h-6 flex-shrink-0 text-red-600 mt-0.5" />
                        <div className="min-w-0">
                          <p className="text-base font-bold text-red-800">
                            Warning: Regular load limit exceeded
                          </p>
                          <p className="text-sm text-red-800 mt-1 leading-relaxed">
                            {selectedFaculty?.name ?? 'This faculty member'} has <strong>{regStr} {unitLabel}</strong> of regular load,
                            which is <strong>{regOverShown} {unitLabel} over</strong> the {limitStr}-{unitLabel === 'units' ? 'unit' : 'hour'} limit.{' '}
                            {extraLoads
                              ? 'Move a subject to Overload (or Praise Load), or remove a subject, to bring it back within the limit.'
                              : 'Remove a subject to bring it back within the limit.'}
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                </>
              );
            })()}

            {/* Tab pills — one highlight slides to the chosen tab */}
            <div className="flex flex-wrap gap-2 mb-4" role="tablist" aria-label="Workload sections">
              {([
                { key: 'actual' as const, label: 'Actual Load', count: termLoads.length, color: LOAD_INK.actual, show: hasActualSection },
                { key: 'regular' as const, label: 'Workload', count: regularPrintLoads.length, color: LOAD_INK.regular, show: true },
                { key: 'overload' as const, label: 'Overload', count: overloadPrintLoads.length + splitPrintLoads.length, color: LOAD_INK.overload, show: hasOverloadSection },
                { key: 'praise' as const, label: 'Praise Load', count: (workload?.praise ?? []).length + praiseSubjectLoads.length + praiseSplitLoads.length, color: LOAD_INK.praise, show: hasPraiseSection },
              ]).filter(t => t.show).map(t => {
                const active = effectiveModalTab === t.key;
                return (
                  <motion.button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchModalTab(t.key, effectiveModalTab)}
                    whileHover={reduceMotion || active ? undefined : { y: -2 }}
                    whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                    transition={{ type: 'spring', stiffness: 420, damping: 28 }}
                    className={`relative isolate inline-flex items-center gap-1.5 px-4 min-h-10 rounded-full text-sm font-semibold transition-colors duration-200 ${
                      active ? '' : 'bg-slate-100 hover:bg-slate-200'
                    }`}
                    // White set inline — the light-mode rule repaints `text-white` as dark ink.
                    // Inactive tabs keep their load colour so each one is recognisable.
                    style={{ color: active ? '#FFFFFF' : t.color }}
                  >
                    {active && (
                      <motion.span
                        layoutId="workload-modal-tab"
                        className="absolute inset-0 -z-10 rounded-full shadow-[0_8px_18px_-10px_rgba(11,42,91,0.55)]"
                        initial={false}
                        animate={{ backgroundColor: t.color }}
                        transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 32 }}
                        aria-hidden="true"
                      />
                    )}
                    {t.label}
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${active ? 'bg-white/25' : 'bg-white text-slate-600'}`}>{t.count}</span>
                  </motion.button>
                );
              })}
            </div>

            {/* Printable content area */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 sm:p-4">
            <div id="workload-print-area">
              <div className="print-header hidden">
                <h3 className="font-bold">INSTRUCTOR WORKLOAD FORM</h3>
                <div className="meta-row">
                  <div>
                    <strong>Name:</strong> {selectedFaculty.name} &nbsp;|&nbsp;
                    <strong>Status:</strong> {selectedFaculty.position} ({selectedFaculty.employment_status})
                  </div>
                  <div>
                    <strong>Semester:</strong> {listSemester} &nbsp;|&nbsp;
                    <strong>A.Y.:</strong> {listYear}
                  </div>
                </div>
              </div>

              {/* Tab content slides in from the side you moved toward */}
              <motion.div
                key={effectiveModalTab}
                initial={reduceMotion ? false : { opacity: 0, x: 28 * modalTabDir }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="min-w-0 max-w-full"
              >
              {/* -- ACTUAL LOAD TABLE (every subject of the term; Permanent faculty can move any of them) -- */}
              {hasActualSection && (
                <div style={{ display: effectiveModalTab === 'actual' ? '' : 'none' }} className="min-w-0 max-w-full">
                  <OfficialWorkloadFormTable
                    rows={officialActualRows}
                    summary={officialActualSummary}
                    showActions={extraLoads}
                    variant="actual"
                    groups={formGroups}
                  />
                </div>
              )}

              {/* -- REGULAR LOAD TABLE -- */}
              <div style={{ display: effectiveModalTab === 'regular' ? '' : 'none' }} className="min-w-0 max-w-full">
                <OfficialWorkloadFormTable
                  rows={officialRegularRows}
                  summary={officialRegularSummary}
                  showActions
                  variant="regular"
                  groups={formGroups}
                />
              </div>{/* end regular tab */}

              {/* -- OVERLOAD TABLE (same official form as Regular Load) -- */}
              {hasOverloadSection && (
                <div style={{ display: effectiveModalTab === 'overload' ? '' : 'none' }} className="min-w-0 max-w-full">
                  <OfficialWorkloadFormTable
                    rows={officialOverloadRows}
                    summary={officialOverloadSummary}
                    showActions
                    variant="overload"
                    groups={formGroups}
                  />
                </div>
              )}

              {/* -- PRAISE LOAD TAB (same official columns; compact empty slots) -- */}
              {hasPraiseSection && (
                <div style={{ display: effectiveModalTab === 'praise' ? '' : 'none' }} className="min-w-0 max-w-full">
                  <OfficialWorkloadFormTable
                    rows={officialPraiseRows}
                    summary={officialPraiseSummary}
                    showActions
                    variant="praise"
                    groups={formGroups}
                  />
              </div>
              )}
              </motion.div>
            </div>
            </div>
          </Modal>
        );
      })()}

      <Modal
        open={!!moveToPraiseConfirm}
        onClose={() => { if (!moveToPraiseProcessing) setMoveToPraiseConfirm(null); }}
        title="Move to Praise Load"
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              disabled={moveToPraiseProcessing}
              onClick={() => setMoveToPraiseConfirm(null)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/20 text-white disabled:opacity-50 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={moveToPraiseProcessing}
              onClick={confirmMoveToPraise}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition"
            >
              {moveToPraiseProcessing ? 'Moving…' : 'Move to Praise Load'}
            </button>
          </div>
        }
      >
        <div className="text-sm text-slate-300 space-y-2">
          <p>
            Move {moveToPraiseConfirm?.ids.length === 1 ? 'this subject' : `${moveToPraiseConfirm?.ids.length ?? 0} subjects`} from Overload to Praise Load?
          </p>
          <p className="text-white">
            Selected workload:{' '}
            <span className="font-semibold tabular-nums">
              {(moveToPraiseConfirm?.total ?? 0).toFixed(2)}{' '}
              {selectedFaculty?.employment_status === 'Permanent' ? 'units' : 'hours'}
            </span>
          </p>
          <p className="text-xs text-slate-500">
            {praiseFromOtherComponent === 'full'
              ? 'The subject stays assigned to the faculty with the same days, times and rooms. Only the workload classification changes.'
              : `Only the ${praiseFromOtherComponent === 'lec' ? 'Lecture' : 'Laboratory'} moves to Praise Load — the ${praiseFromOtherComponent === 'lec' ? 'Laboratory' : 'Lecture'} stays in Regular Load.`}
          </p>
        </div>
      </Modal>

      <Modal
        open={!!praiseFromOtherTarget}
        onClose={() => { if (!praiseFromOtherProcessing) setPraiseFromOtherTarget(null); }}
        title="Move to Praise Load"
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              disabled={praiseFromOtherProcessing}
              onClick={() => setPraiseFromOtherTarget(null)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/20 text-white disabled:opacity-50 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={praiseFromOtherProcessing}
              onClick={confirmPraiseFromOther}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 transition"
            >
              {praiseFromOtherProcessing ? 'Moving…' : 'Move to Praise Load'}
            </button>
          </div>
        }
      >
        <div className="text-sm text-slate-300 space-y-2">
          <p>
            Classify <span className="text-white font-semibold">
              {praiseFromOtherTarget?.subject_code}
              {praiseFromOtherTarget?.subject_name ? ` — ${praiseFromOtherTarget.subject_name}` : ''}
              {praiseFromOtherComponent === 'lec' ? ' (Lecture)' : praiseFromOtherComponent === 'lab' ? ' (Laboratory)' : ''}
            </span> as Praise Load?
          </p>
          {/* A Lec + Lab subject: just the clicked part, or the whole subject in one step */}
          {praiseClickedPart !== 'full' && (
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="What moves to Praise Load">
              {([
                { value: praiseClickedPart, label: `Only the ${praiseClickedPart === 'lec' ? 'Lecture' : 'Laboratory'}` },
                { value: 'full' as const, label: 'Whole subject' },
              ]).map(o => {
                const on = praiseFromOtherComponent === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={praiseFromOtherProcessing}
                    onClick={() => setPraiseFromOtherComponent(o.value)}
                    className={`min-h-10 px-3 rounded-lg text-sm font-semibold border transition-colors ${
                      on ? 'bg-violet-600 border-violet-600' : 'bg-white/5 border-white/15 text-slate-200 hover:bg-white/10'
                    }`}
                    // White set inline — the light theme repaints `text-white` as dark ink
                    style={on ? { color: '#FFFFFF' } : undefined}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-white">
            Workload:{' '}
            <span className="font-semibold tabular-nums">
              {praiseFromOtherTarget
                ? (praiseFromOtherComponent === 'full'
                    ? subjectLoadValue(praiseFromOtherTarget, selectedFaculty?.employment_status === 'Permanent')
                    : praiseFromOtherComponent === 'lec'
                      ? (parseFloat(String(praiseFromOtherTarget.lecture_hours)) || 0)
                      : (parseFloat(String(praiseFromOtherTarget.laboratory_hours)) || 0)
                        * (selectedFaculty?.employment_status === 'Permanent' ? 0.75 : 1)
                  ).toFixed(2)
                : '0.00'}{' '}
              {selectedFaculty?.employment_status === 'Permanent' ? 'units' : 'hours'}
            </span>
          </p>
          <p className="text-xs text-slate-500">
            The subject stays assigned to the faculty with the same days, times and rooms. Only the workload classification changes.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!returnToOverloadConfirm}
        onClose={() => { if (!returnToOverloadProcessing) setReturnToOverloadConfirm(null); }}
        title="Return to Overload"
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              disabled={returnToOverloadProcessing}
              onClick={() => setReturnToOverloadConfirm(null)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/20 text-white disabled:opacity-50 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={returnToOverloadProcessing}
              onClick={confirmReturnToOverload}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50 transition"
            >
              {returnToOverloadProcessing ? 'Moving…' : 'Move to Overload'}
            </button>
          </div>
        }
      >
        <div className="text-sm text-slate-300 space-y-2">
          <p>
            Move {returnToOverloadConfirm?.ids.length === 1 ? 'this subject' : `${returnToOverloadConfirm?.ids.length ?? 0} subjects`} from Praise Load back to Overload?
          </p>
          <p className="text-white">
            Selected workload:{' '}
            <span className="font-semibold tabular-nums">
              {(returnToOverloadConfirm?.total ?? 0).toFixed(2)}{' '}
              {selectedFaculty?.employment_status === 'Permanent' ? 'units' : 'hours'}
            </span>
          </p>
          <p className="text-xs text-slate-500">
            The subject stays assigned to the faculty with the same days, times and rooms. Only the workload classification changes.
          </p>
        </div>
      </Modal>

      {/* -- Delete Praise Load confirmation modal -- */}
      <Modal
        open={!!deletePraiseTarget}
        onClose={() => { if (!deletingPraise) setDeletePraiseTarget(null); }}
        title="Remove Praise Load"
        size="sm"
        footer={
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              disabled={deletingPraise}
              onClick={() => setDeletePraiseTarget(null)}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 hover:bg-white/20 text-white disabled:opacity-50 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deletingPraise}
              onClick={handleDeletePraise}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 transition flex items-center gap-2"
            >
              {deletingPraise ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin inline-block" />
                  Removing…
                </>
              ) : (
                <>
                  <Trash2 className="w-3.5 h-3.5" />
                  Remove
                </>
              )}
            </button>
          </div>
        }
      >
        {deletePraiseSuccess && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-[#111827] border border-white/10 shadow-2xl">
              <TrashDropAnimation className="bg-red-500/15 border-red-500/30" color="#F87171" />
              <p className="text-base font-semibold text-white">Praise Load removed!</p>
            </div>
          </div>
        )}
        <div className="text-sm text-slate-300 space-y-2">
          <p>Are you sure you want to remove this Praise Load?</p>
          {deletePraiseTarget && (
            <p className="font-semibold text-white">{deletePraiseTarget.praise_type}</p>
          )}
          <p className="text-red-400 text-xs">This action cannot be undone.</p>
        </div>
      </Modal>

      {/* -- Remove Subject confirmation modal -- */}
      <Modal
        open={!!removeWorkloadTarget}
        onClose={() => setRemoveWorkloadTarget(null)}
        title="Remove Subject"
        footer={
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setRemoveWorkloadTarget(null)}
              disabled={removingWorkload}
              className="flex-1 border border-[#E2E8F0] text-[#64748B] py-2 rounded-xl text-sm font-semibold hover:bg-[#F8FAFC] transition disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmRemoveSubject}
              disabled={removingWorkload}
              className="flex-1 py-2 rounded-xl text-sm font-bold transition disabled:opacity-60 flex items-center justify-center gap-2"
              style={{ backgroundColor: '#DC2626', color: '#ffffff' }}
            >
              {removingWorkload
                ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Removing…</>
                : <><Trash2 className="w-4 h-4" /> Remove Subject</>}
            </button>
          </div>
        }
      >
        {removeWorkloadTarget && (
          <div className="space-y-4">
            {/* Subject info */}
            <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3">
              <div className="font-mono font-bold text-sm text-[#0B2A5B] mb-0.5">{removeWorkloadTarget.subject_code}</div>
              <div className="text-sm text-[#64748B]">{removeWorkloadTarget.subject_name}</div>
              <div className="flex items-center gap-3 mt-2 text-[11px] text-[#94A3B8] flex-wrap">
                <span>{removeWorkloadTarget.program_code} · {removeWorkloadTarget.block_name} · {removeWorkloadTarget.year_level}</span>
                {(parseFloat(String(removeWorkloadTarget.units)) || 0) > 0 && (
                  <span className="font-semibold text-[#0B2A5B]">
                    {(parseFloat(String(removeWorkloadTarget.units)) || 0).toFixed(2)} {isPermanent ? 'units' : 'hrs'}
                  </span>
                )}
              </div>
            </div>

            {/* Warning */}
            <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-red-700 leading-relaxed">
                This subject will be <span className="font-bold">permanently removed</span> from {selectedFaculty?.name}&apos;s workload.
                The workload units will be recalculated immediately and the subject will become available for reassignment.
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* -- Return to Regular Load modal -- */}
      <Modal
        open={!!returnToRegularTarget}
        onClose={() => {
          if (!returnToRegularProcessing) {
            setReturnToRegularTarget(null);
            setReturnToRegularMode('entire');
            setReturnToRegularAmount(0);
            setReturnToRegularError('');
          }
        }}
        title={returnToRegularTarget
          ? `Return ${returnToRegularTarget.subject_code} — ${returnToRegularTarget.subject_name} to Regular Load?`
          : 'Return to Regular Load'}
        footer={(() => {
          const load = returnToRegularTarget;
          if (!load) return null;
          const overloadUnits = overloadReturnValue(load, isPermanent);
          const remaining = summary?.remaining_regular_load ?? 0;
          const amountToReturn = returnToRegularMode === 'entire' ? overloadUnits : returnToRegularAmount;
          const isInvalidAmount = returnToRegularMode === 'partial' &&
            (returnToRegularAmount <= 0.001 || returnToRegularAmount > overloadUnits + 0.001);
          const canConfirm = !returnToRegularProcessing && !isInvalidAmount && amountToReturn > 0.001;
          return (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setReturnToRegularTarget(null);
                  setReturnToRegularMode('entire');
                  setReturnToRegularAmount(0);
                  setReturnToRegularError('');
                }}
                disabled={returnToRegularProcessing}
                className="flex-1 border border-[#E2E8F0] text-[#64748B] py-2 rounded-xl text-sm font-semibold hover:bg-[#F8FAFC] transition disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmReturnToRegular}
                disabled={!canConfirm}
                className="flex-1 py-2 rounded-xl text-sm font-bold transition disabled:opacity-60 flex items-center justify-center gap-2"
                style={{ backgroundColor: canConfirm ? '#1D5BD6' : '#E2E8F0', color: canConfirm ? '#ffffff' : '#94A3B8' }}
              >
                {returnToRegularProcessing
                  ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  : <><ArrowDownCircle className="w-4 h-4" /> Return to Regular Load</>
                }
              </button>
            </div>
          );
        })()}
      >
        {returnToRegularTarget && (() => {
          const load = returnToRegularTarget;
          const isFullOl = load.load_category === 'Overload';
          const overloadUnits = overloadReturnValue(load, isPermanent);
          const regularUnits = isFullOl ? 0 : (isPermanent
            ? (parseFloat(String(load.units)) || 0)
            : (parseFloat(String(load.hours)) || 0));
          const oc = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
          const compLabel = oc === 'lec' ? 'Lecture' : oc === 'lab' ? 'Laboratory' : '';
          const unit = isPermanent ? 'units' : 'hrs';
          const remaining = summary?.remaining_regular_load ?? 0;
          const currentRegular = summary?.current_regular_load ?? 0;
          const limit = summary?.regular_load_limit ?? 0;
          const amountToReturn = returnToRegularMode === 'entire' ? overloadUnits : returnToRegularAmount;
          const newRegular = currentRegular + amountToReturn;
          const wouldExceed = amountToReturn > remaining + 0.001;
          const overBy = Math.max(0, newRegular - limit);
          const isInvalidAmount = returnToRegularMode === 'partial' &&
            (returnToRegularAmount <= 0.001 || returnToRegularAmount > overloadUnits + 0.001);

          return (
            <div className="space-y-3">
              {/* Subject info */}
              <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-sm text-[#0B2A5B]">{load.subject_code}</span>
                  {isFullOl
                    ? <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-orange-50 text-orange-700 border border-orange-200">Full Overload</span>
                    : <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-orange-50 text-orange-600 border border-orange-200">Split Overload</span>
                  }
                </div>
                <div className="text-sm text-[#64748B]">
                  {load.subject_name}{compLabel ? ` — ${compLabel}` : ''}
                </div>
                {/* Current load breakdown */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="bg-white border border-[#E2E8F0] rounded-lg px-2.5 py-1.5">
                    <div className="text-[10px] text-[#94A3B8] mb-0.5">Regular Portion</div>
                    <div className="text-sm font-bold text-[#0B2A5B]">
                      {regularUnits.toFixed(2)} <span className="text-[10px] font-normal text-[#94A3B8]">{unit}</span>
                    </div>
                  </div>
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                    <div className="text-[10px] text-amber-500 mb-0.5">Overload Portion</div>
                    <div className="text-sm font-bold text-amber-700">
                      {overloadUnits.toFixed(2)} <span className="text-[10px] font-normal">{unit}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Return mode — partial only available for split overload */}
              {!isFullOl && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold text-[#64748B] uppercase tracking-wide">Return Amount</div>
                  <label className="flex items-center gap-2.5 cursor-pointer px-3 py-2 rounded-xl border border-[#E2E8F0] hover:bg-[#F8FAFC] transition">
                    <input
                      type="radio"
                      name="returnMode"
                      checked={returnToRegularMode === 'entire'}
                      onChange={() => { setReturnToRegularMode('entire'); setReturnToRegularAmount(0); }}
                      className="accent-[#1D5BD6]"
                    />
                    <div>
                      <div className="text-sm font-semibold text-[#0B2A5B]">
                        Return All — {overloadUnits.toFixed(2)} {unit}
                      </div>
                      <div className="text-[11px] text-[#94A3B8]">Move the entire overload portion to Regular Load</div>
                    </div>
                  </label>
                  <label className="flex items-start gap-2.5 cursor-pointer px-3 py-2 rounded-xl border border-[#E2E8F0] hover:bg-[#F8FAFC] transition">
                    <input
                      type="radio"
                      name="returnMode"
                      checked={returnToRegularMode === 'partial'}
                      onChange={() => {
                        setReturnToRegularMode('partial');
                        setReturnToRegularAmount(parseFloat(Math.min(overloadUnits, Math.max(0, remaining)).toFixed(2)));
                      }}
                      className="accent-[#1D5BD6] mt-0.5 flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-[#0B2A5B]">Return Partial Amount</div>
                      <div className="text-[11px] text-[#94A3B8] mb-2">Specify how many {unit} to move back to Regular</div>
                      {returnToRegularMode === 'partial' && (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0.01}
                            max={overloadUnits}
                            step={0.01}
                            value={returnToRegularAmount > 0 ? returnToRegularAmount : ''}
                            onChange={e => setReturnToRegularAmount(parseFloat(e.target.value) || 0)}
                            className="w-24 border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-sm text-[#0B2A5B] font-semibold focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/30"
                            placeholder="0.00"
                            autoFocus
                          />
                          <span className="text-[11px] text-[#94A3B8]">max {overloadUnits.toFixed(2)} {unit}</span>
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              )}

              {/* Capacity check */}
              {amountToReturn > 0.001 && (
                <div className={`rounded-xl px-3.5 py-2.5 border flex items-start gap-2 ${
                  wouldExceed ? 'bg-amber-50 border-amber-200' : 'bg-blue-50/50 border-blue-200'
                }`}>
                  {wouldExceed
                    ? <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    : <CheckCircle2 className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                  }
                  <div>
                    <div className={`text-sm font-semibold ${wouldExceed ? 'text-amber-800' : 'text-blue-800'}`}>
                      {wouldExceed ? 'Workload exceeds maximum' : 'Within configured maximum'}
                    </div>
                    <div className="text-[11px] text-[#64748B] mt-0.5">
                      {wouldExceed
                        ? <>This change will bring Regular Load to {newRegular.toFixed(2)} {unit}, which is {(isPermanent ? shownUnitsOver(newRegular, limit) : overBy).toFixed(2)} {unit} above the configured maximum of {capText(limit, isPermanent)} {unit}. You can still confirm this classification.</>
                        : <>Current Regular {currentRegular.toFixed(2)} {unit} + {amountToReturn.toFixed(2)} {unit} = {newRegular.toFixed(2)} {unit}.</>
                      }
                    </div>
                  </div>
                </div>
              )}

              {/* Invalid partial amount warning */}
              {isInvalidAmount && returnToRegularAmount > overloadUnits + 0.001 && (
                <div className="rounded-xl px-3.5 py-2.5 border bg-red-50 border-red-200 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                  <div className="text-sm text-red-700">
                    Amount cannot exceed the overload portion ({overloadUnits.toFixed(2)} {unit}).
                  </div>
                </div>
              )}

              {returnToRegularError && (
                <div className="rounded-xl bg-red-50 border border-red-200 px-3.5 py-2.5 text-sm text-red-700">
                  {returnToRegularError}
                </div>
              )}
            </div>
          );
        })()}
      </Modal>

      {/* -- Load Deduction Modal -----------------------------------------------
          Opened via the Deloading button. Lets the admin set or update load deductions
          for a Permanent faculty without interrupting faculty selection.
          ------------------------------------------------------------------- */}
      <Modal open={!!designationPending} onClose={() => { if (deloadSavedNote === null) setDesignationPending(null); }} title="Faculty Deloading">
        {deloadSavedNote !== null && <AssignSuccess title="Deloading saved!" note={deloadSavedNote} />}
        {designationPending && (() => {
          const totalDeduction = deductionEntries.reduce((s, e) => s + (parseFloat(e.units) || 0), 0);
          const availableLoad  = Math.max(0, regularCap - totalDeduction);
          return (
            <div className="space-y-5">
              {/* Instructor info */}
              <div className="bg-[#0d1424] border border-white/10 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <div className="font-bold text-white text-base">{designationPending.name}</div>
                  <div className="text-xs text-slate-400">{designationPending.position} · Permanent</div>
                </div>
                <div className="text-right text-xs text-slate-500">
                  Base load: <span className="font-semibold text-slate-300">{loadDisplay(regularCap)} units</span>
                </div>
              </div>

              {/* No semester selected warning */}
              {(!listSemester || !listYear) && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-sm text-amber-300 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  Please select a semester in the sidebar before setting load deductions.
                </div>
              )}

              {/* Loading indicator while fetching existing deductions */}
              {modalDeductionsLoading && (
                <div className="flex items-center justify-center gap-2 text-sm text-slate-400 py-2">
                  <div className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
                  Loading existing deductions…
                </div>
              )}

              {designationError && (
                <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-3 rounded-lg text-sm flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                  {designationError}
                </div>
              )}

              {/* Deduction type checkboxes */}
              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-300 mb-3">Deloading Types</div>

                {/* None — a switch that pauses the entries below without erasing them:
                    checking it stops them being counted or saved, unchecking brings them back. */}
                <label className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-colors duration-300 select-none ${
                  deductionNone
                    ? 'bg-slate-700/60 border-slate-500/60 text-slate-200'
                    : 'bg-white/[0.03] border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={deductionNone}
                    onChange={e => {
                      setDeductionNone(e.target.checked);
                      setDesignationError('');
                    }}
                    className="w-4 h-4 accent-slate-400 flex-shrink-0"
                  />
                  <span className="text-sm font-medium flex-1">None</span>
                </label>
                <AnimatePresence initial={false}>
                  {deductionNone && deductionEntries.length > 0 && (
                    <motion.p
                      key="deload-paused-note"
                      initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                      className="overflow-hidden text-xs text-slate-400 px-1"
                    >
                      Your entries are kept. Uncheck None or click an option to use them again.
                    </motion.p>
                  )}
                </AnimatePresence>

                {/* Deduction type options */}
                {DEDUCTION_OPTIONS.map(opt => {
                  const entry   = deductionEntries.find(e => e.type === opt);
                  const checked = !!entry;
                  const paused  = deductionNone && checked;
                  return (
                    <div key={opt}>
                      <label className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-[background-color,border-color,color,opacity] duration-300 select-none ${
                        deductionNone
                          ? 'opacity-60 bg-white/[0.02] border-white/10 text-slate-400 hover:opacity-100 hover:border-white/20'
                          : checked
                            ? 'bg-[#1D5BD6]/10 border-[#1D5BD6]/40 text-blue-300'
                            : 'bg-white/[0.03] border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-300'
                      }`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={e => {
                            setDesignationError('');
                            // Shortcut: while None is on, clicking an option turns None off and
                            // switches this option on (earlier entries come back as they were).
                            if (deductionNone) {
                              setDeductionNone(false);
                              if (!checked) setDeductionEntries(prev => [...prev, { type: opt, description: '', units: '' }]);
                              return;
                            }
                            setDeductionEntries(prev =>
                              e.target.checked
                                ? [...prev, { type: opt, description: '', units: '' }]
                                : prev.filter(x => x.type !== opt)
                            );
                          }}
                          className="w-4 h-4 accent-[#1D5BD6] flex-shrink-0"
                        />
                        <span className="text-sm font-medium flex-1">{opt}</span>
                        {paused && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-white/10 text-slate-300">
                            Paused{entry.units && !isNaN(parseFloat(entry.units)) ? ` · ${parseFloat(entry.units).toFixed(2)} units` : ''}
                          </span>
                        )}
                      </label>

                      {/* Expanded fields for checked type */}
                      <AnimatePresence initial={false}>
                      {checked && !deductionNone && (
                        <motion.div
                          key={`${opt}-fields`}
                          initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                          className="overflow-hidden"
                        >
                        <div className="ml-4 mt-2 mb-1 pl-4 border-l-2 border-[#1D5BD6]/30 space-y-2">
                          <div>
                            <label className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1 block">
                              Description <span className="normal-case text-slate-600">(optional)</span>
                            </label>
                            <input
                              type="text"
                              placeholder={`e.g. Department Chair`}
                              value={entry.description}
                              onChange={ev => setDeductionEntries(prev =>
                                prev.map(e => e.type === opt ? { ...e, description: ev.target.value } : e)
                              )}
                              className="w-full bg-[#0b0f1a] border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#1D5BD6]/50 placeholder:text-slate-600"
                            />
                          </div>
                          <div className="flex items-end gap-3">
                            <div>
                              <label className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1 block">
                                Units to deduct <span className="text-red-400">*</span>
                              </label>
                              <input
                                type="number"
                                min={0.5}
                                max={regularCap}
                                step={0.5}
                                placeholder="e.g. 3"
                                value={entry.units}
                                onChange={ev => {
                                  setDeductionEntries(prev =>
                                    prev.map(e => e.type === opt ? { ...e, units: ev.target.value } : e)
                                  );
                                  setDesignationError('');
                                }}
                                className="w-28 bg-[#0b0f1a] border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#1D5BD6]/50 placeholder:text-slate-600"
                              />
                            </div>
                            {entry.units !== '' && !isNaN(parseFloat(entry.units)) && (
                              <span className="text-xs text-amber-400 pb-2">
                                −{parseFloat(entry.units).toFixed(2)} units
                              </span>
                            )}
                          </div>
                        </div>
                        </motion.div>
                      )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>

              {/* Live summary preview */}
              <div className={`rounded-xl border p-4 space-y-2 ${
                deductionNone || deductionEntries.length === 0
                  ? 'bg-emerald-500/10 border-emerald-500/20'
                  : totalDeduction > regularCap
                    ? 'bg-red-500/10 border-red-500/30'
                    : 'bg-[#0d1424] border-white/10'
              }`}>
                {deductionNone || deductionEntries.length === 0 ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">Regular Load</span>
                    <span className="font-bold text-emerald-300 text-base">
                      {loadDisplay(regularCap)} <span className="text-xs font-normal text-emerald-600">units</span>
                    </span>
                  </div>
                ) : (
                  <>
                    {deductionEntries.map(e => {
                      const v = parseFloat(e.units) || 0;
                      return (
                        <div key={e.type} className="flex items-center justify-between text-sm">
                          <span className="text-slate-400">
                            {e.type}{e.description.trim() ? ` — ${e.description.trim()}` : ''}
                          </span>
                          <span className="text-amber-300 font-semibold tabular-nums">
                            −{v.toFixed(2)} units
                          </span>
                        </div>
                      );
                    })}
                    <div className="border-t border-white/10 pt-2 space-y-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-500">Total Deduction</span>
                        <span className={`font-bold tabular-nums ${totalDeduction > regularCap ? 'text-red-400' : 'text-amber-400'}`}>
                          −{totalDeduction.toFixed(2)} units
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-slate-300">Available Regular Load</span>
                        <span className={`font-bold text-base tabular-nums ${totalDeduction > regularCap ? 'text-red-400' : 'text-emerald-300'}`}>
                          {loadDisplay(availableLoad)}
                          <span className={`text-xs font-normal ml-1 ${totalDeduction > regularCap ? 'text-red-600' : 'text-emerald-600'}`}>units</span>
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setDesignationPending(null)}
                  disabled={designationLoading}
                  className="flex-1 border border-white/10 text-slate-300 py-2.5 rounded-xl text-sm font-semibold hover:bg-white/5 transition disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmDesignation}
                  disabled={designationLoading || modalDeductionsLoading || !listSemester || !listYear || (!deductionNone && deductionEntries.length === 0)}
                  className="flex-1 bg-[#1D5BD6] text-white py-2.5 rounded-xl text-sm font-bold hover:bg-[#2E7DD1] transition disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {designationLoading
                    ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
                    : 'Save & Continue'}
                </button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* Praise Modal — like Faculty Deloading: opens with the current praise; tick to add, untick to remove */}
      <Modal open={praiseModalOpen} onClose={() => { if (!praiseLoading && praiseSavedNote === null) setPraiseModalOpen(false); }} title="Praise Load">
        {praiseSavedNote !== null && <AssignSuccess title="Praise Load saved!" note={praiseSavedNote} />}
        {(() => {
          const { dirty } = praiseChanges(praiseEntries, praiseOriginal);
          // Fixed types first, then any older type already saved for this faculty
          const typeList = [...PRAISE_TYPES as readonly string[]];
          for (const en of [...praiseOriginal, ...praiseEntries]) if (!typeList.includes(en.type)) typeList.push(en.type);
          const updateEntry = (key: string, patch: Partial<PraiseEntry>) =>
            setPraiseEntries(prev => prev.map(x => x.key === key ? { ...x, ...patch } : x));
          return (
        <form onSubmit={savePraise} className="space-y-4">
          {praiseError && (
            <div className="bg-[#FEE2E2] border border-[#FECACA] text-[#DC2626] px-4 py-3 rounded-xl text-sm">{praiseError}</div>
          )}
          <p className="text-sm text-[#64748B]">Non-teaching assignments only (Research, Extension, Administrative, etc.).</p>

          <div className="space-y-2">
            <span className="text-sm font-semibold text-[#334155]">Praise Types</span>
            {typeList.map(opt => {
              const list = praiseEntries.filter(en => en.type === opt);
              const checked = list.length > 0;
              return (
                <div key={opt}>
                  <label className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-[background-color,border-color,color] duration-300 select-none ${
                    checked
                      ? 'bg-[#1D5BD6]/10 border-[#1D5BD6]/40 text-blue-300'
                      : 'bg-white/[0.03] border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-300'
                  }`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={ev => {
                        setPraiseError('');
                        setPraiseEntries(prev => ev.target.checked
                          ? [...prev, newPraiseEntry(opt)]
                          : prev.filter(x => x.type !== opt));
                      }}
                      className="w-4 h-4 accent-[#1D5BD6] flex-shrink-0"
                    />
                    <span className="text-sm font-medium flex-1">{opt}</span>
                    {list.some(en => en.id != null) && (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#ECFDF5] text-[#047857]">Saved</span>
                    )}
                  </label>

                  <AnimatePresence initial={false}>
                  {list.map((entry, i) => (
                    <motion.div
                      key={entry.key}
                      initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                      className="overflow-hidden"
                    >
                    <div className="ml-4 mt-2 mb-1 pl-4 border-l-2 border-[#1D5BD6]/30 space-y-2">
                      {list.length > 1 && (
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Entry {i + 1}</span>
                          <button type="button" onClick={() => setPraiseEntries(prev => prev.filter(x => x.key !== entry.key))}
                            className="text-xs font-semibold text-[#DC2626] hover:underline underline-offset-2">
                            Remove
                          </button>
                        </div>
                      )}
                      <div>
                        <label className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1 block">
                          Description <span className="normal-case text-slate-600">(optional)</span>
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. Research Coordinator"
                          value={entry.description}
                          onChange={ev => updateEntry(entry.key, { description: ev.target.value })}
                          className="w-full bg-[#0b0f1a] border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#1D5BD6]/50 placeholder:text-slate-600"
                        />
                      </div>
                      <div className="flex items-end gap-3">
                        <div>
                          <label className="text-[11px] font-medium text-slate-500 uppercase tracking-wide mb-1 block">
                            Equivalent units
                          </label>
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="0"
                            value={entry.units}
                            onChange={ev => {
                              const raw = ev.target.value;
                              if (!isNonNegDecimalDraft(raw)) return;
                              updateEntry(entry.key, { units: raw });
                              setPraiseError('');
                            }}
                            className="w-28 bg-[#0b0f1a] border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#1D5BD6]/50 placeholder:text-slate-600"
                          />
                        </div>
                        {entry.units !== '' && !isNaN(parseFloat(entry.units)) && (
                          <span className="text-xs text-[#A16207] pb-2">+{parseFloat(entry.units).toFixed(2)} units</span>
                        )}
                      </div>
                    </div>
                    </motion.div>
                  ))}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>

          {/* Live summary — like Deloading's */}
          {praiseEntries.length > 0 ? (() => {
            const total = praiseEntries.reduce((sum, en) => sum + (parseFloat(en.units) || 0), 0);
            return (
              <div className="rounded-xl border p-4 space-y-2 bg-[#0d1424] border-white/10">
                {praiseEntries.map(en => (
                  <div key={en.key} className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">{en.type}{en.description.trim() ? ` — ${en.description.trim()}` : ''}</span>
                    <span className="font-semibold tabular-nums text-[#A16207]">+{(parseFloat(en.units) || 0).toFixed(2)} units</span>
                  </div>
                ))}
                <div className="border-t border-white/10 pt-2 flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-300">Total Praise Load</span>
                  <span className="font-bold text-base tabular-nums text-[#A16207]">{total.toFixed(2)} <span className="text-xs font-normal">units</span></span>
                </div>
              </div>
            );
          })() : praiseOriginal.length > 0 ? (
            <p className="text-sm text-[#B45309]">Saving will remove all of this faculty&apos;s Praise Load.</p>
          ) : null}

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => setPraiseModalOpen(false)} disabled={praiseLoading}
              className="flex-1 border border-white/10 text-slate-300 py-2.5 rounded-xl text-sm font-semibold hover:bg-white/5 transition disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={praiseLoading || !dirty}
              className="flex-1 bg-[#1D5BD6] text-white py-2.5 rounded-xl text-sm font-bold hover:bg-[#2E7DD1] transition disabled:opacity-60 flex items-center justify-center gap-2">
              {praiseLoading
                ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Saving…</>
                : 'Save Praise Load'}
            </button>
          </div>
        </form>
          );
        })()}
      </Modal>
    </div>
  );
}

// ─── AssignSuccess ────────────────────────────────────────────────────────────

/** Same success card as Faculty "updated!" — covers the whole dialog after saving. */
/** Big, high-contrast checkbox for picking subjects to assign in one save. */
function PickBox({ checked, mixed = false, onToggle, label }: {
  checked: boolean; mixed?: boolean; onToggle: () => void; label: string;
}) {
  const reduceMotion = useReducedMotion();
  const on = checked || mixed;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      onClick={e => { e.stopPropagation(); onToggle(); }}
      className={`w-6 h-6 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40 ${
        on ? 'bg-[#1D5BD6] border-[#1D5BD6]' : 'bg-white border-[#94A3B8] hover:border-[#1D5BD6]'
      }`}
    >
      <AnimatePresence mode="wait" initial={false}>
        {on && (
          <motion.span
            key={mixed ? 'mixed' : 'check'}
            initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { scale: 0.4, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
            className="flex"
          >
            {mixed
              ? <Minus className="w-4 h-4 text-white" strokeWidth={3} />
              : <Check className="w-4 h-4 text-white" strokeWidth={3} />}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

function AssignSuccess({ note, title = 'Subject assigned!' }: { note: string; title?: string }) {
  return (
    <div
      className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay"
      role="status"
      aria-live="polite"
    >
      <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl">
        <svg width="72" height="72" viewBox="0 0 52 52" aria-hidden="true">
          <circle className="save-success-circle" cx="26" cy="26" r="24" fill="none" stroke="#22C55E" strokeWidth="3" />
          <path
            className="save-success-check"
            fill="none" stroke="#22C55E" strokeWidth="3.5"
            strokeLinecap="round" strokeLinejoin="round"
            d="M14.5 27 22 34.5 38 17"
          />
        </svg>
        <div className="text-center">
          <p className="text-base font-semibold" style={{ color: '#0B2A5B' }}>{title}</p>
          {note && <p className="mt-0.5 text-sm text-[#475569]">{note}</p>}
        </div>
      </div>
    </div>
  );
}
