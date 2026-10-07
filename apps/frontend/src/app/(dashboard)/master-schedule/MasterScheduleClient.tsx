'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useRealtime } from '@/context/RealtimeContext';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { CalendarDays } from 'lucide-react';
import { SearchInput, FilterBar } from '@/components/ui/SearchFilter';
import FriendlySelect from '@/components/ui/FriendlySelect';
import CountFilterTabs, { type CountFilterOption } from '@/components/ui/CountFilterTabs';
import { Skeleton, TableSkeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { LOADING_DELAY, PAGE_SKELETON_MIN_MS, useMinLoading } from '@/hooks/useMinLoading';
import Link from 'next/link';
import { isScopedChairRole } from '@/lib/roleAccess';
import SubjectFacultyPreview from '@/components/SubjectFacultyPreview';
import { blockCode, isBlockQuery, matchesBlockQuery, programShortCode, squashSearch } from '@shared/blockCode';
import { useLivePrograms } from '@/hooks/useLivePrograms';

const BLOCK_PAGE_EASE = [0.16, 1, 0.3, 1] as const;

/* ── Types ───────────────────────────────────────────────────────── */

interface Program { id: number; code: string; name: string; }

interface Schedule {
  id: number; subject_code: string; subject_name: string;
  lecture_hours: number; laboratory_hours: number; total_hours: number; units: number;
  block_id: number; block_name: string; year_level: string;
  block_semester: string; block_academic_year: string;
  program_code: string; program_name: string; program_id: number;
  faculty_id: number | null; faculty_name: string | null; employee_id: string | null; faculty_position: string | null;
  day_pattern: string | null; start_time: string | null; end_time: string | null;
  room_name: string | null; room_type: string | null; status: string;
}

type BlockPage = {
  /** Unique per block (same-named blocks of different programs stay apart) */
  key: string;
  program_code: string;
  year_level: string;
  semester: string;
  block_name: string;
  subjects: Schedule[];
};

/** Program filter value for every program in the term */
const ALL_PROGRAMS = 'all';

/* ── Constants ───────────────────────────────────────────────────── */

const YEAR_ORDER  = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
const SEM_ORDER   = ['1st Semester', '2nd Semester', 'Summer'];
const YEAR_LEVELS = YEAR_ORDER;
const STATUSES    = ['Unassigned', 'Assigned', 'Scheduled', 'Completed'];

type StatusTab = 'all' | 'Unassigned' | 'Assigned' | 'Scheduled' | 'Completed';

/* Field label + read-only box — same height as the dropdowns beside them */
const MS_LABEL = 'text-xs font-semibold uppercase tracking-wide text-[#475569] mb-1.5';
const MS_READONLY =
  'flex items-center gap-2 min-h-[48px] bg-[#F4F7FC] border border-[#D6E0EF] rounded-xl px-3.5 select-none';
const COL_HEADERS = [
  'Course Code', 'Subject Name', 'Hrs', 'Units',
  'Faculty', 'Day / Time', 'Room', 'Status', 'Actions',
];


/* ── Status pill — light-theme version of Badge ──────────────────── */

function StatusPill({ status, delay = 0 }: { status: string; delay?: number }) {
  const variants: Record<string, { bg: string; text: string; dot: string }> = {
    Unassigned: { bg: 'bg-red-50 border border-red-200', text: 'text-red-600', dot: 'bg-red-500' },
    Assigned:   { bg: 'bg-[#EFF6FF]', text: 'text-[#164BB5]', dot: 'bg-[#1D5BD6]' },
    Scheduled:  { bg: 'bg-[#DCFCE7]', text: 'text-[#16A34A]', dot: 'bg-[#22C55E]' },
    Completed:  { bg: 'bg-[#F5F3FF]', text: 'text-[#7C3AED]', dot: 'bg-[#8B5CF6]' },
  };
  const v = variants[status] ?? variants.Unassigned;
  const attention = status === 'Unassigned';
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide ${v.bg} ${v.text} ${attention ? 'qr-unassigned-pill' : ''}`}
      style={attention ? { animationDelay: `${delay}s` } : undefined}
    >
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${v.dot} ${attention ? 'qr-pulse-dot' : ''}`} />
      {status}
    </span>
  );
}

/** A subject with no faculty is Unassigned whatever status it was left with
 *  (same rule the server used for the Unassigned filter). */
