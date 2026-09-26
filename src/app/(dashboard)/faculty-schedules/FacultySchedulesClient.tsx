'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useToast } from '@/client/context/ToastContext';
import { useSchoolYear } from '@/client/context/SchoolYearContext';
import BackButton from '@/client/components/ui/BackButton';
import WatermarkTitle from '@/client/components/ui/WatermarkTitle';
import { CalendarDays, ChevronDown, Eye, Loader2, Printer, X } from 'lucide-react';
import {
  printRegularLoadDocument,
  type PrintDeduction, type PrintFaculty, type PrintPraise, type PrintWorkloadLoad,
} from '@/lib/instructorWorkloadPrintDocument';
import { SearchInput, FilterSelect } from '@/components/ui/SearchFilter';
import LoadBreakdownDonut from '@/client/components/charts/LoadBreakdownDonut';
import { useScrollLock } from '@/client/hooks/useScrollLock';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { EmploymentBadge } from '@/client/components/ui/EmploymentBadge';
import { Skeleton, TableSkeleton } from '@/client/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';

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

/** Read-only term boxes — same 42px, outlined look as the filter selects. */
const FS_READONLY =
  'flex items-center gap-2 h-[42px] bg-[#F4F7FC] border border-[#D6E0EF] rounded-xl px-3 select-none min-w-0';

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

function rowValue(row: FacultyScheduleRow): number {
  if (row.load_category === 'Praise') return 0;
  if (row.employment_status === 'Permanent') {
    const u = (row.units !== null && Number(row.units) > 0) ? Number(row.units) : row.curriculum_units;
    return u ?? 0;
  }
  const h = (row.hours !== null && Number(row.hours) > 0) ? Number(row.hours) : row.total_hours;
  return h ?? 0;
}

/* ── Print menu ─────────────────────────────────────────────────────────── */

type PrintKind = 'regular' | 'overload' | 'praise';
interface WorkloadPrintData {
  faculty: PrintFaculty;
  loads: (PrintWorkloadLoad & { semester?: string; academic_year?: string })[];
  praise: PrintPraise[];
  deductions: PrintDeduction[];
}

/**
 * Print button for the Schedule Details header. On open it fetches the
 * instructor's workload for the term and lets the user pick which official
 * document to print — Regular Load, Overload, or Praise Load — using the same
 * print format (and load selection) as the Faculty Workload page.
 */
