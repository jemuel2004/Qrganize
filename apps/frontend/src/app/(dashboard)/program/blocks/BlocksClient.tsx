'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useRouter, useSearchParams } from 'next/navigation';
import { useToast } from '@/context/ToastContext';
import { useSchoolYear } from '@/context/SchoolYearContext';
import Modal from '@/components/ui/Modal';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import TrashDropAnimation from '@/components/ui/TrashDropAnimation';
import SelectBox from '@/components/ui/SelectBox';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { CardSkeleton, ListSkeleton, Skeleton } from '@/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import {
  Pencil, Trash2, Eye, BookOpen, CheckCircle,
  AlertTriangle, Users, X, ChevronRight, Plus,
} from 'lucide-react';
import { SearchInput, FilterBar } from '@/components/ui/SearchFilter';
import FriendlySelect from '@/components/ui/FriendlySelect';
import Link, { useLinkStatus } from 'next/link';
import {
  CURRICULUM_VERSIONS,
  blockCurriculumVersion,
  curriculumVersionLabel,
  parseCurriculumVersion,
  type CurriculumVersion,
} from '@shared/curriculumVersion';

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

/**
 * Single source of truth for "which block letter comes next" — must always
 * filter by curriculum_version too, since Block A–J can exist under the Old
 * curriculum while New curriculum for the same Program/Year/Sem/AY is empty
 * (or vice versa). Every caller that needs this must go through here so the
 * dropdown's initial value and the "Next available" hint never disagree.
 */
function computeNextBlockName(
  blocksList: Block[],
  programId: string,
  curriculumVersion: CurriculumVersion | '',
  yearLevel: string,
  semester: string,
  academicYear: string,
): string | undefined {
  const existing = new Set(
    blocksList
      .filter(b =>
        String(b.program_id) === programId &&
        blockCurriculumVersion(b.curriculum_version) === curriculumVersion &&
        b.year_level    === yearLevel &&
        b.semester      === semester &&
        b.academic_year === academicYear
      )
      .map(b => b.block_name.toUpperCase())
  );
  return BLOCK_NAMES.find(n => {
    if (existing.has(n)) return false;
    const i = BLOCK_NAMES.indexOf(n);
    return i === 0 || existing.has(BLOCK_NAMES[i - 1]);
  });
}

