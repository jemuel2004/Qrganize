'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useToast } from '@/context/ToastContext';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useRealtime } from '@/context/RealtimeContext';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { AlertTriangle, CalendarDays, Eye, FileSpreadsheet, Loader2, Printer, RotateCcw, Trash2, X } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import WorkloadPrintMenu from '@/components/WorkloadPrintMenu';
import { SearchInput } from '@/components/ui/SearchFilter';
import FriendlySelect from '@/components/ui/FriendlySelect';
import CountFilterTabs, { type CountFilterOption } from '@/components/ui/CountFilterTabs';
import LoadBreakdownDonut from '@/components/charts/LoadBreakdownDonut';
import { useScrollLock } from '@/hooks/useScrollLock';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { EmploymentBadge } from '@/components/ui/EmploymentBadge';
import { Skeleton, TableSkeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { byPosition } from '@/lib/positionRank';
import {
  DEFAULT_SUMMARY_SIGNATORIES, downloadWorkloadSummaryExcel, loadSummarySignatories, printWorkloadSummary, saveSummarySignatories,
  type SummarySignatories,
} from '@/lib/workloadSummaryPrint';
import { blockCode } from '@shared/blockCode';

/* ── Types ─────────────────────────────────────────────────────────────── */

interface FacultyScheduleRow {
  faculty_id: number;
  faculty_name: string;
  employee_id: string;
  position: string;
  employment_status: string;
  program_id: number;
  program_code: string;
  program_name: string;
  load_id: number;
  /** The class (master_schedule) — what Remove Subject takes off this faculty */
  master_schedule_id: number;
  load_category: 'Regular' | 'Overload' | 'Praise';
  units: number | null;
  hours: number | null;
  subject_code: string;
  subject_name: string;
  curriculum_units: number;
  total_hours: number;
  block_name: string;
  year_level: string;
  semester: string;
  academic_year: string;
  day_pattern: string | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
  room_name: string | null;
  /** Set on the split portion (only the Lec or Lab) moved to Overload / Praise */
  split_component?: 'lec' | 'lab' | null;
  /** This row is the moved part of the subject listed in another row */
  split_portion?: boolean;
}

interface Summary {
  totalSchedules: number;
  totalInstructors: number;
  totalRegular: number;
  totalOverload: number;
  totalPraise: number;
}

interface FacultyOption {
  id: number;
  name: string;
  employment_status: string;
  position: string;
}

/** Field label + read-only term box — same height as the dropdown beside it. */
const FS_LABEL = 'text-xs font-semibold uppercase tracking-wide text-[#475569] mb-1.5';
/** Print Summary signatory fields — 16px text so phones don't zoom in */
const SIGNER_FIELD =
  'w-full h-11 rounded-xl border border-[#CBD5E1] bg-white px-3.5 text-base text-[#0B2A5B] placeholder:text-[#94A3B8] ' +
  'hover:border-[#94A3B8] focus:outline-none focus:border-[#1D5BD6] focus:ring-4 focus:ring-[#1D5BD6]/15 transition';
const FS_READONLY =
  'flex items-center gap-2 min-h-[48px] bg-[#F4F7FC] border border-[#D6E0EF] rounded-xl px-3.5 select-none min-w-0';

type EmploymentTab = 'all' | 'Permanent' | 'Contractual';

/* ── Helpers ────────────────────────────────────────────────────────────── */

function fmtTime(t: string | null) {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${hr}:${m.toString().padStart(2, '0')} ${ap}`;
}

function fmtRange(start: string | null, end: string | null) {
  if (!start) return '—';
  if (!end) return fmtTime(start);
  return `${fmtTime(start)} – ${fmtTime(end)}`;
}

/** Load Breakdown slices → the load_category each one counts */
type LoadKey = 'regular' | 'overload' | 'praise';
const LOAD_META: Record<LoadKey, { category: string; label: string; color: string }> = {
  regular:  { category: 'Regular',  label: 'Regular Load', color: 'var(--load-regular)' },
  overload: { category: 'Overload', label: 'Overload',     color: 'var(--load-overload)' },
  praise:   { category: 'Praise',   label: 'Praise Load',  color: 'var(--load-praise)' },
};

function rowValue(row: FacultyScheduleRow): number {
  if (row.employment_status === 'Permanent') {
    const u = (row.units !== null && Number(row.units) > 0) ? Number(row.units) : row.curriculum_units;
    return u ?? 0;
  }
  const h = (row.hours !== null && Number(row.hours) > 0) ? Number(row.hours) : row.total_hours;
  return h ?? 0;
}

/** Schedule Details order: Regular, then Overload, then Praise; within each,
 *  by first meeting day and time (unscheduled last), then subject and block. */
const LOAD_ORDER: Record<string, number> = { Regular: 0, Overload: 1, Praise: 2 };
function firstDayIndex(dayPattern: string | null): number {
  const first = (dayPattern ?? '').split('/')[0].trim().slice(0, 3);
  const i = first ? DAY_ORDER.findIndex(d => d.startsWith(first)) : -1;
  return i === -1 ? 99 : i;
}
function byLoadThenTime(a: FacultyScheduleRow, b: FacultyScheduleRow): number {
  return (LOAD_ORDER[a.load_category] ?? 9) - (LOAD_ORDER[b.load_category] ?? 9)
    || firstDayIndex(a.day_pattern) - firstDayIndex(b.day_pattern)
    || (a.start_time ?? '99').localeCompare(b.start_time ?? '99')
    || a.subject_code.localeCompare(b.subject_code, undefined, { numeric: true })
    || String(a.year_level ?? '').localeCompare(String(b.year_level ?? ''), undefined, { numeric: true })
    || String(a.block_name ?? '').localeCompare(String(b.block_name ?? ''));
}

/* ── Sub-components ─────────────────────────────────────────────────────── */

function LoadBadge({ cat, part }: { cat: string; part?: 'lec' | 'lab' | null }) {
  const styles: Record<string, string> = {
    Regular:  'bg-[#EFF6FF] text-[#1D5BD6] border border-[#BFDBFE]',
  };
  // Overload / Praise use the Load Breakdown colours
  const tone = LOAD_COLOR[cat];
  const cls = styles[cat] ?? (tone ? 'border' : 'bg-slate-50 text-slate-600 border border-[#E2E8F0]');
  return (
    <span
      className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${cls}`}
      style={tone ? {
        color: tone,
        backgroundColor: `color-mix(in srgb, ${tone} 10%, transparent)`,
        borderColor: `color-mix(in srgb, ${tone} 35%, transparent)`,
      } : undefined}
    >
      {cat}{part ? ` · ${part === 'lec' ? 'Lec' : 'Lab'}` : ''}
    </span>
  );
}



/** Which subjects the Schedule Details table shows — picked with the stat cards. */
type CardFilter = 'all' | 'Regular' | 'Overload' | 'Praise';

interface ActivityRow { id: number; day_of_week: string; start_time: string; end_time: string; activity: string }

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * The faculty's non-teaching time this term (Consultation, Flag Ceremony, …)
 * — not teaching load, but it keeps them unavailable for classes. Same entry
 * on several days is one line; Remove clears it from every day.
 */
