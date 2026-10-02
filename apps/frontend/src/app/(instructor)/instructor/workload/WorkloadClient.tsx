'use client';

import { motion, useReducedMotion } from 'framer-motion';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { RefreshButton } from '@/app/(dashboard)/room-utilization/shared';
import {
  AlertTriangle, Printer, ChevronDown, ChevronRight,
} from 'lucide-react';
import OfficialWorkloadFormTable, { type OfficialFormRow } from '@/components/OfficialWorkloadFormTable';
import { buildOfficialGroups, loadDayPatterns, matchOfficialSlot, formatOfficialNumber, formatOfficialTimeRange, occupiedRangeFromScheduleTimes } from '@/lib/officialWorkloadSlots';
import { useDayCombinations } from '@/lib/dayCombinations';
import { designationFooterLines, designationRowText, isResearchExtensionType, printRegularLoadDocument } from '@/lib/instructorWorkloadPrintDocument';
import { openWorkloadPrintableVersion } from '@/lib/openPrintHtmlDocument';
import { formatLoadCap, regularUnitsCap, shownUnitsCap, shownUnitsOver } from '@shared/regularLoad';
import { useWorkloadPolicy } from '@/hooks/useWorkloadPolicy';
import { LOAD_TONE } from '@/lib/loadTone';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { CardSkeleton, PageBodySkeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { mergeSameSubjects } from '@shared/subjectCode';

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
  /** The split-off Lec/Lab portion is Praise Load, not Overload. */
  split_is_praise?: boolean;
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
/** Load colours shared by the cards and the tabs */
const TAB_TONE = LOAD_TONE;
type WorkloadTab = keyof typeof TAB_TONE;

/** Summary card tinted in its load colour (Regular blue · Overload orange · Praise gold · Total navy) */
function LoadCard({ tone, label, unit, value, of, note, index, onClick, active = false, onPrint }: {
  tone: string; label: string; unit: string; value: string; of?: number | string; note?: string; index: number;
  /** Arrow shortcut: prints this load straight away */
  onPrint?: () => void;
  /** Opens this load's table below */
  onClick?: () => void;
  active?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={e => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1], delay: index * 0.06 } }}
      whileHover={reduceMotion || !onClick ? undefined : { y: -3, boxShadow: `0 14px 28px -16px ${tone}99` }}
      whileTap={reduceMotion || !onClick ? undefined : { scale: 0.98 }}
      className={`qr-stat-tint relative overflow-hidden rounded-2xl border-2 p-4 sm:p-5 ${onPrint ? 'pr-16 sm:pr-[4.5rem]' : ''} text-center w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${onClick ? 'cursor-pointer' : ''}`}
      style={{
        background: `linear-gradient(160deg, ${tone}${active ? '26' : '14'} 0%, #FFFFFF 75%)`,
        borderColor: active ? tone : `${tone}40`,
        boxShadow: active ? `0 10px 24px -14px ${tone}` : undefined,
      }}
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: tone }} />
      {onPrint && (
        <motion.button
          type="button"
          onClick={e => { e.stopPropagation(); onPrint(); }}
          whileHover={reduceMotion ? undefined : { scale: 1.08 }}
          whileTap={reduceMotion ? undefined : { scale: 0.92 }}
          title={`Print ${label}`}
          aria-label={`Print ${label}`}
          className="absolute top-1/2 -translate-y-1/2 right-3 sm:right-4 w-10 h-10 rounded-xl flex items-center justify-center shadow-[0_6px_14px_-6px_rgba(11,42,91,0.5)]"
          style={{ backgroundColor: tone, color: '#FFFFFF' }}
        >
          <ChevronRight className="w-5 h-5" />
        </motion.button>
      )}
      <div className="text-2xl sm:text-3xl font-black mb-1.5 tabular-nums" style={{ color: tone }}>
        {value}
        {of != null && <span className="text-base sm:text-lg font-bold text-[#94A3B8]"> / {of}</span>}
      </div>
      <div className="text-sm font-bold text-[#0B2A5B]">{label}</div>
      <div className="text-xs mt-0.5 text-[#64748B]">{unit}</div>
      {note && <div className="text-xs mt-1 font-semibold text-[#DC2626]">{note}</div>}
    </motion.div>
  );
}

