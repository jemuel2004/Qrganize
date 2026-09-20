'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useSchoolYear } from '@/client/context/SchoolYearContext';
import {
  CalendarDays, BookOpen, AlertCircle,
  UserCheck, CheckCircle2,
} from 'lucide-react';
import { SearchInput, FilterSelect, FilterBar } from '@/components/ui/SearchFilter';
import { CardSkeleton, Skeleton, TableSkeleton } from '@/client/components/ui/skeletons';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { LOADING_DELAY, PAGE_SKELETON_MIN_MS, useMinLoading } from '@/client/hooks/useMinLoading';
import Link from 'next/link';

const BLOCK_PAGE_EASE = [0.16, 1, 0.3, 1] as const;

/* ── Types ───────────────────────────────────────────────────────── */

interface Program { id: number; code: string; name: string; }

interface Schedule {
  id: number; subject_code: string; subject_name: string;
  lecture_hours: number; laboratory_hours: number; total_hours: number; units: number;
  block_name: string; year_level: string;
  block_semester: string; block_academic_year: string;
  program_code: string; program_name: string; program_id: number;
  faculty_name: string | null; employee_id: string | null; faculty_position: string | null;
  day_pattern: string | null; start_time: string | null; end_time: string | null;
  room_name: string | null; room_type: string | null; status: string;
}

type BlockPage = {
  year_level: string;
  semester: string;
  block_name: string;
  subjects: Schedule[];
};

/* ── Constants ───────────────────────────────────────────────────── */

const YEAR_ORDER  = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
const SEM_ORDER   = ['1st Semester', '2nd Semester', 'Summer'];
const YEAR_LEVELS = YEAR_ORDER;
const STATUSES    = ['Unassigned', 'Assigned', 'Scheduled', 'Completed'];
const COL_HEADERS = [
  'Course Code', 'Subject Name', 'Hrs', 'Units',
  'Instructor', 'Day / Time', 'Room', 'Status', 'Actions',
];


/* ── Status pill — light-theme version of Badge ──────────────────── */

