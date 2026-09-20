'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useToast } from '@/client/context/ToastContext';
import { useSchoolYear } from '@/client/context/SchoolYearContext';
import Modal from '@/client/components/ui/Modal';
import { PageLoadTransition } from '@/client/components/ui/PageLoadTransition';
import { CardSkeleton, ListSkeleton, Skeleton } from '@/client/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';
import {
  Plus, Pencil, Trash2, Eye, BookOpen, CheckCircle,
  AlertTriangle, Users, X, GraduationCap, ChevronRight,
} from 'lucide-react';
import { SearchInput, FilterSelect, FilterBar } from '@/components/ui/SearchFilter';
import Link from 'next/link';
import {
  CURRICULUM_VERSIONS,
  blockCurriculumVersion,
  curriculumVersionLabel,
  parseCurriculumVersion,
  type CurriculumVersion,
} from '@/lib/curriculumVersion';

interface Program { id: number; code: string; name: string; }
interface Block {
  id: number; program_id: number; year_level: string; semester: string;
  academic_year: string; block_name: string; number_of_students: number;
  program_code: string; program_name: string;
  subject_count: number; unassigned_count: number;
  assigned_count: number; scheduled_count: number;
  curriculum_version?: CurriculumVersion | string;
}
interface CurriculumPreview {
  id: number; subject_code: string; subject_name: string;
  lecture_hours: number; laboratory_hours: number; total_hours: number; units: number;
}
interface BlockGroup {
  key: string; program_id: number; program: string; programName: string;
  yearLevel: string; semester: string; curriculumVersion: CurriculumVersion; blocks: Block[];
}

const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];
const SEMESTERS   = ['1st Semester', '2nd Semester', 'Summer'];
const BLOCK_NAMES = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
const YEAR_ORDER: Record<string, number> = { '1st Year': 0, '2nd Year': 1, '3rd Year': 2, '4th Year': 3 };
const SEM_ORDER:  Record<string, number> = { '1st Semester': 0, '2nd Semester': 1, 'Summer': 2 };

const emptyForm = {
  program_id: '', curriculum_version: '' as '' | CurriculumVersion, year_level: '', semester: '',
  academic_year: '2025-2026', block_name: 'A', number_of_students: 40,
};


function buildGroups(items: Block[]): BlockGroup[] {
  const map = new Map<string, BlockGroup>();
  for (const b of items) {
    const version = blockCurriculumVersion(b.curriculum_version);
    const key = `${b.program_id}||${version}||${b.year_level}||${b.semester}||${b.academic_year}`;
    if (!map.has(key)) {
      map.set(key, {
        key, program_id: b.program_id,
        program: b.program_code, programName: b.program_name,
        yearLevel: b.year_level, semester: b.semester, curriculumVersion: version, blocks: [],
      });
    }
    map.get(key)!.blocks.push(b);
  }
  for (const g of map.values()) {
    g.blocks.sort((a, b) => a.block_name.localeCompare(b.block_name));
  }
  return [...map.values()].sort((a, b) => {
    if (a.program !== b.program) return a.program.localeCompare(b.program);
    const yi = (YEAR_ORDER[a.yearLevel] ?? 99) - (YEAR_ORDER[b.yearLevel] ?? 99);
    if (yi !== 0) return yi;
    const si = (SEM_ORDER[a.semester] ?? 99) - (SEM_ORDER[b.semester] ?? 99);
    if (si !== 0) return si;
    return a.curriculumVersion.localeCompare(b.curriculumVersion);
  });
}

