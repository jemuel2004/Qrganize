'use client';

import { motion, useReducedMotion } from 'framer-motion';
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useVisibilityAwareInterval } from '@/hooks/useVisibilityAwareInterval';
import { useRealtime } from '@/context/RealtimeContext';
import { useToast } from '@/context/ToastContext';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { RefreshButton } from '@/components/ui/RefreshButton';
import {
  AlertTriangle, ChevronDown,
} from 'lucide-react';
import OfficialWorkloadFormTable, { type OfficialFormRow } from '@/components/OfficialWorkloadFormTable';
import WorkloadPrintMenu from '@/components/WorkloadPrintMenu';
import {
  buildOfficialGroups, loadDayPatterns, matchOfficialSlot, formatOfficialNumber, formatOfficialTotal,
  formatOfficialTimeRange, occupiedRangeFromScheduleTimes,
} from '@/lib/officialWorkloadSlots';
import { useDayCombinations } from '@/lib/dayCombinations';
import {
  actualLoadLines, designationFooterLines, designationRowText, isResearchExtensionType,
  type PrintDocumentResult,
} from '@/lib/instructorWorkloadPrintDocument';
import { openWorkloadPrintableVersion } from '@/lib/openPrintHtmlDocument';
import { canHaveOverloadOrPraise, formatLoadCap, regularUnitsCap, shownUnitsCap, shownUnitsOver } from '@shared/regularLoad';
import { useWorkloadPolicy } from '@/hooks/useWorkloadPolicy';
import { LOAD_TONE } from '@/lib/loadTone';
import SectionReveal from '@/components/ui/SectionReveal';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { Skeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { mergeSameSubjects } from '@shared/subjectCode';
import { isSplitLoad, loadParts, partOf, sumParts } from '@shared/loadSplit';

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
  /** The Lecture's share of the moved part (overloads.lec_part) — see @shared/loadSplit */
  split_lec_part?: number | string | null;
  lec_scheduled?: boolean; lab_scheduled?: boolean;
  lec_start_time?: string | null; lec_end_time?: string | null;
  lab_start_time?: string | null; lab_end_time?: string | null;
  lec_day_pattern?: string | null; lab_day_pattern?: string | null;
}
interface WorkloadDeduction {
  id: number; deduction_type: string; description: string; deducted_units: number;
}
interface PraiseRecord { id: number; praise_type: string; description: string; equivalent_units: number; equivalent_hours: number; semester: string; academic_year: string; remarks: string; [key: string]: unknown; }
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

/** A Regular line's units / hours — only what stays Regular of a split subject. */
function computeRegularRowValues(
  load: WorkloadLoad, row: SplitRow, isP: boolean
): { displayWU: number; displayHours: number } {
  if (!isSplitLoad(load, isP)) return { displayWU: row.wu, displayHours: row.hours };
  const part = partOf(loadParts(load, isP), row.type);
  return part ? { displayWU: part.regularUnits, displayHours: part.regularHours } : { displayWU: 0, displayHours: 0 };
}