/** View button icon — a same-size spinner while the block page opens. */
function ViewLinkIcon() {
  const { pending } = useLinkStatus();
  return pending
    ? <span className="w-4 h-4 border-2 border-emerald-700/30 border-t-emerald-700 rounded-full animate-spin" aria-label="Opening block" />
    : <Eye className="w-4 h-4" aria-hidden />;
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
  const [saveSuccess,    setSaveSuccess]    = useState(false);
  const [listLoading,    setListLoading]    = useState(false);
  const [deletingId,     setDeletingId]     = useState<number | null>(null);
  const [deleteTarget,   setDeleteTarget]   = useState<{ id: number; name: string } | null>(null);
  const [deleteSuccess,  setDeleteSuccess]  = useState(false);
  /* Gmail-style multi-select: tick any blocks (or a whole group from the header) and
     delete them together. A removed letter can be re-created later — creating a
     block only needs the letter before it to exist. */
  const [selectedIds,       setSelectedIds]       = useState<Set<number>>(new Set());
  const [bulkDeleteOpen,    setBulkDeleteOpen]    = useState(false);
  const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);
  const [bulkDeleteSuccess, setBulkDeleteSuccess] = useState(false);
  // Create mode: consecutive block letters to create in one save (e.g. A, B, C)
  const [selectedBlocks, setSelectedBlocks] = useState<string[]>([]);
  const [createdCount,   setCreatedCount]   = useState(0);
  const [modalKey,       setModalKey]       = useState(0);
  const [search,         setSearch]         = useState('');
  const [programFilter,  setProgramFilter]  = useState('');
  const [yearFilter,     setYearFilter]     = useState('');
  const [previewSubjects,  setPreviewSubjects]   = useState<CurriculumPreview[]>([]);
  const [previewLoading,   setPreviewLoading]    = useState(false);
  const [userRole,         setUserRole]          = useState<'admin' | 'program_chair' | null>(null);
  const [chairProgramId,   setChairProgramId]    = useState<number | null>(null);
  const [chairNoProgram,   setChairNoProgram]    = useState(false);
  const [roleReady,        setRoleReady]         = useState(false);

  const isChair = userRole === 'program_chair';
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

        if (role === 'program_chair') {
          setUserRole('program_chair');
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
    if (userRole === 'program_chair') {
      if (chairProgramId != null && Number(pid) !== chairProgramId) return;
      return;
    }
    setProgramFilter(prev => (prev === pid ? prev : pid));
  }, [roleReady, searchParams, userRole, chairProgramId]);

  /* ?yearLevel= is applied once, after the program's blocks load (i.e. after the
     program-change reset below) — never again, so picking another program
     doesn't bring the old year back. */
  const restoredYear = useRef(false);
  useEffect(() => {
    if (restoredYear.current) return;
    const yl = searchParams.get('yearLevel');
    if (!yl || !YEAR_LEVELS.includes(yl)) { restoredYear.current = true; return; }
    if (!programFilter || blocks.length === 0) return;
    restoredYear.current = true;
    setYearFilter(yl);
  }, [searchParams, programFilter, blocks.length]);

  /* Keep Program / Year Level in the URL, so Back from a block (link or the
     browser button) returns to the same list instead of empty filters. */
  useEffect(() => {
    if (!roleReady || !restoredYear.current) return;
    const url = new URL(window.location.href);
    if (programFilter) url.searchParams.set('programId', programFilter);
    else url.searchParams.delete('programId');
    if (yearFilter) url.searchParams.set('yearLevel', yearFilter);
    else url.searchParams.delete('yearLevel');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [roleReady, programFilter, yearFilter]);

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
    if (!programFilter) {
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
  // Fetches every block for the program (across all year levels) — needed so the
  // Create Block modal can enforce one curriculum per Program + Year Level even
  // before the page-level Year Level filter is set.
  }, [programFilter]);

  // Auto-lock the curriculum to whatever's already established for this Program +
  // Year Level combo, so the user can't pick a conflicting curriculum for it.
  useEffect(() => {
    if (editId) return;
    if (!form.program_id || !form.year_level) return;
    const existingBlock = blocks.find(b =>
      String(b.program_id) === form.program_id && b.year_level === form.year_level &&
      b.semester === form.semester && b.academic_year === form.academic_year
    );
    if (!existingBlock) return;
    const established = blockCurriculumVersion(existingBlock.curriculum_version);
    setForm(f => (f.curriculum_version === established ? f : { ...f, curriculum_version: established }));
  }, [editId, form.program_id, form.year_level, form.semester, form.academic_year, blocks]);

  useEffect(() => {
    if (editId) return;
    if (!form.program_id || !form.curriculum_version || !form.year_level || !form.semester || !form.academic_year) return;
    const next = computeNextBlockName(
      blocks, form.program_id, form.curriculum_version, form.year_level, form.semester, form.academic_year,
    );
    if (next) setForm(f => ({ ...f, block_name: next }));
    setSelectedBlocks(next ? [next] : []);
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
    setListLoading(true);
    const params = new URLSearchParams({ program_id: programFilter });
    const data = await fetch('/api/blocks?' + params).then(r => r.json()).catch(() => ({ blocks: [] }));
    setBlocks(data.blocks || []);
    setListLoading(false);
  }

  function openAdd() {
    setModalKey(k => k + 1);  // bump so curriculum useEffect always re-fires
    setPreviewLoading(true);   // show spinner immediately — avoids "no subjects" flash
    setPreviewSubjects([]);

    const academicYear = globalYear || emptyForm.academic_year;

    // Curriculum version is locked to whatever's already established for this
    // Program + Year Level (same rule as `establishedCurriculum` below) — resolve
    // it up front rather than leaving it blank and waiting for a later effect to
    // fix it, so the very first render already has the right value.
    const establishedBlock = blocks.find(b =>
      String(b.program_id) === programFilter && b.year_level === yearFilter &&
      b.semester === globalSemester && b.academic_year === academicYear
    );
    const resolvedCurriculumVersion = establishedBlock
      ? blockCurriculumVersion(establishedBlock.curriculum_version)
      : ('' as const);

    // Compute the next available block name synchronously from the current blocks
    // state, filtered by curriculum_version too — otherwise Block A–J occupied
    // under the Old curriculum would wrongly count as "taken" for a brand-new
    // New-curriculum block set. The auto-select useEffect cannot be relied on
    // here because it only fires when its deps change — if program/year/semester
    // /academic_year are identical to the previous open (e.g. user creates
    // Block A then opens the modal again), the effect is skipped and block_name
    // would incorrectly retain a stale value. Computing it eagerly here
    // guarantees the dropdown always opens on the correct next block.
    const computedNext = computeNextBlockName(
      blocks, programFilter, resolvedCurriculumVersion, yearFilter, globalSemester, academicYear,
    );
    const nextBlock = computedNext ?? emptyForm.block_name;
    setSelectedBlocks(computedNext ? [computedNext] : []);

    setForm({
      ...emptyForm,
      program_id:   programFilter,
      curriculum_version: resolvedCurriculumVersion,
      year_level:   yearFilter,
      semester:     globalSemester,
      academic_year: academicYear,
      block_name:   nextBlock,
    });
    setEditId(null);
    setError(''); setBlockExistsError(false); setBlockOrderError(null);
    setNoCurriculumInfo(null); setSaveSuccess(false);
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
    setSaveSuccess(false);
    setModalOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setError(''); setBlockExistsError(false); setBlockOrderError(null); setNoCurriculumInfo(null);
    const url    = editId ? `/api/blocks/${editId}` : '/api/blocks';
    const method = editId ? 'PUT' : 'POST';
    try {
      const payload = editId ? form : { ...form, block_names: selectedBlocks };
      const res  = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
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
        } else if (data.error === 'CURRICULUM_LOCKED') {
          setError(data.detail || 'This Program and Year Level already has an established curriculum.');
        } else {
          setError(data.error || data.detail || 'Unable to create block. Please try again.');
        }
        return;
      }
      await reloadBlocks();   // refresh block list BEFORE closing so openAdd() sees fresh data
      const count = editId ? 1 : (data.blocks?.length ?? 1);
      setCreatedCount(count);
      setLoading(false);
      setSaveSuccess(true);
      setTimeout(() => {
        setSaveSuccess(false);
        setModalOpen(false);
        toast.success(
          editId ? 'Block updated successfully.'
          : count > 1 ? `${count} blocks created successfully.`
          : 'Block created successfully.',
        );
      }, 1300);
      return;
    } catch {
      setError('Connection error. Please check your network and try again.');
      toast.error('Connection error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: number, blockName: string, groupBlockList: Block[]) {
    // Every role — Admin and Department Chair alike — is restricted to deleting
    // the last block first, to avoid orphaning the block sequence. Block A is
    // only special in that it's alphabetically first, so it's "last" (and thus
    // deletable) only when it's the sole remaining block in the group.
    const sorted    = [...groupBlockList].sort((a, b) => a.block_name.localeCompare(b.block_name));
    const lastBlock = sorted[sorted.length - 1];
    if (lastBlock.id !== id) {
      toast.error(`Only Block ${lastBlock.block_name} (the last block) can be deleted first.`);
      return;
    }
    setDeleteSuccess(false);
    setDeleteTarget({ id, name: blockName });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
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
      // Trash-can animation plays over the dialog, then it closes
      setDeleteSuccess(true);
      reloadBlocks();
      setTimeout(() => {
        setDeleteTarget(null);
        setDeleteSuccess(false);
        toast.delete('Block deleted successfully.');
      }, 1300);
    } catch {
      toast.error('Network error. Please check your connection and try again.');
    } finally {
      setDeletingId(null);
    }
  }

  function toggleBlock(block: Block, on: boolean) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (on) next.add(block.id); else next.delete(block.id);
      return next;
    });
  }

  function toggleBlocks(list: Block[], on: boolean) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const b of list) { if (on) next.add(b.id); else next.delete(b.id); }
      return next;
    });
  }

  async function confirmBulkDelete() {
    const ids = selectedVisible.map(b => b.id);
    if (bulkDeleteLoading || ids.length === 0) return;
    setBulkDeleteLoading(true);
    try {
      const res = await fetch('/api/blocks', {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(res.status === 401
          ? 'Your session has expired. Please log in again and retry.'
          : data.error || 'Failed to delete blocks. Please try again.');
        return;
      }
      const count = data.deleted ?? ids.length;
      setBulkDeleteSuccess(true);
      reloadBlocks();
      setTimeout(() => {
        setBulkDeleteOpen(false);
        setBulkDeleteSuccess(false);
        setSelectedIds(new Set());
        toast.delete(`${count} block${count === 1 ? '' : 's'} deleted.`);
      }, 1300);
    } catch {
      toast.error('Network error. Please check your connection and try again.');
    } finally {
      setBulkDeleteLoading(false);
    }
  }

  // ── Derived values ────────────────────────────────────────────────────────

  const selectedProgram = programs.find(p => String(p.id) === form.program_id);
  const canPreview      = !!(form.program_id && form.curriculum_version && form.year_level && form.semester);

  // Curriculum must stay consistent across every block under the same Program +
  // Year Level + Semester + School Year — once one exists, later blocks for that
  // combo are locked to it; with none left, either curriculum can be picked.
  const sameCohort = blocks.filter(b =>
    String(b.program_id) === form.program_id && b.year_level === form.year_level &&
    b.semester === form.semester && b.academic_year === form.academic_year
  );
  const establishedCurriculum: CurriculumVersion | null =
    form.program_id && form.year_level && sameCohort[0]
      ? blockCurriculumVersion(sameCohort[0].curriculum_version)
      : null;
  const curriculumLocked = !editId && !!establishedCurriculum;

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
  const startIdx = nextCreatableBlock ? BLOCK_NAMES.indexOf(nextCreatableBlock) : -1;

  // Selection is always a consecutive run from the next available block, so the
  // A → B → C order can't be broken: "+" appends the next letter, and only the
  // last chip can be removed (at least one block always stays).
  const nextToAdd = startIdx < 0 ? undefined
    : BLOCK_NAMES[startIdx + selectedBlocks.length];
  const canAddBlock = !!nextToAdd && !existingBlockNames.has(nextToAdd);

  function addNextBlock() {
    if (!canAddBlock || !nextToAdd) return;
    setSelectedBlocks(prev => [...prev, nextToAdd]);
    setBlockExistsError(false); setBlockOrderError(null); setError('');
  }
  function removeLastBlock() {
    setSelectedBlocks(prev => (prev.length > 1 ? prev.slice(0, -1) : prev));
    setBlockExistsError(false); setBlockOrderError(null); setError('');
  }
  const selectionLabel = selectedBlocks.length === 0 ? ''
    : selectedBlocks.length === 1 ? `Block ${selectedBlocks[0]}`
    : `Block ${selectedBlocks[0]} – ${selectedBlocks[selectedBlocks.length - 1]}`;

  // Use the shared YEAR_LEVELS catalog (same as the create/edit modal) rather than
  // deriving options from `blocks`, so every year level is selectable up front.
  const yearOptions = YEAR_LEVELS.filter(y => !!y && YEAR_ORDER[y] != null);

  const filtered = blocks.filter(b => {
    if (yearFilter       && b.year_level    !== yearFilter)        return false;
    if (globalSemester   && b.semester      !== globalSemester)    return false;
    if (globalYear       && b.academic_year !== globalYear)        return false;
    if (search && !b.block_name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const groups          = buildGroups(filtered);
  /* Ticked blocks still shown (a deleted/reloaded block drops out on its own) */
  const selectedVisible    = filtered.filter(b => selectedIds.has(b.id));
  const allVisibleSelected = filtered.length > 0 && selectedVisible.length === filtered.length;
  // A different list → start a fresh selection
  useEffect(() => { setSelectedIds(new Set()); }, [programFilter, yearFilter, search, globalSemester, globalYear]);
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
    if (b.unassigned_count > 0) return { label: 'Needs Faculty', color: 'amber' as const, next: '/workload' };
    return { label: 'Needs Scheduling', color: 'blue' as const, next: '/scheduling' };
  }

  const modalFieldCls = 'w-full border border-[#E2E8F0] rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#1D5BD6]/40 focus:border-[#1D5BD6] bg-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

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

  const reduceMotion = useReducedMotion();
  const resultsKey = `${programFilter}|${yearFilter}|${globalSemester}|${globalYear}`;
  const resultsTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.42, ease: [0.16, 1, 0.3, 1] as const };

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
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between mb-2">
        <div className="min-w-0">
          <BackButton />
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
          style={canCreateBlock ? { backgroundColor: '#1D5BD6', color: '#ffffff' } : {}}
        >
          Create Block
        </button>
      </div>
      <div className="mt-4 sm:mt-7 mb-10">
        <WatermarkTitle>Block Creation</WatermarkTitle>
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
              <FriendlySelect
                value={programFilter}
                onChange={setProgramFilter}
                label="Program"
                placeholder="Select a program"
                guide={!programFilter}
                showHintInTrigger
                minPanelWidth={380}
                options={programs.map(p => ({ value: String(p.id), label: p.code, hint: p.name }))}
              />
            )}
          </div>

          {/* Year Level */}
          <div className="w-full sm:min-w-44 sm:w-auto">
            <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-slate-500">Year Level</label>
            <FriendlySelect
              value={yearFilter}
              onChange={setYearFilter}
              disabled={!programFilter}
              disabledText="Select a program first"
              label="Year Level"
              placeholder="Select year level"
              guide={!!programFilter && !yearFilter}
              minPanelWidth={220}
              options={yearOptions.map(y => ({ value: y, label: y }))}
            />
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
            <div className="text-2xl sm:text-3xl font-bold mb-1 text-[#0B2A5B]">{totalBlocks}</div>
            <div className="text-sm text-[#64748B]">Total Blocks</div>
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 text-center">
            <div className="text-2xl sm:text-3xl font-bold mb-1 text-[#0B2A5B]">{totalReady}</div>
            <div className="text-sm text-[#64748B]">Class Program Ready</div>
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 text-center">
            <div className="text-2xl sm:text-3xl font-bold mb-1 text-[#0B2A5B]">{totalInProgress}</div>
            <div className="text-sm text-[#64748B]">In Progress</div>
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-xl p-4 text-center">
            <div className="text-2xl sm:text-3xl font-bold mb-1 text-[#0B2A5B]">{totalNoSubjects}</div>
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

      <AnimatePresence mode="wait" initial={false}>
      {/* Main Content — missing filter prompt */}
      {filterPrompt && (
        <motion.div
          key="filter-prompt"
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
          transition={resultsTransition}
          className="bg-white border border-[#E2E8F0] rounded-2xl py-14 text-center shadow-sm"
        >
          <p className="text-sm" style={{ color: '#64748B' }}>{filterPrompt}</p>
        </motion.div>
      )}

      {/* Main Content — no blocks found */}
      {!filterPrompt && groups.length === 0 && (
        <motion.div
          key={`${resultsKey}|${search}|empty`}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: -8 }}
          transition={resultsTransition}
          className="bg-white border border-[#E2E8F0] rounded-2xl flex flex-col items-center justify-center py-20 text-center shadow-sm"
        >
          <p className="font-semibold text-base" style={{ color: '#0B2A5B' }}>No blocks found</p>
          {search ? (
            <p className="text-sm mt-1 mb-5" style={{ color: '#64748B' }}>No blocks match your search.</p>
          ) : (
            <p className="text-sm mt-1" style={{ color: '#64748B' }}>No blocks created for this combination yet.</p>
          )}
          {search && (
            <button
              onClick={() => setSearch('')}
              className="mt-4 border border-[#E2E8F0] px-5 py-2.5 rounded-xl hover:bg-[#F8FAFC] transition text-sm font-medium"
              style={{ color: '#64748B' }}
            >
              Clear search
            </button>
          )}
        </motion.div>
      )}

      {/* Main Content — groups list */}
      {!filterPrompt && groups.length > 0 && (
        <motion.div
          key={resultsKey}
          initial={reduceMotion ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? undefined : { opacity: 0, y: -10 }}
          transition={resultsTransition}
          className="space-y-6"
        >
          {groups.map(group => {
            const groupSelected = group.blocks.filter(b => selectedIds.has(b.id)).length;
            return (
            <div key={group.key} className="bg-white rounded-xl border border-[#E2E8F0] overflow-hidden">

              {/* Group header — calm surface + blue accent, not a saturated bar */}
              <div className="bg-[#1D5BD6] px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-base text-white leading-tight break-words">
                    {group.program} — {group.programName}
                  </div>
                  <div className="text-sm mt-0.5 font-medium text-white/85">
                    {group.yearLevel} &nbsp;·&nbsp; {group.semester} &nbsp;·&nbsp; {curriculumVersionLabel(group.curriculumVersion)}
                  </div>
                </div>
                <span className="self-start bg-white/20 text-white text-xs font-semibold px-3 py-1 rounded-full flex-shrink-0">
                  {group.blocks.length} block{group.blocks.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Table on all viewports — horizontal scroll only inside this container */}
              <div className="overflow-x-auto overscroll-x-contain">
                <table className="w-full text-sm min-w-[920px]">
                  <thead>
                    <tr className="border-b border-[color:var(--table-row-line)] bg-[#F8FAFC]">
                      <th className="pl-4 sm:pl-6 pr-1 py-2.5 w-10 text-left">
                        <SelectBox
                          checked={groupSelected === group.blocks.length}
                          indeterminate={groupSelected > 0}
                          onChange={on => toggleBlocks(group.blocks, on)}
                          label={`Select all ${group.program} ${group.yearLevel} blocks`}
                        />
                      </th>
                      <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap min-w-[11rem] text-[#64748B]">Block</th>
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
                      const canDelete         = isLastBlock;
                      const readinessColor    = ready.color === 'blue' ? '#1D5BD6' : undefined;
                      const lastBlockName     = sortedGroupBlocks[sortedGroupBlocks.length - 1].block_name;

                      return (
                        <tr
                          key={b.id}
                          className={`transition-colors ${selectedIds.has(b.id) ? 'bg-[#EFF6FF] hover:bg-[#E0EDFF]' : 'hover:bg-[#F8FAFC]'}`}
                        >
                          <td className="pl-4 sm:pl-6 pr-1 py-4 align-middle">
                            <SelectBox
                              checked={selectedIds.has(b.id)}
                              onChange={on => toggleBlock(b, on)}
                              label={`Select Block ${b.block_name}`}
                            />
                          </td>
                          <td className="px-3 py-4 align-middle whitespace-nowrap">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-base flex-shrink-0 bg-[#EFF6FF]" style={{ color: '#1D5BD6' }}>
                                {b.block_name}
                              </div>
                              <div>
                                <div className="font-bold" style={{ color: '#0B2A5B' }}>Block {b.block_name}</div>
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
                                  <span className="inline-flex items-center gap-1 bg-[#EFF6FF] border border-[#BFDBFE] text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ color: '#1D5BD6' }}>
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
                                <ViewLinkIcon /> View
                              </Link>
                              <button
                                type="button"
                                onClick={() => openEdit(b)}
                                className="inline-flex items-center justify-center gap-1.5 px-3 min-h-11 text-sm font-semibold bg-[#EFF6FF] hover:bg-[#DBEAFE] border border-[#BFDBFE] rounded-xl transition"
                                style={{ color: '#1D5BD6' }}
                              >
                                <Pencil className="w-4 h-4" /> Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => { if (canDelete && deletingId === null) handleDelete(b.id, b.block_name, group.blocks); }}
                                disabled={!canDelete || deletingId !== null}
                                className={`inline-flex items-center justify-center min-h-11 min-w-11 rounded-xl transition ${canDelete && deletingId === null ? 'hover:bg-red-50' : 'opacity-30 cursor-not-allowed'}`}
                                style={{ color: '#EF4444' }}
                                title={
                                  deletingId === b.id ? 'Deleting…'
                                  : !isLastBlock ? `Delete Block ${lastBlockName} first`
                                  : 'Delete block'
                                }
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
            );
          })}

          <div className="text-xs text-right pr-1" style={{ color: '#94A3B8' }}>
            Showing {filtered.length} block{filtered.length !== 1 ? 's' : ''} in {groups.length} group{groups.length !== 1 ? 's' : ''}
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      </PageLoadTransition>
      </PageLoadTransition>

      {/* Create / Edit Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editId ? 'Edit Block' : 'Create New Block'} headerAccent>
        {saveSuccess && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-[#111827] border border-white/10 shadow-2xl">
              <svg width="72" height="72" viewBox="0 0 52 52">
                <circle
                  className="save-success-circle"
                  cx="26" cy="26" r="24"
                  fill="none" stroke="#22C55E" strokeWidth="3"
                />
                <path
                  className="save-success-check"
                  fill="none" stroke="#22C55E" strokeWidth="3.5"
                  strokeLinecap="round" strokeLinejoin="round"
                  d="M14.5 27 22 34.5 38 17"
                />
              </svg>
              <p className="text-base font-semibold text-white">
                {editId ? 'Block updated!' : createdCount > 1 ? `${createdCount} blocks created!` : 'Block created!'}
              </p>
            </div>
          </div>
        )}
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

          {/* Program & Curriculum */}
          <div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>Program *</label>
                {isChair || editId ? (
                  <div className={`${modalFieldCls} bg-slate-50 cursor-default select-none`} style={{ color: '#0B2A5B' }}>
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
                    style={{ color: '#0B2A5B' }}
                  >
                    <option value="">— Select Program —</option>
                    {programs.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
                  </select>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>Curriculum *</label>
                {editId || curriculumLocked ? (
                  <div className={`${modalFieldCls} bg-slate-50 cursor-default select-none`} style={{ color: '#0B2A5B' }}>
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
                    style={{ color: '#0B2A5B' }}
                  >
                    <option value="">— Select Curriculum —</option>
                    {(['new', 'old'] as const).map(v => (
                      <option key={v} value={v}>{curriculumVersionLabel(v)}</option>
                    ))}
                  </select>
                )}
                {curriculumLocked && (
                  <p className="text-[11px] mt-1" style={{ color: '#94A3B8' }}>
                    Locked to{' '}
                    <span className="font-semibold" style={{ color: '#64748B' }}>
                      {curriculumVersionLabel(form.curriculum_version as CurriculumVersion)}
                    </span>{' '}— {selectedProgram?.code} {form.year_level}, {form.semester} already has{' '}
                    {sameCohort.length} {sameCohort.length === 1 ? 'block' : 'blocks'} using it. Delete them to switch curriculum.
                  </p>
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
                    style={{ color: '#0B2A5B' }}
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
                    style={{ color: '#0B2A5B' }}
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
              {canPreview ? (
                <div className="bg-[#1D5BD6] px-4 py-3">
                  <div className="font-bold text-sm text-white leading-tight break-words">
                    {selectedProgram?.code} — {selectedProgram?.name}
                  </div>
                  <div className="text-xs mt-0.5 font-medium text-white/85">
                    {form.year_level} &nbsp;·&nbsp; {form.semester} &nbsp;·&nbsp; {curriculumVersionLabel(form.curriculum_version as CurriculumVersion)}
                  </div>
                </div>
              ) : (
                <div className="px-4 py-2.5 border-b border-[#F1F5F9]" style={{ backgroundColor: '#F8FAFC' }}>
                  <span className="font-semibold text-sm" style={{ color: '#0B2A5B' }}>Subjects that will be loaded into this block</span>
                </div>
              )}
              {!canPreview ? (
                <div className="px-4 py-5 text-center text-sm" style={{ color: '#94A3B8' }}>
                  Select Program, Curriculum, Year Level, and Semester above to preview subjects.
                </div>
              ) : previewLoading ? (
                <div className="px-4 py-5 flex justify-center">
                  <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#1D5BD6', borderTopColor: 'transparent' }} />
                </div>
              ) : previewSubjects.length === 0 ? (
                <div className="px-4 py-5 text-center">
                  <AlertTriangle className="w-5 h-5 text-amber-500 mx-auto mb-2" />
                  <p className="text-sm font-medium text-amber-700">No curriculum subjects found for</p>
                  <p className="text-sm text-amber-600 font-semibold mt-1">
                    {selectedProgram?.code} — {form.curriculum_version ? curriculumVersionLabel(form.curriculum_version) : ''} — {form.year_level}, {form.semester}
                  </p>
                  <Link
                    href="/program/curriculum"
                    onClick={() => setModalOpen(false)}
                    className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium hover:underline"
                    style={{ color: '#1D5BD6' }}
                  >
                    <BookOpen className="w-4 h-4" /> Set up curriculum subjects first
                  </Link>
                </div>
              ) : (
                <>
                  <div className="px-4 py-2 bg-[#ECFDF5] border-b border-[#F1F5F9] text-sm text-emerald-700">
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
                            <td className="px-3 py-2 font-mono font-semibold" style={{ color: '#0B2A5B' }}>{s.subject_code}</td>
                            <td className="px-3 py-2" style={{ color: '#64748B' }}>{s.subject_name}</td>
                            <td className="px-3 py-2 text-center" style={{ color: '#64748B' }}>{s.lecture_hours}</td>
                            <td className="px-3 py-2 text-center" style={{ color: '#64748B' }}>{s.laboratory_hours}</td>
                            <td className="px-3 py-2 text-center" style={{ color: '#64748B' }}>{parseFloat(String(s.total_hours)).toFixed(1)}</td>
                            <td className="px-3 py-2 text-center font-bold" style={{ color: '#1D5BD6' }}>{parseFloat(String(s.units)).toFixed(2)}</td>
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
            <div className={`grid gap-3 ${editId ? 'grid-cols-3' : 'grid-cols-2'}`}>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>Academic Year *</label>
                <input
                  type="text"
                  value={form.academic_year}
                  onChange={e => { setForm(f => ({ ...f, academic_year: e.target.value })); setBlockExistsError(false); setError(''); }}
                  required
                  placeholder="2025-2026"
                  className={modalFieldCls}
                  style={{ color: '#0B2A5B' }}
                />
              </div>
              {editId && (
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>Block Name *</label>
                <select
                  value={form.block_name}
                  onChange={e => { setForm(f => ({ ...f, block_name: e.target.value })); setBlockExistsError(false); setBlockOrderError(null); setError(''); }}
                  required
                  className={modalFieldCls}
                  style={{ color: '#0B2A5B' }}
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
              )}
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: '#64748B' }}>
                  {editId ? 'No. of Students *' : 'Students per Block *'}
                </label>
                <input
                  type="number"
                  min="1"
                  value={form.number_of_students}
                  onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v > 0) setForm(f => ({ ...f, number_of_students: v })); }}
                  required
                  className={modalFieldCls}
                  style={{ color: '#0B2A5B' }}
                />
              </div>
            </div>

            {/* Multi-select: create several consecutive blocks in one save */}
            {!editId && (
              <div className="mt-4">
                <div className="flex items-baseline justify-between gap-2 mb-1.5">
                  <label className="block text-sm font-medium" style={{ color: '#64748B' }}>Blocks to Create *</label>
                  {selectedBlocks.length > 0 && (
                    <span className="text-xs font-semibold" style={{ color: '#1D5BD6' }}>
                      {selectedBlocks.length} selected · {selectionLabel}
                    </span>
                  )}
                </div>
                {nextCreatableBlock ? (
                  <>
                    <motion.div layout className="flex flex-wrap items-center gap-2" role="group" aria-label="Blocks to create">
                      <AnimatePresence initial={false}>
                        {selectedBlocks.map((b, i) => {
                          const isLast = i === selectedBlocks.length - 1;
                          const removable = isLast && selectedBlocks.length > 1;
                          return (
                            <motion.div
                              key={b}
                              layout
                              initial={reduceMotion ? false : { opacity: 0, scale: 0.6, x: -8 }}
                              animate={{ opacity: 1, scale: 1, x: 0 }}
                              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                              transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 30 }}
                              className="relative inline-flex items-center gap-1.5 h-11 pl-3.5 pr-2 rounded-xl bg-[#EFF6FF] border border-[#BFDBFE]"
                            >
                              <span className="w-7 h-7 rounded-lg bg-[#1D5BD6] text-white text-sm font-bold flex items-center justify-center">{b}</span>
                              <span className="text-sm font-semibold pr-1" style={{ color: '#0B2A5B' }}>Block {b}</span>
                              {removable && (
                                <button
                                  type="button"
                                  onClick={removeLastBlock}
                                  className="w-6 h-6 rounded-md flex items-center justify-center text-[#64748B] hover:text-red-500 hover:bg-red-50 transition-colors"
                                  aria-label={`Remove Block ${b}`}
                                  title={`Remove Block ${b}`}
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </motion.div>
                          );
                        })}
                      </AnimatePresence>

                      {canAddBlock && (
                        <motion.button
                          layout
                          type="button"
                          onClick={addNextBlock}
                          whileTap={reduceMotion ? undefined : { scale: 0.9 }}
                          transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 30 }}
                          className="inline-flex items-center gap-1.5 h-11 px-3.5 rounded-xl border border-dashed border-[#93C5FD] text-sm font-semibold hover:bg-[#EFF6FF] hover:border-[#1D5BD6] transition-colors"
                          style={{ color: '#1D5BD6' }}
                          aria-label={`Add Block ${nextToAdd}`}
                          title={`Add Block ${nextToAdd}`}
                        >
                          <Plus className="w-4 h-4" /> Block {nextToAdd}
                        </motion.button>
                      )}
                    </motion.div>
                    <p className="text-[11px] mt-1.5" style={{ color: '#94A3B8' }}>
                      Click <span className="font-semibold" style={{ color: '#64748B' }}>+</span> to add the next block. All blocks are saved together.
                    </p>
                  </>
                ) : BLOCK_NAMES.every(b => existingBlockNames.has(b)) ? (
                  <p className="text-[11px] text-amber-600 font-medium">All block names (A–Z) have already been created for this combination.</p>
                ) : (
                  <p className="text-[11px]" style={{ color: '#94A3B8' }}>Select Program, Curriculum, Year Level, and Semester first.</p>
                )}
              </div>
            )}
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
                <p className="text-amber-700 text-sm mt-0.5">{error || 'Try choosing a different Block Name (e.g., Block B) or a different Academic Year.'}</p>
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
              disabled={loading || (!editId && canPreview && previewSubjects.length === 0) || previewLoading || (!editId && (selectedBlocks.length === 0 || !isBlockCreatable(selectedBlocks[0])))}
              className="flex-1 text-white py-2.5 rounded-xl disabled:opacity-50 transition text-sm font-semibold flex items-center justify-center gap-2 hover:opacity-90"
              style={{ backgroundColor: '#1D5BD6' }}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  {editId ? 'Updating block…' : selectedBlocks.length > 1 ? `Creating ${selectedBlocks.length} blocks…` : 'Creating block…'}
                </>
              ) : editId ? (
                'Update Block'
              ) : (
                `${selectedBlocks.length > 1 ? `Create ${selectedBlocks.length} Blocks` : 'Create Block'}${previewSubjects.length > 0 ? ` · ${previewSubjects.length} subjects${selectedBlocks.length > 1 ? ' each' : ''}` : ''}`
              )}
            </button>
          </div>

        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={!!deleteTarget}
        onClose={() => { if (deletingId === null && !deleteSuccess) setDeleteTarget(null); }}
        title="Delete Block"
      >
        {deleteSuccess && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl">
              <TrashDropAnimation className="bg-red-50 border-red-200" />
              <p className="text-base font-semibold" style={{ color: '#0B2A5B' }}>Block {deleteTarget?.name} deleted!</p>
            </div>
          </div>
        )}
        {deleteTarget && (
          <div className="space-y-5">
            <div className="flex flex-col items-center text-center gap-3 pt-1">
              <div className="w-16 h-16 rounded-2xl bg-red-50 border border-red-200 flex items-center justify-center">
                <Trash2 className="w-8 h-8 text-red-500" />
              </div>
              <div>
                <p className="text-base font-bold" style={{ color: '#0B2A5B' }}>Delete Block {deleteTarget.name}?</p>
                <p className="text-sm mt-1" style={{ color: '#64748B' }}>This action cannot be undone. You can re-create the block afterwards.</p>
              </div>
            </div>

            <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 space-y-2">
              <p className="text-xs font-bold text-red-600 uppercase tracking-wide mb-2">The following will be permanently removed:</p>
              {[
                'Loaded subjects (block subjects)',
                'Master schedule entries',
                'Faculty load assignments',
              ].map(item => (
                <div key={item} className="flex items-center gap-2.5 text-sm text-red-700">
                  <Trash2 className="w-3.5 h-3.5 flex-shrink-0 text-red-500" />
                  {item}
                </div>
              ))}
            </div>

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deletingId !== null}
                className="flex-1 border border-[#E2E8F0] py-2.5 rounded-xl hover:bg-[#F8FAFC] transition text-sm font-medium disabled:opacity-50"
                style={{ color: '#64748B' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deletingId !== null}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl transition text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {deletingId !== null
                  ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Deleting…</>
                  : <><Trash2 className="w-4 h-4" /> Delete Block {deleteTarget.name}</>}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Selection bar (Gmail-style) — slides up while blocks are ticked */}
      <AnimatePresence>
        {selectedVisible.length > 0 && !bulkDeleteOpen && (
          <motion.div
            key="block-selection-bar"
            initial={reduceMotion ? false : { opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
            transition={{ duration: reduceMotion ? 0 : 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-2rem)] max-w-xl"
          >
            <div className="flex items-center gap-3 bg-[#0B2A5B] rounded-2xl shadow-xl pl-5 pr-2 py-2">
              <span className="text-base font-semibold flex-1" style={{ color: '#FFFFFF' }}>
                {selectedVisible.length} selected
              </span>
              {!allVisibleSelected && (
                <button
                  type="button"
                  onClick={() => toggleBlocks(filtered, true)}
                  className="px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-white/10 transition whitespace-nowrap"
                  style={{ color: '#FFFFFF' }}
                >
                  Select all {filtered.length}
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-white/10 transition"
                style={{ color: '#FFFFFF' }}
              >
                Clear
              </button>
              <motion.button
                type="button"
                onClick={() => { setBulkDeleteSuccess(false); setBulkDeleteOpen(true); }}
                whileTap={reduceMotion ? undefined : { scale: 0.97 }}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-sm font-semibold transition"
                style={{ color: '#FFFFFF' }}
              >
                <Trash2 className="w-4 h-4" /> Delete
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Selected Blocks Modal */}
      <Modal
        open={bulkDeleteOpen}
        onClose={() => { if (!bulkDeleteLoading && !bulkDeleteSuccess) setBulkDeleteOpen(false); }}
        title="Delete Blocks"
      >
        {bulkDeleteSuccess && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-2xl backdrop-blur-md save-success-overlay">
            <div className="save-success-badge flex flex-col items-center gap-3 px-8 py-7 rounded-2xl bg-white border border-[#E2E8F0] shadow-2xl">
              <TrashDropAnimation className="bg-red-50 border-red-200" />
              <p className="text-base font-semibold" style={{ color: '#0B2A5B' }}>Blocks deleted!</p>
            </div>
          </div>
        )}
        <div className="space-y-5">
          <div className="flex flex-col items-center text-center gap-3 pt-1">
            <div className="w-16 h-16 rounded-2xl bg-red-50 border border-red-200 flex items-center justify-center">
              <Trash2 className="w-8 h-8 text-red-500" />
            </div>
            <div>
              <p className="text-base font-bold" style={{ color: '#0B2A5B' }}>
                Delete {selectedVisible.length} block{selectedVisible.length === 1 ? '' : 's'}?
              </p>
              <p className="text-sm mt-1" style={{ color: '#64748B' }}>
                {buildGroups(selectedVisible).map(g =>
                  `${g.program} ${g.yearLevel}: ${[...g.blocks].sort((a, b) => a.block_name.localeCompare(b.block_name)).map(b => b.block_name).join(', ')}`,
                ).join(' · ')}
              </p>
              <p className="text-sm mt-2" style={{ color: '#64748B' }}>This action cannot be undone. You can re-create the blocks afterwards.</p>
            </div>
          </div>

          <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 space-y-2">
            <p className="text-xs font-bold text-red-600 uppercase tracking-wide mb-2">The following will be permanently removed:</p>
            {[
              'Loaded subjects (block subjects)',
              'Master schedule entries',
              'Faculty load assignments',
            ].map(item => (
              <div key={item} className="flex items-center gap-2.5 text-sm text-red-700">
                <Trash2 className="w-3.5 h-3.5 flex-shrink-0 text-red-500" />
                {item}
              </div>
            ))}
          </div>

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={bulkDeleteLoading || bulkDeleteSuccess}
              className="flex-1 border border-[#E2E8F0] py-2.5 rounded-xl hover:bg-[#F8FAFC] transition text-sm font-medium disabled:opacity-50"
              style={{ color: '#64748B' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmBulkDelete}
              disabled={bulkDeleteLoading || bulkDeleteSuccess}
              className="flex-1 py-2.5 bg-red-600 hover:bg-red-700 rounded-xl transition text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
              style={{ color: '#FFFFFF' }}
            >
              {bulkDeleteLoading
                ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Deleting…</>
                : <><Trash2 className="w-4 h-4" /> Delete {selectedVisible.length}</>}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