function statusOf(s: Schedule): string {
  return s.faculty_id ? s.status : 'Unassigned';
}

/* ── Search ──────────────────────────────────────────────────────── */

const escapeRegExp = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How well a subject matches the search — 0 = not at all. Case, spaces and
 * dashes don't matter ("it11" finds IT 111, "path fit" finds PATH-FIT). Best
 * first: the course code itself, a code that starts with it, a word of the
 * subject name, then the text anywhere in the code or name, the faculty, the
 * block and (all programs) a program typed in full ("BSIT").
 */
function matchScore(s: Schedule, query: string, withProgram: boolean): number {
  const q = query.trim().toLowerCase();
  const sq = squashSearch(q);
  if (!sq) return 1;
  const base = baseScore(s, q, sq, withProgram);
  // "it" also names BSIT ("cs" BSCS…): that program's matches come first among equals
  return base > 10 && squashSearch(programShortCode(s.program_code)).startsWith(sq) ? base + 5 : base;
}

function baseScore(s: Schedule, q: string, sq: string, withProgram: boolean): number {
  const code = squashSearch(s.subject_code);
  const name = s.subject_name.toLowerCase();
  if (code === sq) return 100;
  if (code.startsWith(sq)) return 90;
  if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(q)}`).test(name)) return 70;
  if (code.includes(sq)) return 60;
  if (name.includes(q) || squashSearch(name).includes(sq)) return 50;
  if ((s.faculty_name || '').toLowerCase().includes(q)) return 40;
  if (blockCode(s.year_level, s.block_name).toLowerCase().includes(q)
    || `${s.year_level} block ${s.block_name}`.toLowerCase().includes(q)) return 30;
  // The whole program code ("BSIT") lists that program; "it" alone doesn't pull in every BSIT subject
  if (withProgram && squashSearch(s.program_code) === sq) return 10;
  return 0;
}

/* ── Data grouping ───────────────────────────────────────────────── */

/**
 * One page per block — by program, then year, semester and block name. While
 * searching (`scores`), the blocks with the best matches come first and each
 * block lists its best matches first.
 */
function buildBlockPages(data: Schedule[], scores?: Map<Schedule, number>): BlockPage[] {
  const byBlock = new Map<number, Schedule[]>();
  for (const s of data) byBlock.set(s.block_id, [...(byBlock.get(s.block_id) ?? []), s]);
  const rank = (order: string[], v: string) => { const i = order.indexOf(v); return i < 0 ? order.length : i; };
  const score = (s: Schedule) => scores?.get(s) ?? 0;
  const best = (rows: Schedule[]) => rows.reduce((m, s) => Math.max(m, score(s)), 0);
  return [...byBlock.entries()]
    .map(([blockId, rows]) => ({
      key: String(blockId),
      program_code: rows[0].program_code,
      year_level: rows[0].year_level,
      semester: rows[0].block_semester,
      block_name: rows[0].block_name,
      subjects: [...rows].sort((a, b) => score(b) - score(a) || a.subject_code.localeCompare(b.subject_code)),
    }))
    .sort((a, b) =>
      best(b.subjects) - best(a.subjects)
      || a.program_code.localeCompare(b.program_code)
      || rank(YEAR_ORDER, a.year_level) - rank(YEAR_ORDER, b.year_level)
      || rank(SEM_ORDER, a.semester) - rank(SEM_ORDER, b.semester)
      || a.block_name.localeCompare(b.block_name));
}

/** "BSCS · 1st Year — Block A" (program shown when every program is listed) */
const blockTitle = (b: BlockPage, withProgram: boolean) =>
  `${withProgram ? `${b.program_code} · ` : ''}${b.year_level} — Block ${b.block_name}`;

/* ── Block subject table (shared between paged and all-years views) ─ */

function BlockTable({ block, onOpenSubject, withProgram = false }: {
  block: BlockPage; onOpenSubject: (s: Schedule) => void; withProgram?: boolean;
}) {
  return (
    <>
      {/* Year + Block header */}
      <div className="mb-4 min-w-0">
        <h2 className="text-base sm:text-lg font-bold text-[#0B2A5B] truncate">
          {blockTitle(block, withProgram)}
        </h2>
        <p className="text-sm text-[#64748B] mt-0.5 truncate">
          {block.semester}
          <span className="text-[#94A3B8]">
            {' · '}
            {block.subjects.length} subject{block.subjects.length !== 1 ? 's' : ''}
          </span>
        </p>
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
              {block.subjects.map((s, i) => {
                // Stagger the attention animations so rows take turns
                const delay = (i % 8) * 0.45;
                const status = statusOf(s);
                return (
                // The whole row opens the subject's faculty pop-up
                <tr
                  key={s.id}
                  onClick={() => onOpenSubject(s)}
                  className="group cursor-pointer bg-white transition-colors duration-150 hover:bg-[#F5F9FF] active:bg-[#EAF1FC]"
                >
                  <td className="px-4 py-3.5 font-mono font-bold text-[#0B2A5B] whitespace-nowrap">
                    {s.subject_code}
                  </td>
                  <td className="px-4 py-3.5 max-w-[200px]">
                    {/* Keyboard way in — Enter / Space opens the same pop-up */}
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); onOpenSubject(s); }}
                      title="See the faculty handling this subject"
                      className="text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1D5BD6]/40"
                    >
                      <span className="line-clamp-2 leading-snug font-medium text-[#334155] group-hover:text-[#1D5BD6] transition-colors duration-150">
                        {s.subject_name}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3.5 text-center text-[#64748B] font-medium whitespace-nowrap">
                    {parseFloat(String(s.total_hours)).toFixed(1)}
                  </td>
                  <td className="px-4 py-3.5 text-center font-bold text-[#1D5BD6] whitespace-nowrap">
                    {parseFloat(String(s.units)).toFixed(2)}
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap">
                    {s.faculty_name
                      ? <span className="text-[#334155] font-medium">{s.faculty_name}</span>
                      : <span className="text-[#94A3B8] italic text-xs">No faculty</span>}
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
                    <StatusPill status={status} delay={delay} />
                  </td>
                  <td className="px-4 py-3.5 whitespace-nowrap">
                    <div className="flex gap-1.5">
                      {status === 'Unassigned' && (
                        <Link
                          href={`/workload?assign=${s.id}&block=${s.block_id}`}
                          onClick={e => e.stopPropagation()}
                          className="qr-assign-btn px-3 py-1.5 text-xs rounded-lg font-semibold"
                          style={{ animationDelay: `${delay}s, ${delay}s` }}
                        >
                          Assign
                        </Link>
                      )}
                      {status === 'Assigned' && (
                        <Link
                          // Instructor is already known — skip Position/Faculty and open this class.
                          href={s.faculty_id
                            ? `/scheduling?step=schedule&faculty=${s.faculty_id}&ms=${s.id}`
                            : `/scheduling?ms=${s.id}`}
                          onClick={e => e.stopPropagation()}
                          className="px-3 py-1.5 text-xs bg-[#DCFCE7] text-[#16A34A] border border-[#BBF7D0] rounded-lg hover:bg-[#BBF7D0] font-semibold transition-colors"
                        >
                          Schedule
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ── Page component ──────────────────────────────────────────────── */

export default function MasterSchedulePage() {
  const searchParams = useSearchParams();
  const { schoolYear: globalYear, semester: globalSemester } = useSchoolYear();

  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [programs,  setPrograms]  = useState<Program[]>([]);
  useLivePrograms(setPrograms);
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
  /* Subject clicked in a block table — its faculty pop-up (SubjectFacultyPreview) */
  const [subjectPreview, setSubjectPreview] = useState<Schedule | null>(null);
  const closeSubjectPreview = useCallback(() => setSubjectPreview(null), []);

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

        const paramProgramId = searchParams.get('program_id');
        const paramStatus = searchParams.get('status');

        if (isScopedChairRole(meData.user?.role)) {
          setIsChair(true);
          const pid = meData.user.program_id != null ? Number(meData.user.program_id) : null;
          if (pid == null) {
            setChairNoProgram(true);
            setChairProgramId(null);
          } else {
            setChairProgramId(pid);
            setChairNoProgram(false);
            setFilters(f => ({
              ...f,
              program_id: String(pid),
              status: paramStatus && STATUSES.includes(paramStatus) ? paramStatus : f.status,
            }));
          }
        } else if (paramProgramId || (paramStatus && STATUSES.includes(paramStatus))) {
          // A status link without a program (e.g. the Dashboard's "Unassigned Subjects")
          // counts every program, so it opens on All Programs
          setFilters(f => ({
            ...f,
            program_id: paramProgramId || ALL_PROGRAMS,
            status: paramStatus && STATUSES.includes(paramStatus) ? paramStatus : f.status,
          }));
        }
      } catch { /* ignore */ }
      finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read initial query params once on mount only
  }, []);

  /** Query of the list on screen — a late answer for older filters is dropped.
   *  Every status is loaded; the Status filter is applied on the page, so the
   *  Unassigned / Assigned counts always cover the whole list. */
  const listQuery = useRef('');
  useEffect(() => {
    if (!filters.program_id) { listQuery.current = ''; setSchedules([]); return; }
    setLoading(true);
    const params = new URLSearchParams(
      filters.program_id === ALL_PROGRAMS ? { all_programs: '1' } : { program_id: filters.program_id },
    );
    if (filters.year_level) params.set('year_level',    filters.year_level);
    if (globalSemester)     params.set('semester',      globalSemester);
    if (globalYear)         params.set('academic_year', globalYear);
    const query = params.toString();
    listQuery.current = query;
    fetch('/api/master-schedule?' + query)
      .then(r => r.json())
      .then(d => { if (listQuery.current !== query) return; setSchedules(d.schedules || []); setLoading(false); })
      .catch(() => { if (listQuery.current === query) setLoading(false); });
  }, [filters.program_id, filters.year_level, globalSemester, globalYear]);

  // Live updates: assignments, schedules, blocks or rooms changed elsewhere —
  // the list reloads quietly; filters, search and the block page stay.
  useRealtime(['schedule', 'workload', 'blocks', 'rooms'], () => {
    const query = listQuery.current;
    if (!query) return;
    return fetch('/api/master-schedule?' + query)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && listQuery.current === query && Array.isArray(d.schedules)) setSchedules(d.schedules); })
      .catch(() => {});
  }, { enabled: !loading && !booting });

  function setFilter(key: keyof typeof filters, value: string) {
    if (isChair && key === 'program_id') return;
    if (key === 'program_id') {
      setFilters({ program_id: value, year_level: '', status: '', search: '' });
    } else {
      setFilters(f => ({ ...f, [key]: value }));
    }
  }

  const programSelected = !!filters.program_id;
  const isAllPrograms = filters.program_id === ALL_PROGRAMS;
  const showPageSkeleton = useMinLoading(booting, LOADING_DELAY);
  const showScheduleSkeleton = useMinLoading(
    !showPageSkeleton && loading && programSelected,
    PAGE_SKELETON_MIN_MS,
  );
  const lockedProgram = isChair
    ? programs.find(p => p.id === chairProgramId) ?? null
    : null;

  /* A search that names a block ("2D", "BSIT 2D", "2nd Year Block D") shows
     only that block — not subjects that merely contain the text ("Animation
     2D/3D"). Anything else matches subject, faculty, block or program. */
  const query = filters.search.trim();
  const blockSearch = isBlockQuery(query);
  /* Searched over every subject of the term before the block pages are made,
     so a match on any page shows — and the best matches come first. */
  const scores = new Map<Schedule, number>();
  for (const s of schedules) {
    const score = !query ? 1
      : blockSearch
        ? (matchesBlockQuery(query, s.program_code, s.year_level, s.block_name) || squashSearch(s.subject_code) === squashSearch(query) ? 100 : 0)
        : matchScore(s, query, isAllPrograms);
    if (score > 0) scores.set(s, score);
  }
  const searched = schedules.filter(s => scores.has(s));
  /* Status narrows only the list below — the count tiles keep counting every
     status, so choosing Unassigned never turns Assigned into 0 (and back). */
  const filtered = filters.status
    ? searched.filter(s => statusOf(s) === filters.status)
    : searched;

  const stats = {
    total:      searched.length,
    unassigned: searched.filter(s => statusOf(s) === 'Unassigned').length,
    assigned:   searched.filter(s => statusOf(s) === 'Assigned').length,
    scheduled:  searched.filter(s => statusOf(s) === 'Scheduled').length,
    completed:  searched.filter(s => statusOf(s) === 'Completed').length,
  };

  const blockPages = buildBlockPages(filtered, query ? scores : undefined);
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

  /* The pager sits under the block's table — after a page change, bring the new
     block's heading back into view if the page had scrolled past it */
  const blockTopRef = useRef<HTMLDivElement>(null);
  function revealBlockTop() {
    requestAnimationFrame(() => {
      const el = blockTopRef.current;
      if (el && el.getBoundingClientRect().top < 80) el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    });
  }

  function goToPrevBlock() {
    if (safePageIndex <= 0) return;
    setPageDirection(-1);
    setBlockPageIndex(i => Math.max(0, i - 1));
    revealBlockTop();
  }

  function goToNextBlock() {
    if (safePageIndex >= totalBlockPages - 1) return;
    setPageDirection(1);
    setBlockPageIndex(i => Math.min(totalBlockPages - 1, i + 1));
    revealBlockTop();
  }

  /** "Go to block" list — jump straight to any block (slides the way it lies) */
  function goToBlock(key: string) {
    const to = blockPages.findIndex(b => b.key === key);
    if (to < 0 || to === safePageIndex) return;
    setPageDirection(to > safePageIndex ? 1 : -1);
    setBlockPageIndex(to);
    revealBlockTop();
  }

  /* Status buttons — same colours as the status pills in the table:
     red = still needs a faculty member, blue = assigned (to schedule), green = scheduled */
  const statusTab = (filters.status || 'all') as StatusTab;
  const statusTabs: CountFilterOption<StatusTab>[] = [
    { key: 'all',        label: 'All',        count: stats.total,      color: '#0B2A5B' },
    { key: 'Unassigned', label: 'Unassigned', count: stats.unassigned, color: '#B91C1C', dot: '#DC2626' },
    { key: 'Assigned',   label: 'Assigned',   count: stats.assigned,   color: '#1D5BD6', dot: '#1D5BD6' },
    { key: 'Scheduled',  label: 'Scheduled',  count: stats.scheduled,  color: '#15803D', dot: '#16A34A' },
    // Only shown once something is marked Completed
    ...(stats.completed > 0 || filters.status === 'Completed'
      ? [{ key: 'Completed' as const, label: 'Completed', count: stats.completed, color: '#0B2A5B', dot: '#8B5CF6' }]
      : []),
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

      {/* Filter card: Program · Year Level · Term */}
      <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm px-4 sm:px-5 py-4">
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-20 rounded" />
              <Skeleton className="h-12 w-full rounded-xl" />
            </div>
          ))}
        </div>
      </div>

      {/* Content area */}
      <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm p-4 sm:p-6 space-y-4">
        <TableSkeleton rows={8} cols={6} />
      </div>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <PageLoadTransition showSkeleton={showPageSkeleton} skeleton={pageSkeleton}>

      {/* ── Page header ──────────────────────────────────────────── */}
      <div className="mb-8">
        <BackButton />
        <div className="mt-4 sm:mt-7 mb-2">
          <WatermarkTitle>Master Schedule</WatermarkTitle>
        </div>
      </div>

      {/* ── Filter panel ─────────────────────────────────────────────
          Row 1: Program · Year Level · Term (from Settings)
          Row 2: status buttons with live counts · search (once a program is chosen) */}
      <FilterBar className="!px-4 sm:!px-5 !py-4">
        {chairNoProgram && (
          <div className="mb-4 rounded-xl border border-[#E2E8F0] bg-slate-50 px-4 py-3 text-sm text-slate-600">
            No program is assigned to your Department Chair account. Please contact the administrator.
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4">

          {/* Program — locked for Department Chair */}
          <div className="min-w-0">
            <p className={MS_LABEL}>Program</p>
            {isChair ? (
              <div className={MS_READONLY}>
                <span className="text-[15px] text-[#0B2A5B] font-semibold truncate">
                  {lockedProgram
                    ? `${lockedProgram.code} — ${lockedProgram.name}`
                    : chairNoProgram ? 'No program assigned' : '—'}
                </span>
              </div>
            ) : (
              <FriendlySelect
                value={filters.program_id}
                onChange={v => setFilter('program_id', v)}
                label="Program"
                placeholder="Select a program"
                guide={!filters.program_id}
                showHintInTrigger
                minPanelWidth={380}
                options={[
                  { value: ALL_PROGRAMS, label: 'All Programs', hint: 'Every program this term' },
                  ...programs.map(p => ({ value: String(p.id), label: p.code, hint: p.name })),
                ]}
              />
            )}
          </div>

          {/* Year Level */}
          <div className="min-w-0">
            <p className={MS_LABEL}>Year Level</p>
            <FriendlySelect
              value={filters.year_level}
              onChange={v => setFilter('year_level', v)}
              disabled={!programSelected}
              disabledText="Select a program first"
              label="Year Level"
              minPanelWidth={220}
              options={[{ value: '', label: 'All Year Levels' }, ...YEAR_LEVELS.map(y => ({ value: y, label: y }))]}
            />
          </div>

          {/* Term — set in Settings, read-only here */}
          <div className="min-w-0">
            <p className={MS_LABEL}>Term</p>
            <div className={MS_READONLY}>
              <CalendarDays className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
              <span className="text-[15px] text-[#0B2A5B] font-semibold truncate">
                {[globalSemester, globalYear].filter(Boolean).join(' · ') || '—'}
              </span>
            </div>
          </div>
        </div>

        {programSelected && (
          <div className="mt-4 pt-4 border-t border-[#EEF2F7] flex flex-col lg:flex-row lg:items-center gap-3">
            {/* Click a status to show only those subjects; the counts always cover the whole list */}
            <CountFilterTabs
              label="Status"
              layoutId="master-schedule-status"
              value={statusTab}
              onChange={key => setFilter('status', key === 'all' ? '' : key)}
              options={statusTabs}
              className="flex-1 min-w-0"
            />
            <SearchInput
              value={filters.search}
              onChange={v => setFilter('search', v)}
              placeholder="Search subject, faculty, or block (e.g. 2D)…"
              className="w-full lg:w-80 flex-shrink-0 !bg-white border border-[#D6E0EF] hover:border-[#9DB8E8] focus-within:border-[#1D5BD6]"
            />
          </div>
        )}
      </FilterBar>

      {/* ── Empty state ───────────────────────────────────────────── */}
      {!programSelected && (
        <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm py-14 text-center">
          <p className="text-sm text-[#64748B]">Select a program to see its master schedule.</p>
        </div>
      )}

      {/* ── Loading / schedule content ───────────────────────────── */}
      {programSelected && (
        <PageLoadTransition
          showSkeleton={showScheduleSkeleton}
          skeleton={<TableSkeleton rows={8} cols={6} />}
        >
        <>
          {/* No results */}
          {filtered.length === 0 && (
            <div className="bg-white rounded-2xl border border-[#E2E8F0] shadow-sm py-12 text-center">
              <p className="text-sm text-[#64748B]">No subjects found.</p>
            </div>
          )}

          {/* One block per page — every view (a single year, all years, all programs) */}
          {currentBlock && (
            <div ref={blockTopRef} className="mb-4 min-w-0 scroll-mt-24">
              {/* Animated block header + schedule only — pager stays stable below */}
              <div className="min-w-0 overflow-x-hidden">
                <AnimatePresence mode="wait" initial={false} custom={pageDirection}>
                  <motion.div
                    key={currentBlock.key}
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
                    <BlockTable block={currentBlock} onOpenSubject={setSubjectPreview} withProgram={isAllPrograms} />
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* Block pagination — stable while content transitions */}
              {totalBlockPages >= 1 && (
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between min-w-0">
                  {/* Go to block — jump to any block instead of clicking through every page */}
                  <div className="w-full sm:w-[22rem] min-w-0 order-2 sm:order-1">
                    <FriendlySelect
                      value={currentBlock.key}
                      onChange={goToBlock}
                      label="Go to block"
                      searchable={blockPages.length > 8}
                      searchPlaceholder="Type a block, e.g. BSIT 2nd Year Block B"
                      minPanelWidth={340}
                      options={blockPages.map(b => ({
                        value: b.key,
                        label: blockTitle(b, isAllPrograms),
                        hint: `${b.semester} · ${b.subjects.length} subject${b.subjects.length !== 1 ? 's' : ''}`,
                      }))}
                    />
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
                          className="inline-block text-sm font-medium text-[#0B2A5B] tabular-nums px-1 whitespace-nowrap"
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
              {filtered.length} subject{filtered.length !== 1 ? 's' : ''} · {isAllPrograms ? 'All Programs' : selectedProgram?.code}
            </p>
          )}
        </>
        </PageLoadTransition>
      )}

      </PageLoadTransition>

      {/* Every faculty member handling the clicked subject this term — same
          pop-up as the eye on Scheduling; this block's class is marked */}
      <SubjectFacultyPreview
        subject={subjectPreview ? { code: subjectPreview.subject_code, name: subjectPreview.subject_name } : null}
        semester={globalSemester}
        academicYear={globalYear}
        currentMsId={subjectPreview?.id ?? null}
        onClose={closeSubjectPreview}
      />
    </div>
  );
}
