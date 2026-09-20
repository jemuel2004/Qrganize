'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useVisibilityAwareInterval } from '@/client/hooks/useVisibilityAwareInterval';
import { useToast } from '@/client/context/ToastContext';
import { useSchoolYear } from '@/client/context/SchoolYearContext';
import { SearchInput, FilterSelect, FilterBar } from '@/components/ui/SearchFilter';
import Modal from '@/client/components/ui/Modal';
import OfficialWorkloadFormTable, { type OfficialFormRow } from '@/client/components/OfficialWorkloadFormTable';
import {
  matchOfficialSlot,
  formatOfficialNumber,
  formatOfficialTimeRange,
  occupiedRangeFromScheduleTimes,
} from '@/lib/officialWorkloadSlots';
import { printRegularLoadDocument } from '@/lib/instructorWorkloadPrintDocument';
import { openWorkloadPrintableVersion } from '@/lib/openPrintHtmlDocument';
import { coerceSubjectCategory } from '@/lib/subjectCategory';
import { REGULAR_LOAD_MAX_UNITS } from '@/lib/regularLoad';
import { blockCurriculumVersion, curriculumVersionAbbrev } from '@/lib/curriculumVersion';
import { ListSkeleton } from '@/client/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';
import {
  Plus, X, AlertTriangle,
  Eye, Award, CheckCircle2, Pencil,
  Trash2, ArrowUpCircle, ArrowDownCircle, ArrowRight, ArrowLeft,
} from 'lucide-react';

interface Faculty {
  id: number; name: string; employee_id: string; position: string; employment_status: string;
  designation_type: string; designation_units: number;
  program_id: number | null; program_code: string | null; program_name: string | null;
  years_in_service: number | null;
  educational_qualification: string | null;
  major: string | null;
  eligibility: string | null;
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
}
interface Block {
  id: number; block_name: string; year_level: string; semester: string;
  academic_year: string; program_id: number; program_code: string;
  subject_count?: number; unassigned_count?: number;
  assigned_count?: number; scheduled_count?: number;
  curriculum_version?: string;
}

/** A block is complete only when it has subjects and none remain unassigned. 0/0 is not complete. */
function isBlockFullyAssigned(b: Block): boolean {
  return Number(b.subject_count) > 0 && Number(b.unassigned_count) === 0;
}

function blockDropdownLabel(b: Block): string {
  const abbr = curriculumVersionAbbrev(blockCurriculumVersion(b.curriculum_version));
  const available = Number(b.unassigned_count) || 0;
  return `Block ${b.block_name} — ${abbr} · ${available} Available`;
}

interface Program { id: number; code: string; name: string; department?: string | null; }

/** Active programs for the selected instructor, ordered by program code. */
function programsAllowedForInstructor(faculty: Faculty | null, allPrograms: Program[]): Program[] {
  if (!faculty) return [];
  return [...allPrograms].sort((a, b) =>
    a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: 'base' })
  );
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

/* Shown when instructor still has remaining regular load and admin clicks Assign */
interface RemainingBalanceWarning {
  msId: number;
  subjectCode: string;
  subjectName: string;
  remaining: number;
  subjectValue: number;
  unit: string;
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

/* Highest → lowest academic rank for Permanent instructors */
const POSITION_RANK: Record<string, number> = {
  'Professor II': 1, 'Professor I': 2,
  'Associate Professor IV': 3, 'Associate Professor III': 4,
  'Associate Professor II': 5, 'Associate Professor I': 6,
  'Assistant Professor V': 7, 'Assistant Professor IV': 8,
  'Assistant Professor III': 9, 'Assistant Professor II': 10,
  'Assistant Professor I': 11,
  'Instructor III': 12, 'Instructor II': 13, 'Instructor I': 14,
  'Temporary Permanent': 15,
};

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
  return { displayWU, displayHours };
}

function extractYearNum(yearLevel: string): string {
  const m = yearLevel.match(/\d+/);
  return m ? m[0] : yearLevel;
}

/* -- Load Deduction types ----------------------------------------------- */
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

