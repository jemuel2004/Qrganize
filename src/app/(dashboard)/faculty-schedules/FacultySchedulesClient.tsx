'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useToast } from '@/client/context/ToastContext';
import { useSchoolYear } from '@/client/context/SchoolYearContext';
import { Eye, X } from 'lucide-react';
import { SearchInput, FilterSelect, SF_DISABLED } from '@/components/ui/SearchFilter';
import { useScrollLock } from '@/client/hooks/useScrollLock';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { CardSkeleton, Skeleton, TableSkeleton } from '@/client/components/ui/skeletons';
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

/* ── Sub-components ─────────────────────────────────────────────────────── */

function LoadBadge({ cat }: { cat: string }) {
  const styles: Record<string, string> = {
    Regular:  'bg-[#EFF6FF] text-[#3C91E6] border border-[#BFDBFE]',
    Overload: 'bg-[#FFFBEB] text-amber-700 border border-[#FDE68A]',
    Praise:   'bg-purple-50 text-purple-700 border border-purple-200',
  };
  const cls = styles[cat] ?? 'bg-slate-50 text-slate-600 border border-[#E2E8F0]';
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${cls}`}>
      {cat}
    </span>
  );
}

function EmpBadge({ status }: { status: string }) {
  if (status === 'Permanent') {
    return (
      <span className="inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-bold whitespace-nowrap bg-slate-100 text-slate-500 border border-slate-300">
        {status}
      </span>
    );
  }
  return (
    <span className="text-[11px] font-normal whitespace-nowrap" style={{ color: '#64748B' }}>
      {status}
    </span>
  );
}

interface CardProps {
  label: string;
  value: number;
}

function SummaryCard({ label, value }: CardProps) {
  return (
    <div className="bg-white border border-[#E2E8F0] rounded-2xl p-4 sm:p-5 shadow-sm w-full min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wide leading-tight" style={{ color: '#64748B' }}>{label}</p>
      <p className="text-2xl font-bold leading-none mt-2" style={{ color: '#1E3A5F' }}>{value}</p>
    </div>
  );
}

function ModalStat({ label, value, color = '#1E3A5F' }: { label: string; value: number; color?: string }) {
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
    name: string; empId: string; position: string; empStatus: string; rows: FacultyScheduleRow[];
  } | null>(null);
  useScrollLock(Boolean(viewFaculty));

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
    return result;
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

      {/* Filters: 4 fields + search */}
      <div className="bg-white rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-4 sm:p-5 space-y-3 w-full min-w-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-1.5 min-w-0">
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="h-[42px] w-full rounded-xl" />
            </div>
          ))}
        </div>
        <Skeleton className="h-[42px] w-full max-w-md rounded-full" />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4 w-full">
        {Array.from({ length: 5 }, (_, i) => (
          <CardSkeleton key={i} className="h-[88px]" />
        ))}
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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: '#1E3A5F' }}>Faculty Schedules</h1>
          <p className="text-sm mt-0.5" style={{ color: '#64748B' }}>
            View all schedules assigned to each instructor — Regular, Overload, and Praise combined.
          </p>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="bg-white rounded-2xl shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-4 sm:p-5 space-y-3 w-full min-w-0">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 items-end">
          <div className="min-w-0 w-full">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Employment Type</label>
            <FilterSelect value={filters.employment_status} onChange={v => setF('employment_status', v)}>
              <option value="">All Employment Types</option>
              <option value="Permanent">Permanent</option>
              <option value="Contractual">Contractual</option>
            </FilterSelect>
          </div>

          <div className="min-w-0 w-full">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Instructor</label>
            <FilterSelect value={filters.faculty_id} onChange={v => setF('faculty_id', v)}>
              <option value="">All Instructors</option>
              {filteredFaculty.map(f => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </FilterSelect>
          </div>

          <div className="min-w-0 w-full">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Semester</label>
            <div className={SF_DISABLED}>{globalSemester || 'From sidebar'}</div>
          </div>

          <div className="min-w-0 w-full">
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">School Year</label>
            <div className={SF_DISABLED}>{globalYear || 'From sidebar'}</div>
          </div>
        </div>

        <SearchInput
          value={filters.search}
          onChange={v => setF('search', v)}
          placeholder="Search instructor or subject…"
          className="w-full max-w-md"
        />
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4 w-full">
        <SummaryCard label="Instructors Scheduled" value={summary.totalInstructors} />
        <SummaryCard label="Regular Load"          value={summary.totalRegular}     />
        <SummaryCard label="Overload"              value={summary.totalOverload}    />
        <SummaryCard label="Praise / Deduction"    value={summary.totalPraise}      />
        <SummaryCard label="Total Subjects"        value={summary.totalSchedules}   />
      </div>

      {/* ── Instructor Summary Table ── */}
      <div className="bg-white border border-[#E2E8F0] rounded-2xl overflow-hidden shadow-sm w-full min-w-0">

        <div className="px-4 sm:px-6 py-4 border-b border-[#F1F5F9] flex items-center justify-between">
          <p className="text-sm font-semibold" style={{ color: '#1E3A5F' }}>
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
                        <div className="font-semibold text-[14px] leading-snug truncate" style={{ color: '#1E3A5F' }}>{group.facultyName}</div>
                        <div className="text-xs mt-0.5 truncate" style={{ color: '#94A3B8' }}>{group.empId}</div>
                      </td>

                      <td className="px-4 sm:px-5 py-4 text-sm truncate" style={{ color: '#64748B' }}>{group.position || '—'}</td>

                      <td className="px-4 sm:px-5 py-4">
                        <span className="text-base font-semibold" style={{ color: '#1E3A5F' }}>{regularCount}</span>
                      </td>

                      <td className="px-4 sm:px-5 py-4">
                        <span className="text-base font-semibold" style={{ color: '#1E3A5F' }}>{overloadCount}</span>
                      </td>

                      <td className="px-4 sm:px-5 py-4">
                        <span className="text-base font-bold" style={{ color: '#1E3A5F' }}>{group.rows.length}</span>
                      </td>

                      <td className="px-4 sm:px-5 py-4">
                        <span className="text-base font-bold" style={{ color: '#1E3A5F' }}>{valueLabel}</span>
                      </td>

                      <td className="px-4 sm:px-5 py-4">
                        <button
                          onClick={() => setViewFaculty({ name: group.facultyName, empId: group.empId, position: group.position, empStatus: group.empStatus, rows: group.rows })}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-[#EFF6FF] border border-[#BFDBFE] hover:bg-[#DBEAFE] transition-colors"
                          style={{ color: '#3C91E6' }}
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
      {viewFaculty && (() => {
        const isPerm       = viewFaculty.empStatus === 'Permanent';
        const regularRows  = viewFaculty.rows.filter(r => r.load_category === 'Regular');
        const overloadRows = viewFaculty.rows.filter(r => r.load_category === 'Overload');
        const totalVal     = viewFaculty.rows.reduce((s, r) => s + rowValue(r), 0);
        const unitLabel    = isPerm ? 'Total Units' : 'Total Hours';
        const unitColor    = isPerm ? '#059669' : '#3C91E6';

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            data-modal-root
            role="dialog"
            aria-modal="true"
            aria-labelledby="sched-modal-title"
            onClick={() => setViewFaculty(null)}
            onKeyDown={e => { if (e.key === 'Escape') setViewFaculty(null); }}
            tabIndex={-1}
          >
            <div
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
                    style={{ color: '#1E3A5F', fontSize: '20px' }}
                  >
                    {viewFaculty.name}
                  </h2>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="text-xs font-mono" style={{ color: '#94A3B8' }}>{viewFaculty.empId}</span>
                    <span aria-hidden="true" style={{ color: '#CBD5E1' }}>·</span>
                    <span className="text-xs" style={{ color: '#64748B' }}>{viewFaculty.position || '—'}</span>
                    <span aria-hidden="true" style={{ color: '#CBD5E1' }}>·</span>
                    <EmpBadge status={viewFaculty.empStatus} />
                  </div>
                </div>
                <button
                  onClick={() => setViewFaculty(null)}
                  className="ml-4 p-1.5 rounded-lg transition-colors hover:bg-[#F1F5F9] flex-shrink-0"
                  style={{ color: '#94A3B8' }}
                  aria-label="Close schedule details"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* ── Statistics Grid ── */}
              <div className="px-6 py-3 border-b border-[#F1F5F9] flex-shrink-0" style={{ backgroundColor: '#F8FAFC' }}>
                <div className="grid grid-cols-4 gap-3">
                  <ModalStat label="Total Subjects" value={viewFaculty.rows.length} color="#1E3A5F" />
                  <ModalStat label="Regular Load"   value={regularRows.length}      color="#3C91E6" />
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
                          <td className="px-4 py-2.5 whitespace-nowrap font-mono font-semibold" style={{ color: '#3C91E6' }}>
                            {row.subject_code}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: '#1E3A5F' }}>
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
                </table>
              </div>

              {/* ── Footer ── */}
              <div className="px-6 py-3 border-t border-[#F1F5F9] flex items-center justify-between flex-shrink-0">
                <span className="text-xs" style={{ color: '#94A3B8' }}>
                  {viewFaculty.rows.length} schedule{viewFaculty.rows.length !== 1 ? 's' : ''} total
                </span>
                <button
                  onClick={() => setViewFaculty(null)}
                  className="px-6 py-2 rounded-lg border font-semibold text-sm transition-colors hover:bg-[#F1F5F9]"
                  style={{ color: '#64748B', borderColor: '#E2E8F0' }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