function WorkloadPrintMenu({ facultyId, semester, academicYear }: {
  facultyId: number; semester: string; academicYear: string;
}) {
  const reduceMotion = useReducedMotion();
  const ease = [0.4, 0, 0.2, 1] as const;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<WorkloadPrintData | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState('');
  const [printing, setPrinting] = useState<PrintKind | null>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function fetchWorkload() {
    setLoadingData(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (semester) qs.set('semester', semester);
      if (academicYear) qs.set('academic_year', academicYear);
      const res = await fetch(`/api/workload/${facultyId}?${qs}`);
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Unable to load workload.');
      setData({ faculty: d.faculty, loads: d.loads ?? [], praise: d.praise ?? [], deductions: d.deductions ?? [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load workload.');
    } finally {
      setLoadingData(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !data && !loadingData) fetchWorkload();
  }

  // Same load selection as the Faculty Workload page's print
  const isP = data?.faculty.employment_status === 'Permanent';
  const termLoads = (data?.loads ?? []).filter(l =>
    (!semester || !l.semester || l.semester === semester) &&
    (!academicYear || !l.academic_year || l.academic_year === academicYear));
  const regularLoads  = termLoads;
  const overloadLoads = termLoads.filter(l => l.load_category === 'Overload');
  const isSplit = (l: PrintWorkloadLoad) => l.load_category === 'Regular' && (
    isP ? (Number(l.split_overload_units) || 0) > 0.001 : (Number(l.split_overload_hours) || 0) > 0.001);
  const splitLoads    = termLoads.filter(l => isSplit(l) && !l.split_is_praise);
  // Praise: whole subjects + a lone Lec/Lab portion moved to Praise
  const praiseLoads   = termLoads.filter(l => l.load_category === 'Praise' || (isSplit(l) && l.split_is_praise));

  const options: { kind: PrintKind; label: string; count: number; dot: string }[] = [
    { kind: 'regular',  label: 'Regular Load', count: regularLoads.filter(l => l.load_category === 'Regular').length, dot: 'var(--load-regular)' },
    { kind: 'overload', label: 'Overload',     count: overloadLoads.length + splitLoads.length,                        dot: 'var(--load-overload)' },
    { kind: 'praise',   label: 'Praise Load',  count: praiseLoads.length + (data?.praise.length ?? 0),                 dot: 'var(--load-praise)' },
  ];

  async function handlePrint(kind: PrintKind) {
    if (!data) return;
    setPrinting(kind);
    setError('');
    try {
      const result = await printRegularLoadDocument({
        faculty: data.faculty,
        loads: kind === 'overload' ? [...overloadLoads, ...splitLoads]
          : kind === 'praise' ? praiseLoads
          : regularLoads,
        praise: kind === 'praise' ? data.praise : [],
        deductions: kind === 'regular' ? data.deductions : [],
        semester,
        academicYear,
        documentKind: kind,
        printablePath: '/workload/print',
      });
      if (!result.ok) {
        setError('Printing is not supported directly in this browser. Try Chrome or Safari.');
      } else {
        setOpen(false);
      }
    } finally {
      setPrinting(null);
    }
  }

  return (
    <div ref={wrapRef} className="relative" onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}>
      <motion.button
        type="button"
        onClick={toggle}
        whileTap={reduceMotion ? undefined : { scale: 0.95 }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Print workload"
        className={`group inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[13px] font-semibold transition-colors ${
          open ? 'text-[#1D5BD6] bg-[#EFF6FF]' : 'text-[#64748B] hover:text-[#1D5BD6] hover:bg-[#EFF6FF]'
        }`}
      >
        <Printer className="w-4 h-4 transition-transform duration-200 group-hover:-translate-y-px" />
        Print
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.2, ease }} className="inline-flex">
          <ChevronDown className="w-3.5 h-3.5" />
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.2, ease } }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97, transition: { duration: 0.15, ease } }}
            style={{ transformOrigin: 'top right' }}
            className="absolute right-0 top-full mt-2 z-20 w-64 bg-white border border-[#E2E8F0] rounded-xl shadow-[0_16px_40px_-12px_rgba(11,42,91,0.35)] p-1.5"
          >
            <p className="px-2.5 pt-1.5 pb-2 text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">
              Print official form
            </p>
            {loadingData ? (
              <div className="flex items-center gap-2 px-2.5 py-3 text-[13px] text-[#64748B]">
                <Loader2 className="w-4 h-4 animate-spin text-[#1D5BD6]" /> Loading workload…
              </div>
            ) : !data ? (
              <div className="px-2.5 py-2 space-y-2">
                <p className="text-[12px] text-red-700">{error || 'Unable to load workload.'}</p>
                <button type="button" onClick={fetchWorkload} className="text-[12px] font-semibold text-[#1D5BD6] hover:underline">
                  Try again
                </button>
              </div>
            ) : (
              <>
                {options.map((o, i) => {
                  const empty = o.count === 0;
                  return (
                    <motion.button
                      key={o.kind}
                      type="button"
                      role="menuitem"
                      disabled={empty || printing !== null}
                      onClick={() => handlePrint(o.kind)}
                      initial={reduceMotion ? false : { opacity: 0, x: 6 }}
                      animate={{ opacity: 1, x: 0, transition: { duration: reduceMotion ? 0 : 0.2, ease, delay: reduceMotion ? 0 : 0.04 * i } }}
                      className="group w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[13px] transition-colors enabled:hover:bg-[#F4F7FC] disabled:cursor-not-allowed"
                    >
                      <span className="w-2.5 h-2.5 rounded-[3px] flex-shrink-0" style={{ backgroundColor: o.dot, opacity: empty ? 0.35 : 1 }} aria-hidden="true" />
                      <span className={`font-semibold ${empty ? 'text-[#94A3B8]' : 'text-[#0B2A5B]'}`}>{o.label}</span>
                      <span className="ml-auto text-[11px] tabular-nums text-[#94A3B8]">
                        {empty ? 'None' : `${o.count} item${o.count === 1 ? '' : 's'}`}
                      </span>
                      {printing === o.kind
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1D5BD6]" />
                        : <Printer className={`w-3.5 h-3.5 transition-colors ${empty ? 'text-[#CBD5E1]' : 'text-[#94A3B8] group-hover:text-[#1D5BD6]'}`} />}
                    </motion.button>
                  );
                })}
                {error && <p className="px-2.5 pt-1.5 pb-1 text-[12px] text-red-700">{error}</p>}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────────── */

function LoadBadge({ cat }: { cat: string }) {
  const styles: Record<string, string> = {
    Regular:  'bg-[#EFF6FF] text-[#1D5BD6] border border-[#BFDBFE]',
    Overload: 'bg-orange-50 text-orange-700 border border-orange-200',
    Praise:   'bg-yellow-50 text-yellow-800 border border-yellow-300',
  };
  const cls = styles[cat] ?? 'bg-slate-50 text-slate-600 border border-[#E2E8F0]';
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${cls}`}>
      {cat}
    </span>
  );
}


function ModalStat({ label, value, color = '#0B2A5B' }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-white border border-[#E2E8F0] rounded-xl px-4 py-3 flex flex-col shadow-sm">
      <span className="text-[26px] font-bold leading-none tabular-nums" style={{ color }}>{value}</span>
      <span className="text-[10px] uppercase tracking-wider font-semibold mt-1.5" style={{ color: '#94A3B8' }}>{label}</span>
    </div>
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

  const [rows, setRows]               = useState<FacultyScheduleRow[]>([]);
  const [summary, setSummary]         = useState<Summary>({ totalSchedules: 0, totalInstructors: 0, totalRegular: 0, totalOverload: 0, totalPraise: 0 });
  const [facultyList, setFacultyList] = useState<FacultyOption[]>([]);
  const [loading, setLoading]         = useState(true);

  const [viewFaculty, setViewFaculty] = useState<{
    id: number; name: string; empId: string; position: string; empStatus: string; rows: FacultyScheduleRow[];
  } | null>(null);
  useScrollLock(Boolean(viewFaculty));
  const reduceMotion = useReducedMotion();

  const [filters, setFilters] = useState({
    employment_status: '',
    faculty_id: '',
    search: '',
  });

  function setF(key: keyof typeof filters, val: string) {
    setFilters(prev => ({ ...prev, [key]: val }));
  }

  useEffect(() => {
    fetch('/api/faculty')
      .then(r => r.json())
      .then(d => setFacultyList((d.faculty ?? []).map((f: Record<string, unknown>) => ({
        id: f.id, name: f.name, employment_status: f.employment_status, position: f.position ?? '',
      }))));
  }, []);

  useEffect(() => {
    const raw = initialFacultyQuery.trim();
    if (!raw) return;
    if (appliedFacultyQuery.current === raw) return;
    if (facultyList.length === 0) return;

    appliedFacultyQuery.current = raw;
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.error('Invalid instructor.');
      return;
    }
    const match = facultyList.find(f => f.id === id);
    if (!match) {
      toast.error('Instructor not found or is no longer active.');
      return;
    }
    setFilters(prev => ({
      ...prev,
      faculty_id: String(match.id),
      employment_status: match.employment_status,
    }));
  }, [facultyList, initialFacultyQuery, toast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.employment_status) params.set('employment_status', filters.employment_status);
      if (globalSemester)            params.set('semester',          globalSemester);
      if (globalYear)                params.set('academic_year',     globalYear);
      if (filters.faculty_id)        params.set('faculty_id',        filters.faculty_id);

      const res  = await fetch(`/api/faculty-schedules?${params}`);
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? 'Failed to load schedules.'); return; }

      setRows(data.schedules ?? []);
      setSummary(data.summary ?? { totalSchedules: 0, totalInstructors: 0, totalRegular: 0, totalOverload: 0, totalPraise: 0 });
    } catch {
      toast.error('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [filters.employment_status, filters.faculty_id, globalSemester, globalYear, toast]);

  useEffect(() => { load(); }, [load]);

  const filteredFaculty = useMemo(() => {
    const byEmp = filters.employment_status
      ? facultyList.filter(f => f.employment_status === filters.employment_status)
      : facultyList;
    return [...byEmp].sort((a, b) => {
      const ra = POSITION_RANK[a.position] ?? 999;
      const rb = POSITION_RANK[b.position] ?? 999;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
  }, [facultyList, filters.employment_status]);

  useEffect(() => {
    if (filters.faculty_id && !filteredFaculty.some(f => String(f.id) === filters.faculty_id)) {
      setF('faculty_id', '');
    }
  }, [filteredFaculty, filters.faculty_id]);

  const q = filters.search.toLowerCase().trim();

  const groups = useMemo(() => {
    type Group = {
      facultyId: number; facultyName: string; position: string;
      empStatus: string; empId: string; rows: FacultyScheduleRow[];
    };
    const result: Group[] = [];
    for (const row of rows) {
      const last = result[result.length - 1];
      if (!last || last.facultyId !== row.faculty_id) {
        result.push({ facultyId: row.faculty_id, facultyName: row.faculty_name, position: row.position, empStatus: row.employment_status, empId: row.employee_id, rows: [row] });
      } else {
        last.rows.push(row);
      }
    }
    // Permanent block first, then Contractual — never interleaved. Within each
    // block, lowest total load (least complete) first; ties by name.
    const totalOf = (g: Group) => g.rows.reduce((sum, r) => sum + rowValue(r), 0);
    return result.sort((a, b) => {
      const ta = a.empStatus === 'Permanent' ? 0 : 1;
      const tb = b.empStatus === 'Permanent' ? 0 : 1;
      if (ta !== tb) return ta - tb;
      const diff = totalOf(a) - totalOf(b);
      if (Math.abs(diff) > 0.001) return diff;
      return a.facultyName.localeCompare(b.facultyName);
    });
  }, [rows]);

  const visibleGroups = useMemo(() =>
    q
      ? groups.filter(g =>
          g.facultyName.toLowerCase().includes(q) ||
          g.position.toLowerCase().includes(q) ||
          g.empStatus.toLowerCase().includes(q) ||
          g.rows.some(r =>
            r.subject_code.toLowerCase().includes(q) ||
            r.subject_name.toLowerCase().includes(q) ||
            r.block_name.toLowerCase().includes(q) ||
            (r.room_name ?? '').toLowerCase().includes(q)
          )
        )
      : groups,
    [groups, q]
  );

  const SUMMARY_COLS = ['Instructor Name', 'Position', 'Regular', 'Overload', 'Total Subjects', 'Total Units / Hours', 'View'];
  const showPageSkeleton = useMinLoading(loading && rows.length === 0, LOADING_DELAY);

  const pageSkeleton = (
    <div className="space-y-6" role="status" aria-live="polite" aria-label="Loading faculty schedules">
      {/* Title */}
      <div className="space-y-2 min-w-0">
        <Skeleton className="h-8 w-52 sm:w-60 rounded-md" />
        <Skeleton className="h-4 w-full max-w-xl rounded" />
      </div>

      {/* Filters (2×2 + search) left · donut right */}
      <div className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] p-4 sm:p-6 w-full min-w-0">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-6 lg:gap-10 items-start">
          <div className="space-y-3 min-w-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[42px] w-full rounded-xl" />)}
            </div>
            <Skeleton className="h-[42px] w-full max-w-md rounded-full" />
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
          <WatermarkTitle>Faculty Schedules</WatermarkTitle>
        </div>
      </div>

      {/* ── Filters (left) + load breakdown (right) ── */}
      <div className="bg-white rounded-2xl border border-[#E3E9F3] shadow-[0_1px_3px_rgba(11,42,91,0.06)] p-4 sm:p-6 w-full min-w-0">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-6 lg:gap-10 items-start">

          {/* Left — 2×2 filters, search underneath */}
          <div className="space-y-3 min-w-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FilterSelect value={filters.employment_status} onChange={v => setF('employment_status', v)} label="Employment Type" className="qr-ms-field">
                <option value="">All Employment Types</option>
                <option value="Permanent">Permanent</option>
                <option value="Contractual">Contractual</option>
              </FilterSelect>
              <FilterSelect value={filters.faculty_id} onChange={v => setF('faculty_id', v)} label="Instructor" className="qr-ms-field">
                <option value="">All Instructors</option>
                {filteredFaculty.map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </FilterSelect>
              <div className={FS_READONLY} title="Semester (set in Settings)">
                <CalendarDays className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
                <span className="text-sm text-[#0B2A5B] font-semibold truncate">{globalSemester || 'Semester'}</span>
              </div>
              <div className={FS_READONLY} title="School Year (set in Settings)">
                <CalendarDays className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
                <span className="text-sm text-[#0B2A5B] font-semibold truncate">{globalYear || 'School Year'}</span>
              </div>
            </div>
            <SearchInput
              value={filters.search}
              onChange={v => setF('search', v)}
              placeholder="Search instructor or subject…"
              className="w-full sm:max-w-md !bg-white border border-[#D6E0EF] shadow-[0_1px_3px_rgba(11,42,91,0.06)] hover:border-[#9DB8E8] focus-within:border-[#1D5BD6]"
            />
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
              extraRows={[{ label: 'Instructors scheduled', value: summary.totalInstructors }]}
            />
          </div>
        </div>
      </div>

      {/* ── Instructor Summary Table ── */}
      <div className="bg-white border border-[#E2E8F0] rounded-2xl overflow-hidden shadow-sm w-full min-w-0">

        <div className="px-4 sm:px-6 py-4 border-b border-[#F1F5F9] flex items-center justify-between">
          <p className="text-sm font-semibold" style={{ color: '#0B2A5B' }}>
            {visibleGroups.length} instructor{visibleGroups.length !== 1 ? 's' : ''}
            {q && <span className="font-normal ml-2" style={{ color: '#64748B' }}>matching &ldquo;{filters.search}&rdquo;</span>}
          </p>
        </div>

        <div className="overflow-x-auto">
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
                    No instructors found. Try adjusting your filters.
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
                        <div className="text-xs mt-0.5 truncate" style={{ color: '#94A3B8' }}>{group.empId}</div>
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
        const regularRows  = viewFaculty.rows.filter(r => r.load_category === 'Regular');
        const overloadRows = viewFaculty.rows.filter(r => r.load_category === 'Overload');
        const totalVal     = viewFaculty.rows.reduce((s, r) => s + rowValue(r), 0);
        const unitLabel    = isPerm ? 'Total Units' : 'Total Hours';
        const unitColor    = isPerm ? '#059669' : '#1D5BD6';

        const ease = [0.4, 0, 0.2, 1] as const;
        return (
          <motion.div
            key="faculty-schedule-details"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: reduceMotion ? 0 : 0.4, ease } }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.3, ease } }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            data-modal-root
            role="dialog"
            aria-modal="true"
            aria-labelledby="sched-modal-title"
            onClick={() => setViewFaculty(null)}
            onKeyDown={e => { if (e.key === 'Escape') setViewFaculty(null); }}
            tabIndex={-1}
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.45, ease, delay: reduceMotion ? 0 : 0.05 } }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.97, transition: { duration: 0.3, ease } }}
              className="bg-white rounded-2xl shadow-2xl w-[85vw] max-w-[1300px] max-h-[85vh] flex flex-col"
              style={{ border: '1px solid #E2E8F0' }}
              onClick={e => e.stopPropagation()}
            >
              {/* ── Modal Header ── */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-[#F1F5F9] flex-shrink-0">
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#94A3B8' }}>
                    Schedule Details
                  </p>
                  <h2
                    id="sched-modal-title"
                    className="font-bold leading-tight truncate"
                    style={{ color: '#0B2A5B', fontSize: '20px' }}
                  >
                    {viewFaculty.name}
                  </h2>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="text-xs font-mono" style={{ color: '#94A3B8' }}>{viewFaculty.empId}</span>
                    <span aria-hidden="true" style={{ color: '#CBD5E1' }}>·</span>
                    <span className="text-xs" style={{ color: '#64748B' }}>{viewFaculty.position || '—'}</span>
                    <span aria-hidden="true" style={{ color: '#CBD5E1' }}>·</span>
                    <EmploymentBadge status={viewFaculty.empStatus} />
                  </div>
                </div>
                {/* Quiet header actions: Print menu (Regular / Overload / Praise) · Close */}
                <div className="ml-4 flex items-center gap-1 flex-shrink-0">
                  <WorkloadPrintMenu
                    key={viewFaculty.id}
                    facultyId={viewFaculty.id}
                    semester={globalSemester}
                    academicYear={globalYear}
                  />
                  <span className="w-px h-5 bg-[#E2E8F0] mx-1" aria-hidden="true" />
                  <motion.button
                    type="button"
                    onClick={() => setViewFaculty(null)}
                    whileHover={reduceMotion ? undefined : { rotate: 90 }}
                    whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                    transition={{ duration: 0.2, ease }}
                    className="p-1.5 rounded-lg transition-colors hover:bg-[#F1F5F9]"
                    style={{ color: '#94A3B8' }}
                    aria-label="Close schedule details"
                  >
                    <X className="w-4 h-4" />
                  </motion.button>
                </div>
              </div>

              {/* ── Statistics Grid ── */}
              <div className="px-6 py-3 border-b border-[#F1F5F9] flex-shrink-0" style={{ backgroundColor: '#F8FAFC' }}>
                <div className="grid grid-cols-4 gap-3">
                  <ModalStat label="Total Subjects" value={viewFaculty.rows.length} color="#0B2A5B" />
                  <ModalStat label="Regular Load"   value={regularRows.length}      color="#1D5BD6" />
                  <ModalStat label="Overload"        value={overloadRows.length}     color="#D97706" />
                  <div className="bg-white border border-[#E2E8F0] rounded-xl px-4 py-3 flex flex-col shadow-sm">
                    <span className="text-[26px] font-bold leading-none tabular-nums" style={{ color: unitColor }}>
                      {totalVal.toFixed(2)}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider font-semibold mt-1.5" style={{ color: '#94A3B8' }}>
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
                    </tr>
                  </thead>
                  <tbody>
                    {viewFaculty.rows.map(row => {
                      const val = row.load_category === 'Praise' ? null : rowValue(row);
                      return (
                        <tr
                          key={`view-${row.load_id}-${row.subject_code}-${row.load_category}`}
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
                            {row.block_name}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: '#64748B' }}>
                            {row.room_name ?? (
                              <span className="italic" style={{ color: '#CBD5E1' }}>No room</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <LoadBadge cat={row.load_category} />
                          </td>
                          <td className="px-4 py-2.5 whitespace-nowrap font-semibold text-right" style={{ color: val != null ? unitColor : '#94A3B8' }}>
                            {val != null ? val.toFixed(2) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {/* Total of the Hours / Units column — pinned so it stays visible while scrolling */}
                  {viewFaculty.rows.length > 0 && (
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
                          {totalVal.toFixed(2)}
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>

              {/* ── Footer ── */}
              <div className="px-6 py-3 border-t border-[#F1F5F9] flex items-center justify-between flex-shrink-0">
                <span className="text-xs" style={{ color: '#94A3B8' }}>
                  {viewFaculty.rows.length} schedule{viewFaculty.rows.length !== 1 ? 's' : ''} total
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
    </div>
  );
}