const EMPTY_PRAISE_FORM = {
  praise_type: '',
  description: '',
  equivalent_units: '0',
  equivalent_hours: '0',
  remarks: '',
};

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
}: {
  initialFacultyQuery?: string;
}) {
  const toast = useToast();
  const { schoolYear: globalYear, semester: globalSemester, loading: syLoading } = useSchoolYear();
  const syInit = useRef(false);
  const appliedFacultyQuery = useRef<string | null>(null);

  const [faculty, setFaculty] = useState<Faculty[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [allBlocks, setAllBlocks] = useState<Block[]>([]);
  const [search, setSearch] = useState('');
  const [filterEmploymentType, setFilterEmploymentType] = useState('');

  const [facultySummaries, setFacultySummaries] = useState<Record<number, FacultySummary>>({});
  /* Single global semester/year — drives the instructor list badges, workload
   * details, and the block/subject assignment filters. No second selector needed. */
  const [listSemester, setListSemester] = useState('');
  const [listYear, setListYear] = useState('');

  // Initialize from global school year context once it loads
  useEffect(() => {
    if (!syLoading && !syInit.current) {
      syInit.current = true;
      if (globalYear)    setListYear(globalYear);
      if (globalSemester) setListSemester(globalSemester);
    }
  }, [syLoading, globalYear, globalSemester]);

  const [selectedFaculty, setSelectedFaculty] = useState<Faculty | null>(null);
  const [workload, setWorkload] = useState<WorkloadSummary | null>(null);
  /* All-semester loads: same as workload.loads but never semester-filtered.
   * This is the single source of truth for the Workload Form modal and the
   * Handled Subjects overload table — ensures subjects like IT321 are never
   * hidden just because a different semester is selected in the workload tab. */
  const [allWorkloadLoads, setAllWorkloadLoads] = useState<WorkloadLoad[]>([]);

  const [filterProgram, setFilterProgram] = useState('');
  const [filterBlock, setFilterBlock] = useState('');
  const [filterYearLevel, setFilterYearLevel] = useState('');
  // filterSemester and filterAcademicYear are derived from the global selectors —
  // no separate state, so Step 2 always stays in sync with Step 1 automatically.
  const filterSemester    = listSemester;
  const filterAcademicYear = listYear;

  const [availableSchedules, setAvailableSchedules] = useState<Schedule[]>([]);
  const [availLoading, setAvailLoading] = useState(false);
  const [filtersApplied, setFiltersApplied] = useState(false);

  const [assignMsg, setAssignMsg] = useState('');
  const [assignError, setAssignError] = useState('');

  /* Assignment confirmation modals */
  const [remainingBalanceWarning, setRemainingBalanceWarning] = useState<RemainingBalanceWarning | null>(null);
  const [overloadConfirm, setOverloadConfirm] = useState<OverloadConfirmData | null>(null);

  /* Move to Overload modal */
  const [moveToOverloadTarget, setMoveToOverloadTarget] = useState<MoveToOverloadContext | null>(null);
  const [moveToOverloadProcessing, setMoveToOverloadProcessing] = useState(false);
  const [moveToOverloadMode, setMoveToOverloadMode] = useState<'entire' | 'split'>('entire');
  const [splitRegularAmount, setSplitRegularAmount] = useState(0);
  /* Units the admin wants to keep as Regular for the specific component being moved */
  const [componentSplitUnits, setComponentSplitUnits] = useState(0);

  const [instructorPanelCollapsed, setInstructorPanelCollapsed] = useState(false);
  const [workloadModalOpen, setWorkloadModalOpen] = useState(false);
  const [workloadModalTab, setWorkloadModalTab] = useState<'regular' | 'overload' | 'praise'>('regular');
  const [printError, setPrintError] = useState('');
  const [printOfferFallback, setPrintOfferFallback] = useState(false);
  const [praiseModalOpen, setPraiseModalOpen] = useState(false);
  const [praiseForm, setPraiseForm] = useState(EMPTY_PRAISE_FORM);
  const [praiseError, setPraiseError] = useState('');
  const [praiseLoading, setPraiseLoading] = useState(false);
  const [deletePraiseTarget, setDeletePraiseTarget] = useState<{ id: number; praise_type: string } | null>(null);
  const [deletingPraise, setDeletingPraise]         = useState(false);

  /* Return to Regular Load modal */
  const [returnToRegularTarget, setReturnToRegularTarget] = useState<WorkloadLoad | null>(null);
  const [returnToRegularMode, setReturnToRegularMode] = useState<'entire' | 'partial'>('entire');
  const [returnToRegularAmount, setReturnToRegularAmount] = useState(0);
  const [returnToRegularProcessing, setReturnToRegularProcessing] = useState(false);
  const [returnToRegularError, setReturnToRegularError] = useState('');

  const [moveToPraiseConfirm, setMoveToPraiseConfirm] = useState<{ ids: number[]; total: number } | null>(null);
  const [moveToPraiseProcessing, setMoveToPraiseProcessing] = useState(false);
  const [returnToOverloadConfirm, setReturnToOverloadConfirm] = useState<{ ids: number[]; total: number } | null>(null);
  const [returnToOverloadProcessing, setReturnToOverloadProcessing] = useState(false);

  /* Remove subject from workload — confirmation modal */
  const [removeWorkloadTarget, setRemoveWorkloadTarget] = useState<WorkloadLoad | null>(null);
  const [removingWorkload, setRemovingWorkload] = useState(false);

  /* Load Deduction modal — opened only via Edit Deduction */
  const [designationPending, setDesignationPending] = useState<Faculty | null>(null);
  const [deductionEntries, setDeductionEntries] = useState<DeductionEntry[]>([]);
  const [deductionNone, setDeductionNone] = useState(true);
  const [designationError, setDesignationError] = useState('');
  const [designationLoading, setDesignationLoading] = useState(false);
  const [modalDeductionsLoading, setModalDeductionsLoading] = useState(false);
  const [deductionMsg, setDeductionMsg] = useState('');
  const [subjectSearch, setSubjectSearch] = useState('');
  const [subjectCategory, setSubjectCategory] = useState<'Minor' | 'Major'>('Minor');
  const [showInstructorDropdown, setShowInstructorDropdown] = useState(false);
  const instructorDropRef = useRef<HTMLDivElement>(null);

  const loadBlocks = useCallback(() => {
    fetch('/api/blocks')
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

  const loadFacultyList = useCallback(() => {
    fetch('/api/faculty')
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => {
        if (d && !d.error) setFaculty(d.faculty || []);
      })
      .catch(err => {
        console.warn('[workload] loadFacultyList failed:', err instanceof Error ? err.message : err);
      });
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

  /* All blocks for the selected program (used to build year-level options) */
  const programBlocks = allBlocks.filter(b => !filterProgram || String(b.program_id) === filterProgram);

  /* Unique year levels available in the selected program, sorted */
  const programYearLevels = [...new Set(programBlocks.map(b => b.year_level))].sort();

  /* Blocks further filtered by year level, semester, and academic year to prevent duplicates */
  const filteredBlocks = programBlocks.filter(b =>
    (!filterYearLevel    || b.year_level    === filterYearLevel)    &&
    (!filterSemester     || b.semester      === filterSemester)     &&
    (!filterAcademicYear || b.academic_year === filterAcademicYear)
  );

  function handleBlockChange(blockId: string) {
    if (blockId) {
      const block = allBlocks.find(b => String(b.id) === blockId);
      if (block && isBlockFullyAssigned(block) && filterBlock !== blockId) return;
    }
    setFilterBlock(blockId);
    setAvailableSchedules([]);
    setFiltersApplied(false);
  }

  function handleYearLevelChange(yl: string) {
    setFilterYearLevel(yl);
    setFilterBlock('');            // reset block when year level changes
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

  // Full reset of instructor selection and all dependent child filters.
  // Called whenever Employment Type changes so no stale data from the
  // previous type leaks into the new context.
  const resetInstructorAndFilters = useCallback(() => {
    setSearch('');
    setShowInstructorDropdown(false);
    setSelectedFaculty(null);
    setWorkload(null);
    setAllWorkloadLoads([]);
    setFilterProgram('');
    setFilterBlock('');
    setFilterYearLevel('');
    setAvailableSchedules([]);
    setFiltersApplied(false);
    setAssignMsg('');
    setAssignError('');
    setRemainingBalanceWarning(null);
    setOverloadConfirm(null);
    setMoveToOverloadTarget(null);
    setMoveToOverloadMode('entire');
    setSplitRegularAmount(0);
    setComponentSplitUnits(0);
  }, []);

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
      if (split) n += 1;
    }
    return n;
  }

  function countPraiseEntries(loads: WorkloadLoad[], praiseRows: unknown[]): number {
    return loads.filter(l => l.load_category === 'Praise').length + praiseRows.length;
  }

  /**
   * Keep the Workload Form open; if the active special section became empty,
   * fall back to Regular Load. If it still has records, stay on that section.
   */
  function syncWorkloadModalTab(opts: {
    current: 'regular' | 'overload' | 'praise';
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
    if (!listSemester) { setFacultySummaries({}); return; }
    const params = new URLSearchParams({ semester: listSemester, academic_year: listYear });
    fetch(`/api/workload/summaries?${params}`)
      .then(r => r.json())
      .then(d => setFacultySummaries(d.summaries || {}))
      .catch(() => {});
  }, [listSemester, listYear]);

  useEffect(() => { loadFacultySummaries(); }, [loadFacultySummaries]);

  useVisibilityAwareInterval(() => {
    loadBlocks();
    loadFacultyList();
    loadFacultySummaries();
  }, 30_000);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (instructorDropRef.current && !instructorDropRef.current.contains(e.target as Node)) {
        setShowInstructorDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function loadAvailable() {
    if (!allFiltersSet) return;
    setAvailLoading(true);
    setFiltersApplied(true);
    const params = new URLSearchParams({
      status: 'Unassigned',
      program_id: filterProgram,
      block_id: filterBlock,
      year_level: filterYearLevel,
      semester: filterSemester,
      academic_year: filterAcademicYear,
    });
    fetch('/api/master-schedule?' + params)
      .then(r => r.json())
      .then(d => { setAvailableSchedules(d.schedules || []); setAvailLoading(false); })
      .catch(() => setAvailLoading(false));
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
  async function assignSubject(msId: number, assignCategory?: 'regular' | 'overload') {
    if (!selectedFaculty) return;
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
        if (data.confirmation_type === 'remaining_balance') {
          setRemainingBalanceWarning({
            msId,
            subjectCode:  data.subject_code  || '',
            subjectName:  data.subject_name  || '',
            remaining:    data.remaining,
            subjectValue: data.subject_value,
            unit:         data.unit,
          });
        } else {
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
        }
        return;
      }

      if (!res.ok) { setAssignError(data.error || 'Failed to assign subject'); toast.error(data.error || 'Failed to assign subject.'); return; }
      setAssignMsg(data.message || 'Subject assigned successfully.');
      toast.success('Subject assigned successfully.');
      setRemainingBalanceWarning(null);
      setOverloadConfirm(null);
      loadWorkload(); loadAllFacultyLoads(); loadAvailable(); loadFacultySummaries(); loadBlocks();
    } catch { setAssignError('Connection error'); toast.error('Connection error. Please try again.'); }
  }

  async function unassignSubject(msId: number) {
    if (!selectedFaculty) return;
    const res = await fetch('/api/workload/unassign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ faculty_id: selectedFaculty.id, master_schedule_id: msId }),
    });
    if (!res.ok) { const d = await res.json(); setAssignError(d.error || 'Failed to unassign subject'); toast.error(d.error || 'Failed to remove subject.'); return; }
    toast.success('Subject removed successfully.');
    loadWorkload(); loadAllFacultyLoads(); loadAvailable(); loadFacultySummaries(); loadBlocks();
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
    } else {
      /* Full / single-component: keep the existing max-regular pre-fill for the split slider */
      const subjectTotal = isPermanent ? calcWorkloadUnits(lec, lab) : lec + lab;
      const maxRegular = summary
        ? parseFloat(Math.max(0, Math.min(subjectTotal - 0.01, subjectTotal + summary.remaining_regular_load)).toFixed(2))
        : 0;
      setSplitRegularAmount(maxRegular);
      setComponentSplitUnits(0);
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

  async function addPraise(e: React.FormEvent) {
    e.preventDefault();
    if (!filterSemester) { setPraiseError('Please select a semester before adding a Praise assignment.'); return; }
    const units = parseNonNegDecimal(praiseForm.equivalent_units);
    const hours = parseNonNegDecimal(praiseForm.equivalent_hours);
    if (units === null) { setPraiseError('Equivalent Units must be a valid non-negative number.'); return; }
    if (hours === null) { setPraiseError('Equivalent Hours must be a valid non-negative number.'); return; }
    if (
      !hasAtMostThreeNumericDigits(praiseForm.equivalent_units)
      || !hasAtMostThreeNumericDigits(praiseForm.equivalent_hours)
    ) {
      setPraiseError('Maximum of 3 digits only (e.g., 1.23).');
      return;
    }
    setPraiseLoading(true); setPraiseError('');
    try {
      const res = await fetch('/api/praise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_id: selectedFaculty?.id,
          praise_type: praiseForm.praise_type,
          description: praiseForm.description,
          remarks: praiseForm.remarks,
          equivalent_units: units,
          equivalent_hours: hours,
          academic_year: filterAcademicYear,
          semester: filterSemester,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setPraiseError(data.error); toast.error(data.error || 'Failed to add PRAISE assignment.'); return; }
      toast.success('PRAISE assignment added successfully.');
      setPraiseForm(EMPTY_PRAISE_FORM);
      setPraiseModalOpen(false);
      loadWorkload(); loadAllFacultyLoads();
    } catch { setPraiseError('Connection error'); toast.error('Connection error. Please try again.'); }
    finally { setPraiseLoading(false); }
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
      toast.success('Praise Load removed successfully.');
      setDeletePraiseTarget(null);

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
    setRemainingBalanceWarning(null); setOverloadConfirm(null);
    setMoveToOverloadTarget(null); setMoveToOverloadMode('entire'); setSplitRegularAmount(0); setComponentSplitUnits(0);
    setAvailableSchedules([]);
    setFiltersApplied(false);
    setFilterYearLevel('');
    setFilterBlock('');
    setFilterProgram(f.program_id != null ? String(f.program_id) : '');
    setMoveToPraiseConfirm(null);
    setReturnToOverloadConfirm(null);
    setSelectedFaculty(f);
  }, []);

  useEffect(() => {
    const raw = initialFacultyQuery.trim();
    if (!raw) return;
    if (appliedFacultyQuery.current === raw) return;
    if (faculty.length === 0) return;

    appliedFacultyQuery.current = raw;
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.error('Invalid instructor.');
      return;
    }
    const match = faculty.find(f => f.id === id);
    if (!match) {
      toast.error('Instructor not found or is no longer active.');
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
      if (total > REGULAR_LOAD_MAX_UNITS) {
        setDesignationError(`Total deduction cannot exceed ${REGULAR_LOAD_MAX_UNITS} units.`); return;
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
      setDesignationPending(null);
      setDeductionMsg('Load deduction saved. Workload updated.');
      loadWorkload();
      loadAllFacultyLoads();
      loadFacultySummaries();
    } catch { setDesignationError('Connection error. Please try again.'); }
    finally { setDesignationLoading(false); }
  }

  const summary = workload?.summary;
  const isPermanent = selectedFaculty?.employment_status === 'Permanent';
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
    /* Exceeded: teaching load (current_load) surpasses the available slot (regular_load_limit = REGULAR_LOAD_MAX_UNITS - deduction) */
    const exceeded = Math.max(0, s.current_load - s.regular_load_limit);
    if (exceeded > 0.001)          return { label: 'Exceeded',    dot: 'bg-red-500',    text: 'text-red-400'    } as const;
    if (s.has_overload)            return { label: 'Has Overload', dot: 'bg-purple-500', text: 'text-purple-400' } as const;
    if (s.remaining_load <= 0.001) return { label: 'Full Load',   dot: 'bg-amber-500',  text: 'text-amber-400'  } as const;
    const pct = s.regular_load_limit > 0 ? s.remaining_load / s.regular_load_limit : 1;
    if (pct <= 0.3)                return { label: 'Near Limit',  dot: 'bg-yellow-400', text: 'text-yellow-400' } as const;
    return                                { label: 'Available',   dot: 'bg-emerald-500', text: 'text-emerald-400' } as const;
  }

  const filteredFaculty = faculty
    .filter(f => {
      const matchesSearch = !search ||
        f.name.toLowerCase().includes(search.toLowerCase()) ||
        f.employee_id.toLowerCase().includes(search.toLowerCase());
      const matchesType = !filterEmploymentType ||
        f.employment_status === filterEmploymentType;
      return matchesSearch && matchesType;
    })
    .sort((a, b) => {
      if (filterEmploymentType === 'Permanent') {
        const ra = POSITION_RANK[a.position] ?? 99;
        const rb = POSITION_RANK[b.position] ?? 99;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });

  const selectedBlock   = allBlocks.find(b => String(b.id) === filterBlock);
  const selectedProgram = programs.find(p => String(p.id) === filterProgram);
  const instructorSelected = selectedFaculty != null;
  const programsForInstructor = programsAllowedForInstructor(selectedFaculty, programs);

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
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-400 border border-purple-500/30">
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
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-purple-500/20 text-purple-400 border border-purple-500/30">
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


  /* Subject-table client-side search — scoped to the active Major/Minor tab */
  const categorySchedules = availableSchedules.filter(s =>
    coerceSubjectCategory(s.subject_category, 'Minor') === subjectCategory
  );
  const displaySchedules = categorySchedules.filter(s =>
    !subjectSearch ||
    s.subject_code.toLowerCase().includes(subjectSearch.toLowerCase()) ||
    s.subject_name.toLowerCase().includes(subjectSearch.toLowerCase())
  );
  const showSubjectsSkeleton = useMinLoading(availLoading, LOADING_DELAY);

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0 space-y-5">
      {/* -- Page Header ------------------------------------------------------- */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 min-w-0">
        <div className="min-w-0">
          <h1 className="text-[22px] sm:text-[26px] font-bold tracking-tight text-[#1E3A5F] leading-tight">
            Faculty Workload
          </h1>
          <p className="text-sm text-[#65676B] mt-1 max-w-xl">
            Assign an instructor to each block subject before scheduling.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end sm:flex-shrink-0">
          {selectedFaculty && isPermanent && (
            <button
              type="button"
              onClick={() => openDeductionModal(selectedFaculty)}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 min-h-10 rounded-xl text-sm font-semibold border border-[#E2E8F0] bg-[var(--surface-elevated)] text-[#1E3A5F] hover:bg-[var(--background-secondary)] transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit Deduction
            </button>
          )}
          {selectedFaculty && isPermanent && (
            <button
              type="button"
              onClick={() => {
                setPraiseForm(EMPTY_PRAISE_FORM);
                setPraiseError('');
                setPraiseModalOpen(true);
              }}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 min-h-10 rounded-xl text-sm font-semibold border border-[#E2E8F0] bg-[var(--surface-elevated)] text-[#1E3A5F] hover:bg-[var(--background-secondary)] transition-colors"
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
              setWorkloadModalTab('regular');
            }}
            className={[
              'inline-flex items-center justify-center gap-2 px-4 min-h-10 rounded-xl text-sm font-semibold transition-colors',
              selectedFaculty
                ? 'bg-[#3C91E6] text-white hover:bg-[#2E7DD1]'
                : 'bg-[#E4E6EB] text-[#64748B] cursor-not-allowed border border-[#D1D5DB]',
            ].join(' ')}
            title={selectedFaculty ? 'View assigned workload' : 'Select an instructor first'}
          >
            <Eye className="w-4 h-4" aria-hidden />
            View Workload
          </button>
        </div>
      </div>

      {/* -- Filter Card: Instructor → Program → Year → Block ------------------ */}
      <FilterBar className="relative z-20 min-w-0 overflow-visible mb-0">
        <div className="mb-4">
          <p className="text-sm font-semibold text-[#1E3A5F]">Filter by</p>
          <p className="text-xs text-slate-400 mt-0.5">Instructor, then program, year level, and block</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-4">

          <div className="min-w-0 order-1 lg:col-span-2">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Employment Type
            </label>
            <FilterSelect
              value={filterEmploymentType}
              onChange={v => { setFilterEmploymentType(v); resetInstructorAndFilters(); }}
              label="Employment Type"
              className="w-full min-h-[42px]"
            >
              <option value="">— All Types —</option>
              <option value="Permanent">Permanent</option>
              <option value="Contractual">Contractual</option>
            </FilterSelect>
          </div>

          <div className="min-w-0 w-full order-2 lg:col-span-3">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Instructor <span className="text-red-500">*</span>
            </label>
            <div className="relative" ref={instructorDropRef}>
              <div className={`flex items-center gap-2 rounded-xl px-3 min-h-[42px] py-2.5 transition-all duration-200 ${
                selectedFaculty
                  ? 'bg-white shadow-[0_1px_3px_rgba(0,0,0,0.05)] hover:bg-slate-50 focus-within:shadow-[0_2px_12px_rgba(0,0,0,0.09)]'
                  : 'bg-slate-100 hover:bg-slate-200/60 focus-within:bg-white focus-within:shadow-[0_2px_12px_rgba(0,0,0,0.09)]'
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
                  placeholder="Search instructor by name or ID…"
                  aria-required="true"
                  aria-label="Instructor"
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
                    aria-label="Clear instructor"
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
                            <div className="font-semibold text-slate-800 text-sm break-words">{f.name}</div>
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
                          <div className="mt-1 text-xs text-slate-400">{current.toFixed(2)} / {limit} {unit}</div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="min-w-0 w-full order-3 lg:col-span-3">
            <label
              className={`block text-xs font-semibold uppercase tracking-wide mb-1.5 ${
                instructorSelected ? 'text-slate-500' : 'text-slate-400'
              }`}
            >
              Program
            </label>
            <FilterSelect
              value={instructorSelected ? filterProgram : ''}
              onChange={handleProgramChange}
              disabled={!instructorSelected}
              label="Program"
              className="w-full min-h-[42px]"
            >
              <option value="">
                {instructorSelected ? '— Select Program —' : 'Select an instructor first'}
              </option>
              {programsForInstructor.map(p => (
                <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
              ))}
            </FilterSelect>
          </div>

          <div className="min-w-0 order-4 lg:col-span-2">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Year Level
            </label>
            <FilterSelect
              value={filterYearLevel}
              onChange={handleYearLevelChange}
              disabled={!filterProgram}
              label="Year Level"
              className="w-full min-h-[42px]"
            >
              <option value="">— Select Year Level —</option>
              {programYearLevels.map(yl => (
                <option key={yl} value={yl}>{yl}</option>
              ))}
            </FilterSelect>
          </div>

          <div className="min-w-0 order-5 lg:col-span-2">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
              Block
            </label>
            <FilterSelect
              value={filterBlock}
              onChange={handleBlockChange}
              disabled={!filterYearLevel}
              label="Block"
              className="w-full min-h-[42px]"
            >
              <option value="">— Select Block —</option>
              {filteredBlocks
                .map(b => {
                  const complete = isBlockFullyAssigned(b);
                  return (
                    <option key={b.id} value={b.id} disabled={complete}>
                      {blockDropdownLabel(b)}
                    </option>
                  );
                })}
            </FilterSelect>
          </div>
        </div>
      </FilterBar>


      {/* Select Subject */}
          <div className="bg-[var(--surface-elevated)] rounded-2xl border border-[#E2E8F0]/70 shadow-sm overflow-hidden">
            {selectedFaculty && (
              <div className="bg-[#3C91E6] px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-base text-white leading-tight break-words">Select Subject</div>
                  <div className="text-sm mt-0.5 font-medium text-white/85">Pick a subject to assign to this instructor</div>
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
                  className="relative grid grid-cols-2 p-1 rounded-xl bg-[#F1F5F9] border border-[#E2E8F0]"
                >
                  <span
                    aria-hidden
                    className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-4px)] rounded-lg bg-[#3C91E6] shadow-sm transition-transform duration-200 ease-out ${
                      subjectCategory === 'Major' ? 'translate-x-full' : 'translate-x-0'
                    }`}
                  />
                  {(['Minor', 'Major'] as const).map(cat => {
                    const active = subjectCategory === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setSubjectCategory(cat)}
                        className={`relative z-10 min-h-[44px] px-2 sm:px-3 py-2 rounded-lg text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors duration-200 ${
                          active ? 'text-white' : 'text-[#64748B]'
                        }`}
                      >
                        {cat} Subjects
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

            {!selectedFaculty ? (
              <div className="py-14 px-8 text-center">
                <p className="text-sm text-[#64748B]">No instructor selected.</p>
              </div>
            ) : !allFiltersSet ? (
              <div className="py-14 px-8 text-center">
                <p className="text-sm text-[#64748B]">No subjects to display.</p>
              </div>
            ) : showSubjectsSkeleton ? (
              <div className="p-4 sm:p-6">
                <ListSkeleton rows={6} />
              </div>
            ) : displaySchedules.length === 0 ? (
              <div className="py-14 px-8 text-center">
                <div className="w-14 h-14 bg-[#FEF9C3] rounded-2xl flex items-center justify-center mx-auto mb-4 border border-[#FDE68A]">
                  <AlertTriangle className="w-7 h-7 text-[#CA8A04]" />
                </div>
                <p className="text-[#1E3A5F] font-semibold text-base mb-1">
                  {subjectSearch
                    ? 'No Results Found'
                    : subjectCategory === 'Minor'
                      ? 'No available minor subjects.'
                      : 'No available major subjects.'}
                </p>
                <p className="text-sm text-[#64748B]">
                  {subjectSearch
                    ? 'Try a different search term.'
                    : categorySchedules.length === 0 && availableSchedules.length > 0
                      ? `Switch to ${subjectCategory === 'Minor' ? 'Major' : 'Minor'} Subjects to see the remaining unassigned subjects.`
                      : 'All subjects in this block may already be assigned to an instructor.'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                    <tr>
                      {['Code', 'Subject Name', 'Lec', 'Lab', isPermanent ? 'Units' : 'Hrs', ''].map(h => (
                        <th key={h} className="text-left px-5 py-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">{h}</th>
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
                      return (
                        <tr
                          key={s.id}
                          className={`transition-colors ${willExceed ? 'bg-[#FEF2F2] hover:bg-red-50' : 'hover:bg-[#F8FAFC]'}`}
                        >
                          <td className="px-5 py-4 font-mono font-semibold text-[#1E3A5F] text-sm align-middle whitespace-nowrap">{s.subject_code}</td>
                          <td className="px-5 py-4 align-middle">
                            <div style={{ minWidth: 160, maxWidth: 280 }}>
                              <div
                                className="text-[#1E3A5F] text-sm font-medium leading-snug"
                                style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden' }}
                                title={s.subject_name}
                              >
                                {s.subject_name}
                              </div>
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {lecH > 0 && (
                                  <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-[#EFF6FF] text-[#3C91E6]">Lec</span>
                                )}
                                {labH > 0 && (
                                  <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-[#F5F3FF] text-[#7C3AED]">Lab</span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-5 py-4 text-center text-[#64748B] text-sm align-middle">{lecH > 0 ? lecH : '—'}</td>
                          <td className="px-5 py-4 text-center text-[#64748B] text-sm align-middle">{labH > 0 ? labH : '—'}</td>
                          <td className={`px-5 py-4 text-center font-bold text-base align-middle ${willExceed ? 'text-[#DC2626]' : 'text-[#3C91E6]'}`}>
                            {wu.toFixed(2)}
                          </td>
                          <td className="px-5 py-4 align-middle">
                            {willExceed ? (
                              <button
                                onClick={() => assignSubject(s.id)}
                                title="Exceeds remaining regular load — will require confirmation"
                                className="flex items-center justify-center w-9 h-9 rounded-full bg-[#FEE2E2] text-[#DC2626] border border-[#FECACA] hover:bg-[#FECACA] transition-colors"
                              >
                                <AlertTriangle className="w-4 h-4" />
                              </button>
                            ) : (
                              <button
                                onClick={() => assignSubject(s.id)}
                                title="Assign to instructor"
                                className="flex items-center justify-center w-9 h-9 rounded-full transition-colors shadow-sm"
                                style={{ backgroundColor: '#3C91E6', color: '#ffffff' }}
                                onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#2E7DD1')}
                                onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#3C91E6')}
                              >
                                <Plus className="w-4 h-4" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>

      {/* -- Remaining Balance Warning Modal -----------------------------------
          Shown when instructor still has remaining load and admin clicks Assign.
          Admin must explicitly choose to continue or ignore.
          ------------------------------------------------------------------- */}
      <Modal open={!!remainingBalanceWarning} onClose={() => setRemainingBalanceWarning(null)} title="Confirm Assignment">
        <div className="space-y-4">
          <div className="bg-[#FFFBEB] border border-[#FDE68A] rounded-xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[#D97706] flex-shrink-0 mt-0.5" />
            <p className="text-[#1E3A5F] text-sm leading-relaxed">
              This instructor still has remaining regular load balance. Do you want to continue adding this subject?
            </p>
          </div>
          {remainingBalanceWarning && (
            <div className="bg-[#F8FAFC] rounded-xl border border-[#E2E8F0] p-4 space-y-2.5">
              <div className="flex justify-between text-sm">
                <span className="text-[#64748B]">Subject</span>
                <span className="font-semibold text-[#1E3A5F] text-right ml-4">
                  {remainingBalanceWarning.subjectCode}
                  {remainingBalanceWarning.subjectName ? ` — ${remainingBalanceWarning.subjectName}` : ''}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#64748B]">This subject</span>
                <span className="font-semibold text-[#3C91E6]">+{remainingBalanceWarning.subjectValue.toFixed(2)} {remainingBalanceWarning.unit}</span>
              </div>
              <div className="flex justify-between text-sm border-t border-[#E2E8F0] pt-2.5">
                <span className="text-[#64748B]">Remaining balance</span>
                <span className="font-semibold text-[#16A34A]">
                  {remainingBalanceWarning.remaining.toFixed(2)} {remainingBalanceWarning.unit} available
                </span>
              </div>
            </div>
          )}
          <div className="flex gap-3 pt-1">
            <button onClick={() => setRemainingBalanceWarning(null)}
              className="flex-1 border border-[#E2E8F0] text-[#64748B] py-2.5 rounded-xl text-sm font-semibold hover:bg-[#F8FAFC] transition">
              Cancel
            </button>
            <button
              onClick={() => {
                const w = remainingBalanceWarning;
                setRemainingBalanceWarning(null);
                if (w) assignSubject(w.msId, 'regular');
              }}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition"
              style={{ backgroundColor: '#3C91E6', color: '#ffffff' }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#2E7DD1')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#3C91E6')}
            >
              Continue Adding
            </button>
          </div>
        </div>
      </Modal>

      {/* -- Overload Warning Modal --------------------------------------------
          Shown when assigning would exceed the regular load limit (fully or
          partially). Admin must explicitly choose to continue or ignore.
          ------------------------------------------------------------------- */}
      <Modal open={!!overloadConfirm} onClose={() => setOverloadConfirm(null)} title="Overload Warning">
        <div className="space-y-4">
          <div className="bg-[#FEF2F2] border border-[#FECACA] rounded-xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[#DC2626] flex-shrink-0 mt-0.5" />
            <p className="text-[#1E3A5F] text-sm leading-relaxed">
              This subject will exceed the regular load limit. You may continue adding it, then manually move a subject to overload using the table below.
            </p>
          </div>
          {overloadConfirm && (
            <div className="bg-[#F8FAFC] rounded-xl border border-[#E2E8F0] p-4 space-y-2.5">
              <div className="flex justify-between text-sm">
                <span className="text-[#64748B]">Subject</span>
                <span className="font-semibold text-[#1E3A5F] text-right ml-4">
                  {overloadConfirm.subjectCode}
                  {overloadConfirm.subjectName ? ` — ${overloadConfirm.subjectName}` : ''}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#64748B]">Load limit</span>
                <span className="font-semibold text-[#1E3A5F]">
                  {overloadConfirm.loadLimit} {overloadConfirm.unit}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#64748B]">Current load</span>
                <span className="font-semibold text-[#1E3A5F]">
                  {overloadConfirm.currentLoad.toFixed(2)} {overloadConfirm.unit}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-[#64748B]">Remaining</span>
                <span className={`font-semibold ${overloadConfirm.remaining <= 0 ? 'text-[#DC2626]' : 'text-[#16A34A]'}`}>
                  {Math.max(0, overloadConfirm.remaining).toFixed(2)} {overloadConfirm.unit}
                  {overloadConfirm.remaining <= 0 && ' — Full'}
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
              onClick={() => {
                const c = overloadConfirm;
                setOverloadConfirm(null);
                if (c) assignSubject(c.msId, 'regular');
              }}
              className="flex-1 bg-[#DC2626] hover:bg-[#B91C1C] text-white py-2.5 rounded-xl text-sm font-bold transition flex items-center justify-center gap-2"
            >
              Continue Adding
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
              style={{ backgroundColor: '#3C91E6', color: '#ffffff' }}
              onMouseEnter={e => { if (!moveToOverloadProcessing && canConfirmOverload) e.currentTarget.style.backgroundColor = '#2E7DD1'; }}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#3C91E6')}
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
            const componentTotalHours = component === 'lec' ? lec : lab;
            const componentTotalWU    = component === 'lec'
              ? (isPermanent ? lec : lec)
              : (isPermanent ? lab * 0.75 : lab);
            const otherTotalWU = component === 'lec'
              ? (isPermanent ? lab * 0.75 : lab)
              : (isPermanent ? lec : lec);
            const componentLabel = component === 'lec' ? 'Lecture' : component === 'lab' ? 'Laboratory' : '';
            const otherLabel     = component === 'lec' ? 'Laboratory' : 'Lecture';

            /* split preview for component-specific (input is in units/wu) */
            const compRegularWU  = componentSplitUnits;
            const compRegularHours = isPermanent
              ? (component === 'lec' ? componentSplitUnits : Math.round(componentSplitUnits / 0.75))
              : componentSplitUnits;
            const compOverloadWU    = Math.max(0, componentTotalWU - componentSplitUnits);
            const compOverloadHours = Math.max(0, componentTotalHours - compRegularHours);

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
                    if (mode === 'split' && !isComponentSpecific) setSplitRegularAmount(maxRegularPart);
                    if (mode === 'split' && isComponentSpecific) setComponentSplitUnits(0);
                  }}
                  className={`w-full text-left px-3.5 py-3 rounded-xl border transition ${
                    active
                      ? 'border-[#3C91E6] bg-[#EFF6FF]'
                      : 'border-[#E2E8F0] bg-white hover:border-[#CBD5E1]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center mt-0.5 ${
                      active ? 'border-[#3C91E6]' : 'border-[#CBD5E1]'
                    }`}>
                      {active && <div className="w-1.5 h-1.5 rounded-full bg-[#3C91E6]" />}
                    </div>
                    <div>
                      <div className={`text-sm font-medium ${active ? 'text-[#1E3A5F]' : 'text-[#334155]'}`}>{label}</div>
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

            return (
              <>
                <div>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-[#1E3A5F]">{load.subject_code}</span>
                    {isComponentSpecific && (
                      <span className="text-[13px] text-[#64748B]">{componentLabel}</span>
                    )}
                  </div>
                  <p className="text-[13px] text-[#64748B] mt-0.5">{load.subject_name}</p>
                  <p className="text-[13px] text-[#1E3A5F] mt-1.5">
                    {isComponentSpecific
                      ? <>{componentTotalWU.toFixed(2)} {unit}{isPermanent ? ` (${componentTotalHours.toFixed(2)} hrs)` : ''}. {otherLabel} stays Regular ({otherTotalWU.toFixed(2)} {unit}).</>
                      : <>{subjectTotal.toFixed(2)} {unit}</>}
                  </p>
                </div>

                <ChoiceBtn
                  mode="entire"
                  active={moveToOverloadMode === 'entire'}
                  label={isComponentSpecific ? `Move all of ${componentLabel}` : 'Move all'}
                  description={isComponentSpecific
                    ? `${componentTotalWU.toFixed(2)} ${unit} will be counted as Overload. ${otherLabel} stays Regular.`
                    : `All ${subjectTotal.toFixed(2)} ${unit} will be counted as Overload.`}
                />
                <ChoiceBtn
                  mode="split"
                  active={moveToOverloadMode === 'split'}
                  label="Split"
                  description={isComponentSpecific
                    ? `Keep some of ${componentLabel} as Regular and move the rest.`
                    : 'Keep some as Regular and move the rest to Overload.'}
                />
                {moveToOverloadMode === 'split' && (
                  <div className="rounded-xl border border-[#E2E8F0] px-3.5 py-3 space-y-2.5">
                    {isComponentSpecific ? (
                      <>
                        <div>
                          <label className="text-[13px] text-[#64748B]">Keep as Regular ({unit})</label>
                          <input
                            type="number"
                            min={0}
                            max={parseFloat((componentTotalWU - 0.01).toFixed(2))}
                            step={0.25}
                            value={componentSplitUnits}
                            onChange={e => {
                              const raw = parseFloat(e.target.value);
                              const v   = isNaN(raw) ? 0 : raw;
                              setComponentSplitUnits(
                                parseFloat(Math.max(0, Math.min(componentTotalWU, v)).toFixed(2))
                              );
                            }}
                            className="mt-1 w-full bg-white border border-[#CBD5E1] text-[#1E3A5F] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/40 focus:border-[#3C91E6]"
                          />
                          <p className="text-[12px] text-[#94A3B8] mt-1">Up to {(componentTotalWU - 0.01).toFixed(2)}</p>
                        </div>
                        <p className="text-[13px] text-[#1E3A5F]">
                          Regular {compRegularWU.toFixed(2)} {unit}
                          {isPermanent ? ` (${compRegularHours.toFixed(2)} hrs)` : ''}
                          <span className="text-[#94A3B8]"> · </span>
                          Overload {compOverloadWU.toFixed(2)} {unit}
                          {isPermanent ? ` (${compOverloadHours.toFixed(2)} hrs)` : ''}
                        </p>
                        {compOverloadWU <= 0.001 && (
                          <p className="text-[13px] text-[#B91C1C]">Enter a Regular amount less than the full load so something moves to Overload.</p>
                        )}
                      </>
                    ) : (
                      <>
                        <div>
                          <label className="text-[13px] text-[#64748B]">Keep as Regular ({unit})</label>
                          <input
                            type="number"
                            min={0}
                            max={maxRegularPart}
                            step={0.25}
                            value={splitRegularAmount}
                            onChange={e => {
                              const raw = parseFloat(e.target.value);
                              const v   = isNaN(raw) ? 0 : raw;
                              setSplitRegularAmount(parseFloat(Math.max(0, Math.min(maxRegularPart, v)).toFixed(2)));
                            }}
                            className="mt-1 w-full bg-white border border-[#CBD5E1] text-[#1E3A5F] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/40 focus:border-[#3C91E6]"
                          />
                          <p className="text-[12px] text-[#94A3B8] mt-1">Up to {maxRegularPart.toFixed(2)}</p>
                        </div>
                        <p className="text-[13px] text-[#1E3A5F]">
                          Regular {splitRegularAmount.toFixed(2)} {unit}
                          <span className="text-[#94A3B8]"> · </span>
                          Overload {Math.max(0, overloadPortion).toFixed(2)} {unit}
                        </p>
                        {overloadPortion <= 0.001 && (
                          <p className="text-[13px] text-[#B91C1C]">Enter a Regular amount less than the full load so something moves to Overload.</p>
                        )}
                      </>
                    )}
                  </div>
                )}

                {impactPreview && summary && (() => {
                  const { afterRegular, afterOverload, afterRemaining, isAfterExceeded } = impactPreview;
                  const overBy = Math.max(0, afterRegular - summary.regular_load_limit);
                  return (
                    <div className="pt-1">
                      <p className="text-[13px] text-[#334155] leading-relaxed">
                        After this move, Regular will be {afterRegular.toFixed(2)} {unit}
                        {' '}(now {regularVal.toFixed(2)}) and Overload will be {afterOverload.toFixed(2)} {unit}.
                      </p>
                      {isAfterExceeded && afterRegular > summary.regular_load_limit + 0.001 && (
                        <p className="text-[13px] text-[#B45309] mt-1.5 leading-relaxed">
                          Regular will be {overBy.toFixed(2)} {unit} over the maximum of {summary.regular_load_limit.toFixed(2)}. You can still move this.
                        </p>
                      )}
                      {isAfterExceeded && afterRegular <= summary.regular_load_limit + 0.001 && (
                        <p className="text-[13px] text-[#64748B] mt-1.5 leading-relaxed">
                          Combined load will still be above the regular maximum. You can still move this.
                        </p>
                      )}
                      {!isAfterExceeded && afterRemaining > 0.001 && (
                        <p className="text-[13px] text-[#64748B] mt-1.5">
                          {afterRemaining.toFixed(2)} {unit} still available under the regular maximum.
                        </p>
                      )}
                    </div>
                  );
                })()}
              </>
            );
          })()}
        </div>
      </Modal>

      {/* View Workload Modal */}
      {workloadModalOpen && workload && selectedFaculty && (() => {
        const s = workload.summary;
        const isP = selectedFaculty.employment_status === 'Permanent';

        /* Summary totals from the semester-filtered API response are authoritative.
         * Regular table uses semester-filtered workload.loads.
         * Overload/split tables use allWorkloadLoads so cross-semester overloads appear. */

        const totalDeductionUnits = isP ? (s.total_deduction_units || 0) : 0;

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
        // Unique scheduled subjects this semester only (ms_id is unique per block_subject)
        const distinctSubjects = new Set(workload.loads.map(l => l.ms_id)).size;
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
        const splitPrintLoads    = termLoads.filter(l =>
          l.load_category === 'Regular' && (
            isP
              ? (parseFloat(String(l.split_overload_units)) || 0) > 0.001
              : (parseFloat(String(l.split_overload_hours)) || 0) > 0.001
          )
        );
        const hasOverloadSection = overloadPrintLoads.length > 0 || splitPrintLoads.length > 0;
        const hasPraiseSection = (workload.praise ?? []).length > 0 || praiseSubjectLoads.length > 0;
        /* Never leave the active section pointing at a hidden empty tab. */
        const effectiveModalTab: 'regular' | 'overload' | 'praise' =
          (workloadModalTab === 'overload' && !hasOverloadSection)
          || (workloadModalTab === 'praise' && !hasPraiseSection)
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
        const actionRegular = `${actionBtn} bg-[#E8F4FC] text-[#1E4A7A] border-[#3C91E6]/50 hover:bg-[#D4E9F8]`;
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
            slotId: matchOfficialSlot(day, start, end),
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
                                  {!isSplitRow && (
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
        const seenOverloadMs = new Set<number>();
        for (const list of Object.values(overloadGrouped)) {
          for (const { load, row } of list) {
                            const lec2 = parseFloat(String(load.lecture_hours)) || 0;
                            const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
                            const hasBoth2 = lec2 > 0 && lab2 > 0;
                            const olWU = hasBoth2
                              ? (row.type === 'lec' ? lec2 : lab2 * 0.75)
                              : (isP ? parseFloat(String(load.units)) || 0 : parseFloat(String(load.hours)) || 0);
                            const olHrs = row.hours;
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
                <button
                  type="button"
                  title="Move to Praise Load"
                  onClick={() => requestMoveToPraise(termLoads, [load.ms_id])}
                  className={actionPraise}
                >
                  <ArrowRight className="w-3 h-3" />
                  Praise
                </button>
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
            const splitRow = toOfficialRow(load, row, olV, olHours, (
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

        const officialOverloadSummary = {
          unitsText: formatOfficialNumber(olVal),
          hoursText: formatOfficialNumber(overloadContactHours),
          designation: '',
          specialAssignments: [] as { key: string; description: string; units: string }[],
          preparations: '',
          totalUnitsText: formatOfficialNumber(olVal),
          totalDescription: 'Overload',
        };

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
                  : (isP ? parseFloat(String(load.units)) || 0 : parseFloat(String(load.hours)) || 0);
                const isFirstOfSubject = !seenPraiseMs.has(load.ms_id);
                seenPraiseMs.add(load.ms_id);
                const base = toOfficialRow(load, row, wu, row.hours, isFirstOfSubject ? (
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
          ...(workload.praise ?? []).map((p: {
          id: number; praise_type?: string; description?: string; remarks?: string;
          equivalent_units?: unknown; equivalent_hours?: unknown;
        }) => ({
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
        })),
        ];

        const praiseSubjectHours = praiseSubjectLoads.reduce((sum, l) => {
          return sum + (parseFloat(String(l.lecture_hours)) || 0) + (parseFloat(String(l.laboratory_hours)) || 0);
        }, 0);
        const praiseUnitsSum = praiseSubjectVal + (workload.praise ?? []).reduce(
          (sum: number, p: { equivalent_units?: unknown }) => sum + (parseFloat(String(p.equivalent_units)) || 0),
          0,
        );
        const praiseHoursSum = praiseSubjectHours + (workload.praise ?? []).reduce(
          (sum: number, p: { equivalent_hours?: unknown }) => sum + (parseFloat(String(p.equivalent_hours)) || 0),
          0,
        );
        const officialPraiseSummary = {
          unitsText: formatOfficialNumber(praiseUnitsSum),
          hoursText: formatOfficialNumber(praiseHoursSum),
          designation: '',
          specialAssignments: [] as { key: string; description: string; units: string }[],
          preparations: '',
          totalUnitsText: formatOfficialNumber(praiseUnitsSum),
          totalDescription: 'Praise Load',
        };

        const designationText = (() => {
          const t = (selectedFaculty.designation_type || '').trim();
          if (!t || /^none$/i.test(t) || /^no designation$/i.test(t)) return 'No Designation';
          return t;
        })();
        const officialRegularSummary = {
          unitsText: formatOfficialNumber(totalRegularWU),
          hoursText: formatOfficialNumber(totalRegularHours),
          designation: designationText,
          specialAssignments: (workload.praise ?? []).map((p: { id?: number; praise_type?: string; description?: string; equivalent_units?: unknown }, i: number) => ({
            key: String(p.id ?? i),
            description: String(p.praise_type || p.description || ''),
            units: formatOfficialNumber(parseFloat(String(p.equivalent_units)) || 0),
          })),
          preparations: String(distinctSubjects),
          totalUnitsText: formatOfficialNumber(
            isP ? totalRegularWU + totalDeductionUnits + praiseTotal : totalRegularHours + praiseTotal
          ),
        };

        async function handlePrint() {
          if (!selectedFaculty || !workload) return;
          setPrintError('');
          setPrintOfferFallback(false);
          const kind = effectiveModalTab;
          const result = await printRegularLoadDocument({
            faculty: selectedFaculty,
            loads: kind === 'overload'
              ? [...overloadPrintLoads, ...splitPrintLoads]
              : kind === 'praise'
                ? praiseSubjectLoads
                : (workload.loads ?? []),
            praise: kind === 'praise' ? (workload.praise ?? []) : (kind === 'regular' ? (workload.praise ?? []) : []),
            deductions: kind === 'regular' ? (workload.deductions ?? []) : [],
            semester: listSemester,
            academicYear: listYear,
            documentKind: kind,
            printablePath: '/workload/print',
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
            title="Instructor Workload Form"
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
                <button
                  type="button"
                  onClick={handlePrint}
                  className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 text-white px-4 min-h-11 rounded-xl text-sm font-medium transition w-full sm:w-auto"
                >
                  Print {effectiveModalTab === 'regular' ? 'Regular Load' : effectiveModalTab === 'overload' ? 'Overload' : 'Praise Load'}
                </button>
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
              const modalTotal   = modalRegVal + modalOlVal + modalPraiseVal;
              const modalExceeded = Math.max(0, modalRegVal - s.regular_load_limit);
              const modalIsExceeded = modalExceeded > 0.001;
              const unitLabel = isP ? 'units' : 'hrs';
              const limitStr = Number(s.regular_load_limit).toFixed(2);
              const regStr = modalRegVal.toFixed(2);
              const card = 'bg-white border border-slate-200 rounded-lg p-3.5 min-w-0';
              const labelCls = 'text-xs text-slate-500 uppercase tracking-wide font-semibold mb-0.5';
              const valueCls = 'text-lg font-bold text-slate-900 tabular-nums';
              const mutedCls = 'text-sm font-normal text-slate-500 ml-1';
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
                  <div className={card}>
                    <div className={labelCls}>{isP ? 'Regular Load' : 'Regular Hours'}</div>
                    <div className={valueCls}>
                      {regStr} / {limitStr}
                      <span className={mutedCls}>{unitLabel}</span>
                    </div>
                  </div>
                  <div className={card}>
                    <div className={labelCls}>Overload</div>
                    <div className={valueCls}>
                      {modalOlVal.toFixed(2)}
                      <span className={mutedCls}>{unitLabel}</span>
                    </div>
                  </div>
                  <div className={card}>
                    <div className={labelCls}>Praise Load</div>
                    <div className={valueCls}>
                      {modalPraiseVal.toFixed(2)}
                      <span className={mutedCls}>{unitLabel}</span>
                    </div>
                  </div>
                  <div className={card}>
                    <div className={labelCls}>{isP ? 'Actual Assigned' : 'Actual Hours'}</div>
                    <div className={valueCls}>
                      {modalTotal.toFixed(2)}
                      <span className={mutedCls}>{unitLabel}</span>
                    </div>
                  </div>
                  <div className={card}>
                    <div className={labelCls}>Unplaced Excess</div>
                    <div className={`text-lg font-bold tabular-nums ${modalIsExceeded ? 'text-red-600' : 'text-slate-900'}`}>
                      {modalExceeded.toFixed(2)}
                      <span className={mutedCls}>{unitLabel}</span>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Tab pills */}
            <div className="flex flex-wrap gap-2 mb-4">
                              <button
                                type="button"
                onClick={() => setWorkloadModalTab('regular')}
                className={`inline-flex items-center gap-1.5 px-4 min-h-10 rounded-full text-sm font-semibold transition ${
                  effectiveModalTab === 'regular'
                    ? 'bg-blue-500 text-white'
                    : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10'
                }`}
              >
                Regular Load
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-white/20">{regularPrintLoads.length}</span>
                              </button>
              {hasOverloadSection && (
                <button
                  type="button"
                  onClick={() => setWorkloadModalTab('overload')}
                  className={`inline-flex items-center gap-1.5 px-4 min-h-10 rounded-full text-sm font-semibold transition ${
                    effectiveModalTab === 'overload'
                      ? 'bg-amber-500 text-white'
                      : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10'
                  }`}
                >
                  Overload
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-white/20">{overloadPrintLoads.length + splitPrintLoads.length}</span>
                </button>
              )}
              {hasPraiseSection && (
                <button
                  type="button"
                  onClick={() => setWorkloadModalTab('praise')}
                  className={`inline-flex items-center gap-1.5 px-4 min-h-10 rounded-full text-sm font-semibold transition ${
                    effectiveModalTab === 'praise'
                      ? 'bg-amber-500 text-white'
                      : 'bg-white/5 text-slate-400 hover:text-white hover:bg-white/10'
                  }`}
                >
                  Praise Load
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-white/20">{(workload?.praise ?? []).length + praiseSubjectLoads.length}</span>
                </button>
              )}
                  </div>

            {/* Printable content area */}
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

              {/* -- REGULAR LOAD TABLE -- */}
              <div style={{ display: effectiveModalTab === 'regular' ? '' : 'none' }} className="min-w-0 max-w-full">
                <OfficialWorkloadFormTable
                  rows={officialRegularRows}
                  summary={officialRegularSummary}
                  showActions
                  variant="regular"
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
                  />
              </div>
              )}
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
            The subject stays assigned to the instructor. Only the workload classification changes.
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
            The subject stays assigned to the instructor. Only the workload classification changes.
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
              <div className="font-mono font-bold text-sm text-[#1E3A5F] mb-0.5">{removeWorkloadTarget.subject_code}</div>
              <div className="text-sm text-[#64748B]">{removeWorkloadTarget.subject_name}</div>
              <div className="flex items-center gap-3 mt-2 text-[11px] text-[#94A3B8] flex-wrap">
                <span>{removeWorkloadTarget.program_code} · {removeWorkloadTarget.block_name} · {removeWorkloadTarget.year_level}</span>
                {(parseFloat(String(removeWorkloadTarget.units)) || 0) > 0 && (
                  <span className="font-semibold text-[#1E3A5F]">
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
                style={{ backgroundColor: canConfirm ? '#3C91E6' : '#E2E8F0', color: canConfirm ? '#ffffff' : '#94A3B8' }}
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
                  <span className="font-mono font-bold text-sm text-[#1E3A5F]">{load.subject_code}</span>
                  {isFullOl
                    ? <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-50 text-amber-600 border border-amber-200">Full Overload</span>
                    : <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-purple-50 text-purple-700 border border-purple-200">Split Overload</span>
                  }
                </div>
                <div className="text-sm text-[#64748B]">
                  {load.subject_name}{compLabel ? ` — ${compLabel}` : ''}
                </div>
                {/* Current load breakdown */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div className="bg-white border border-[#E2E8F0] rounded-lg px-2.5 py-1.5">
                    <div className="text-[10px] text-[#94A3B8] mb-0.5">Regular Portion</div>
                    <div className="text-sm font-bold text-[#1E3A5F]">
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
                      className="accent-[#3C91E6]"
                    />
                    <div>
                      <div className="text-sm font-semibold text-[#1E3A5F]">
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
                      className="accent-[#3C91E6] mt-0.5 flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-[#1E3A5F]">Return Partial Amount</div>
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
                            className="w-24 border border-[#E2E8F0] rounded-lg px-2.5 py-1.5 text-sm text-[#1E3A5F] font-semibold focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/30"
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
                        ? <>This change will bring Regular Load to {newRegular.toFixed(2)} {unit}, which is {overBy.toFixed(2)} {unit} above the configured maximum of {limit.toFixed(2)} {unit}. You can still confirm this classification.</>
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
          Opened via Edit Deduction. Lets the admin set or update load deductions
          for a Permanent instructor without interrupting instructor selection.
          ------------------------------------------------------------------- */}
      <Modal open={!!designationPending} onClose={() => setDesignationPending(null)} title="Instructor Load Deduction">
        {designationPending && (() => {
          const totalDeduction = deductionEntries.reduce((s, e) => s + (parseFloat(e.units) || 0), 0);
          const availableLoad  = Math.max(0, REGULAR_LOAD_MAX_UNITS - totalDeduction);
          return (
            <div className="space-y-5">
              {/* Instructor info */}
              <div className="bg-[#0d1424] border border-white/10 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <div className="font-bold text-white text-base">{designationPending.name}</div>
                  <div className="text-xs text-slate-400">{designationPending.position} · Permanent</div>
                </div>
                <div className="text-right text-xs text-slate-500">
                  Base load: <span className="font-semibold text-slate-300">{REGULAR_LOAD_MAX_UNITS} units</span>
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
                <div className="text-sm font-semibold text-slate-300 mb-3">Deduction Types</div>

                {/* None */}
                <label className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition select-none ${
                  deductionNone
                    ? 'bg-slate-700/60 border-slate-500/60 text-slate-200'
                    : 'bg-white/[0.03] border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-300'
                }`}>
                  <input
                    type="checkbox"
                    checked={deductionNone}
                    onChange={e => {
                      if (e.target.checked) { setDeductionNone(true); setDeductionEntries([]); }
                      else { setDeductionNone(false); }
                      setDesignationError('');
                    }}
                    className="w-4 h-4 accent-slate-400 flex-shrink-0"
                  />
                  <span className="text-sm font-medium">None — No Deduction</span>
                </label>

                {/* Deduction type options */}
                {DEDUCTION_OPTIONS.map(opt => {
                  const entry   = deductionEntries.find(e => e.type === opt);
                  const checked = !!entry;
                  return (
                    <div key={opt}>
                      <label className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition select-none ${
                        deductionNone
                          ? 'opacity-40 cursor-not-allowed bg-white/[0.02] border-white/5 text-slate-500'
                          : checked
                            ? 'bg-[#3C91E6]/10 border-[#3C91E6]/40 text-blue-300'
                            : 'bg-white/[0.03] border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-300'
                      }`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={deductionNone}
                          onChange={e => {
                            setDeductionNone(false);
                            setDeductionEntries(prev =>
                              e.target.checked
                                ? [...prev, { type: opt, description: '', units: '' }]
                                : prev.filter(x => x.type !== opt)
                            );
                            setDesignationError('');
                          }}
                          className="w-4 h-4 accent-[#3C91E6] flex-shrink-0"
                        />
                        <span className="text-sm font-medium flex-1">{opt}</span>
                      </label>

                      {/* Expanded fields for checked type */}
                      {checked && !deductionNone && (
                        <div className="ml-4 mt-2 mb-1 pl-4 border-l-2 border-[#3C91E6]/30 space-y-2">
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
                              className="w-full bg-[#0b0f1a] border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#3C91E6]/50 placeholder:text-slate-600"
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
                                max={REGULAR_LOAD_MAX_UNITS}
                                step={0.5}
                                placeholder="e.g. 3"
                                value={entry.units}
                                onChange={ev => {
                                  setDeductionEntries(prev =>
                                    prev.map(e => e.type === opt ? { ...e, units: ev.target.value } : e)
                                  );
                                  setDesignationError('');
                                }}
                                className="w-28 bg-[#0b0f1a] border border-white/10 text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#3C91E6]/50 placeholder:text-slate-600"
                              />
                            </div>
                            {entry.units !== '' && !isNaN(parseFloat(entry.units)) && (
                              <span className="text-xs text-amber-400 pb-2">
                                −{parseFloat(entry.units).toFixed(2)} units
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Live summary preview */}
              <div className={`rounded-xl border p-4 space-y-2 ${
                deductionNone || deductionEntries.length === 0
                  ? 'bg-emerald-500/10 border-emerald-500/20'
                  : totalDeduction > REGULAR_LOAD_MAX_UNITS
                    ? 'bg-red-500/10 border-red-500/30'
                    : 'bg-[#0d1424] border-white/10'
              }`}>
                {deductionNone || deductionEntries.length === 0 ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">Regular Load (no deduction)</span>
                    <span className="font-bold text-emerald-300 text-base">
                      {REGULAR_LOAD_MAX_UNITS.toFixed(2)} <span className="text-xs font-normal text-emerald-600">units</span>
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
                        <span className={`font-bold tabular-nums ${totalDeduction > REGULAR_LOAD_MAX_UNITS ? 'text-red-400' : 'text-amber-400'}`}>
                          −{totalDeduction.toFixed(2)} units
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold text-slate-300">Available Regular Load</span>
                        <span className={`font-bold text-base tabular-nums ${totalDeduction > REGULAR_LOAD_MAX_UNITS ? 'text-red-400' : 'text-emerald-300'}`}>
                          {availableLoad.toFixed(2)}
                          <span className={`text-xs font-normal ml-1 ${totalDeduction > REGULAR_LOAD_MAX_UNITS ? 'text-red-600' : 'text-emerald-600'}`}>units</span>
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
                  className="flex-1 bg-[#3C91E6] text-white py-2.5 rounded-xl text-sm font-bold hover:bg-[#2E7DD1] transition disabled:opacity-60 flex items-center justify-center gap-2"
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

      {/* Praise Modal */}
      <Modal open={praiseModalOpen} onClose={() => setPraiseModalOpen(false)} title="Add Praise Assignment">
        <form onSubmit={addPraise} className="space-y-4">
          {praiseError && (
            <div className="bg-[#FEE2E2] border border-[#FECACA] text-[#DC2626] px-4 py-3 rounded-xl text-sm">{praiseError}</div>
          )}
          <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-xl p-3 text-sm text-[#3C91E6]">
            Praise is for non-teaching assignments only (Research, Extension, Administrative, etc.)
          </div>
          <div>
            <label className="block text-sm font-semibold text-[#64748B] mb-1.5">Praise Type *</label>
            <select value={praiseForm.praise_type} onChange={e => setPraiseForm(f => ({ ...f, praise_type: e.target.value }))} required
              className="w-full bg-slate-100 border-0 rounded-xl px-3 py-2.5 text-sm text-slate-800 appearance-none cursor-pointer transition-all duration-200 outline-none hover:bg-slate-200/60 focus:bg-white focus:shadow-[0_2px_10px_rgba(0,0,0,0.08)]">
              <option value="">Select Praise Type</option>
              <option>Research</option>
              <option>Extension</option>
              <option>Special Assignment</option>
              <option>Administrative Assignment</option>
              <option>Committee Work</option>
              <option>Other Non-Teaching Load</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-[#64748B] mb-1.5">Description</label>
            <textarea value={praiseForm.description} onChange={e => setPraiseForm(f => ({ ...f, description: e.target.value }))}
              className="w-full border border-[#CBD5E1] bg-white text-[#1E3A5F] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/40 focus:border-[#3C91E6] transition-colors h-20 resize-none placeholder:text-[#CBD5E1]" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-[#64748B] mb-1.5">Equivalent Units</label>
              <input
                type="text"
                inputMode="decimal"
                value={praiseForm.equivalent_units}
                onChange={e => {
                  const raw = e.target.value;
                  if (!isNonNegDecimalDraft(raw)) return;
                  setPraiseForm(f => ({ ...f, equivalent_units: raw }));
                }}
                className="w-full bg-slate-100 border-0 rounded-xl px-3 py-2.5 text-sm text-slate-800 transition-all duration-200 outline-none hover:bg-slate-200/60 focus:bg-white focus:shadow-[0_2px_10px_rgba(0,0,0,0.08)]"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-[#64748B] mb-1.5">Equivalent Hours</label>
              <input
                type="text"
                inputMode="decimal"
                value={praiseForm.equivalent_hours}
                onChange={e => {
                  const raw = e.target.value;
                  if (!isNonNegDecimalDraft(raw)) return;
                  setPraiseForm(f => ({ ...f, equivalent_hours: raw }));
                }}
                className="w-full bg-slate-100 border-0 rounded-xl px-3 py-2.5 text-sm text-slate-800 transition-all duration-200 outline-none hover:bg-slate-200/60 focus:bg-white focus:shadow-[0_2px_10px_rgba(0,0,0,0.08)]"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-[#64748B] mb-1.5">Remarks</label>
            <textarea value={praiseForm.remarks} onChange={e => setPraiseForm(f => ({ ...f, remarks: e.target.value }))}
              className="w-full border border-[#CBD5E1] bg-white text-[#1E3A5F] rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/40 focus:border-[#3C91E6] transition-colors h-16 resize-none placeholder:text-[#CBD5E1]" />
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={() => setPraiseModalOpen(false)}
              className="flex-1 border border-[#E2E8F0] text-[#64748B] py-2.5 rounded-xl text-sm font-semibold hover:bg-[#F8FAFC] transition">
              Cancel
            </button>
            <button type="submit" disabled={praiseLoading}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 transition"
              style={{ backgroundColor: '#3C91E6', color: '#ffffff' }}
              onMouseEnter={e => { if (!praiseLoading) e.currentTarget.style.backgroundColor = '#2E7DD1'; }}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#3C91E6')}
            >
              {praiseLoading ? 'Saving…' : 'Add Praise'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