/** Total card's view: how Regular + Overload (+ Praise) add up — each row opens its table. */
function TotalBreakdown({ unit, rows, total, subjects, onOpen }: {
  unit: string;
  rows: { key: 'regular' | 'overload' | 'praise'; label: string; count: number; value: number }[];
  total: number;
  subjects: number;
  onOpen: (key: 'regular' | 'overload' | 'praise') => void;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <div className="divide-y divide-[#E2E8F0]">
      {rows.map((r, i) => (
        <motion.button
          key={r.key}
          type="button"
          onClick={() => onOpen(r.key)}
          initial={reduceMotion ? false : { opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0, transition: { duration: 0.25, delay: i * 0.05 } }}
          className="w-full flex items-center gap-3 px-4 sm:px-5 py-4 text-left hover:bg-[#F8FAFC] transition-colors"
        >
          <span aria-hidden className="w-1.5 self-stretch rounded-full" style={{ backgroundColor: TAB_TONE[r.key] }} />
          <span className="flex-1 min-w-0">
            <span className="block text-[15px] font-bold text-[#0B2A5B]">{r.label}</span>
            <span className="block text-sm text-[#64748B]">{r.count} subject{r.count !== 1 ? 's' : ''}</span>
          </span>
          <span className="text-lg font-black tabular-nums" style={{ color: TAB_TONE[r.key] }}>{r.value.toFixed(2)}</span>
          <span className="text-sm text-[#64748B] w-12">{unit}</span>
          <ChevronRight className="w-5 h-5 text-[#94A3B8] flex-shrink-0" />
        </motion.button>
      ))}
      <div className="flex items-center gap-3 px-4 sm:px-5 py-4 bg-[#F8FAFC]">
        <span aria-hidden className="w-1.5 self-stretch rounded-full" style={{ backgroundColor: TAB_TONE.total }} />
        <span className="flex-1 min-w-0">
          <span className="block text-[15px] font-black text-[#0B2A5B]">Total</span>
          <span className="block text-sm text-[#64748B]">{subjects} subject{subjects !== 1 ? 's' : ''}</span>
        </span>
        <span className="text-lg font-black tabular-nums text-[#0B2A5B]">{total.toFixed(2)}</span>
        <span className="text-sm text-[#64748B] w-12">{unit}</span>
        <span className="w-5 flex-shrink-0" />
      </div>
    </div>
  );
}