/** The subject's Lec / Lab lines at their full values (split amounts: loadParts). */
function splitLoad(load: WorkloadLoad): SplitRow[] {
  const lec = parseFloat(String(load.lecture_hours))   || 0;
  const lab = parseFloat(String(load.laboratory_hours)) || 0;

  if (lec > 0 && lab > 0) {
    const lecRow: SplitRow = { key: `${load.id}-lec`, load, type: 'lec', hours: lec, wu: lec,        description: `${load.subject_name} (Lec)`, room_name: load.lec_room_name };
    const labRow: SplitRow = { key: `${load.id}-lab`, load, type: 'lab', hours: lab, wu: lab * 0.75, description: `${load.subject_name} (Lab)`, room_name: load.lab_room_name };
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

/* ─── Main Component ─────────────────────────────────────────────────────── */
/** Load colours shared by the cards and the tabs */
const TAB_TONE = LOAD_TONE;
type WorkloadTab = keyof typeof TAB_TONE;

/** Summary card tinted in its load colour (Actual Load navy · Regular blue · Overload orange · Praise gold) */
function LoadCard({ tone, edgeColor = tone, label, unit, value, of, note, detail, index, onClick, active = false, className = '' }: {
  tone: string; label: string; unit: string; value: string; of?: number | string; note?: string; index: number;
  /** Top strip colour, when it must differ from `tone` (e.g. a theme-aware CSS variable) */
  edgeColor?: string;
  /** Extra plain line under the unit, e.g. how the number adds up */
  detail?: string;
  /** Opens this load's table below */
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-pressed={onClick ? active : undefined}
      onClick={onClick}
      onKeyDown={e => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.4, 0, 0.2, 1], delay: index * 0.06 } }}
      whileHover={reduceMotion || !onClick ? undefined : { y: -3, boxShadow: `0 14px 28px -16px ${tone}99` }}
      whileTap={reduceMotion || !onClick ? undefined : { scale: 0.98 }}
      className={`qr-stat-tint relative overflow-hidden rounded-2xl border-2 p-4 sm:p-5 text-center w-full min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${onClick ? 'cursor-pointer' : ''} ${className}`}
      style={{
        background: `linear-gradient(160deg, ${tone}${active ? '26' : '14'} 0%, #FFFFFF 75%)`,
        borderColor: active ? tone : `${tone}40`,
        boxShadow: active ? `0 10px 24px -14px ${tone}` : undefined,
      }}
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: edgeColor }} />
      {/* The card whose table is open below gets a matching bottom edge */}
      <motion.span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-1 origin-center"
        style={{ backgroundColor: edgeColor }}
        initial={false}
        animate={{ scaleX: active ? 1 : 0, opacity: active ? 1 : 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.4, 0, 0.2, 1] }}
      />
      <div className="text-2xl sm:text-3xl font-black mb-1.5 tabular-nums" style={{ color: tone }}>
        {/* A live update eases the new number in, so the change is noticed */}
        <motion.span
          key={value}
          className="inline-block"
          initial={reduceMotion ? false : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } }}
        >
          {value}
        </motion.span>
        {of != null && <span className="text-base sm:text-lg font-bold text-[#94A3B8]"> / {of}</span>}
      </div>
      <div className="text-sm font-bold text-[#0B2A5B]">{label}</div>
      <div className="text-xs mt-0.5 text-[#64748B]">{unit}</div>
      {detail && <div className="text-xs mt-0.5 text-[#64748B] text-balance">{detail}</div>}
      {note && <div className="text-xs mt-1 font-semibold text-[#DC2626]">{note}</div>}
    </motion.div>
  );
}

/** What the workload response holds — compared after a live reload to tell whether anything changed. */
function workloadSignature(w: WorkloadSummary): string {
  return JSON.stringify([w.loads, w.praise, w.deductions, w.summary]);
}