function StatusPill({ status }: { status: string }) {
  const variants: Record<string, { bg: string; text: string; dot: string }> = {
    Unassigned: { bg: 'bg-[#F1F5F9]', text: 'text-[#64748B]', dot: 'bg-[#94A3B8]' },
    Assigned:   { bg: 'bg-[#EFF6FF]', text: 'text-[#2563EB]', dot: 'bg-[#3C91E6]' },
    Scheduled:  { bg: 'bg-[#DCFCE7]', text: 'text-[#16A34A]', dot: 'bg-[#22C55E]' },
    Completed:  { bg: 'bg-[#F5F3FF]', text: 'text-[#7C3AED]', dot: 'bg-[#8B5CF6]' },
  };
  const v = variants[status] ?? variants.Unassigned;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide ${v.bg} ${v.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${v.dot}`} />
      {status}
    </span>
  );
}

/* ── Data grouping ───────────────────────────────────────────────── */

function buildGroups(data: Schedule[]) {
  return YEAR_ORDER
    .filter(y => data.some(s => s.year_level === y))
    .map(year => ({
      year_level: year,
      semesters: SEM_ORDER
        .filter(sem => data.some(s => s.year_level === year && s.block_semester === sem))
        .map(sem => {
          const rows   = data.filter(s => s.year_level === year && s.block_semester === sem);
          const blocks = [...new Set(rows.map(s => s.block_name))].sort();
          return {
            semester: sem,
            blocks: blocks.map(block => ({
              block_name: block,
              subjects: rows
                .filter(s => s.block_name === block)
                .sort((a, b) => a.subject_code.localeCompare(b.subject_code)),
            })),
          };
        }),
    }));
}

/* ── Page component ──────────────────────────────────────────────── */

export default function MasterSchedulePage() {
  const { schoolYear: globalYear, semester: globalSemester } = useSchoolYear();

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [programs,  setPrograms]  = useState<Program[]>([]);
  const [filters,   setFilters]   = useState({
    program_id: '', year_level: '', status: '', search: '',
  });
  const [loading, setLoading] = useState(false);
  const [booting, setBooting] = useState(true);
  const [isChair, setIsChair] = useState(false);
  const [chairProgramId, setChairProgramId] = useState<number | null>(null);
  const [chairNoProgram, setChairNoProgram] = useState(false);
  const [blockPageIndex, setBlockPageIndex] = useState(0);
  const [pageDirection, setPageDirection] = useState(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [meRes, progRes] = await Promise.all([
          fetch('/api/account/me'),
          fetch('/api/programs'),
        ]);
        const meData = await meRes.json().catch(() => ({}));
        const progData = await progRes.json().catch(() => ({}));
        if (cancelled) return;
        setPrograms(progData.programs || []);
        if (meData.user?.role === 'department_chair') {
          setIsChair(true);
          const pid = meData.user.program_id != null ? Number(meData.user.program_id) : null;
          if (pid == null) {
            setChairNoProgram(true);
            setChairProgramId(null);
          } else {
            setChairProgramId(pid);
            setChairNoProgram(false);
            setFilters(f => ({ ...f, program_id: String(pid) }));
          }
        }
      } catch { /* ignore */ }
      finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!filters.program_id) { setSchedules([]); return; }
    setLoading(true);
    const params = new URLSearchParams({ program_id: filters.program_id });
    if (filters.year_level) params.set('year_level',    filters.year_level);
    if (globalSemester)     params.set('semester',      globalSemester);
    if (globalYear)         params.set('academic_year', globalYear);
    if (filters.status)     params.set('status',        filters.status);
    fetch('/api/master-schedule?' + params)
      .then(r => r.json())
      .then(d => { setSchedules(d.schedules || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [filters.program_id, filters.year_level, filters.status, globalSemester, globalYear]);

  function setFilter(key: keyof typeof filters, value: string) {
    if (isChair && key === 'program_id') return;
    if (key === 'program_id') {
      setFilters({ program_id: value, year_level: '', status: '', search: '' });
    } else {
      setFilters(f => ({ ...f, [key]: value }));
    }
  }

  const programSelected = !!filters.program_id;
  const showPageSkeleton = useMinLoading(booting, LOADING_DELAY);
  const showScheduleSkeleton = useMinLoading(
    !showPageSkeleton && loading && programSelected,
    schedules.length === 0 ? PAGE_SKELETON_MIN_MS : 0,
  );
  const lockedProgram = isChair
    ? programs.find(p => p.id === chairProgramId) ?? null
    : null;

  const filtered = schedules.filter(s =>
    !filters.search ||
    s.subject_code.toLowerCase().includes(filters.search.toLowerCase()) ||
    s.subject_name.toLowerCase().includes(filters.search.toLowerCase()) ||
    (s.faculty_name || '').toLowerCase().includes(filters.search.toLowerCase()) ||
    s.block_name.toLowerCase().includes(filters.search.toLowerCase())
  );

  const stats = {
    total:      filtered.length,
    unassigned: filtered.filter(s => s.status === 'Unassigned').length,
    assigned:   filtered.filter(s => s.status === 'Assigned').length,
    scheduled:  filtered.filter(s => s.status === 'Scheduled').length,
  };

  const groups          = buildGroups(filtered);
  const blockPages: BlockPage[] = groups.flatMap(y =>
    y.semesters.flatMap(s =>
      s.blocks.map(b => ({
        year_level: y.year_level,
        semester: s.semester,
        block_name: b.block_name,
        subjects: b.subjects,
      })),
    ),
  );
  const selectedProgram = programs.find(p => String(p.id) === filters.program_id);

  /* Reset to first block page when filters / term / result size change */
  useEffect(() => {
    setPageDirection(0);
    setBlockPageIndex(0);
  }, [
    filters.program_id,
    filters.year_level,
    filters.status,
    filters.search,
    globalSemester,
    globalYear,
  ]);

  useEffect(() => {
    if (blockPages.length === 0) {
      if (blockPageIndex !== 0) setBlockPageIndex(0);
      return;
    }
    if (blockPageIndex > blockPages.length - 1) {
      setBlockPageIndex(blockPages.length - 1);
    }
  }, [blockPages.length, blockPageIndex]);

  const safePageIndex = blockPages.length === 0
    ? 0
    : Math.min(blockPageIndex, blockPages.length - 1);
  const currentBlock = blockPages[safePageIndex] ?? null;
  const totalBlockPages = blockPages.length;

  const blockSlidePx = reduceMotion ? 0 : 14;
  const blockPageTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.22, ease: BLOCK_PAGE_EASE };
  const pageLabelTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.15, ease: BLOCK_PAGE_EASE };

  function goToPrevBlock() {
    if (safePageIndex <= 0) return;
    setPageDirection(-1);
    setBlockPageIndex(i => Math.max(0, i - 1));
  }

  function goToNextBlock() {
    if (safePageIndex >= totalBlockPages - 1) return;
    setPageDirection(1);
    setBlockPageIndex(i => Math.min(totalBlockPages - 1, i + 1));
  }

  const STAT_CARDS = [
    {
      label: 'Total Subjects', value: stats.total,
      Icon: BookOpen,
      iconBg: 'bg-[#EFF6FF]', iconCls: 'text-[#3C91E6]', valueCls: 'text-[#1E3A5F]',
    },
    {
      label: 'Unassigned',     value: stats.unassigned,
      Icon: AlertCircle,
      iconBg: 'bg-[#F8FAFC]', iconCls: 'text-[#94A3B8]', valueCls: 'text-[#64748B]',
    },
    {
      label: 'Assigned',       value: stats.assigned,
      Icon: UserCheck,
      iconBg: 'bg-[#EFF6FF]', iconCls: 'text-[#3C91E6]', valueCls: 'text-[#3C91E6]',
    },
    {
      label: 'Scheduled',      value: stats.scheduled,
      Icon: CheckCircle2,
      iconBg: 'bg-[#DCFCE7]', iconCls: 'text-[#16A34A]', valueCls: 'text-[#16A34A]',
    },
  ];

  const pageSkeleton = (
    <div className="space-y-6" role="status" aria-live="polite" aria-label="Loading master schedule">
      {/* Title + action buttons */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2 min-w-0">
          <Skeleton className="h-8 w-48 sm:w-56 rounded-md" />
          <Skeleton className="h-4 w-72 sm:w-96 max-w-full rounded" />
        </div>
        <div className="flex gap-2.5 flex-shrink-0">
          <Skeleton className="h-10 w-[8.5rem] rounded-xl" />
          <Skeleton className="h-10 w-[9.25rem] rounded-xl" />
        </div>
      </div>

      {/* Filter card: 5 controls + search */}
      <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm px-4 sm:px-5 py-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
          <Skeleton className="h-[42px] w-full rounded-xl xl:col-span-2" />
          <Skeleton className="h-[42px] w-full rounded-xl" />
          <Skeleton className="h-[42px] w-full rounded-xl" />
          <Skeleton className="h-[42px] w-full rounded-xl" />
          <Skeleton className="h-[42px] w-full rounded-xl" />
        </div>
        <Skeleton className="h-[42px] w-full rounded-full" />
      </div>

      {/* Content area */}
      <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm p-4 sm:p-6 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} className="h-[88px]" />)}
        </div>
        <TableSkeleton rows={8} cols={6} />
      </div>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <PageLoadTransition showSkeleton={showPageSkeleton} skeleton={pageSkeleton}>

      {/* ── Page header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#1E3A5F]">Master Schedule</h1>
          <p className="text-[#64748B] text-sm mt-0.5">
            View and manage all subject assignments across blocks
          </p>
        </div>

        <div className="flex gap-2.5 flex-shrink-0">
          <Link
            href="/workload"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-sm"
            style={{ backgroundColor: '#3C91E6', color: '#ffffff' }}
            onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#2E7DD1')}
            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '#3C91E6')}
          >
            Assign Workload
          </Link>
          {/* Green success action */}
          <Link
            href="/scheduling"
            className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-sm"
          >
            Schedule Subjects
          </Link>
        </div>
      </div>

      {/* ── Filter panel ─────────────────────────────────────────── */}
      <FilterBar>
        {chairNoProgram && (
          <div className="mb-3 rounded-xl border border-[#E2E8F0] bg-slate-50 px-4 py-3 text-sm text-slate-600">
            No program is assigned to your Department Chair account. Please contact the administrator.
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">

          {/* Program — locked for Department Chair */}
          {isChair ? (
            <div className="xl:col-span-2 flex items-center gap-2 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5 select-none">
              <span className="text-sm text-slate-600 font-medium truncate">
                {lockedProgram
                  ? `${lockedProgram.code} — ${lockedProgram.name}`
                  : chairNoProgram ? 'No program assigned' : '—'}
              </span>
            </div>
          ) : (
            <FilterSelect
              value={filters.program_id}
              onChange={v => setFilter('program_id', v)}
              className="xl:col-span-2"
              label="Program"
            >
              <option value="">— Select Program —</option>
              {programs.map(p => (
                <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
              ))}
            </FilterSelect>
          )}

          {/* Year Level */}
          <FilterSelect
            value={filters.year_level}
            onChange={v => setFilter('year_level', v)}
            disabled={!programSelected}
            label="Year Level"
          >
            <option value="">All Year Levels</option>
            {YEAR_LEVELS.map(y => <option key={y} value={y}>{y}</option>)}
          </FilterSelect>

          {/* Semester — read-only */}
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5 select-none">
            <CalendarDays className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
            <span className="text-sm text-slate-600 font-medium truncate">{globalSemester || '—'}</span>
          </div>

          {/* Academic Year — read-only */}
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5 select-none">
            <CalendarDays className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
            <span className="text-sm text-slate-600 font-medium truncate">{globalYear || '—'}</span>
          </div>

          {/* Status */}
          <FilterSelect
            value={filters.status}
            onChange={v => setFilter('status', v)}
            disabled={!programSelected}
            label="Status"
          >
            <option value="">All Statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </FilterSelect>

        </div>

        {/* Search bar */}
        <SearchInput
          value={filters.search}
          onChange={v => setFilter('search', v)}
          placeholder="Search by subject code, name, instructor, or block…"
          disabled={!programSelected}
          className="mt-3"
        />
      </FilterBar>

      {/* ── Empty state ───────────────────────────────────────────── */}
      {!programSelected && (
        <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm py-14 text-center">
          <p className="text-sm text-[#64748B]">No schedule records found.</p>
        </div>
      )}

      {/* ── Loading / schedule content ───────────────────────────── */}
      {programSelected && (
        <PageLoadTransition
          showSkeleton={showScheduleSkeleton}
          skeleton={
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {Array.from({ length: 4 }, (_, i) => <CardSkeleton key={i} className="h-[88px]" />)}
              </div>
              <TableSkeleton rows={8} cols={6} />
            </div>
          }
        >
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
            {STAT_CARDS.map(({ label, value, Icon, iconBg, iconCls, valueCls }) => (
              <div
                key={label}
                className="bg-white rounded-xl border border-[#E2E8F0] p-5 hover:border-[#BFDBFE] transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className={`text-3xl font-bold ${valueCls}`}>{value}</div>
                    <div className="text-sm font-medium text-[#64748B] mt-1">{label}</div>
                  </div>
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${iconBg}`}>
                    <Icon className={`w-5 h-5 ${iconCls}`} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* No results */}
          {filtered.length === 0 && (
            <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm py-12 text-center">
              <p className="text-sm text-[#64748B]">No subjects found.</p>
            </div>
          )}

          {/* Single block page */}
          {currentBlock && (
            <div className="mb-4 min-w-0">
              {/* Animated block header + schedule only — pager stays stable below */}
              <div className="min-w-0 overflow-x-hidden">
                <AnimatePresence mode="wait" initial={false} custom={pageDirection}>
                  <motion.div
                    key={`${currentBlock.year_level}|${currentBlock.semester}|${currentBlock.block_name}`}
                    custom={pageDirection}
                    initial={
                      reduceMotion
                        ? false
                        : { opacity: 0, x: pageDirection * blockSlidePx }
                    }
                    animate={{ opacity: 1, x: 0 }}
                    exit={
                      reduceMotion
                        ? undefined
                        : { opacity: 0, x: pageDirection * -blockSlidePx }
                    }
                    transition={blockPageTransition}
                    className="min-w-0"
                  >
                    {/* Year + Block header */}
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3 mb-4 min-w-0">
                      <div className="min-w-0">
                        <h2 className="text-base sm:text-lg font-bold text-[#1E3A5F] truncate">
                          {currentBlock.year_level} — Block {currentBlock.block_name}
                        </h2>
                        <p className="text-sm text-[#64748B] mt-0.5 truncate">
                          {currentBlock.semester}
                          <span className="text-[#94A3B8]">
                            {' · '}
                            {currentBlock.subjects.length} subject{currentBlock.subjects.length !== 1 ? 's' : ''}
                          </span>
                        </p>
                      </div>
                      <span className="inline-flex self-start items-center px-3 py-1.5 rounded-lg bg-[#EFF6FF] text-[#3C91E6] border border-[#BFDBFE] text-sm font-bold uppercase tracking-wide flex-shrink-0">
                        Block {currentBlock.block_name}
                      </span>
                    </div>

                    {/* Subject table */}
                    <div className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                              {COL_HEADERS.map(h => (
                                <th
                                  key={h}
                                  className="text-left px-4 py-3 text-[10px] font-bold text-[#64748B] uppercase tracking-wider whitespace-nowrap"
                                >
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#F1F5F9]">
                            {currentBlock.subjects.map((s) => (
                              <tr
                                key={s.id}
                                className="transition-colors hover:bg-[#F8FAFC] bg-white"
                              >
                                <td className="px-4 py-3.5 font-mono font-bold text-[#1E3A5F] whitespace-nowrap">
                                  {s.subject_code}
                                </td>
                                <td className="px-4 py-3.5 max-w-[200px]">
                                  <span className="line-clamp-2 leading-snug text-[#334155]">
                                    {s.subject_name}
                                  </span>
                                </td>
                                <td className="px-4 py-3.5 text-center text-[#64748B] font-medium whitespace-nowrap">
                                  {parseFloat(String(s.total_hours)).toFixed(1)}
                                </td>
                                <td className="px-4 py-3.5 text-center font-bold text-[#3C91E6] whitespace-nowrap">
                                  {parseFloat(String(s.units)).toFixed(2)}
                                </td>
                                <td className="px-4 py-3.5 whitespace-nowrap">
                                  {s.faculty_name
                                    ? <span className="text-[#334155] font-medium">{s.faculty_name}</span>
                                    : <span className="text-[#94A3B8] italic text-xs">No instructor</span>}
                                </td>
                                <td className="px-4 py-3.5 whitespace-nowrap">
                                  {s.day_pattern
                                    ? (
                                      <span className="text-[#334155] font-medium">
                                        {s.day_pattern}{' '}
                                        {s.start_time?.slice(0, 5)}
                                        {s.end_time ? `–${s.end_time.slice(0, 5)}` : ''}
                                      </span>
                                    )
                                    : <span className="text-[#94A3B8] italic text-xs">Not scheduled</span>}
                                </td>
                                <td className="px-4 py-3.5 whitespace-nowrap">
                                  {s.room_name
                                    ? <span className="text-[#334155] font-medium">{s.room_name}</span>
                                    : <span className="text-[#94A3B8] italic text-xs">No room</span>}
                                </td>
                                <td className="px-4 py-3.5 whitespace-nowrap">
                                  <StatusPill status={s.status} />
                                </td>
                                <td className="px-4 py-3.5 whitespace-nowrap">
                                  <div className="flex gap-1.5">
                                    {s.status === 'Unassigned' && (
                                      <Link
                                        href={`/workload?assign=${s.id}`}
                                        className="px-3 py-1.5 text-xs bg-[#EFF6FF] text-[#3C91E6] border border-[#BFDBFE] rounded-lg hover:bg-[#DBEAFE] font-semibold transition-colors"
                                      >
                                        Assign
                                      </Link>
                                    )}
                                    {s.status === 'Assigned' && (
                                      <Link
                                        href={`/scheduling?ms=${s.id}`}
                                        className="px-3 py-1.5 text-xs bg-[#DCFCE7] text-[#16A34A] border border-[#BBF7D0] rounded-lg hover:bg-[#BBF7D0] font-semibold transition-colors"
                                      >
                                        Schedule
                                      </Link>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* Block pagination — stable while content transitions */}
              {totalBlockPages >= 1 && (
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between min-w-0">
                  <div className="text-sm text-[#64748B] min-w-0 order-2 sm:order-1 overflow-hidden">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.p
                        key={`${currentBlock.year_level}|${currentBlock.block_name}`}
                        initial={reduceMotion ? false : { opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduceMotion ? undefined : { opacity: 0, y: -4 }}
                        transition={pageLabelTransition}
                        className="font-medium text-[#1E3A5F] truncate"
                      >
                        {currentBlock.year_level} — Block {currentBlock.block_name}
                      </motion.p>
                    </AnimatePresence>
                  </div>
                  <div className="flex items-center justify-between sm:justify-end gap-2 flex-wrap order-1 sm:order-2">
                    <button
                      type="button"
                      onClick={goToPrevBlock}
                      disabled={safePageIndex === 0}
                      className="inline-flex items-center justify-center min-h-10 px-3.5 rounded-xl border border-[#E2E8F0] bg-white text-sm font-semibold text-[#64748B] hover:bg-[#F8FAFC] hover:border-[#CBD5E1] active:scale-[0.97] active:bg-[#F1F5F9] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 transition-[background-color,border-color,transform,opacity] duration-150 ease-out"
                    >
                      Previous
                    </button>
                    <div className="relative min-w-[7.5rem] text-center overflow-hidden">
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.span
                          key={safePageIndex}
                          initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
                          transition={pageLabelTransition}
                          className="inline-block text-sm font-medium text-[#1E3A5F] tabular-nums px-1 whitespace-nowrap"
                        >
                          Page {safePageIndex + 1} of {totalBlockPages}
                        </motion.span>
                      </AnimatePresence>
                    </div>
                    <button
                      type="button"
                      onClick={goToNextBlock}
                      disabled={safePageIndex >= totalBlockPages - 1}
                      className="inline-flex items-center justify-center min-h-10 px-3.5 rounded-xl border border-[#E2E8F0] bg-white text-sm font-semibold text-[#64748B] hover:bg-[#F8FAFC] hover:border-[#CBD5E1] active:scale-[0.97] active:bg-[#F1F5F9] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 transition-[background-color,border-color,transform,opacity] duration-150 ease-out"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Footer count */}
          {filtered.length > 0 && (
            <p className="text-sm text-[#94A3B8] text-right mt-2 pb-2">
              {filtered.length} subject{filtered.length !== 1 ? 's' : ''} · {selectedProgram?.code}
            </p>
          )}
        </>
        </PageLoadTransition>
      )}

      </PageLoadTransition>
    </div>
  );
}