export default function InstructorWorkloadClient() {
  const workloadPolicy = useWorkloadPolicy();
  const [semester,     setSemester]     = useState('');
  const [academicYear, setAcademicYear] = useState('');
  // Form groups follow the term's day combinations (Settings → Day Combinations)
  const { active: dayCombos } = useDayCombinations(semester || null, academicYear || null);
  const [periodReady,  setPeriodReady]  = useState(false);
  const [noPeriod,     setNoPeriod]     = useState(false);
  const [data,         setData]         = useState<WorkloadSummary | null>(null);
  // Plus any day set this faculty's classes use that isn't configured, so they still show in their time slot
  const formGroups = useMemo(() => buildOfficialGroups(dayCombos, loadDayPatterns(data?.loads)), [dayCombos, data]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [activeTab,    setActiveTab]    = useState<WorkloadTab>('regular');
  const [printError,   setPrintError]   = useState('');
  const [printOfferFallback, setPrintOfferFallback] = useState(false);
  /** Whether the currently selected workload table is visible. */
  const [tableVisible, setTableVisible] = useState(true);

  function selectTab(key: WorkloadTab) {
    setActiveTab(key);
    setTableVisible(true);
  }

  const fetchWorkload = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
      setNoPeriod(false);
    }
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
      setNoPeriod(false);

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
      setError(null);
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchWorkload(); }, [fetchWorkload]);

  // Live updates: subjects assigned or moved, schedules, PRAISE or deloading
  // changed, or a new active term — the workload reloads quietly (the open tab stays)
  useRealtime(['workload', 'schedule', 'faculty', 'term'], () => fetchWorkload(true), { enabled: !loading });
  // Fallback only — every change above arrives live
  useVisibilityAwareInterval(() => fetchWorkload(true), 120_000);

  /* ── Derived values (mirrors admin WorkloadClient modal logic) ─────────── */
  const workload = data;
  const isP = workload?.faculty?.employment_status === 'Permanent';
  const s   = workload?.summary;

  const regularPrintLoads  = workload?.loads.filter(l => l.load_category === 'Regular') ?? [];
  const overloadPrintLoads = workload?.loads.filter(l => l.load_category === 'Overload') ?? [];
  const praiseSubjectLoads = workload?.loads.filter(l => l.load_category === 'Praise') ?? [];
  const isSplitRegular = (l: WorkloadLoad) => l.load_category === 'Regular' && (
    isP
      ? (parseFloat(String(l.split_overload_units)) || 0) > 0.001
      : (parseFloat(String(l.split_overload_hours)) || 0) > 0.001
  );
  const splitPrintLoads    = workload?.loads.filter(l => isSplitRegular(l) && !l.split_is_praise) ?? [];
  /* Only the Lec or Lab moved to Praise — the rest of the subject stays Regular */
  const praiseSplitLoads   = workload?.loads.filter(l => isSplitRegular(l) && l.split_is_praise) ?? [];

  const hasOverloadSection = overloadPrintLoads.length > 0 || splitPrintLoads.length > 0;
  const hasPraiseSection = (workload?.praise ?? []).length > 0 || praiseSubjectLoads.length > 0 || praiseSplitLoads.length > 0;
  const effectiveTab: WorkloadTab = activeTab === 'praise' && !hasPraiseSection ? 'regular' : activeTab;
  /** What the Print button prints — the Total summary has no form of its own, so it prints the Regular Load. */
  const printTab: 'regular' | 'overload' | 'praise' = effectiveTab === 'total' ? 'regular' : effectiveTab;

  useEffect(() => {
    if (activeTab !== effectiveTab) setActiveTab(effectiveTab);
  }, [activeTab, effectiveTab]);

  const totalDeductionUnits = isP ? (s?.total_deduction_units || 0) : 0;
  const olVal  = isP ? (s?.total_overload_units || 0) : (s?.total_overload_hours || 0);
  const praiseSubjectVal = isP ? (s?.total_praise_units || 0) : (s?.total_praise_hours || 0);
  const praiseTotal = praiseSubjectVal + (workload?.praise.reduce((sum, p) => sum + (parseFloat(String(p.equivalent_units)) || 0), 0) ?? 0);
  const distinctSubjects = new Set(workload?.loads.map(l => l.ms_id) ?? []).size;
  /** No. of Preparation: the same subject (code + title) across blocks counts once. */
  const preparationCount = mergeSameSubjects(workload?.loads ?? []).length;

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
        slotId: matchOfficialSlot(day, start, end, formGroups),
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
  // Same text as the admin form and print: each deduction's description (e.g. "ICT Coordinator")
  const designationText = designationRowText(workload?.deductions ?? []);
  const officialRegularSummary = {
    unitsText: formatOfficialNumber(totalRegularWU),
    hoursText: formatOfficialNumber(totalRegularHoursDisplay),
    designation: designationText,
    // Same lines as the admin form and print: one per deduction, labelled by type
    designationLines: designationFooterLines(isP ? (workload?.deductions ?? []) : []).map(l => ({
      key: l.key, label: l.label, description: l.description,
      units: l.units > 0 ? formatOfficialNumber(l.units) : '',
    })),
    // Special Assignment = the Special Assignment deduction (Praise Load has its own form)
    specialAssignments: (isP ? (workload?.deductions ?? []) : [])
      .filter(d => d.deduction_type === 'Special Assignment')
      .map((d, i) => ({
        key: String(d.id ?? i),
        description: d.description || 'Special Assignment',
        units: formatOfficialNumber(parseFloat(String(d.deducted_units)) || 0),
      })),
    preparations: String(preparationCount),
    // Regular Load = teaching + deductions (Praise is not part of it — as on the admin form and print)
    totalUnitsText: formatOfficialNumber(
      isP ? totalRegularWU + totalDeductionUnits : totalRegularHoursDisplay
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
        slotId: matchOfficialSlot(day, start, end, formGroups),
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
        slotId: matchOfficialSlot(day, start, end, formGroups),
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
    // Same row format as the Regular form — Designation / Special Assignment left blank
    designationLines: [{ key: 'designation-blank', label: 'Designation', description: '', units: '' }],
    specialAssignments: [] as { key: string; description: string; units: string }[],
    preparations: String(mergeSameSubjects([...overloadPrintLoads, ...splitPrintLoads]).length),
    totalUnitsText: formatOfficialNumber(olVal),
    totalDescription: 'Overload',
  };

  const praiseHoursSum = praiseSubjectLoads.reduce((sum, l) => {
    return sum + (parseFloat(String(l.lecture_hours)) || 0) + (parseFloat(String(l.laboratory_hours)) || 0);
  }, 0) + praiseSplitLoads.reduce((sum, l) => {
    if (!isP) return sum + (parseFloat(String(l.split_overload_hours)) || 0);
    return sum + (parseFloat(String(l.overload_component === 'lab' ? l.laboratory_hours : l.lecture_hours)) || 0);
  }, 0);
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
          slotId: matchOfficialSlot(day, start, end, formGroups),
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
    ...praiseSplitLoads.flatMap((load) => {
      const oc = (load.overload_component || 'full') as 'lec' | 'lab' | 'full';
      const val = isP
        ? (parseFloat(String(load.split_overload_units)) || 0)
        : (parseFloat(String(load.split_overload_hours)) || 0);
      return splitLoad(load, isP).filter(r => oc === 'full' || r.type === oc).map((row) => {
        const hrs = !isP ? val : parseFloat(String(row.type === 'lab' ? load.laboratory_hours : load.lecture_hours)) || 0;
        const start = row.type === 'lec' ? (load.lec_start_time ?? load.start_time) : (load.lab_start_time ?? load.start_time);
        const end   = row.type === 'lec' ? (load.lec_end_time ?? load.end_time) : (load.lab_end_time ?? load.end_time);
        const day   = row.type === 'lec' ? (load.lec_day_pattern ?? load.day_pattern) : (load.lab_day_pattern ?? load.day_pattern);
        const yearNum = extractYearNum(load.year_level);
        const occupied = occupiedRangeFromScheduleTimes(start, end);
        return {
          key: `${row.key}-split-praise`,
          slotId: matchOfficialSlot(day, start, end, formGroups),
          timeLabel: formatOfficialTimeRange(start, end),
          rangeStartMin: occupied?.startMin,
          rangeEndMin: occupied?.endMin,
          subjectCode: load.subject_code,
          description: `${row.description} · Source: Regular`,
          course: `${load.program_code} ${yearNum}${load.block_name}`,
          students: load.number_of_students > 0 ? String(load.number_of_students) : '',
          units: formatOfficialNumber(val),
          hours: formatOfficialNumber(hrs),
          room: row.room_name || '',
        };
      });
    }),
  ];
  /* Official Praise Load form: No. of Units is teaching only; each praise record
     goes on "Add: Research/Extension" or "Add: Special Assignment" (same as admin + print). */
  const praiseRecordLine = (p: { id?: number; praise_type?: string; description?: string; remarks?: string; equivalent_units?: unknown }, i: number) => ({
    key: `praise-${p.id ?? i}`,
    description: String(p.description || p.remarks || p.praise_type || ''),
    units: formatOfficialNumber(parseFloat(String(p.equivalent_units)) || 0),
  });
  const praiseRecords = workload?.praise ?? [];
  const praiseTeaching = praiseSubjectVal > 0.001;
  const praisePreparations = mergeSameSubjects([...praiseSubjectLoads, ...praiseSplitLoads]).length;
  const officialPraiseSummary = {
    unitsText: praiseTeaching ? formatOfficialNumber(praiseSubjectVal) : '',
    hoursText: praiseTeaching ? formatOfficialNumber(praiseHoursSum) : '',
    designation: '',
    researchExtension: praiseRecords.filter(p => isResearchExtensionType(p.praise_type)).map(praiseRecordLine),
    specialAssignments: praiseRecords.filter(p => !isResearchExtensionType(p.praise_type)).map(praiseRecordLine),
    preparations: praiseTeaching && praisePreparations > 0 ? String(praisePreparations) : '',
    totalUnitsText: formatOfficialNumber(praiseTotal),
    totalDescription: 'Praise Load',
  };

  /* ── Print (official NEMSU template — same for Regular / Overload / Praise) ── */
  async function handlePrint(which?: 'regular' | 'overload' | 'praise') {
    if (!workload) return;
    setPrintError('');
    setPrintOfferFallback(false);
    const kind = which ?? printTab;
    const result = await printRegularLoadDocument({
      faculty: workload.faculty,
      loads: kind === 'overload'
        ? [...overloadPrintLoads, ...splitPrintLoads]
        : kind === 'praise'
          ? [...praiseSubjectLoads, ...praiseSplitLoads]
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
    <div className="min-h-full p-4 sm:p-6 lg:p-8">
      {/* Desktop: balanced width, centred (phones/tablets unchanged) */}
      <div className="lg:max-w-6xl lg:mx-auto">
      {/* ── Page header ───────────────────────────────────────────────── */}
      <div className="mb-5">
        <BackButton />
        <div className="mt-2 lg:mt-5 mb-4">
          <WatermarkTitle>My Workload</WatermarkTitle>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2.5">
          <RefreshButton onRefresh={() => fetchWorkload()} loading={loading} />
          {workload && (
            <motion.button
              type="button"
              onClick={() => handlePrint()}
              whileTap={{ scale: 0.97 }}
              className="h-11 inline-flex items-center justify-center gap-2 px-4 rounded-xl text-[15px] font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] transition-colors shadow-lg shadow-[#1D5BD6]/20"
              style={{ color: '#FFFFFF' }}
            >
              <Printer className="w-4 h-4" />
              Print {printTab === 'regular' ? 'Regular Load' : printTab === 'overload' ? 'Overload' : 'Praise Load'}
            </motion.button>
          )}
        </div>
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
            <p className="text-sm font-semibold text-[#0B2A5B] mt-0.5">
              {semester && academicYear
                ? `${semester} — A.Y. ${academicYear}`
                : periodReady
                  ? 'No active academic period is currently configured.'
                  : 'Loading period…'}
            </p>
          </div>
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
          <p className="text-sm font-semibold text-[#0B2A5B] flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[#DC2626]" />
            Failed to load workload data
          </p>
          <p className="text-sm text-[#64748B] mt-1">{error}</p>
          <button
            type="button"
            onClick={() => fetchWorkload()}
            className="mt-3 px-3.5 py-2 bg-[#1D5BD6] hover:bg-[#2E7DD1] text-white rounded-lg text-sm font-semibold transition-colors"
          >
            Try Again
          </button>
        </div>
      )}

      {!showSkeleton && !error && noPeriod && (
        <div className="bg-white border border-[#E2E8F0] rounded-lg px-4 py-6">
          <p className="text-sm font-semibold text-[#0B2A5B]">No active academic period is currently configured.</p>
          <p className="text-sm text-[#64748B] mt-1">
            Workload will appear here once an administrator sets the active school year and semester.
          </p>
        </div>
      )}

      {/* ── Workload content ──────────────────────────────────────────── */}
      {!showSkeleton && !error && !noPeriod && workload && (() => {
        const modalRegVal  = isP ? totalRegularWU : totalRegularHoursDisplay;
        const modalTotal   = modalRegVal + olVal + praiseTotal;
        // The term's limit from the server (deloading applied); the policy is only a fallback.
        // `??`, not `||` — a limit of 0 (deloading ≥ the whole load) is a real limit.
        const regLimit = Number(s?.regular_load_limit ?? (isP ? regularUnitsCap(workloadPolicy) : workloadPolicy.contractualHours));
        const modalExceeded = Math.max(0, modalRegVal - regLimit);
        const modalIsExceeded = modalExceeded > 0.001;
        // Shown as 18 (not 18.25) — the grace stays in the maths
        const regLimitShown = isP ? formatLoadCap(shownUnitsCap(regLimit)) : formatLoadCap(regLimit);
        const regOverShown = isP ? shownUnitsOver(modalRegVal, regLimit) : modalExceeded;
        const overloadCount = overloadPrintLoads.length + splitPrintLoads.length;
        const praiseCount = (workload.praise ?? []).length + praiseSubjectLoads.length + praiseSplitLoads.length;

        return (
          <>
            {/* ── Summary cards: Regular · Overload · Praise (if any) · Total — click to open that table ── */}
            <div className={`grid grid-cols-2 gap-3 sm:gap-4 mb-5 ${hasPraiseSection ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
              <LoadCard index={0} tone={TAB_TONE.regular} label={isP ? 'Regular Load' : 'Regular Hours'} unit={isP ? 'units' : 'hours'}
                value={modalRegVal.toFixed(2)} of={regLimitShown}
                note={modalIsExceeded ? `Exceeded by ${regOverShown.toFixed(2)}` : undefined}
                active={effectiveTab === 'regular' && tableVisible} onClick={() => selectTab('regular')}
                onPrint={() => handlePrint('regular')} />
              <LoadCard index={1} tone={TAB_TONE.overload} label="Overload" unit={isP ? 'units' : 'hours'} value={olVal.toFixed(2)}
                active={effectiveTab === 'overload' && tableVisible}
                onClick={() => selectTab('overload')}
                onPrint={hasOverloadSection ? () => handlePrint('overload') : undefined} />
              {hasPraiseSection && (
                <LoadCard index={2} tone={TAB_TONE.praise} label="Praise Load" unit={`${isP ? 'units' : 'hours'} · ${praiseCount} item${praiseCount !== 1 ? 's' : ''}`}
                  value={praiseTotal.toFixed(2)}
                  active={effectiveTab === 'praise' && tableVisible} onClick={() => selectTab('praise')}
                  onPrint={() => handlePrint('praise')} />
              )}
              <LoadCard index={3} tone={TAB_TONE.total} label={isP ? 'Total Units' : 'Total Hours'}
                unit={`${isP ? 'units' : 'hours'} · ${distinctSubjects} subject${distinctSubjects !== 1 ? 's' : ''}`}
                value={modalTotal.toFixed(2)}
                active={effectiveTab === 'total' && tableVisible} onClick={() => selectTab('total')} />
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

              {/* Tab navigation — Regular always; Overload/Praise only with data (same colours as the cards) */}
              <div className="flex flex-wrap items-center gap-2 mb-1">
                {([
                  { key: 'regular', label: 'Workload', count: regularPrintLoads.length, show: true },
                  { key: 'overload', label: 'Overload', count: overloadCount, show: hasOverloadSection || effectiveTab === 'overload' },
                  { key: 'praise', label: 'Praise Load', count: praiseCount, show: hasPraiseSection },
                  { key: 'total', label: isP ? 'Total Units' : 'Total Hours', count: distinctSubjects, show: effectiveTab === 'total' },
                ] as const).filter(t => t.show).map(t => {
                  const on = effectiveTab === t.key;
                  const c = TAB_TONE[t.key];
                  return (
                    <motion.button
                      key={t.key}
                      type="button"
                      onClick={() => selectTab(t.key)}
                      whileTap={{ scale: 0.96 }}
                      whileHover={on ? undefined : { y: -2 }}
                      animate={{ backgroundColor: on ? c : `${c}14`, borderColor: on ? c : `${c}59`, color: on ? '#FFFFFF' : c }}
                      transition={{ duration: 0.25 }}
                      className="inline-flex items-center gap-2 px-4 h-11 rounded-xl text-[15px] font-bold border-2"
                    >
                      {t.label}
                      <span className="min-w-6 h-6 px-1.5 rounded-full text-[12px] font-bold inline-flex items-center justify-center"
                        style={on ? { backgroundColor: 'rgba(255,255,255,0.25)', color: '#FFFFFF' } : { backgroundColor: '#FFFFFF', color: c }}>
                        {t.count}
                      </span>
                    </motion.button>
                  );
                })}

                <button
                  type="button"
                  aria-expanded={tableVisible}
                  onClick={() => setTableVisible(v => !v)}
                  className="inline-flex items-center gap-1 ml-auto px-2.5 py-2 text-sm font-semibold text-[#1D5BD6] hover:text-[#2E7DD1] transition-colors"
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
                        <p className="text-sm font-semibold text-[#0B2A5B]">No regular workload assigned</p>
                        <p className="text-sm text-[#64748B] mt-1">
                          No regular load subjects for the active academic period.
                        </p>
                      </div>
                    ) : (
                      <OfficialWorkloadFormTable
                        rows={officialRegularRows}
                        summary={officialRegularSummary}
                        groups={formGroups}
                      />
                    )
                  )}
                  {effectiveTab === 'overload' && (
                    hasOverloadSection ? (
                      <OfficialWorkloadFormTable
                        rows={officialOverloadRows}
                        summary={officialOverloadSummary}
                        variant="overload"
                        groups={formGroups}
                      />
                    ) : (
                      <div className="px-4 py-8 text-center">
                        <p className="text-sm font-semibold text-[#0B2A5B]">No overload assigned</p>
                        <p className="text-sm text-[#64748B] mt-1">
                          No overload subjects for the active academic period.
                        </p>
                      </div>
                    )
                  )}
                  {effectiveTab === 'total' && (
                    <TotalBreakdown
                      unit={isP ? 'units' : 'hours'}
                      rows={[
                        { key: 'regular', label: isP ? 'Regular Load' : 'Regular Hours', count: regularPrintLoads.length, value: modalRegVal },
                        { key: 'overload', label: 'Overload', count: overloadCount, value: olVal },
                        ...(hasPraiseSection ? [{ key: 'praise' as const, label: 'Praise Load', count: praiseCount, value: praiseTotal }] : []),
                      ]}
                      total={modalTotal}
                      subjects={distinctSubjects}
                      onOpen={selectTab}
                    />
                  )}
                  {effectiveTab === 'praise' && (
                    <OfficialWorkloadFormTable
                      rows={officialPraiseRows}
                      summary={officialPraiseSummary}
                      variant="praise"
                      groups={formGroups}
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
    </div>
  );
}