function NonTeachingTime({ facultyId, semester, academicYear }: { facultyId: number; semester: string; academicYear: string }) {
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ semester, academic_year: academicYear });
    const res = await fetch(`/api/faculty/${facultyId}/activities?${qs}`).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    if (data && Array.isArray(data.activities)) setRows(data.activities);
  }, [facultyId, semester, academicYear]);
  useEffect(() => { void load(); }, [load]);
  useRealtime(['schedule', 'faculty'], load);

  const groups = useMemo(() => {
    const map = new Map<string, { key: string; ids: number[]; days: string[]; start: string; end: string; activity: string }>();
    for (const r of rows) {
      const key = `${r.activity.toLowerCase()}|${r.start_time}|${r.end_time}`;
      const g = map.get(key) ?? { key, ids: [], days: [], start: r.start_time, end: r.end_time, activity: r.activity };
      g.ids.push(r.id);
      g.days.push(r.day_of_week);
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) =>
      DAY_ORDER.indexOf(a.days[0]) - DAY_ORDER.indexOf(b.days[0]) || a.start.localeCompare(b.start));
  }, [rows]);

  async function remove(g: { key: string; ids: number[]; activity: string }) {
    setBusyKey(g.key);
    try {
      for (const id of g.ids) {
        const res = await fetch(`/api/faculty/${facultyId}/activities?activity_id=${id}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error();
      }
      toast.success(`${g.activity} removed.`);
      setConfirmKey(null);
      await load();
    } catch {
      toast.error('Could not remove it. Please try again.');
    } finally {
      setBusyKey(null);
    }
  }

  if (groups.length === 0) return null;
  return (
    <div className="px-4 sm:px-6 py-3 border-t border-[#F1F5F9] flex-shrink-0 max-h-[30vh] overflow-auto">
      <p className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: '#64748B' }}>
        Non-teaching time <span className="normal-case tracking-normal font-medium" style={{ color: '#94A3B8' }}>· not teaching load; no class can be scheduled then</span>
      </p>
      <ul className="divide-y divide-[#F1F5F9]">
        {groups.map(g => (
          <li key={g.key} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span style={{ color: '#0B2A5B' }}>
              <span className="font-semibold">{g.activity}</span>
              <span style={{ color: '#64748B' }}>
                {' · '}{DAY_ORDER.filter(d => g.days.includes(d)).map(d => d.slice(0, 3)).join('/')} {fmtRange(g.start, g.end)}
              </span>
            </span>
            {confirmKey === g.key ? (
              <span className="flex items-center gap-2">
                <span className="text-xs" style={{ color: '#64748B' }}>Remove?</span>
                <motion.button type="button" onClick={() => remove(g)} disabled={busyKey === g.key}
                  whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                  className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white bg-[#DC2626] hover:bg-[#B91C1C] disabled:opacity-60 transition-colors">
                  {busyKey === g.key ? 'Removing…' : 'Yes, remove'}
                </motion.button>
                <motion.button type="button" onClick={() => setConfirmKey(null)} disabled={busyKey === g.key}
                  whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                  className="px-3 py-1.5 rounded-lg text-sm font-semibold border hover:bg-[#F1F5F9] transition-colors"
                  style={{ color: '#64748B', borderColor: '#E2E8F0' }}>
                  Keep
                </motion.button>
              </span>
            ) : (
              <motion.button type="button" onClick={() => setConfirmKey(g.key)}
                whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                className="px-3 py-1.5 rounded-lg text-sm font-semibold border hover:bg-[#FEF2F2] transition-colors"
                style={{ color: '#DC2626', borderColor: '#FECACA' }}>
                Remove
              </motion.button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Table text colour per load type — matches the Load Breakdown colours */
const LOAD_COLOR: Record<string, string> = {
  Overload: 'var(--load-overload)',
  Praise:   'var(--load-praise)',
};

/** Stat card that filters the Schedule Details table (Actual Load = every subject). */
function FilterCard({ label, value, color, active, onClick }: {
  label: string; value: number; color: string; active: boolean; onClick: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const empty = value === 0;
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={empty}
      aria-pressed={active}
      whileHover={reduceMotion || empty || active ? undefined : { y: -2 }}
      whileTap={reduceMotion || empty ? undefined : { scale: 0.97 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      title={empty ? `No ${label}` : `Show ${label}`}
      className={`text-left rounded-xl px-3 sm:px-4 py-3 flex flex-col shadow-sm min-w-0 border transition-[background-color,border-color,box-shadow] duration-300 disabled:cursor-not-allowed ${
        active
          ? 'bg-[#EFF6FF] border-[#1D5BD6] ring-2 ring-[#1D5BD6]/20'
          : 'bg-white border-[#E2E8F0] enabled:hover:border-[#1D5BD6]'
      }`}
    >
      <span className="text-[24px] sm:text-[26px] font-bold leading-none tabular-nums" style={{ color }}>{value}</span>
      <span className="text-[11px] sm:text-[10px] uppercase tracking-wide sm:tracking-wider font-semibold mt-1.5 leading-tight" style={{ color: active ? '#1D5BD6' : '#64748B' }}>{label}</span>
    </motion.button>
  );
}

/* ── Main Component ─────────────────────────────────────────────────────── */

export default function FacultySchedulesClient({
  initialFacultyQuery = '',
}: {
  initialFacultyQuery?: string;
}) {
  const toast = useToast();
  const { schoolYear: globalYear, semester: globalSemester } = useSchoolYear();
  const appliedFacultyQuery = useRef<string | null>(null);

  /** Every faculty's subjects this term — Employment Type, Faculty and search filter it on the page */
  const [rows, setRows]               = useState<FacultyScheduleRow[]>([]);
  const [facultyList, setFacultyList] = useState<FacultyOption[]>([]);
  const [loading, setLoading]         = useState(true);

  const [viewFaculty, setViewFaculty] = useState<{
    id: number; name: string; empId: string; position: string; empStatus: string; rows: FacultyScheduleRow[];
  } | null>(null);
  /** Load Breakdown slice clicked — lists the faculty who have that load */
  const [loadPick, setLoadPick] = useState<LoadKey | null>(null);
  useScrollLock(Boolean(viewFaculty) || Boolean(loadPick));

  /* Stat-card filter for the open Schedule Details. Remembered per faculty, so
     opening someone else always starts on Actual Load (every subject). */
  const [cardPick, setCardPick] = useState<{ facultyId: number; filter: CardFilter } | null>(null);
  const cardFilter: CardFilter = viewFaculty && cardPick?.facultyId === viewFaculty.id ? cardPick.filter : 'all';
  const reduceMotion = useReducedMotion();
  /* The open Schedule Details reads the live rows, so a background refresh
     (another user changing this faculty's classes) shows up there too. */
  const viewRows = useMemo(
    () => (viewFaculty ? rows.filter(r => r.faculty_id === viewFaculty.id).sort(byLoadThenTime) : []),
    [rows, viewFaculty],
  );

  const [filters, setFilters] = useState({
    employment_status: '',
    faculty_id: '',
    search: '',
  });

  function setF(key: keyof typeof filters, val: string) {
    setFilters(prev => ({ ...prev, [key]: val }));
  }

  const loadFacultyList = useCallback(() => fetch('/api/faculty')
    .then(r => r.json())
    .then(d => setFacultyList((d.faculty ?? []).map((f: Record<string, unknown>) => ({
      id: f.id, name: f.name, employment_status: f.employment_status, position: f.position ?? '',
    }))))
    .catch(() => {}), []);
  useEffect(() => { loadFacultyList(); }, [loadFacultyList]);

  useEffect(() => {
    const raw = initialFacultyQuery.trim();
    if (!raw) return;
    if (appliedFacultyQuery.current === raw) return;
    if (facultyList.length === 0) return;

    appliedFacultyQuery.current = raw;
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.error('Invalid faculty.');
      return;
    }
    const match = facultyList.find(f => f.id === id);
    if (!match) {
      toast.error('Faculty not found or is no longer active.');
      return;
    }
    setFilters(prev => ({
      ...prev,
      faculty_id: String(match.id),
      employment_status: match.employment_status,
    }));
  }, [facultyList, initialFacultyQuery, toast]);

  /** Latest request — an older answer (filters changed meanwhile) is dropped. */
  const loadSeq = useRef(0);
  /** silent: live-update refresh — no loading state, no error toasts */
  const load = useCallback(async (silent = false) => {
    const seq = ++loadSeq.current;
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (globalSemester) params.set('semester',      globalSemester);
      if (globalYear)     params.set('academic_year', globalYear);

      const res  = await fetch(`/api/faculty-schedules?${params}`);
      const data = await res.json();
      if (seq !== loadSeq.current) return;
      if (!res.ok) { if (!silent) toast.error(data.error ?? 'Failed to load schedules.'); return; }

      setRows(data.schedules ?? []);
    } catch {
      if (!silent && seq === loadSeq.current) toast.error('Connection error. Please try again.');
    } finally {
      if (!silent && seq === loadSeq.current) setLoading(false);
    }
  }, [globalSemester, globalYear, toast]);

  useEffect(() => { load(); }, [load]);

  // Live updates: schedules, loads, rooms or faculty changed elsewhere — quiet
  // reload; filters, search and the open schedule details stay.
  useRealtime(['schedule', 'workload', 'rooms', 'faculty'], () => Promise.all([load(true), loadFacultyList()]), { enabled: !loading });

  /* Remove Subject (trash in Schedule Details) — the same action as on Faculty
     Workload: the class leaves this faculty's load, its day / time / room are
     cleared and it goes back to Unassigned for reassignment. */
  const [removeTarget, setRemoveTarget] = useState<FacultyScheduleRow | null>(null);
  const [removing, setRemoving] = useState(false);
  /* Every row of the subject being removed (Regular + a moved Overload / Praise part) */
  const removeRows = removeTarget
    ? rows.filter(r => r.faculty_id === removeTarget.faculty_id && r.master_schedule_id === removeTarget.master_schedule_id)
    : [];
  async function confirmRemoveSubject() {
    if (!removeTarget || removing) return;
    setRemoving(true);
    try {
      const res = await fetch('/api/workload/unassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faculty_id: removeTarget.faculty_id, master_schedule_id: removeTarget.master_schedule_id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || 'Failed to remove subject.');
        return;
      }
      toast.success(`${removeTarget.subject_code} removed from ${removeTarget.faculty_name}.`);
      setRemoveTarget(null);
      await load(true);
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setRemoving(false);
    }
  }

  const filteredFaculty = useMemo(() => {
    const byEmp = filters.employment_status
      ? facultyList.filter(f => f.employment_status === filters.employment_status)
      : facultyList;
    return [...byEmp].sort(byPosition);
  }, [facultyList, filters.employment_status]);

  useEffect(() => {
    if (filters.faculty_id && !filteredFaculty.some(f => String(f.id) === filters.faculty_id)) {
      setFilters(prev => ({ ...prev, faculty_id: '' }));
    }
  }, [filteredFaculty, filters.faculty_id]);

  const q = filters.search.toLowerCase().trim();

  /** One group per faculty with subjects this term (every employment type) */
  const allGroups = useMemo(() => {
    type Group = {
      facultyId: number; facultyName: string; position: string;
      empStatus: string; empId: string; rows: FacultyScheduleRow[];
    };
    const byFaculty = new Map<number, Group>();
    for (const row of rows) {
      const g = byFaculty.get(row.faculty_id);
      if (g) g.rows.push(row);
      else byFaculty.set(row.faculty_id, { facultyId: row.faculty_id, facultyName: row.faculty_name, position: row.position ?? '', empStatus: row.employment_status, empId: row.employee_id, rows: [row] });
    }
    // Permanent block first, then Contractual — never interleaved. Within each
    // block, lowest total load (least complete) first; ties by name.
    const totalOf = (g: Group) => g.rows.reduce((sum, r) => sum + rowValue(r), 0);
    return [...byFaculty.values()].sort((a, b) => {
      const ta = a.empStatus === 'Permanent' ? 0 : 1;
      const tb = b.empStatus === 'Permanent' ? 0 : 1;
      if (ta !== tb) return ta - tb;
      const diff = totalOf(a) - totalOf(b);
      if (Math.abs(diff) > 0.001) return diff;
      return a.facultyName.localeCompare(b.facultyName);
    });
  }, [rows]);

  /** The chosen Employment Type and Faculty */
  const groups = useMemo(() => allGroups.filter(g =>
    (!filters.employment_status || g.empStatus === filters.employment_status)
    && (!filters.faculty_id || String(g.facultyId) === filters.faculty_id),
  ), [allGroups, filters.employment_status, filters.faculty_id]);

  const matchesSearch = useCallback((g: (typeof allGroups)[number]) =>
    !q ||
    g.facultyName.toLowerCase().includes(q) ||
    g.position.toLowerCase().includes(q) ||
    g.empStatus.toLowerCase().includes(q) ||
    g.rows.some(r =>
      r.subject_code.toLowerCase().includes(q) ||
      r.subject_name.toLowerCase().includes(q) ||
      blockCode(r.year_level, r.block_name).toLowerCase().includes(q) ||
      (r.room_name ?? '').toLowerCase().includes(q)
    ), [q]);

  const visibleGroups = useMemo(() => groups.filter(matchesSearch), [groups, matchesSearch]);

  /* Print Summary — the Summary of Faculty Workload for the term: every faculty with
     subjects, Permanent then Contractual, each line from their own official forms. */
  const [summaryProgress, setSummaryProgress] = useState<{ done: number; total: number; excel: boolean } | null>(null);
  /* Print Summary first shows the names in the summary's footer — they can be
     edited (remembered in this browser for next time). Download Excel, its own
     button, gives the same sheet with those saved names. */
  const [signers, setSigners] = useState<SummarySignatories | null>(null);
  function openSummaryDialog() {
    if (summaryProgress) return;
    if (allGroups.length === 0) { toast.info('No faculty have subjects this term yet.'); return; }
    setSigners(loadSummarySignatories());
  }
  function printFromDialog() {
    if (!signers) return;
    saveSummarySignatories(signers);
    setSigners(null);
    // Same click — the print window opens straight away, so pop-up blockers allow it
    void makeSummary(signers, false);
  }
  function downloadSummaryExcel() {
    void makeSummary(loadSummarySignatories(), true);
  }
  async function makeSummary(signatories: SummarySignatories, excel: boolean) {
    if (summaryProgress) return;
    const ids = allGroups.map(g => g.facultyId);
    if (ids.length === 0) { toast.info('No faculty have subjects this term yet.'); return; }
    setSummaryProgress({ done: 0, total: ids.length, excel });
    const opts = {
      facultyIds: ids, semester: globalSemester, academicYear: globalYear, signatories,
      onProgress: (done: number, total: number) => setSummaryProgress({ done, total, excel }),
    };
    try {
      if (excel) {
        await downloadWorkloadSummaryExcel(opts);
        toast.success('Summary of Faculty Workload downloaded as Excel.');
      } else {
        const result = await printWorkloadSummary(opts);
        if (!result.ok) toast.error('Could not open the print window. Allow pop-ups for this site and try again.');
        else if (result.method === 'download') toast.info('The summary was downloaded — open the file to print it.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not prepare the summary. Please try again.');
    } finally {
      setSummaryProgress(null);
    }
  }

  /* Employment Type buttons count every faculty matching the search, whichever
     type is chosen — picking Permanent never turns Contractual into 0. */
  const typeCounts = useMemo(() => {
    const searched = allGroups.filter(matchesSearch);
    return {
      all: searched.length,
      Permanent: searched.filter(g => g.empStatus === 'Permanent').length,
      Contractual: searched.filter(g => g.empStatus === 'Contractual').length,
    };
  }, [allGroups, matchesSearch]);
  const typeTab = (filters.employment_status || 'all') as EmploymentTab;
  const typeTabs: CountFilterOption<EmploymentTab>[] = [
    { key: 'all',         label: 'All',         count: typeCounts.all,         color: '#0B2A5B' },
    { key: 'Permanent',   label: 'Permanent',   count: typeCounts.Permanent,   color: '#17805F', dot: '#1F9D74' },
    { key: 'Contractual', label: 'Contractual', count: typeCounts.Contractual, color: '#A85F12', dot: '#C9761A' },
  ];

  /* Load Breakdown — the chosen Employment Type and Faculty, counted the same
     way the server used to (subjects per load type, faculty scheduled). */
  const summary: Summary = useMemo(() => {
    const shown = groups.flatMap(g => g.rows);
    return {
      totalSchedules:   new Set(shown.map(r => r.load_id)).size,
      totalInstructors: groups.length,
      totalRegular:     shown.filter(r => r.load_category === 'Regular').length,
      totalOverload:    shown.filter(r => r.load_category === 'Overload').length,
      totalPraise:      shown.filter(r => r.load_category === 'Praise').length,
    };
  }, [groups]);

  /** Faculty behind the clicked Load Breakdown slice, most subjects first */
  const pickedFaculty = useMemo(() => {
    if (!loadPick) return [];
    const category = LOAD_META[loadPick].category;
    return groups
      .map(g => {
        const mine = g.rows.filter(r => r.load_category === category);
        return { group: g, rows: mine, value: mine.reduce((s, r) => s + rowValue(r), 0) };
      })
      .filter(x => x.rows.length > 0)
      .sort((a, b) => b.rows.length - a.rows.length || a.group.facultyName.localeCompare(b.group.facultyName));
  }, [groups, loadPick]);

  const SUMMARY_COLS = ['Faculty Name', 'Position', 'Regular', 'Overload', 'Total Subjects', 'Total Units / Hours', 'View'];
  const showPageSkeleton = useMinLoading(loading && rows.length === 0, LOADING_DELAY);

  const pageSkeleton = (
    <div className="space-y-6" role="status" aria-live="polite" aria-label="Loading faculty schedules">
      {/* Title */}
      <div className="space-y-2 min-w-0">
        <Skeleton className="h-8 w-52 sm:w-60 rounded-md" />
        <Skeleton className="h-4 w-full max-w-xl rounded" />
      </div>

      {/* Filters (type buttons · faculty + term · search) left · donut right */}
      <div className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] p-4 sm:p-6 w-full min-w-0">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-6 lg:gap-10 items-start">
          <div className="space-y-5 min-w-0">
            <div className="space-y-2">
              <Skeleton className="h-3 w-32 rounded" />
              <div className="flex flex-wrap gap-2.5">
                {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-11 w-32 rounded-xl" />)}
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {Array.from({ length: 2 }, (_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-20 rounded" />
                  <Skeleton className="h-12 w-full rounded-xl" />
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-16 rounded" />
              <Skeleton className="h-11 w-full rounded-2xl" />
            </div>
          </div>
          <div className="rounded-2xl border border-[#E3E9F3] p-5 space-y-4">
            <Skeleton className="h-4 w-40 rounded" />
            <div className="flex items-center gap-6">
              <Skeleton className="w-[184px] h-[184px] rounded-full" />
              <div className="space-y-3 w-[220px]">
                {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-4 w-full rounded" />)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white border border-[#E2E8F0] rounded-2xl overflow-hidden shadow-sm w-full min-w-0 p-4 sm:p-5 space-y-3">
        <Skeleton className="h-4 w-28 rounded" />
        <TableSkeleton cols={7} rows={8} />
      </div>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <PageLoadTransition
        showSkeleton={showPageSkeleton}
        skeleton={pageSkeleton}
        className="space-y-6"
      >

      {/* ── Page Header ── */}
      <div>
        <BackButton />
        <div className="mt-4 sm:mt-7 mb-4">
          <WatermarkTitle>Faculty Schedule</WatermarkTitle>
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          {/* Excel: the same sheet as the print, with the names saved from Print Summary */}
          <motion.button
            type="button"
            onClick={downloadSummaryExcel}
            disabled={!!summaryProgress}
            whileHover={reduceMotion || summaryProgress ? undefined : { y: -1 }}
            whileTap={reduceMotion || summaryProgress ? undefined : { scale: 0.96 }}
            title="Download the Summary of Faculty Workload as an Excel file"
            className="group inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-[15px] font-semibold border-2 border-[#1D5BD6] text-[#1D5BD6] bg-white hover:bg-[#EFF6FF] transition-colors disabled:cursor-wait disabled:opacity-70"
          >
            {summaryProgress?.excel
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Preparing Excel… {summaryProgress.done} of {summaryProgress.total}</>
              : <><FileSpreadsheet className="w-4 h-4 transition-transform duration-200 group-hover:-translate-y-px" style={{ color: '#1D6F42' }} /> Download Excel</>}
          </motion.button>
          <motion.button
            type="button"
            onClick={openSummaryDialog}
            disabled={!!summaryProgress}
            whileHover={reduceMotion || summaryProgress ? undefined : { y: -1 }}
            whileTap={reduceMotion || summaryProgress ? undefined : { scale: 0.96 }}
            title="Print the Summary of Faculty Workload for this term"
            className="group inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-[15px] font-semibold bg-[#1D5BD6] hover:bg-[#164BB5] shadow-lg shadow-[#1D5BD6]/20 transition-colors disabled:cursor-wait disabled:opacity-90"
            // White set inline — the light-mode rule repaints `text-white` as dark ink
            style={{ color: '#FFFFFF' }}
          >
            {summaryProgress && !summaryProgress.excel
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Preparing… {summaryProgress.done} of {summaryProgress.total}</>
              : <><Printer className="w-4 h-4 transition-transform duration-200 group-hover:-translate-y-px" /> Print Summary</>}
          </motion.button>
        </div>
      </div>

      {/* ── Filters (left) + load breakdown (right) ── */}
      <div className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] p-4 sm:p-6 w-full min-w-0">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-6 lg:gap-10 items-start">

          {/* Left — Employment Type buttons, Faculty + Term, search */}
          <div className="space-y-5 min-w-0">
            <div className="min-w-0">
              <p className={FS_LABEL}>Employment Type</p>
              {/* Counts cover every faculty matching the search, whichever type is chosen */}
              <CountFilterTabs
                label="Employment type"
                layoutId="faculty-schedules-type"
                value={typeTab}
                onChange={key => setF('employment_status', key === 'all' ? '' : key)}
                options={typeTabs}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="min-w-0">
                <p className={FS_LABEL}>Faculty</p>
                <FriendlySelect
                  value={filters.faculty_id}
                  onChange={v => setF('faculty_id', v)}
                  label="Faculty"
                  searchable
                  searchPlaceholder="Type a name…"
                  minPanelWidth={340}
                  options={[
                    { value: '', label: 'All Faculty' },
                    ...filteredFaculty.map(f => ({ value: String(f.id), label: f.name, hint: f.position || f.employment_status })),
                  ]}
                />
              </div>
              <div className="min-w-0">
                <p className={FS_LABEL}>Term</p>
                <div className={FS_READONLY}>
                  <CalendarDays className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
                  <span className="text-[15px] text-[#0B2A5B] font-semibold truncate">
                    {[globalSemester, globalYear].filter(Boolean).join(' · ') || '—'}
                  </span>
                </div>
              </div>
            </div>

            <div className="min-w-0">
              <p className={FS_LABEL}>Search</p>
              <SearchInput
                value={filters.search}
                onChange={v => setF('search', v)}
                placeholder="Search faculty or subject…"
                className="w-full !bg-white border border-[#D6E0EF] hover:border-[#9DB8E8] focus-within:border-[#1D5BD6]"
              />
            </div>
          </div>

          {/* Right — load breakdown donut + legend (printing lives in each instructor's View) */}
          <div className="min-w-0">
            <LoadBreakdownDonut
              title="Load Breakdown"
              slices={[
                { key: 'regular',  label: 'Regular Load', value: summary.totalRegular,  color: 'var(--load-regular)' },
                { key: 'overload', label: 'Overload',     value: summary.totalOverload, color: 'var(--load-overload)' },
                { key: 'praise',   label: 'Praise',       value: summary.totalPraise,   color: 'var(--load-praise)' },
              ]}
              extraRows={[{ label: 'Faculty scheduled', value: summary.totalInstructors }]}
              onSliceClick={key => { if (key in LOAD_META) setLoadPick(key as LoadKey); }}
            />
          </div>
        </div>
      </div>

      {/* ── Instructor Summary Table ── */}
      <div className="bg-white border border-[#E2E8F0] rounded-2xl overflow-hidden shadow-sm w-full min-w-0">

        <div className="px-4 sm:px-6 py-4 border-b border-[#F1F5F9] flex items-center justify-between">
          <p className="text-sm font-semibold" style={{ color: '#0B2A5B' }}>
            {visibleGroups.length} faculty
            {q && <span className="font-normal ml-2" style={{ color: '#64748B' }}>matching &ldquo;{filters.search}&rdquo;</span>}
          </p>
        </div>

        {/* Phone: one card per faculty instead of a sideways-scrolling table */}
        <ul className="md:hidden divide-y divide-[#F1F5F9]">
          {visibleGroups.length === 0 ? (
            <li className="text-center py-16 px-4 text-[15px]" style={{ color: '#94A3B8' }}>No faculty found. Try adjusting your filters.</li>
          ) : visibleGroups.map(group => {
            const isPermanent = group.empStatus === 'Permanent';
            const totalValue = group.rows.reduce((sum, r) => sum + rowValue(r), 0);
            const stats = [
              { label: 'Regular', value: group.rows.filter(r => r.load_category === 'Regular').length },
              { label: 'Overload', value: group.rows.filter(r => r.load_category === 'Overload').length },
              { label: 'Subjects', value: group.rows.length },
              { label: isPermanent ? 'Units' : 'Hours', value: isPermanent ? totalValue.toFixed(2) : totalValue.toFixed(1) },
            ];
            return (
              <li key={`m-${group.facultyId}`}>
                <button
                  type="button"
                  onClick={() => setViewFaculty({ id: group.facultyId, name: group.facultyName, empId: group.empId, position: group.position, empStatus: group.empStatus, rows: group.rows })}
                  className="w-full text-left px-4 py-4 active:bg-[#F1F5F9] transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-[15px] leading-snug break-words" style={{ color: '#0B2A5B' }}>{group.facultyName}</p>
                      <p className="text-[13px] mt-0.5 break-words" style={{ color: '#64748B' }}>{group.position || '—'}</p>
                    </div>
                    <EmploymentBadge status={group.empStatus} className="flex-shrink-0" />
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2">
                    {stats.map(st => (
                      <div key={st.label} className="rounded-lg bg-[#F8FAFC] border border-[#EEF2F8] px-2 py-1.5 text-center min-w-0">
                        <p className="text-[15px] font-bold tabular-nums" style={{ color: '#0B2A5B' }}>{st.value}</p>
                        <p className="text-[11px] font-semibold truncate" style={{ color: '#64748B' }}>{st.label}</p>
                      </div>
                    ))}
                  </div>
                  <span className="mt-3 inline-flex items-center gap-1.5 text-[14px] font-semibold" style={{ color: '#1D5BD6' }}>
                    <Eye className="w-4 h-4" /> View schedule
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-[720px] table-fixed text-sm">
            <thead>
              <tr className="border-b border-[#F1F5F9]" style={{ backgroundColor: '#F8FAFC' }}>
                {SUMMARY_COLS.map(h => (
                  <th
                    key={h}
                    className={`px-4 sm:px-5 py-3.5 text-left text-[11px] font-bold uppercase tracking-wider ${
                      h === 'View' ? 'w-[8rem]' : ''
                    }`}
                    style={{ color: '#64748B' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody className="divide-y divide-[#F1F5F9]">
              {visibleGroups.length === 0 ? (
                <tr>
                  <td colSpan={SUMMARY_COLS.length} className="text-center py-20 text-[15px]" style={{ color: '#94A3B8' }}>
                    No faculty found. Try adjusting your filters.
                  </td>
                </tr>
              ) : (
                visibleGroups.map(group => {
                  const isPermanent = group.empStatus === 'Permanent';
                  const regularCount  = group.rows.filter(r => r.load_category === 'Regular').length;
                  const overloadCount = group.rows.filter(r => r.load_category === 'Overload').length;
                  const totalValue    = group.rows.reduce((sum, r) => sum + rowValue(r), 0);
                  const valueLabel    = isPermanent
                    ? `${totalValue.toFixed(2)} units`
                    : `${totalValue.toFixed(1)} hrs`;

                  return (
                    <tr key={`grp-${group.facultyId}`} className="hover:bg-[#F8FAFC] transition-colors">

                      <td className="px-4 sm:px-5 py-4 min-w-0">
                        <div className="font-semibold text-[14px] leading-snug truncate" style={{ color: '#0B2A5B' }}>{group.facultyName}</div>
                      </td>

                      <td className="px-4 sm:px-5 py-4 text-sm min-w-0" style={{ color: '#64748B' }}>
                        <div className="truncate">{group.position || '—'}</div>
                        <EmploymentBadge status={group.empStatus} className="mt-1" />
                      </td>

                      <td className="px-4 sm:px-5 py-4">
                        <span className="text-base font-semibold" style={{ color: '#0B2A5B' }}>{regularCount}</span>
                      </td>

                      <td className="px-4 sm:px-5 py-4">
                        <span className="text-base font-semibold" style={{ color: '#0B2A5B' }}>{overloadCount}</span>
                      </td>

                      <td className="px-4 sm:px-5 py-4">
                        <span className="text-base font-bold" style={{ color: '#0B2A5B' }}>{group.rows.length}</span>
                      </td>

                      <td className="px-4 sm:px-5 py-4">
                        <span className="text-base font-bold" style={{ color: '#0B2A5B' }}>{valueLabel}</span>
                      </td>

                      <td className="px-4 sm:px-5 py-4">
                        <button
                          onClick={() => setViewFaculty({ id: group.facultyId, name: group.facultyName, empId: group.empId, position: group.position, empStatus: group.empStatus, rows: group.rows })}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-[#EFF6FF] border border-[#BFDBFE] hover:bg-[#DBEAFE] transition-colors"
                          style={{ color: '#1D5BD6' }}
                        >
                          <Eye className="w-4 h-4" />
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      </PageLoadTransition>

      {/* ── Schedule Details Modal ── */}
      {/* Schedule Details — balanced ease: backdrop fades while the panel rises +
          scales in (~0.45s); closing plays the reverse a little quicker (~0.3s). */}
      <AnimatePresence>
      {viewFaculty && (() => {
        const isPerm       = viewFaculty.empStatus === 'Permanent';
        const regularRows  = viewRows.filter(r => r.load_category === 'Regular');
        const overloadRows = viewRows.filter(r => r.load_category === 'Overload');
        const praiseRows   = viewRows.filter(r => r.load_category === 'Praise');
        const totalVal     = viewRows.reduce((s, r) => s + rowValue(r), 0);
        const shownRows    = cardFilter === 'all' ? viewRows : viewRows.filter(r => r.load_category === cardFilter);
        const shownTotal   = shownRows.reduce((s, r) => s + rowValue(r), 0);
        const pickCard = (filter: CardFilter) => setCardPick({
          facultyId: viewFaculty.id,
          // Clicking the chosen card again goes back to every subject
          filter: filter === cardFilter && filter !== 'all' ? 'all' : filter,
        });
        const unitLabel    = isPerm ? 'Total Units' : 'Total Hours';
        const unitColor    = isPerm ? '#059669' : '#1D5BD6';

        const ease = [0.4, 0, 0.2, 1] as const;
        return (
          <motion.div
            key="faculty-schedule-details"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: reduceMotion ? 0 : 0.4, ease } }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.3, ease } }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 sm:p-4"
            data-modal-root
            role="dialog"
            aria-modal="true"
            aria-labelledby="sched-modal-title"
            onClick={() => setViewFaculty(null)}
            // Esc while Remove Subject is asking closes only that question
            onKeyDown={e => { if (e.key === 'Escape' && !removeTarget) setViewFaculty(null); }}
            tabIndex={-1}
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.45, ease, delay: reduceMotion ? 0 : 0.05 } }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.3, ease } }}
              className="bg-white rounded-2xl shadow-2xl w-full sm:w-[85vw] max-w-[1300px] max-h-[92vh] sm:max-h-[85vh] flex flex-col"
              style={{ border: '1px solid #E2E8F0' }}
              onClick={e => e.stopPropagation()}
            >
              {/* ── Modal Header ── */}
              <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-4 border-b border-[#F1F5F9] flex-shrink-0">
                <div className="min-w-0 flex-1 pr-10 sm:pr-0">
                  <p className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#94A3B8' }}>
                    Schedule Details
                  </p>
                  <h2
                    id="sched-modal-title"
                    className="font-bold leading-tight break-words sm:truncate"
                    style={{ color: '#0B2A5B', fontSize: '20px' }}
                  >
                    {viewFaculty.name}
                  </h2>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="text-xs" style={{ color: '#64748B' }}>{viewFaculty.position || '—'}</span>
                    <span aria-hidden="true" style={{ color: '#CBD5E1' }}>·</span>
                    <EmploymentBadge status={viewFaculty.empStatus} />
                  </div>
                </div>
                {/* Quiet header actions: Print menu (Actual Load / Regular / Overload / Praise) · Close */}
                <div className="sm:ml-4 flex items-center gap-2 sm:gap-1 sm:flex-shrink-0">
                  <WorkloadPrintMenu
                    key={`excel-${viewFaculty.id}`}
                    mode="excel"
                    phoneStretch
                    facultyId={viewFaculty.id}
                    semester={globalSemester}
                    academicYear={globalYear}
                  />
                  <WorkloadPrintMenu
                    key={viewFaculty.id}
                    phoneStretch
                    facultyId={viewFaculty.id}
                    semester={globalSemester}
                    academicYear={globalYear}
                  />
                  <span className="hidden sm:block w-px h-5 bg-[#E2E8F0] mx-1" aria-hidden="true" />
                  <motion.button
                    type="button"
                    onClick={() => setViewFaculty(null)}
                    whileHover={reduceMotion ? undefined : { rotate: 90 }}
                    whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                    transition={{ duration: 0.2, ease }}
                    className="absolute top-3 right-3 sm:static p-2 sm:p-1.5 rounded-lg transition-colors hover:bg-[#F1F5F9]"
                    style={{ color: '#64748B' }}
                    aria-label="Close schedule details"
                  >
                    <X className="w-4 h-4" />
                  </motion.button>
                </div>
              </div>

              {/* ── Statistics Grid ── */}
              <div className="px-4 sm:px-6 py-3 border-b border-[#F1F5F9] flex-shrink-0" style={{ backgroundColor: '#F8FAFC' }}>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3">
                  {([
                    { filter: 'all' as const,      label: 'Actual Load',  value: viewRows.length, color: '#0B2A5B' },
                    { filter: 'Regular' as const,  label: 'Regular Load', value: regularRows.length,      color: 'var(--load-regular)' },
                    { filter: 'Overload' as const, label: 'Overload',     value: overloadRows.length,     color: 'var(--load-overload)' },
                    { filter: 'Praise' as const,   label: 'Praise Load',  value: praiseRows.length,       color: 'var(--load-praise)' },
                  ]).map(c => (
                    <FilterCard
                      key={c.filter}
                      label={c.label}
                      value={c.value}
                      color={c.color}
                      active={cardFilter === c.filter}
                      onClick={() => pickCard(c.filter)}
                    />
                  ))}
                  <div className="bg-white border border-[#E2E8F0] rounded-xl px-3 sm:px-4 py-3 flex flex-col shadow-sm min-w-0">
                    <span className="text-[24px] sm:text-[26px] font-bold leading-none tabular-nums" style={{ color: unitColor }}>
                      {totalVal.toFixed(2)}
                    </span>
                    <span className="text-[11px] sm:text-[10px] uppercase tracking-wide sm:tracking-wider font-semibold mt-1.5 leading-tight" style={{ color: '#64748B' }}>
                      {unitLabel}
                    </span>
                  </div>
                </div>
              </div>

              {/* ── Schedule Table ── */}
              <div className="overflow-auto flex-1 min-h-0">
                <table className="w-full border-collapse" style={{ fontSize: '14px' }}>
                  <colgroup>
                    <col style={{ width: '80px',  minWidth: '80px'  }} />
                    <col style={{ width: '120px', minWidth: '110px' }} />
                    <col style={{ width: '130px', minWidth: '130px' }} />
                    <col />
                    <col style={{ width: '80px',  minWidth: '80px'  }} />
                    <col style={{ width: '150px', minWidth: '140px' }} />
                    <col style={{ width: '120px', minWidth: '120px' }} />
                    <col style={{ width: '90px',  minWidth: '90px'  }} />
                    <col style={{ width: '64px',  minWidth: '64px'  }} />
                  </colgroup>
                  <thead className="sticky top-0 z-10">
                    <tr style={{ backgroundColor: '#F8FAFC', borderBottom: '2px solid #E2E8F0' }}>
                      {(['Day', 'Time', 'Subject Code', 'Subject Name', 'Block', 'Room', 'Load Type',
                        isPerm ? 'Units' : 'Hours'] as const).map((h, i) => (
                        <th
                          key={h}
                          className="px-4 py-2.5 whitespace-nowrap"
                          style={{
                            color: '#64748B',
                            fontSize: '11px',
                            fontWeight: 700,
                            textAlign: i === 7 ? 'right' : 'left',
                            letterSpacing: '0.06em',
                            textTransform: 'uppercase',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                      <th className="px-2 py-2.5"><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody key={cardFilter}>
                    {shownRows.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-4 py-10 text-center text-sm" style={{ color: '#94A3B8' }}>
                          No subjects{cardFilter === 'all' ? '' : ` in ${cardFilter === 'Overload' ? 'Overload' : `${cardFilter} Load`}`}.
                        </td>
                      </tr>
                    )}
                    {shownRows.map((row, i) => {
                      const val = rowValue(row);
                      const valColor = LOAD_COLOR[row.load_category] ?? unitColor;
                      return (
                        <motion.tr
                          key={`view-${row.load_id}-${row.subject_code}-${row.load_category}`}
                          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1], delay: reduceMotion ? 0 : Math.min(i, 10) * 0.035 }}
                          className="hover:bg-[#F8FAFC] transition-colors"
                          style={{ borderBottom: '1px solid #F1F5F9' }}
                        >
                          <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: '#64748B' }}>
                            {row.day_pattern || '—'}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: '#64748B' }}>
                            {fmtRange(row.start_time, row.end_time)}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap font-mono font-semibold" style={{ color: '#1D5BD6' }}>
                            {row.subject_code}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: '#0B2A5B' }}>
                            <span
                              className="block leading-snug"
                              style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                              title={row.subject_name}
                            >
                              {row.subject_name}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: '#64748B' }}>
                            {blockCode(row.year_level, row.block_name)}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: '#64748B' }}>
                            {row.room_name ?? (
                              <span className="italic" style={{ color: '#CBD5E1' }}>No room</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <LoadBadge cat={row.load_category} part={row.split_component} />
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap font-semibold text-right" style={{ color: valColor }}>
                            {val.toFixed(2)}
                          </td>
                          <td className="px-2 py-2 text-center">
                            {/* A moved Overload / Praise part is removed with its subject's main row */}
                            {!row.split_portion && (
                              <motion.button
                                type="button"
                                onClick={() => setRemoveTarget(row)}
                                whileHover={reduceMotion ? undefined : { y: -1 }}
                                whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                                transition={{ duration: 0.18, ease }}
                                title="Remove subject"
                                aria-label={`Remove ${row.subject_code} from ${row.faculty_name}`}
                                className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 hover:border-red-300 transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </motion.button>
                            )}
                          </td>
                        </motion.tr>
                      );
                    })}
                  </tbody>
                  {/* Total of the Hours / Units column — pinned so it stays visible while scrolling */}
                  {shownRows.length > 0 && (
                    <tfoot className="sticky bottom-0 z-10">
                      <tr style={{ backgroundColor: '#F4F7FC', borderTop: '2px solid #D6E0EF' }}>
                        <td
                          colSpan={7}
                          className="px-4 py-3 text-right whitespace-nowrap"
                          style={{ color: '#0B2A5B', fontSize: '12px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}
                        >
                          {isPerm ? 'Total Units' : 'Total Hours'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-right tabular-nums" style={{ color: unitColor, fontSize: '15px', fontWeight: 800 }}>
                          {shownTotal.toFixed(2)}
                        </td>
                        <td aria-hidden="true" />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>

              <NonTeachingTime key={`nt-${viewFaculty.id}`} facultyId={viewFaculty.id} semester={globalSemester} academicYear={globalYear} />

              {/* ── Footer ── */}
              <div className="px-6 py-3 border-t border-[#F1F5F9] flex items-center justify-between flex-shrink-0">
                <span className="text-xs" style={{ color: '#94A3B8' }}>
                  {shownRows.length} load{shownRows.length !== 1 ? 's' : ''}
                  {cardFilter === 'all' ? ' total' : ` · ${cardFilter === 'Overload' ? 'Overload' : `${cardFilter} Load`} only`}
                </span>
                <motion.button
                  type="button"
                  onClick={() => setViewFaculty(null)}
                  whileTap={reduceMotion ? undefined : { scale: 0.96 }}
                  className="px-6 py-2 rounded-lg border font-semibold text-sm transition-colors hover:bg-[#F1F5F9]"
                  style={{ color: '#64748B', borderColor: '#E2E8F0' }}
                >
                  Close
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        );
      })()}
      </AnimatePresence>

      {/* ── Remove Subject confirmation (same as Faculty Workload) — outside the
          Schedule Details overlay, so Esc here only closes this ── */}
      {/* ── Print Summary: names in the footer (editable, remembered in this browser) ── */}
      <Modal
        open={!!signers}
        onClose={() => setSigners(null)}
        title="Print Summary"
        subtitle="Check the names at the bottom of the summary, then print."
        icon={Printer}
        size="lg"
        footer={
          <div className="flex gap-3">
            <motion.button
              type="button"
              onClick={() => setSigners(null)}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="flex-1 h-11 border border-[#CBD5E1] text-[#334155] rounded-xl text-[15px] font-semibold hover:bg-[#F8FAFC] transition"
            >
              Cancel
            </motion.button>
            <motion.button
              type="submit"
              form="summary-signers"
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="flex-1 h-11 rounded-xl text-[15px] font-bold bg-[#1D5BD6] hover:bg-[#164BB5] transition inline-flex items-center justify-center gap-2"
              style={{ color: '#FFFFFF' }}
            >
              <Printer className="w-4 h-4" /> Print Summary
            </motion.button>
          </div>
        }
      >
        {signers && (
          <form id="summary-signers" onSubmit={e => { e.preventDefault(); printFromDialog(); }} className="space-y-4">
            {([
              ['preparedBy', 'Prepared by'],
              ['recommending', 'Recommending Approval'],
              ['approved', 'Approved'],
            ] as const).map(([key, label], i) => (
              <motion.fieldset
                key={key}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.3, delay: reduceMotion ? 0 : 0.05 + i * 0.06 } }}
                className="rounded-xl border border-[#E2E8F0] px-4 pb-4 pt-2"
              >
                <legend className="px-1.5 text-sm font-bold text-[#0B2A5B]">{label}</legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[13px] font-semibold text-[#475569]">Name</span>
                    <input
                      value={signers[key].name}
                      onChange={e => setSigners(s => s && { ...s, [key]: { ...s[key], name: e.target.value } })}
                      placeholder="Full name, e.g. JUAN A. DELA CRUZ, Ph.D."
                      className={SIGNER_FIELD}
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="mb-1 block text-[13px] font-semibold text-[#475569]">Position</span>
                    <input
                      value={signers[key].title}
                      onChange={e => setSigners(s => s && { ...s, [key]: { ...s[key], title: e.target.value } })}
                      placeholder="e.g. Campus Director"
                      className={SIGNER_FIELD}
                    />
                  </label>
                </div>
              </motion.fieldset>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] text-[#64748B]">Changes are remembered on this computer and used for Download Excel too.</p>
              {JSON.stringify(signers) !== JSON.stringify(DEFAULT_SUMMARY_SIGNATORIES) && (
                <button
                  type="button"
                  onClick={() => setSigners(DEFAULT_SUMMARY_SIGNATORIES)}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-semibold text-[#1D5BD6] hover:bg-[#EFF6FF] transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Reset to the original names
                </button>
              )}
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={!!removeTarget}
        onClose={() => { if (!removing) setRemoveTarget(null); }}
        title="Remove Subject"
        footer={
          <div className="flex gap-3">
            <motion.button
              type="button"
              onClick={() => setRemoveTarget(null)}
              disabled={removing}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="flex-1 border border-[#E2E8F0] text-[#64748B] py-2.5 rounded-xl text-sm font-semibold hover:bg-[#F8FAFC] transition disabled:opacity-50"
            >
              Cancel
            </motion.button>
            <motion.button
              type="button"
              onClick={confirmRemoveSubject}
              disabled={removing}
              whileTap={reduceMotion ? undefined : { scale: 0.97 }}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold transition disabled:opacity-60 flex items-center justify-center gap-2"
              style={{ backgroundColor: '#DC2626', color: '#ffffff' }}
            >
              {removing
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Removing…</>
                : <><Trash2 className="w-4 h-4" /> Remove Subject</>}
            </motion.button>
          </div>
        }
      >
        {removeTarget && (() => {
          const isPermTarget = removeTarget.employment_status === 'Permanent';
          const total = removeRows.reduce((s, r) => s + rowValue(r), 0);
          const movedPart = removeRows.find(r => r.split_portion);
          return (
            <div className="space-y-4">
              {/* Subject */}
              <div className="bg-[#F8FAFC] border border-[#E2E8F0] rounded-xl px-4 py-3">
                <div className="font-mono font-bold text-sm text-[#0B2A5B] mb-0.5">{removeTarget.subject_code}</div>
                <div className="text-sm text-[#64748B]">{removeTarget.subject_name}</div>
                <div className="flex items-center gap-3 mt-2 text-[11px] text-[#94A3B8] flex-wrap">
                  <span>{removeTarget.program_code} · Block {removeTarget.block_name} · {removeTarget.year_level}</span>
                  {total > 0 && (
                    <span className="font-semibold text-[#0B2A5B]">
                      {total.toFixed(2)} {isPermTarget ? 'units' : 'hrs'}
                    </span>
                  )}
                </div>
              </div>

              {/* What happens */}
              <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-red-700 leading-relaxed">
                  This subject will be <span className="font-bold">permanently removed</span> from {removeTarget.faculty_name}&apos;s workload
                  {movedPart ? `, including its ${movedPart.load_category} part` : ''}.
                  Its day, time and room are cleared, and the subject becomes available for reassignment.
                </div>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* ── Load Breakdown drill-down: faculty who have the clicked load ── */}
      <AnimatePresence>
        {loadPick && (() => {
          const meta = LOAD_META[loadPick];
          const ease = [0.4, 0, 0.2, 1] as const;
          const subjectTotal = pickedFaculty.reduce((s, f) => s + f.rows.length, 0);
          return (
            <motion.div
              key="load-breakdown-faculty"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: reduceMotion ? 0 : 0.35, ease } }}
              exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.25, ease } }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
              data-modal-root
              role="dialog"
              aria-modal="true"
              aria-labelledby="load-pick-title"
              onClick={() => setLoadPick(null)}
              onKeyDown={e => { if (e.key === 'Escape') setLoadPick(null); }}
              tabIndex={-1}
            >
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.4, ease, delay: reduceMotion ? 0 : 0.04 } }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.25, ease } }}
                className="relative bg-white rounded-2xl shadow-2xl w-full max-w-[640px] max-h-[80vh] flex flex-col overflow-hidden border border-[#E2E8F0]"
                onClick={e => e.stopPropagation()}
              >
                <div className="h-1.5 flex-shrink-0" style={{ backgroundColor: meta.color }} />
                {/* Header */}
                <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-[#F1F5F9] flex-shrink-0">
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#1D5BD6]">Load Breakdown</p>
                    <h2 id="load-pick-title" className="mt-1 flex items-center gap-2 text-xl font-bold text-[#0B2A5B]">
                      <span className="w-3.5 h-3.5 rounded-[4px] flex-shrink-0" style={{ backgroundColor: meta.color }} aria-hidden />
                      {meta.label}
                    </h2>
                    <p className="text-sm text-[#64748B] mt-0.5">
                      {pickedFaculty.length} faculty · {subjectTotal} subject{subjectTotal !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLoadPick(null)}
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-[#94A3B8] hover:text-[#0B2A5B] hover:bg-[#F1F5F9] transition-colors"
                    aria-label="Close"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* Faculty list */}
                <div className="flex-1 overflow-y-auto">
                  {pickedFaculty.length === 0 ? (
                    <p className="px-6 py-12 text-center text-sm text-[#94A3B8]">No faculty have {meta.label.toLowerCase()} this term.</p>
                  ) : (
                    <ul className="divide-y divide-[#F1F5F9]">
                      {pickedFaculty.map(({ group, rows: mine, value }, i) => {
                        const isPerm = group.empStatus === 'Permanent';
                        const codes = [...new Set(mine.map(r => r.subject_code))];
                        return (
                          <motion.li
                            key={group.facultyId}
                            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0, transition: { duration: 0.25, ease, delay: reduceMotion ? 0 : Math.min(i, 10) * 0.035 } }}
                            className="px-6 py-3.5 flex items-center gap-4 hover:bg-[#F8FAFC] transition-colors"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-[15px] text-[#0B2A5B] truncate">{group.facultyName}</span>
                                <EmploymentBadge status={group.empStatus} />
                              </div>
                              <div className="text-xs text-[#94A3B8] mt-0.5 truncate">{group.position || '—'}</div>
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {codes.map(code => (
                                  <span key={code} className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-[#F1F5F9] text-[#334155]">{code}</span>
                                ))}
                              </div>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="text-lg font-bold tabular-nums text-[#0B2A5B]">{mine.length}</div>
                              <div className="text-[11px] text-[#64748B]">
                                subject{mine.length !== 1 ? 's' : ''}
                                {value > 0 && ` · ${isPerm ? `${value.toFixed(2)} units` : `${value.toFixed(1)} hrs`}`}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setLoadPick(null);
                                setViewFaculty({ id: group.facultyId, name: group.facultyName, empId: group.empId, position: group.position, empStatus: group.empStatus, rows: group.rows });
                              }}
                              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-sm font-semibold bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D5BD6] hover:bg-[#DBEAFE] transition-colors flex-shrink-0"
                            >
                              <Eye className="w-4 h-4" /> View
                            </button>
                          </motion.li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </motion.div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