export default function BlocksPage() {
  const toast = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { schoolYear: globalYear, semester: globalSemester } = useSchoolYear();
  const appliedBlockNav = useRef(false);

  const [blocks,         setBlocks]         = useState<Block[]>([]);
  const [programs,       setPrograms]       = useState<Program[]>([]);
  const [form,           setForm]           = useState(emptyForm);
  const [editId,         setEditId]         = useState<number | null>(null);
  const [modalOpen,      setModalOpen]      = useState(false);
  const [error,          setError]          = useState('');
  const [blockExistsError,  setBlockExistsError]  = useState(false);
  const [blockOrderError,   setBlockOrderError]   = useState<{ required: string; requested: string } | null>(null);
  const [noCurriculumInfo,  setNoCurriculumInfo]  = useState<{ program_code: string; year_level: string; semester: string; curriculum_label?: string } | null>(null);
  const [loading,        setLoading]        = useState(false);
  const [listLoading,    setListLoading]    = useState(false);
  const [deletingId,     setDeletingId]     = useState<number | null>(null);
  const [modalKey,       setModalKey]       = useState(0);
  const [search,         setSearch]         = useState('');
  const [programFilter,  setProgramFilter]  = useState('');
  const [yearFilter,     setYearFilter]     = useState('');
  const [previewSubjects,  setPreviewSubjects]   = useState<CurriculumPreview[]>([]);
  const [previewLoading,   setPreviewLoading]    = useState(false);
  const [userRole,         setUserRole]          = useState<'admin' | 'department_chair' | null>(null);
  const [chairProgramId,   setChairProgramId]    = useState<number | null>(null);
  const [chairNoProgram,   setChairNoProgram]    = useState(false);
  const [roleReady,        setRoleReady]         = useState(false);

  const isChair = userRole === 'department_chair';
  const lockedProgram = isChair
    ? programs.find(p => p.id === chairProgramId) ?? programs[0] ?? null
    : null;

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

        const role = meData.user?.role as string | undefined;
        const assignedPid = meData.user?.program_id != null ? Number(meData.user.program_id) : null;
        const list: Program[] = progData.programs || [];
        setPrograms(list);

        if (role === 'department_chair') {
          setUserRole('department_chair');
          if (assignedPid == null || list.length === 0) {
            setChairProgramId(null);
            setChairNoProgram(true);
            setProgramFilter('');
          } else {
            setChairProgramId(assignedPid);
            setChairNoProgram(false);
            setProgramFilter(String(assignedPid));
          }
        } else {
          setUserRole('admin');
          setChairProgramId(null);
          setChairNoProgram(false);
        }
      } catch {
        if (!cancelled) setUserRole('admin');
      } finally {
        if (!cancelled) setRoleReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!roleReady) return;
    const pid = searchParams.get('programId');
    if (!pid) return;
    if (userRole === 'department_chair') {
      if (chairProgramId != null && Number(pid) !== chairProgramId) return;
      return;
    }
    setProgramFilter(prev => (prev === pid ? prev : pid));
  }, [roleReady, searchParams, userRole, chairProgramId]);

  useEffect(() => {
    const yl = searchParams.get('yearLevel');
    if (!yl || !programFilter || blocks.length === 0) return;
    setYearFilter(prev => prev || yl);
  }, [searchParams, programFilter, blocks.length]);

  useEffect(() => {
    if (appliedBlockNav.current) return;
    const bid = searchParams.get('blockId');
    const pid = searchParams.get('programId');
    if (!bid || blocks.length === 0) return;
    const block = blocks.find(b => String(b.id) === bid);
    if (!block) return;
    if (pid && String(block.program_id) !== pid) return;
    appliedBlockNav.current = true;
    router.replace(`/program/blocks/${block.id}`);
  }, [blocks, searchParams, router]);

  useEffect(() => {
    setYearFilter('');
  }, [programFilter]);

  useEffect(() => {
    if (!programFilter || !yearFilter) {
      setBlocks([]);
      setListLoading(false);
      return;
    }

    const controller = new AbortController();
    setListLoading(true);
    const params = new URLSearchParams({ program_id: programFilter });
    fetch('/api/blocks?' + params, { signal: controller.signal })
      .then(r => r.json())
      .then(d => setBlocks(d.blocks || []))
      .catch(err => {
        if (err.name !== 'AbortError') setBlocks([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false);
      });

    return () => controller.abort();
  }, [programFilter, yearFilter]);

  useEffect(() => {
    if (editId) return;
    if (!form.program_id || !form.curriculum_version || !form.year_level || !form.semester || !form.academic_year) return;
    const existing = new Set(
      blocks
        .filter(b =>
          String(b.program_id) === form.program_id &&
          blockCurriculumVersion(b.curriculum_version) === form.curriculum_version &&
          b.year_level    === form.year_level  &&
          b.semester      === form.semester    &&
          b.academic_year === form.academic_year
        )
        .map(b => b.block_name.toUpperCase())
    );
    const creatable = (n: string) => {
      if (existing.has(n)) return false;
      const i = BLOCK_NAMES.indexOf(n);
      return i === 0 || existing.has(BLOCK_NAMES[i - 1]);
    };
    const next = BLOCK_NAMES.find(n => creatable(n));
    if (next) setForm(f => ({ ...f, block_name: next }));
  }, [form.program_id, form.curriculum_version, form.year_level, form.semester, form.academic_year, blocks, editId]);

  useEffect(() => {
    if (editId) return;
    if (!form.program_id || !form.curriculum_version || !form.year_level || !form.semester) {
      setPreviewSubjects([]);
      setPreviewLoading(false);
      return;
    }
    // AbortController prevents stale responses from a previous (slower) fetch
    // overwriting the result of a newer one when the user changes form fields quickly.
    const controller = new AbortController();
    setPreviewLoading(true);
    const p = new URLSearchParams({
      program_id: form.program_id,
      year_level: form.year_level,
      semester: form.semester,
      curriculum_version: form.curriculum_version,
    });
    fetch('/api/curriculum?' + p, { signal: controller.signal })
      .then(r => r.json())
      .then(d => { setPreviewSubjects(d.curriculums || []); setPreviewLoading(false); })
      .catch(err => { if (err.name !== 'AbortError') { setPreviewSubjects([]); setPreviewLoading(false); } });
    return () => controller.abort();
  // modalKey increments each time the modal opens, forcing a fresh fetch even
  // when the other fields are identical to the previous session.
  }, [form.program_id, form.curriculum_version, form.year_level, form.semester, editId, modalKey]);

  async function reloadBlocks() {
    if (!programFilter) { setBlocks([]); return; }
    const params = new URLSearchParams({ program_id: programFilter });
    const data = await fetch('/api/blocks?' + params).then(r => r.json()).catch(() => ({ blocks: [] }));
    setBlocks(data.blocks || []);
  }

  function openAdd() {
    setModalKey(k => k + 1);  // bump so curriculum useEffect always re-fires
    setPreviewLoading(true);   // show spinner immediately — avoids "no subjects" flash
    setPreviewSubjects([]);

    const academicYear = globalYear || emptyForm.academic_year;

    // Compute the next available block name synchronously from the current blocks
    // state. The auto-select useEffect cannot be relied on here because it only
    // fires when its deps change — if program/year/semester/academic_year are
    // identical to the previous open (e.g. user creates Block A then opens the
    // modal again), the effect is skipped and block_name would incorrectly revert
    // to 'A'. Computing it eagerly here guarantees the dropdown always opens on
    // the correct next block.
    const existing = new Set(
      blocks
        .filter(b =>
          String(b.program_id) === programFilter &&
          b.year_level    === yearFilter      &&
          b.semester      === globalSemester  &&
          b.academic_year === academicYear
        )
        .map(b => b.block_name.toUpperCase())
    );
    const nextBlock = BLOCK_NAMES.find(n => {
      if (existing.has(n)) return false;
      const i = BLOCK_NAMES.indexOf(n);
      return i === 0 || existing.has(BLOCK_NAMES[i - 1]);
    }) ?? emptyForm.block_name;

    setForm({
      ...emptyForm,
      program_id:   programFilter,
      year_level:   yearFilter,
      semester:     globalSemester,
      academic_year: academicYear,
      block_name:   nextBlock,
    });
    setEditId(null);
    setError(''); setBlockExistsError(false); setBlockOrderError(null);
    setNoCurriculumInfo(null);
    setModalOpen(true);
  }

  function openEdit(b: Block) {
    setForm({
      program_id: String(b.program_id),
      curriculum_version: blockCurriculumVersion(b.curriculum_version),
      year_level: b.year_level,
      semester: b.semester, academic_year: b.academic_year,
      block_name: b.block_name, number_of_students: b.number_of_students,
    });
    setEditId(b.id);
    setError(''); setBlockExistsError(false); setBlockOrderError(null);
    setNoCurriculumInfo(null); setPreviewSubjects([]); setPreviewLoading(false);
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(''); setBlockExistsError(false); setBlockOrderError(null); setNoCurriculumInfo(null);
    const url    = editId ? `/api/blocks/${editId}` : '/api/blocks';
    const method = editId ? 'PUT' : 'POST';
    try {
      const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'NO_CURRICULUM') {
          setNoCurriculumInfo({
            program_code: data.program_code,
            year_level: data.year_level,
            semester: data.semester,
            curriculum_label: data.curriculum_label,
          });
        } else if (data.error === 'BLOCK_EXISTS') {
          setBlockExistsError(true); setError(data.detail || 'This block already exists.');
        } else if (data.error === 'BLOCK_ORDER') {
          setBlockOrderError({ required: data.required_block, requested: data.requested_block });
        } else {
          setError(data.error || data.detail || 'Unable to create block. Please try again.');
        }
        return;
      }
      await reloadBlocks();   // refresh block list BEFORE closing so openAdd() sees fresh data
      setModalOpen(false);
      toast.success(editId ? 'Block updated successfully.' : 'Block created successfully.');
    } catch {
      setError('Connection error. Please check your network and try again.');
      toast.error('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: number, blockName: string, groupBlockList: Block[]) {
    if (blockName.toUpperCase() === 'A') {
      toast.error('Block A cannot be deleted. It is required by all other blocks.');
      return;
    }
    const sorted    = [...groupBlockList].sort((a, b) => a.block_name.localeCompare(b.block_name));
    const lastBlock = sorted[sorted.length - 1];
    if (lastBlock.id !== id) {
      toast.error(`Only Block ${lastBlock.block_name} (the last block) can be deleted first.`);
      return;
    }
    if (!confirm(
      'Delete this block?\n\n' +
      'This will permanently remove the block and all associated data:\n' +
      '• Loaded subjects (block subjects)\n' +
      '• Master schedule entries\n' +
      '• Instructor load assignments\n\n' +
      'This action cannot be undone. You can re-create the block afterwards.'
    )) return;

    setDeletingId(id);
    try {
      const res = await fetch(`/api/blocks/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = res.status === 401
          ? 'Your session has expired. Please log in again and retry.'
          : data.error || 'Failed to delete block. Please try again.';
        toast.error(msg);
        return;
      }
      toast.delete('Block deleted successfully.');
      reloadBlocks();
    } catch {
      toast.error('Network error. Please check your connection and try again.');
    } finally {
      setDeletingId(null);
    }
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const selectedProgram = programs.find(p => String(p.id) === form.program_id);
  const canPreview      = !!(form.program_id && form.curriculum_version && form.year_level && form.semester);

  const existingBlockNames = new Set(
    blocks
      .filter(b =>
        String(b.program_id) === form.program_id &&
        blockCurriculumVersion(b.curriculum_version) === form.curriculum_version &&
        b.year_level    === form.year_level  &&
        b.semester      === form.semester    &&
        b.academic_year === form.academic_year
      )
      .map(b => b.block_name.toUpperCase())
  );

  function isBlockCreatable(name: string): boolean {
    if (existingBlockNames.has(name)) return false;
    const idx = BLOCK_NAMES.indexOf(name);
    return idx === 0 || existingBlockNames.has(BLOCK_NAMES[idx - 1]);
  }

  const nextCreatableBlock = BLOCK_NAMES.find(b => isBlockCreatable(b));

  // Use the shared YEAR_LEVELS catalog (same as the create/edit modal).
  // Do NOT derive options from `blocks` — fetch is gated on yearFilter, so that
  // would leave the Year Level dropdown empty until a year is already selected.
  const yearOptions = YEAR_LEVELS.filter(y => !!y && YEAR_ORDER[y] != null);

  const filtered = blocks.filter(b => {
    if (yearFilter       && b.year_level    !== yearFilter)        return false;
    if (globalSemester   && b.semester      !== globalSemester)    return false;
    if (globalYear       && b.academic_year !== globalYear)        return false;
    if (search && !b.block_name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const groups          = buildGroups(filtered);
  const totalBlocks     = filtered.length;
  const totalReady      = filtered.filter(b => b.subject_count > 0 && b.scheduled_count === b.subject_count).length;
  const totalInProgress = filtered.filter(b => b.subject_count > 0 && b.scheduled_count < b.subject_count).length;
  const totalNoSubjects = filtered.filter(b => b.subject_count === 0).length;

  const activeFilterCount = [yearFilter, search].filter(Boolean).length;
  const allFiltersSet     = !!(programFilter && yearFilter && globalSemester && globalYear);

  const allBlocksTakenForCurrentFilter = allFiltersSet && CURRICULUM_VERSIONS.every(ver =>
    BLOCK_NAMES.every(n =>
      blocks.some(b =>
        String(b.program_id) === programFilter &&
        blockCurriculumVersion(b.curriculum_version) === ver &&
        b.year_level    === yearFilter     &&
        b.semester      === globalSemester &&
        b.academic_year === globalYear     &&
        b.block_name.toUpperCase() === n
      )
    )
  );

  function blockReadiness(b: Block) {
    if (b.subject_count === 0) return { label: 'No Subjects', color: 'gray' as const, next: null };
    if (b.scheduled_count === b.subject_count) return { label: 'Class Program Ready', color: 'green' as const, next: '/program/class-program' };
    if (b.unassigned_count > 0) return { label: 'Needs Instructor', color: 'amber' as const, next: '/workload' };
    return { label: 'Needs Scheduling', color: 'blue' as const, next: '/scheduling' };
  }

  const modalFieldCls = 'w-full border border-[#E2E8F0] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3C91E6]/40 focus:border-[#3C91E6] bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

  // ── Block list content (extracted to avoid nested-return JSX parsing issues) ──

  const canCreateBlock = !!(programFilter && !allBlocksTakenForCurrentFilter && !chairNoProgram);

  // Full-page skeleton when opening Block Creation (until role/programs ready).
  const showPageSkeleton = useMinLoading(!roleReady, LOADING_DELAY);
  // List skeleton only while a valid (program + year) API fetch is in flight.
  const showListSkeleton = useMinLoading(
    !showPageSkeleton && listLoading && !!programFilter && !!yearFilter,
    LOADING_DELAY,
  );

  const filterPrompt =
    !programFilter ? 'Select a Program and Year Level to view available blocks.'
    : !yearFilter ? 'Select a Year Level to view available blocks.'
    : !globalSemester ? 'Set an active semester in Settings to view blocks.'
    : !globalYear ? 'Set an active school year in Settings to view blocks.'
    : null;

  const readinessStyles: Record<string, string> = {
    green: 'bg-[#ECFDF5] text-emerald-700 border border-[#A7F3D0]',
    blue:  'bg-[#EFF6FF] border border-[#BFDBFE]',
    amber: 'bg-[#FFFBEB] text-amber-700 border border-[#FDE68A]',
    gray:  'bg-slate-50 text-slate-500 border border-[#E2E8F0]',
  };

  const pageSkeleton = (
    <div className="space-y-6" role="status" aria-live="polite" aria-label="Loading block creation">
      {/* Title + Create Block */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2 min-w-0">
          <Skeleton className="h-8 w-48 sm:w-56 rounded-md" />
          <Skeleton className="h-4 w-80 sm:w-[28rem] max-w-full rounded" />
        </div>
        <Skeleton className="h-11 w-full sm:w-[9.5rem] rounded-xl flex-shrink-0" />
      </div>

      {/* Filters: Program, Year Level, Semester, School Year, Search */}
      <div className="bg-white rounded-2xl border border-[#E5E7EB] shadow-sm px-4 sm:px-5 py-4">
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-4">
          <div className="flex flex-col w-full sm:flex-1 sm:min-w-52 gap-1.5">
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="h-[42px] w-full rounded-xl" />
          </div>
          <div className="flex flex-col w-full sm:min-w-36 gap-1.5">
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="h-[42px] w-full rounded-xl" />
          </div>
          <div className="flex flex-col w-full sm:min-w-36 gap-1.5">
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="h-[42px] w-full rounded-xl" />
          </div>
          <div className="flex flex-col w-full sm:min-w-36 gap-1.5">
            <Skeleton className="h-3 w-20 rounded" />
            <Skeleton className="h-[42px] w-full rounded-xl" />
          </div>
          <div className="flex flex-col w-full sm:flex-1 sm:min-w-44 gap-1.5">
            <Skeleton className="h-3 w-14 rounded" />
            <Skeleton className="h-[42px] w-full rounded-xl" />
          </div>
        </div>
      </div>

      {/* Empty content card */}
      <div className="bg-white border border-[#E2E8F0] rounded-2xl py-14 shadow-sm flex flex-col items-center gap-3">
        <Skeleton className="h-4 w-72 max-w-full rounded" />
      </div>
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">

      <PageLoadTransition showSkeleton={showPageSkeleton} skeleton={pageSkeleton}>

      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-6">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold" style={{ color: '#1E3A5F' }}>Block Creation</h1>
          <p className="text-sm mt-0.5" style={{ color: '#64748B' }}>
            Create student blocks — subjects load automatically from Curriculum Setup
          </p>
        </div>
        <button
          type="button"
          onClick={canCreateBlock ? openAdd : undefined}
          title={
            chairNoProgram                  ? 'No program is assigned to your account' :
            !programFilter                  ? 'Select a program first' :
            allBlocksTakenForCurrentFilter  ? 'All block names (A–Z) have already been created for this combination' :
                                              'Create a new block'
          }
          className={`inline-flex items-center justify-center gap-2 px-5 min-h-11 rounded-xl font-semibold text-sm transition shadow-sm w-full sm:w-auto flex-shrink-0 ${
            canCreateBlock ? 'hover:opacity-90' : 'bg-slate-100 text-slate-400 border border-[#E2E8F0] cursor-not-allowed'
          }`}
          style={canCreateBlock ? { backgroundColor: '#3C91E6', color: '#ffffff' } : {}}
        >
          <Plus className="w-4 h-4" /> Create Block
        </button>
      </div>

      {chairNoProgram && roleReady && (
        <div className="mb-4 rounded-xl border border-[#E2E8F0] bg-slate-50 px-4 py-3 text-sm text-slate-600">
          No program is assigned to your Department Chair account. Please contact the administrator.
        </div>
      )}

      {/* Filter Bar */}
      <FilterBar className="!px-4 sm:!px-5 !py-4">
        <div className="flex flex-col sm:flex-row sm:items-end gap-4 sm:flex-wrap">

          {/* Program */}
          <div className="w-full sm:flex-1 sm:min-w-52">
            <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-slate-500">
              Program <span className="text-red-400">*</span>
            </label>
            {isChair ? (
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5 text-sm text-slate-600 font-medium cursor-default select-none truncate">
                {lockedProgram
                  ? `${lockedProgram.code} — ${lockedProgram.name}`
                  : chairNoProgram
                    ? 'No program assigned'
                    : '—'}
              </div>
            ) : (
              <FilterSelect value={programFilter} onChange={setProgramFilter} label="Program" className="w-full">
                <option value="">— Select a Program —</option>
                {programs.map(p => (
                  <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                ))}
              </FilterSelect>
            )}
          </div>

          {/* Year Level */}
          <div className="w-full sm:min-w-36 sm:w-auto">
            <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-slate-500">Year Level</label>
            <FilterSelect value={yearFilter} onChange={setYearFilter} disabled={!programFilter} label="Year Level" className="w-full">
              <option value="">— Year Level —</option>
              {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
            </FilterSelect>
          </div>

          {/* Semester — read-only */}
          <div className="w-full sm:min-w-36 sm:w-auto">
            <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-slate-500">Semester</label>
            <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5 text-sm text-slate-600 font-medium cursor-default select-none">
              {globalSemester || '—'}
            </div>
          </div>

          {/* School Year — read-only */}
          <div className="w-full sm:min-w-36 sm:w-auto">
            <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-slate-500">School Year</label>
            <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2.5 text-sm text-slate-600 font-medium cursor-default select-none">
              {globalYear || '—'}
            </div>
          </div>

          {/* Search */}
          <div className="w-full sm:flex-1 sm:min-w-44">
            <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-slate-500">Search</label>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search by block name (e.g. A, B, C…)"
              disabled={!allFiltersSet}
            />
          </div>

          {/* Clear filters */}
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() => { setYearFilter(''); setSearch(''); }}
              className="flex items-center justify-center gap-1.5 text-xs border border-slate-200 rounded-xl px-3 min-h-11 hover:bg-slate-50 transition whitespace-nowrap sm:self-end text-slate-500 hover:text-slate-700 w-full sm:w-auto"
            >
              <X className="w-3 h-3" /> Clear filters
            </button>
          )}
        </div>

        {/* Active search pill */}
        {search && (
          <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-slate-100">
            <span className="text-[11px] text-slate-400">Active filters:</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
              &ldquo;{search}&rdquo;
              <button onClick={() => setSearch('')} className="hover:opacity-70 transition-opacity">
                <X className="w-3 h-3" />
              </button>
            </span>
            <span className="text-[11px] text-slate-400">
              — {filtered.length} block{filtered.length !== 1 ? 's' : ''} shown
            </span>
          </div>
        )}
      </FilterBar>

      {/* Stats Row */}
      {allFiltersSet && totalBlocks > 0 && !showListSkeleton && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-5">
          <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 text-center">
            <div className="text-2xl sm:text-3xl font-bold mb-1 text-[#1E3A5F]">{totalBlocks}</div>
            <div className="text-sm text-[#64748B]">Total Blocks</div>
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 text-center">
            <div className="text-2xl sm:text-3xl font-bold mb-1 text-[#1E3A5F]">{totalReady}</div>
            <div className="text-sm text-[#64748B]">Class Program Ready</div>
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 text-center">
            <div className="text-2xl sm:text-3xl font-bold mb-1 text-[#1E3A5F]">{totalInProgress}</div>
            <div className="text-sm text-[#64748B]">In Progress</div>
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 text-center">
            <div className="text-2xl sm:text-3xl font-bold mb-1 text-[#1E3A5F]">{totalNoSubjects}</div>
            <div className="text-sm text-[#64748B]">No Subjects Loaded</div>
          </div>
        </div>
      )}

      <PageLoadTransition
        showSkeleton={showListSkeleton}
        skeleton={
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              {Array.from({ length: 4 }, (_, i) => (
                <CardSkeleton key={i} className="h-[88px]" />
              ))}
            </div>
            <ListSkeleton rows={6} />
          </div>
        }
      >

      {/* Main Content — missing filter prompt */}
      {filterPrompt && (
        <div className="bg-white border border-[#E2E8F0] rounded-2xl py-14 text-center shadow-sm">
          <p className="text-sm" style={{ color: '#64748B' }}>{filterPrompt}</p>
        </div>
      )}

      {/* Main Content — no blocks found */}
      {!filterPrompt && groups.length === 0 && (
        <div className="bg-white border border-[#E2E8F0] rounded-2xl flex flex-col items-center justify-center py-20 text-center shadow-sm">
          <div className="w-14 h-14 rounded-full flex items-center justify-center mb-4 bg-[#F8FAFC]">
            <GraduationCap className="w-7 h-7" style={{ color: '#94A3B8' }} />
          </div>
          <p className="font-semibold text-base" style={{ color: '#1E3A5F' }}>No blocks found</p>
          {search ? (
            <p className="text-sm mt-1 mb-5" style={{ color: '#64748B' }}>No blocks match your search.</p>
          ) : (
            <p className="text-sm mt-1 mb-5" style={{ color: '#64748B' }}>No blocks created for this combination yet.</p>
          )}
          {search ? (
            <button
              onClick={() => setSearch('')}
              className="flex items-center gap-2 border border-[#E2E8F0] px-5 py-2.5 rounded-xl hover:bg-[#F8FAFC] transition text-sm font-medium"
              style={{ color: '#64748B' }}
            >
              <X className="w-4 h-4" /> Clear search
            </button>
          ) : (
            <button
              onClick={openAdd}
              className="flex items-center gap-2 text-white px-5 py-2.5 rounded-xl transition font-semibold text-sm shadow-sm hover:opacity-90"
              style={{ backgroundColor: '#3C91E6' }}
            >
              <Plus className="w-4 h-4" /> Create First Block
            </button>
          )}
        </div>
      )}

      {/* Main Content — groups list */}
      {!filterPrompt && groups.length > 0 && (
        <div className="space-y-6">
          {groups.map(group => (
            <div key={group.key} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">

              {/* Group header — calm surface + blue accent, not a saturated bar */}
              <div className="px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-[#F8FAFC] border-b border-[#E2E8F0]">
                <div className="min-w-0 flex items-start gap-3">
                  <span className="mt-1 w-1 self-stretch min-h-[2.25rem] rounded-full bg-[#3C91E6] flex-shrink-0" aria-hidden />
                  <div className="min-w-0">
                    <div className="font-bold text-base leading-tight text-[#1E3A5F] break-words">
                      {group.program} — {group.programName}
                    </div>
                    <div className="text-sm mt-0.5 font-medium text-[#64748B]">
                      {group.yearLevel} &nbsp;·&nbsp; {group.semester} &nbsp;·&nbsp; {curriculumVersionLabel(group.curriculumVersion)}
                    </div>
                  </div>
                </div>
                <span className="self-start bg-[#EFF6FF] text-[#2563EB] border border-[#BFDBFE] text-xs font-semibold px-3 py-1 rounded-full flex-shrink-0">
                  {group.blocks.length} block{group.blocks.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Table on all viewports — horizontal scroll only inside this container */}
              <div className="overflow-x-auto overscroll-x-contain">
                <table className="w-full text-sm min-w-[920px]">
                  <thead>
                    <tr className="border-b border-[color:var(--table-row-line)] bg-[#F8FAFC]">
                      <th className="text-left px-4 sm:px-6 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap min-w-[11rem] text-[#64748B]">Block</th>
                      <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap min-w-[6rem] text-[#64748B]">Students</th>
                      <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap min-w-[16rem] text-[#64748B]">Subject Status</th>
                      <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap min-w-[9rem] text-[#64748B]">Readiness</th>
                      <th className="text-right px-4 sm:px-6 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap min-w-[14rem] text-[#64748B]">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[color:var(--table-row-line)]">
                    {group.blocks.map(b => {
                      const hasSubjects       = b.subject_count > 0;
                      const ready             = blockReadiness(b);
                      const sortedGroupBlocks = [...group.blocks].sort((a, x) => a.block_name.localeCompare(x.block_name));
                      const isLastBlock       = sortedGroupBlocks[sortedGroupBlocks.length - 1].id === b.id;
                      const isBlockA          = b.block_name.toUpperCase() === 'A';
                      const canDelete         = isLastBlock && !isBlockA;
                      const readinessColor    = ready.color === 'blue' ? '#3C91E6' : undefined;
                      const lastBlockName     = sortedGroupBlocks[sortedGroupBlocks.length - 1].block_name;

                      return (
                        <tr key={b.id} className="hover:bg-[#F8FAFC] transition-colors">
                          <td className="px-4 sm:px-6 py-4 align-middle whitespace-nowrap">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-base flex-shrink-0 bg-[#EFF6FF]" style={{ color: '#3C91E6' }}>
                                {b.block_name}
                              </div>
                              <div>
                                <div className="font-bold" style={{ color: '#1E3A5F' }}>Block {b.block_name}</div>
                                <div className="text-xs" style={{ color: '#94A3B8' }}>{b.academic_year}</div>
                              </div>
                            </div>
                          </td>

                          <td className="px-3 py-4 align-middle whitespace-nowrap">
                            <div className="flex items-center gap-1">
                              <Users className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#94A3B8' }} />
                              <span className="font-medium text-sm" style={{ color: '#64748B' }}>{b.number_of_students}</span>
                            </div>
                          </td>

                          <td className="px-3 py-4 align-middle">
                            {!hasSubjects ? (
                              <span className="inline-flex items-center gap-1.5 bg-[#FFFBEB] text-amber-700 border border-[#FDE68A] text-xs font-semibold px-2.5 py-1 rounded-full whitespace-nowrap">
                                <AlertTriangle className="w-3 h-3" /> No subjects loaded
                              </span>
                            ) : (
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-xs font-medium whitespace-nowrap" style={{ color: '#94A3B8' }}>{b.subject_count} subjects:</span>
                                {b.scheduled_count > 0 && (
                                  <span className="inline-flex items-center gap-1 bg-[#ECFDF5] text-emerald-700 border border-[#A7F3D0] text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap">
                                    <CheckCircle className="w-3 h-3" /> {b.scheduled_count} Scheduled
                                  </span>
                                )}
                                {b.assigned_count > 0 && (
                                  <span className="inline-flex items-center gap-1 bg-[#EFF6FF] border border-[#BFDBFE] text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color: '#3C91E6' }}>
                                    <Users className="w-3 h-3" /> {b.assigned_count} Assigned
                                  </span>
                                )}
                                {b.unassigned_count > 0 && (
                                  <span className="inline-flex items-center gap-1 bg-slate-50 text-slate-500 border border-[#E2E8F0] text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap">
                                    {b.unassigned_count} Unassigned
                                  </span>
                                )}
                              </div>
                            )}
                          </td>

                          <td className="px-3 py-4 align-middle whitespace-nowrap">
                            {ready.next ? (
                              <Link
                                href={ready.next}
                                className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full transition hover:opacity-80 ${readinessStyles[ready.color]}`}
                                style={readinessColor ? { color: readinessColor } : {}}
                              >
                                {ready.label} <ChevronRight className="w-3 h-3" />
                              </Link>
                            ) : (
                              <span
                                className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full ${readinessStyles[ready.color]}`}
                                style={readinessColor ? { color: readinessColor } : {}}
                              >
                                {ready.label}
                              </span>
                            )}
                          </td>

                          <td className="px-4 sm:px-6 py-4 align-middle whitespace-nowrap">
                            <div className="flex items-center justify-end gap-2">
                              <Link
                                href={`/program/blocks/${b.id}`}
                                className="inline-flex items-center justify-center gap-1.5 px-3 min-h-11 text-sm font-semibold text-emerald-700 bg-[#ECFDF5] hover:bg-[#D1FAE5] border border-[#A7F3D0] rounded-xl transition"
                                title="View block details"
                              >
                                <Eye className="w-4 h-4" /> View
                              </Link>
                              <button
                                type="button"
                                onClick={() => openEdit(b)}
                                className="inline-flex items-center justify-center gap-1.5 px-3 min-h-11 text-sm font-semibold bg-[#EFF6FF] hover:bg-[#DBEAFE] border border-[#BFDBFE] rounded-xl transition"
                                style={{ color: '#3C91E6' }}
                              >
                                <Pencil className="w-4 h-4" /> Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => { if (canDelete && deletingId === null) handleDelete(b.id, b.block_name, group.blocks); }}
                                disabled={!canDelete || deletingId !== null}
                                className={`inline-flex items-center justify-center min-h-11 min-w-11 rounded-xl transition ${canDelete && deletingId === null ? 'hover:bg-red-50' : 'opacity-30 cursor-not-allowed'}`}
                                style={{ color: '#EF4444' }}
                                title={isBlockA ? 'Block A cannot be deleted' : !isLastBlock ? `Delete Block ${lastBlockName} first` : deletingId === b.id ? 'Deleting…' : 'Delete block'}
                              >
                                {deletingId === b.id
                                  ? <span className="w-4 h-4 border-2 border-red-400 border-t-transparent rounded-full animate-spin inline-block" />
                                  : <Trash2 className="w-4 h-4" />}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

            </div>
          ))}

          <div className="text-xs text-right pr-1" style={{ color: '#94A3B8' }}>
            Showing {filtered.length} block{filtered.length !== 1 ? 's' : ''} in {groups.length} group{groups.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}

      </PageLoadTransition>
      </PageLoadTransition>

      {/* Create / Edit Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editId ? 'Edit Block' : 'Create New Block'}>
        <form onSubmit={handleSubmit} className="space-y-5">

          {noCurriculumInfo && (
            <div className="bg-[#FFFBEB] border border-[#FDE68A] rounded-xl p-4">
              <div className="flex items-start gap-2 mb-2">
                <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-amber-800 font-semibold text-sm">No curriculum subjects found</p>
                  <p className="text-amber-700 text-sm mt-0.5">
                    <strong>{noCurriculumInfo.program_code}</strong>
                    {noCurriculumInfo.curriculum_label ? ` — ${noCurriculumInfo.curriculum_label}` : ''}
                    {' '}— {noCurriculumInfo.year_level}, {noCurriculumInfo.semester} has no subjects set up yet.
                  </p>
                </div>
              </div>
              <Link
                href="/program/curriculum"
                onClick={() => setModalOpen(false)}
                className="inline-flex items-center gap-2 bg-amber-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-amber-600 transition mt-1"
              >
                <BookOpen className="w-4 h-4" /> Go to Curriculum Setup
              </Link>
            </div>
          )}

          {/* Step 1 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-7 h-7 rounded-full text-white text-sm flex items-center justify-center font-bold flex-shrink-0" style={{ backgroundColor: '#3C91E6' }}>1</span>
              <span className="font-semibold text-sm" style={{ color: '#1E3A5F' }}>Select Program, Curriculum, Year Level &amp; Semester</span>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>Program *</label>
                {isChair || editId ? (
                  <div className={`${modalFieldCls} bg-slate-50 cursor-default select-none`} style={{ color: '#1E3A5F' }}>
                    {selectedProgram
                      ? `${selectedProgram.code} — ${selectedProgram.name}`
                      : lockedProgram
                        ? `${lockedProgram.code} — ${lockedProgram.name}`
                        : '—'}
                  </div>
                ) : (
                  <select
                    value={form.program_id}
                    onChange={e => setForm(f => ({ ...f, program_id: e.target.value }))}
                    required
                    className={modalFieldCls}
                    style={{ color: '#1E3A5F' }}
                  >
                    <option value="">— Select Program —</option>
                    {programs.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>Curriculum *</label>
                {editId ? (
                  <div className={`${modalFieldCls} bg-slate-50 cursor-default select-none`} style={{ color: '#1E3A5F' }}>
                    {form.curriculum_version ? curriculumVersionLabel(form.curriculum_version) : '—'}
                  </div>
                ) : (
                  <select
                    value={form.curriculum_version}
                    onChange={e => setForm(f => ({
                      ...f,
                      curriculum_version: parseCurriculumVersion(e.target.value) ?? '',
                    }))}
                    required
                    className={modalFieldCls}
                    style={{ color: '#1E3A5F' }}
                  >
                    <option value="">— Select Curriculum —</option>
                    {(['new', 'old'] as const).map(v => (
                      <option key={v} value={v}>{curriculumVersionLabel(v)}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>Year Level *</label>
                  <select
                    value={form.year_level}
                    onChange={e => setForm(f => ({ ...f, year_level: e.target.value }))}
                    required
                    disabled={!!editId}
                    className={modalFieldCls}
                    style={{ color: '#1E3A5F' }}
                  >
                    <option value="">— Select —</option>
                    {YEAR_LEVELS.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>Semester *</label>
                  <select
                    value={form.semester}
                    onChange={e => setForm(f => ({ ...f, semester: e.target.value }))}
                    required
                    disabled={!!editId}
                    className={modalFieldCls}
                    style={{ color: '#1E3A5F' }}
                  >
                    <option value="">— Select —</option>
                    {SEMESTERS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Subject Preview */}
          {!editId && (
            <div className="border border-[#E2E8F0] rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[#F1F5F9] flex items-center gap-2" style={{ backgroundColor: '#F8FAFC' }}>
                <span className="w-7 h-7 rounded-full text-white text-sm flex items-center justify-center font-bold flex-shrink-0" style={{ backgroundColor: '#3C91E6' }}>2</span>
                <span className="font-semibold text-sm" style={{ color: '#1E3A5F' }}>Subjects that will be loaded into this block</span>
              </div>
              {!canPreview ? (
                <div className="px-4 py-5 text-center text-sm" style={{ color: '#94A3B8' }}>
                  Select Program, Curriculum, Year Level, and Semester above to preview subjects.
                </div>
              ) : previewLoading ? (
                <div className="px-4 py-5 flex justify-center">
                  <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#3C91E6', borderTopColor: 'transparent' }} />
                </div>
              ) : previewSubjects.length === 0 ? (
                <div className="px-4 py-5 text-center">
                  <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-2" />
                  <p className="text-sm font-medium text-amber-700">No curriculum subjects found for</p>
                  <p className="text-sm text-amber-600 font-semibold mt-1">
                    {selectedProgram?.code} — {form.curriculum_version ? curriculumVersionLabel(form.curriculum_version) : ''} — {form.year_level}, {form.semester}
                  </p>
                  <Link
                    href="/program/curriculum"
                    onClick={() => setModalOpen(false)}
                    className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium hover:underline"
                    style={{ color: '#3C91E6' }}
                  >
                    <BookOpen className="w-4 h-4" /> Set up curriculum subjects first
                  </Link>
                </div>
              ) : (
                <>
                  <div className="px-4 py-2 bg-[#ECFDF5] border-b border-[#F1F5F9] flex items-center gap-2 text-sm text-emerald-700">
                    <CheckCircle className="w-4 h-4" />
                    <strong>{previewSubjects.length} subject{previewSubjects.length !== 1 ? 's' : ''}</strong>
                    {' '}will be automatically added from {selectedProgram?.code} {form.curriculum_version ? curriculumVersionLabel(form.curriculum_version) : 'curriculum'}.
                  </div>
                  <div className="overflow-x-auto max-h-52">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0" style={{ backgroundColor: '#F8FAFC' }}>
                        <tr>
                          {['Code', 'Subject Name', 'Lec', 'Lab', 'Total Hrs', 'Units'].map(h => (
                            <th key={h} className="text-left px-3 py-2 font-bold uppercase tracking-wide border-b border-[#F1F5F9]" style={{ color: '#64748B' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#F1F5F9]">
                        {previewSubjects.map(s => (
                          <tr key={s.id} className="hover:bg-[#F8FAFC]">
                            <td className="px-3 py-2 font-mono font-semibold" style={{ color: '#1E3A5F' }}>{s.subject_code}</td>
                            <td className="px-3 py-2" style={{ color: '#64748B' }}>{s.subject_name}</td>
                            <td className="px-3 py-2 text-center" style={{ color: '#64748B' }}>{s.lecture_hours}</td>
                            <td className="px-3 py-2 text-center" style={{ color: '#64748B' }}>{s.laboratory_hours}</td>
                            <td className="px-3 py-2 text-center" style={{ color: '#64748B' }}>{parseFloat(String(s.total_hours)).toFixed(1)}</td>
                            <td className="px-3 py-2 text-center font-bold" style={{ color: '#3C91E6' }}>{parseFloat(String(s.units)).toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Block Details */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="w-7 h-7 rounded-full text-white text-sm flex items-center justify-center font-bold flex-shrink-0" style={{ backgroundColor: '#3C91E6' }}>
                {editId ? '2' : '3'}
              </span>
              <span className="font-semibold text-sm" style={{ color: '#1E3A5F' }}>Block Details</span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>Academic Year *</label>
                <input
                  type="text"
                  value={form.academic_year}
                  onChange={e => { setForm(f => ({ ...f, academic_year: e.target.value })); setBlockExistsError(false); setError(''); }}
                  required
                  placeholder="2025-2026"
                  className={modalFieldCls}
                  style={{ color: '#1E3A5F' }}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>Block Name *</label>
                <select
                  value={form.block_name}
                  onChange={e => { setForm(f => ({ ...f, block_name: e.target.value })); setBlockExistsError(false); setBlockOrderError(null); setError(''); }}
                  required
                  className={modalFieldCls}
                  style={{ color: '#1E3A5F' }}
                >
                  {BLOCK_NAMES.map(b => {
                    if (editId) return <option key={b} value={b}>Block {b}</option>;
                    const alreadyExists = existingBlockNames.has(b);
                    const creatable     = isBlockCreatable(b);
                    const idx           = BLOCK_NAMES.indexOf(b);
                    const prevBlock     = idx > 0 ? BLOCK_NAMES[idx - 1] : null;
                    const label = alreadyExists
                      ? `Block ${b} (already exists)`
                      : (!creatable && prevBlock)
                        ? `Block ${b} (create Block ${prevBlock} first)`
                        : `Block ${b}`;
                    return <option key={b} value={b} disabled={alreadyExists || !creatable}>{label}</option>;
                  })}
                </select>
                {!editId && nextCreatableBlock && (
                  <p className="text-[11px] mt-1" style={{ color: '#94A3B8' }}>
                    Next available: <span className="font-semibold" style={{ color: '#64748B' }}>Block {nextCreatableBlock}</span>
                  </p>
                )}
                {!editId && !nextCreatableBlock && BLOCK_NAMES.every(b => existingBlockNames.has(b)) && (
                  <p className="text-[11px] text-amber-600 mt-1 font-medium">All block names (A–Z) have already been created for this combination.</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>No. of Students *</label>
                <input
                  type="number"
                  min="1"
                  value={form.number_of_students}
                  onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v > 0) setForm(f => ({ ...f, number_of_students: v })); }}
                  required
                  className={modalFieldCls}
                  style={{ color: '#1E3A5F' }}
                />
              </div>
            </div>
          </div>

          {/* Error banners */}
          {blockOrderError && (
            <div className="bg-[#FFFBEB] border border-[#FDE68A] rounded-xl px-4 py-3 flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-amber-800 font-semibold text-sm">Block {blockOrderError.required} must be created first.</p>
                <p className="text-amber-700 text-sm mt-0.5">
                  You cannot create Block {blockOrderError.requested} yet. Please create Block {blockOrderError.required} first.
                </p>
              </div>
            </div>
          )}
          {blockExistsError && (
            <div className="bg-[#FFFBEB] border border-[#FDE68A] rounded-xl px-4 py-3 flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-amber-800 font-semibold text-sm">This block already exists.</p>
                <p className="text-amber-700 text-sm mt-0.5">Try choosing a different Block Name (e.g., Block B) or a different Academic Year.</p>
              </div>
            </div>
          )}
          {error && !noCurriculumInfo && !blockExistsError && !blockOrderError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="flex-1 border border-[#E2E8F0] py-2.5 rounded-xl hover:bg-[#F8FAFC] transition text-sm font-medium"
              style={{ color: '#64748B' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || (!editId && canPreview && previewSubjects.length === 0) || previewLoading || (!editId && !isBlockCreatable(form.block_name))}
              className="flex-1 text-white py-2.5 rounded-xl disabled:opacity-50 transition text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90"
              style={{ backgroundColor: '#3C91E6' }}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Creating block…
                </>
              ) : editId ? (
                'Update Block'
              ) : (
                `Create Block${previewSubjects.length > 0 ? ` · ${previewSubjects.length} subjects` : ''}`
              )}
            </button>
          </div>

        </form>
      </Modal>
    </div>
  );
}