export default function InstructorWorkloadClient() {
  const workloadPolicy = useWorkloadPolicy();
  const toast = useToast();
  /** Last workload seen — a live reload that differs from it tells the faculty */
  const lastSignature = useRef('');
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
  // Opens on Actual Load — the first section (falls back to Workload when there are no subjects)
  const [activeTab,    setActiveTab]    = useState<WorkloadTab>('actual');
  const [printError,   setPrintError]   = useState('');
  const [printOfferFallback, setPrintOfferFallback] = useState(false);
  /** Whether the currently selected workload table is visible. */
  const [tableVisible, setTableVisible] = useState(true);
  /** A card was tapped at least once — from then on the opened section is revealed with motion */
  const [sectionSwitched, setSectionSwitched] = useState(false);

  /** The heading above the open form — tapping a card brings it into view when it's below the screen */
  const sectionRef = useRef<HTMLDivElement>(null);
  function selectTab(key: WorkloadTab) {
    setActiveTab(key);
    setTableVisible(true);
    setSectionSwitched(true);
    requestAnimationFrame(() => {
      const el = sectionRef.current;
      if (el && el.getBoundingClientRect().top > window.innerHeight - 160) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }

  /** Resolves false when the workload could not be loaded */
  const fetchWorkload = useCallback(async (silent = false): Promise<boolean> => {
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
        lastSignature.current = '';
        return true;
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
          lastSignature.current = '';
          return true;
        }
        throw new Error(body.error || `Error ${res.status}`);
      }
      const json = await res.json();
      if (json.period?.semester) setSemester(json.period.semester);
      if (json.period?.schoolYear) setAcademicYear(json.period.schoolYear);
      setData(json);
      setError(null);
      // The office changed this workload while the page was open — say so
      const signature = workloadSignature(json);
      if (silent && lastSignature.current && signature !== lastSignature.current) {
        toast.info('Your workload was just updated.');
      }
      lastSignature.current = signature;
      return true;
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchWorkload(); }, [fetchWorkload]);

  // Refresh button: the whole page reloads behind the skeleton, then fades back in
  const [refreshing, setRefreshing] = useState(false);
  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    const ok = await fetchWorkload(true);
    setRefreshing(false);
    if (!ok) toast.error('Could not refresh your workload. Check your connection and try again.');
    return ok;
  }, [fetchWorkload, toast]);

  // Live updates: subjects assigned or moved, schedules, PRAISE or deloading
  // changed, or a new active term — the workload reloads quietly (the open tab
  // stays) within seconds of the change, and a short message says it changed
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
  const hasActualSection = (workload?.loads.length ?? 0) > 0;
  const effectiveTab: WorkloadTab =
    (activeTab === 'praise' && !hasPraiseSection) || (activeTab === 'actual' && !hasActualSection) ? 'regular' : activeTab;

  // Only once the workload is in — before that every section looks empty
  const workloadLoaded = !!workload;
  useEffect(() => {
    if (workloadLoaded && activeTab !== effectiveTab) setActiveTab(effectiveTab);
  }, [workloadLoaded, activeTab, effectiveTab]);

  const totalDeductionUnits = isP ? (s?.total_deduction_units || 0) : 0;
  const olVal  = isP ? (s?.total_overload_units || 0) : (s?.total_overload_hours || 0);
  const praiseSubjectVal = isP ? (s?.total_praise_units || 0) : (s?.total_praise_hours || 0);
  const praiseTotal = praiseSubjectVal + (workload?.praise.reduce((sum, p) => sum + (parseFloat(String(p.equivalent_units)) || 0), 0) ?? 0);
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
    for (const l of splitPrintLoads) total += sumParts(loadParts(l, isP)).movedHours;
    return total;
  })();

  /* Group regular loads by day section */
  type PrintRow = { load: WorkloadLoad; row: SplitRow };
  const grouped: Record<string, PrintRow[]> = {};
  for (const load of regularPrintLoads) {
    for (const row of splitLoad(load)) {
      // Skip a part whose whole value is in Overload / Praise (nothing of it stays Regular)
      const { displayWU, displayHours } = computeRegularRowValues(load, row, isP);
      if (isSplitLoad(load, isP) && (isP ? displayWU : displayHours) < 0.001) continue;
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
    unitsText: formatOfficialTotal(totalRegularWU),
    hoursText: formatOfficialTotal(totalRegularHoursDisplay),
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
    // Regular Load = teaching + deductions (Praise is not part of it — as on the admin form and print).
    // Units for everyone (no deductions for Contractual); hours go under Hours.
    totalUnitsText: formatOfficialTotal(totalRegularWU + totalDeductionUnits),
    totalHoursText: formatOfficialTotal(totalRegularHoursDisplay),
  };

  /* Group overload loads by section (same placement as official Regular slots) */
  const overloadGrouped: Record<string, PrintRow[]> = {};
  for (const load of overloadPrintLoads) {
    for (const row of splitLoad(load)) {
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
  /** Work units on the Overload lines — the form's units total for Contractual (kept in hours) */
  let overloadRowsWU = 0;
  for (const list of Object.values(overloadGrouped)) {
    for (const { load, row } of list) {
      const lec2 = parseFloat(String(load.lecture_hours)) || 0;
      const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
      const hasBoth2 = lec2 > 0 && lab2 > 0;
      // Units column = work units for everyone (Contractual subjects are kept in hours)
      const olWU = hasBoth2
            ? (row.type === 'lec' ? lec2 : lab2 * 0.75)
            : (isP ? parseFloat(String(load.units)) || 0 : lec2 + lab2 * 0.75);
      overloadRowsWU += olWU;
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
    const olParts = loadParts(load, isP);
    for (const row of splitLoad(load)) {
      // Only the part moved to Overload — Lecture and Laboratory each on its own line
      const part = partOf(olParts, row.type);
      if (!part || (isP ? part.movedUnits : part.movedHours) < 0.001) continue;
      const start = row.type === 'lec' ? (load.lec_start_time ?? load.start_time) : (load.lab_start_time ?? load.start_time);
      const end   = row.type === 'lec' ? (load.lec_end_time ?? load.end_time) : (load.lab_end_time ?? load.end_time);
      const day   = row.type === 'lec' ? (load.lec_day_pattern ?? load.day_pattern) : (load.lab_day_pattern ?? load.day_pattern);
      const yearNum = extractYearNum(load.year_level);
      const occupied = occupiedRangeFromScheduleTimes(start, end);
      const rowWU = part.movedUnits;
      const olHours = part.movedHours;
      overloadRowsWU += rowWU;
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
        units: formatOfficialNumber(rowWU),
        hours: formatOfficialNumber(olHours),
        room: row.room_name || '',
      });
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

  const praiseHoursSum = praiseSubjectLoads.reduce((sum, l) => {
    return sum + (parseFloat(String(l.lecture_hours)) || 0) + (parseFloat(String(l.laboratory_hours)) || 0);
  }, 0) + praiseSplitLoads.reduce((sum, l) => sum + sumParts(loadParts(l, isP)).movedHours, 0);
  /** Work units on the Praise lines — the form's units for Contractual (kept in hours) */
  let praiseRowsWU = 0;
  const officialPraiseRows: OfficialFormRow[] = [
    ...praiseSubjectLoads.flatMap((load) =>
      splitLoad(load).map((row) => {
        const lec2 = parseFloat(String(load.lecture_hours)) || 0;
        const lab2 = parseFloat(String(load.laboratory_hours)) || 0;
        const hasBoth2 = lec2 > 0 && lab2 > 0;
        const wu = hasBoth2
          ? (row.type === 'lec' ? lec2 : lab2 * 0.75)
          : (isP ? parseFloat(String(load.units)) || 0 : lec2 + lab2 * 0.75);
        praiseRowsWU += wu;
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
      // Only the part moved to Praise — Lecture and Laboratory each on its own line
      const praiseParts = loadParts(load, isP);
      const movedOf = (row: SplitRow) => partOf(praiseParts, row.type);
      return splitLoad(load).filter(r => ((isP ? movedOf(r)?.movedUnits : movedOf(r)?.movedHours) ?? 0) > 0.001).map((row) => {
        const hrs = movedOf(row)?.movedHours ?? 0;
        const rowWU = movedOf(row)?.movedUnits ?? 0;
        praiseRowsWU += rowWU;
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
          units: formatOfficialNumber(rowWU),
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
  /* Units under Units, hours under Hours — Contractual praise subjects are stored in hours only */
  const praiseTeachingUnits = isP ? praiseSubjectVal : praiseRowsWU;
  const praiseFormUnits = praiseTeachingUnits + praiseRecords.reduce((sum, p) => sum + (parseFloat(String(p.equivalent_units)) || 0), 0);
  const officialPraiseSummary = {
    unitsText: praiseTeaching ? formatOfficialTotal(praiseTeachingUnits) : '',
    hoursText: praiseTeaching ? formatOfficialTotal(praiseHoursSum) : '',
    designation: '',
    researchExtension: praiseRecords.filter(p => isResearchExtensionType(p.praise_type)).map(praiseRecordLine),
    specialAssignments: praiseRecords.filter(p => !isResearchExtensionType(p.praise_type)).map(praiseRecordLine),
    preparations: praiseTeaching && praisePreparations > 0 ? String(praisePreparations) : '',
    totalUnitsText: formatOfficialTotal(praiseFormUnits),
    totalHoursText: praiseTeaching ? formatOfficialTotal(praiseHoursSum) : '',
    totalDescription: 'Praise Load',
  };

  /* Actual Load: every subject of the term at its full Lec/Lab value — the same lines
     as the printed Actual Load form, with the Regular form's summary lines. */
  const actualLines = actualLoadLines(workload?.loads ?? [], isP);
  const officialActualRows: OfficialFormRow[] = actualLines.map(({ row, startTime, endTime, dayPattern }) => {
    const occupied = occupiedRangeFromScheduleTimes(startTime, endTime);
    return {
      key: `${row.key}-actual`,
      slotId: matchOfficialSlot(dayPattern, startTime, endTime, formGroups),
      timeLabel: formatOfficialTimeRange(startTime, endTime),
      rangeStartMin: occupied?.startMin,
      rangeEndMin: occupied?.endMin,
      subjectCode: row.load.subject_code,
      description: row.description,
      course: `${row.load.program_code} ${extractYearNum(row.load.year_level)}${row.load.block_name}`,
      students: row.load.number_of_students > 0 ? String(row.load.number_of_students) : '',
      units: formatOfficialNumber(row.wu),
      hours: formatOfficialNumber(row.hours),
      room: row.room_name || '',
    };
  });
  const actualWU = actualLines.reduce((sum, l) => sum + l.row.wu, 0);
  const actualHours = actualLines.reduce((sum, l) => sum + l.row.hours, 0);
  /** The form's Total No. of Units (Actual Load): teaching + deloading */
  const actualTotalUnits = actualWU + totalDeductionUnits;
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

  /* ── Print: the menu asks which official form first (Actual Load / Regular / Overload / Praise) ── */
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
    const opened = openWorkloadPrintableVersion('/instructor/workload/print');
    if (!opened) {
      setPrintError(
        'Unable to open the printable version. Please open this page in Chrome or Safari and try again.',
      );
      setPrintOfferFallback(true);
    }
  }

  const showSkeleton = useMinLoading((loading && !data) || refreshing, LOADING_DELAY);

  /* ── Render ─────────────────────────────────────────────────────────────── */
  return (
    <div className="min-h-full p-4 sm:p-6 lg:p-8">
      {/* Desktop: balanced width, centred (phones/tablets unchanged) */}
      <div className="lg:max-w-6xl lg:mx-auto">
      {/* ── Page header ───────────────────────────────────────────────── */}
      <div className="mb-4">
        <BackButton />
        <div className="mt-2 lg:mt-5">
          <WatermarkTitle>My Workload</WatermarkTitle>
        </div>
      </div>

      {/* ── Active academic period (Admin-controlled, read-only) + Refresh / Print ── */}
      <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-[0_1px_3px_rgba(0,0,0,0.06)] px-4 py-3.5 sm:px-5 mb-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#64748B] uppercase tracking-wide">
            Active academic period
          </p>
          <p className="text-[15px] font-bold text-[#0B2A5B] mt-0.5">
            {semester && academicYear
              ? `${semester} — A.Y. ${academicYear}`
              : periodReady
                ? 'No active academic period is currently configured.'
                : 'Loading period…'}
          </p>
        </div>
        <div className="flex items-center gap-2.5 w-full sm:w-auto">
          <RefreshButton
            overlay={false}
            onRefresh={refreshAll}
            loading={refreshing || showSkeleton}
            className="flex-1 sm:flex-none"
          />
          {workload && (
            <WorkloadPrintMenu
              data={{ faculty: workload.faculty, loads: workload.loads, praise: workload.praise, deductions: workload.deductions }}
              semester={semester}
              academicYear={academicYear}
              look="primary"
              phoneStretch
              printablePath="/instructor/workload/print"
              onPrinted={handlePrinted}
            />
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

      {/* ── Loading — same shape as the page: load cards, section bar, form ── */}
      <PageLoadTransition
        showSkeleton={showSkeleton}
        skeleton={
          <div>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-5">
              <Skeleton className="col-span-2 lg:col-span-1 h-[118px] sm:h-[132px] rounded-2xl" />
              <Skeleton className="h-[118px] sm:h-[132px] rounded-2xl" />
              <Skeleton className="h-[118px] sm:h-[132px] rounded-2xl" />
            </div>
            <div className="flex items-center justify-between mb-3">
              <Skeleton className="h-6 w-44 rounded" />
              <Skeleton className="h-10 w-24 rounded-lg" />
            </div>
            <div className="space-y-2.5">
              {[0, 1, 2].map(i => <Skeleton key={i} className="h-[150px] lg:h-[60px] rounded-xl" />)}
            </div>
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
        const actualCount = workload.loads.length;
        // Contractual faculty carry Regular Load only — no Overload card unless there is something in it
        const showOverloadCard = canHaveOverloadOrPraise(workload.faculty?.employment_status) || hasOverloadSection;
        const cardCount = 2 + Number(showOverloadCard) + Number(hasPraiseSection);
        const unitWord = isP ? 'units' : 'hours';
        const plural = (n: number, word: string) => `${n} ${word}${n !== 1 ? 's' : ''}`;
        const sectionLabel = {
          actual: 'Actual Load', regular: isP ? 'Regular Load' : 'Regular Hours', overload: 'Overload', praise: 'Praise Load',
        }[effectiveTab];
        const sectionCount = {
          actual: plural(actualCount, 'subject'),
          regular: plural(regularPrintLoads.length, 'subject'),
          overload: plural(overloadCount, 'subject'),
          praise: plural(praiseCount, 'item'),
        }[effectiveTab];

        return (
          <>
            {/* ── Summary cards: Actual Load · Regular · Overload · Praise (if any) — tap one to open its form below.
                 Phones: an odd number of cards puts Actual Load across the top, so no card sits alone ── */}
            <div className={`grid grid-cols-2 gap-3 sm:gap-4 mb-5 ${cardCount === 4 ? 'lg:grid-cols-4' : cardCount === 3 ? 'lg:grid-cols-3' : ''}`}>
              <LoadCard index={0} tone={TAB_TONE.actual} edgeColor="var(--load-actual)" label="Actual Load"
                className={cardCount % 2 === 1 ? 'col-span-2 lg:col-span-1' : ''}
                unit={`${unitWord} · ${plural(actualCount, 'subject')}`}
                // With deloading the form's total is teaching + deloading — show how it adds up
                detail={totalDeductionUnits > 0.001 ? `${actualWU.toFixed(2)} teaching + ${totalDeductionUnits.toFixed(2)} deloading` : undefined}
                value={actualTotal.toFixed(2)}
                active={effectiveTab === 'actual' && tableVisible}
                onClick={hasActualSection ? () => selectTab('actual') : undefined} />
              <LoadCard index={1} tone={TAB_TONE.regular} label={isP ? 'Regular Load' : 'Regular Hours'} unit={isP ? 'units' : 'hours'}
                value={modalRegVal.toFixed(2)} of={regLimitShown}
                note={modalIsExceeded ? `Exceeded by ${regOverShown.toFixed(2)}` : undefined}
                active={effectiveTab === 'regular' && tableVisible} onClick={() => selectTab('regular')} />
              {showOverloadCard && (
                <LoadCard index={2} tone={TAB_TONE.overload} label="Overload" unit={isP ? 'units' : 'hours'} value={olVal.toFixed(2)}
                  active={effectiveTab === 'overload' && tableVisible}
                  onClick={() => selectTab('overload')} />
              )}
              {hasPraiseSection && (
                <LoadCard index={showOverloadCard ? 3 : 2} tone={TAB_TONE.praise} label="Praise Load" unit={`${unitWord} · ${plural(praiseCount, 'item')}`}
                  value={praiseTotal.toFixed(2)}
                  active={effectiveTab === 'praise' && tableVisible} onClick={() => selectTab('praise')} />
              )}
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

              {/* What the cards above opened: its name and count, and Hide / Show */}
              <div ref={sectionRef} className="flex items-center justify-between gap-3 scroll-mt-4">
                <h2 className="min-w-0">
                  <SectionReveal sectionKey={`title-${effectiveTab}`} play={sectionSwitched} className="flex items-baseline gap-x-2 flex-wrap">
                    <span className="text-lg font-bold" style={{ color: TAB_TONE[effectiveTab] }}>{sectionLabel}</span>
                    <span className="text-sm font-semibold text-[#64748B]">{sectionCount}</span>
                  </SectionReveal>
                </h2>
                <button
                  type="button"
                  aria-expanded={tableVisible}
                  onClick={() => setTableVisible(v => !v)}
                  className="inline-flex items-center gap-1.5 flex-shrink-0 h-10 px-3.5 rounded-lg border border-[#BFDBFE] bg-[#EFF6FF] text-sm font-semibold text-[#1D5BD6] hover:bg-[#DBEAFE] hover:border-[#1D5BD6] active:scale-95 transition-all"
                >
                  <ChevronDown
                    className={`w-4 h-4 transition-transform duration-300 ease-in-out ${tableVisible ? 'rotate-180' : 'rotate-0'}`}
                  />
                  {tableVisible ? 'Hide' : 'Show'}
                </button>
              </div>

              <WorkloadCollapsible open={tableVisible}>
                {/* The official form as a table on every screen, in a white box — phones
                    swipe it sideways (the user asked for the table, not cards, 2026-10-08) */}
                <SectionReveal sectionKey={effectiveTab} play={sectionSwitched} className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
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
                  {effectiveTab === 'actual' && (
                    <OfficialWorkloadFormTable
                      rows={officialActualRows}
                      summary={officialActualSummary}
                      variant="actual"
                      groups={formGroups}
                    />
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
                  {effectiveTab === 'praise' && (
                    <OfficialWorkloadFormTable
                      rows={officialPraiseRows}
                      summary={officialPraiseSummary}
                      variant="praise"
                      groups={formGroups}
                    />
                  )}
                </SectionReveal>
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
