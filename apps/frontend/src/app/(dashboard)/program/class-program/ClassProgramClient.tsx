'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, Printer, RotateCcw, Settings2, UserRound } from 'lucide-react';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useRealtime } from '@/context/RealtimeContext';
import { fetchDayCombinations, useDayCombinations } from '@/lib/dayCombinations';
import { blockCurriculumVersion, curriculumVersionLabel } from '@shared/curriculumVersion';
import {
  DEFAULT_COORDINATORS, EMPTY_SIGNATORY, downloadClassProgramExcel, expandToDisplayRows, fetchClassProgram, fmt12, fmtNum,
  formatCourseLabel, formatTimeRange, groupByDay, isAM, programKey,
  type BlockDetail, type DayGroup, type DisplayRow, type RawSchedule, type Signatory,
} from './classProgramReport';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import FriendlySelect from '@/components/ui/FriendlySelect';
import { BlockBadge } from '@/components/OfficialWorkloadFormTable';
import { FilterBar, SF_INPUT } from '@/components/ui/SearchFilter';
import { DocumentSkeleton, Skeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { isScopedChairRole } from '@/lib/roleAccess';
import {
  DEFAULT_FOOTER_CONFIG,
  NEMSU_OFFICIAL_DEPT,
  formatAy,
  officialPrintEmbeddedDocumentCss,
  officialPrintPreviewShellCss,
  semesterHeading,
} from '@/lib/nemsuOfficialPrintChrome';
import { useLivePrograms } from '@/hooks/useLivePrograms';

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface Program { id: number; code: string; name: string; department?: string; }
interface Block {
  id: number; block_name: string; year_level: string; semester: string;
  academic_year: string; program_id: number; program_code: string; program_name: string;
  subject_count: number; unassigned_count: number; assigned_count: number; scheduled_count: number;
  curriculum_version?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** "2nd Year" → "2" (Year & Block labels read 1A, 1B, 2A… as on Faculty Workload) */
function yearNum(yearLevel: string): string {
  const m = yearLevel.match(/\d+/);
  return m ? m[0] : yearLevel;
}

/** Same label style as Blocks / Faculty Workload filter rows */
const LABEL_CLS = 'block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5';

/* Phones: the three actions share one row of equal buttons */
const BTN_BASE =
  'inline-flex items-center justify-center gap-2 max-sm:w-full max-sm:min-h-[44px] max-sm:px-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60';
const BTN_SECONDARY =
  `${BTN_BASE} bg-white border border-[#E5E7EB] text-[#374151] hover:border-[#1D5BD6] hover:text-[#164BB5] hover:bg-[#F9FAFB] active:bg-[#EFF6FF]`;
const BTN_PRIMARY =
  `${BTN_BASE} bg-[#164BB5] !text-white hover:bg-[#1D4ED8] active:bg-[#1E40AF] shadow-sm`;



// ─── Print CSS — Faculty Workload official chrome + Class Program preview ─────

const PRINT_CSS = `
${officialPrintEmbeddedDocumentCss()}
${officialPrintPreviewShellCss()}
/* Screen only: the schedule's header row stays visible while scrolling.
   Solid background + drawn borders so it never looks transparent or covers
   rows unevenly (collapsed borders don't travel with sticky cells). */
@media screen {
  .cp-shell .wl.cp-sticky-head thead th {
    position: sticky;
    top: 0;
    z-index: 5;
    background: #fff;
    box-shadow: inset 0 1px 0 #222, inset 0 -1px 0 #222, 0 2px 4px -2px rgba(15, 23, 42, 0.25);
  }
}
/* Phones and tablets read the class cards; the paper form is for wide screens
   and for printing (print is not a screen, so it still prints from a phone). */
@media screen and (max-width: 1023.98px) {
  .cp-doc { display: none !important; }
}
/* "BSIT 1A" stays on one line, as on Faculty Workload */
.cp-shell .wl td.t-course { white-space: nowrap; }
`;

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ClassProgramPage() {
  const { semester: globalSemester, schoolYear: globalYear, loading: semLoading } = useSchoolYear();
  const { active: dayCombos } = useDayCombinations(globalSemester, globalYear);

  // ── Abort controllers ─────────────────────────────────────────────────────
  const blocksAbortRef = useRef<AbortController | null>(null);
  const docAbortRef    = useRef<AbortController | null>(null);
  /** Queries of the block list / document on screen (live updates re-use them) */
  const blocksQuery    = useRef('');
  const docQuery       = useRef('');

  // ── Programs (loaded once — just need the list for the dropdown) ──────────
  const [programs, setPrograms] = useState<Program[]>([]);
  useLivePrograms(setPrograms);
  const [isChair, setIsChair] = useState(false);
  const [chairProgramId, setChairProgramId] = useState<number | null>(null);
  const [chairNoProgram, setChairNoProgram] = useState(false);
  /** Programs and role still loading — the page shows its skeleton */
  const [booting, setBooting] = useState(true);

  // Single source of truth for Program → Year & Block. One pick (e.g. "1A")
  // sets both the block and its year level, as on Faculty Workload.
  const [filterProgram,   setFilterProgram]   = useState('');
  const [filterYearLevel, setFilterYearLevel] = useState('');
  const [selectedBlockId, setSelectedBlockId] = useState('');

  /* Reports → Class Program → Print opens this page in a new tab with
     ?program=&year=&block=&action=print — preselect those and print once the
     document is ready. (notifyReports only matters if the page is framed.) */
  const pendingRef = useRef<{ block: string; action: 'print' | 'excel' } | null>(null);
  function notifyReports(status: 'done' | 'error', message = '') {
    if (window.parent !== window) {
      window.parent.postMessage({ source: 'qrganize-class-program', status, message }, window.location.origin);
    }
  }
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const program = sp.get('program');
    const year = sp.get('year');
    const block = sp.get('block');
    const action = sp.get('action');
    if (!program || !year || !block || (action !== 'print' && action !== 'excel')) return;
    pendingRef.current = { block, action };
    setFilterProgram(program);
    setFilterYearLevel(year);
  }, []);

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
        const list: Program[] = progData.programs || [];
        setPrograms(list);
        if (isScopedChairRole(meData.user?.role)) {
          setIsChair(true);
          const pid = meData.user.program_id != null ? Number(meData.user.program_id) : null;
          if (pid == null) {
            setChairNoProgram(true);
            setChairProgramId(null);
          } else {
            setChairProgramId(pid);
            setChairNoProgram(false);
            setFilterProgram(String(pid));
          }
        }
      } catch { /* non-critical */ }
      finally { if (!cancelled) setBooting(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const lockedProgram = isChair
    ? programs.find(p => p.id === chairProgramId) ?? null
    : null;

  // ── Blocks — loaded lazily only when program + year level + semester ready ─
  const [blocks,        setBlocks]        = useState<Block[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [blocksError,   setBlocksError]   = useState('');

  // ── Document state ─────────────────────────────────────────────────────────
  const [blockDetail, setBlockDetail] = useState<BlockDetail | null>(null);
  const [schedules,   setSchedules]   = useState<RawSchedule[]>([]);
  const [hasLoaded,   setHasLoaded]   = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [loadError,   setLoadError]   = useState('');

  // ── Document settings — persisted in localStorage so they survive refreshes ─
  const LS_KEY = 'cp_doc_settings_v2'; // v2: earlier saved signatories were blank or shifted
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw) as Record<string, string>;
    } catch { /* ignore */ }
    return null;
  }
  const saved = loadSettings();
  const [campusName,    setCampusName]    = useState(saved?.campusName    || 'Cantilan Campus');
  const [campusAddress, setCampusAddress] = useState(saved?.campusAddress || 'Cantilan, Surigao del Sur');
  const [campusTel,     setCampusTel]     = useState(saved?.campusTel     || '086-212-5122');
  const [campusWebsite, setCampusWebsite] = useState(saved?.campusWebsite || 'www.nemsu.edu.ph');
  // "Prepared by" is the Program Coordinator — one per program, editable.
  const COORD_LS_KEY = 'cp_prepared_by_program';
  const [coordinatorEdits, setCoordinatorEdits] = useState<Record<string, Signatory>>(() => {
    try {
      const raw = localStorage.getItem(COORD_LS_KEY);
      if (raw) return JSON.parse(raw) as Record<string, Signatory>;
    } catch { /* ignore */ }
    return {};
  });
  const [recommendedBy, setRecommendedBy] = useState<Signatory>({
    name:        saved?.recommendedByName  || 'RAMONALIZA A. ESPENIDO, MST-SS',
    designation: saved?.recommendedByDesig || 'Registrar III',
  });
  const [notedBy, setNotedBy] = useState<Signatory>({
    name:        saved?.notedByName  || 'ENGR. NELYNE LOURDES Y. PLAZA, Ph.D.',
    designation: saved?.notedByDesig || 'Dept. Chair, Dept. of Computer Studies',
  });
  const [approvedBy, setApprovedBy] = useState<Signatory>({
    name:        saved?.approvedByName  || 'JUANCHO A. INTANO, Ph.D.',
    designation: saved?.approvedByDesig || 'Campus Director',
  });
  const [showSettings,  setShowSettings]  = useState(false);

  // Persist to localStorage whenever any setting changes
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        campusName, campusAddress, campusTel, campusWebsite,
        recommendedByName:   recommendedBy.name,
        recommendedByDesig:  recommendedBy.designation,
        notedByName:         notedBy.name,
        notedByDesig:        notedBy.designation,
        approvedByName:      approvedBy.name,
        approvedByDesig:     approvedBy.designation,
      }));
    } catch { /* ignore */ }
  }, [campusName, campusAddress, campusTel, campusWebsite,
      recommendedBy, notedBy, approvedBy]);

  useEffect(() => {
    try { localStorage.setItem(COORD_LS_KEY, JSON.stringify(coordinatorEdits)); } catch { /* ignore */ }
  }, [coordinatorEdits]);

  const selectedProgramCode =
    programs.find(p => String(p.id) === filterProgram)?.code ?? blockDetail?.program_code ?? '';
  const coordKey = programKey(selectedProgramCode);
  const defaultCoordinator = DEFAULT_COORDINATORS[coordKey] ?? EMPTY_SIGNATORY;
  const preparedBy: Signatory = coordinatorEdits[coordKey] ?? defaultCoordinator;
  const coordinatorEdited = coordKey in coordinatorEdits;
  function setPreparedBy(update: (s: Signatory) => Signatory) {
    if (!coordKey) return;
    setCoordinatorEdits(m => ({ ...m, [coordKey]: update(m[coordKey] ?? defaultCoordinator) }));
  }
  function resetPreparedBy() {
    setCoordinatorEdits(m => {
      const next = { ...m };
      delete next[coordKey];
      return next;
    });
  }

  // ── Derived guard: all user selections must be present ────────────────────
  // Semester is automatic (from SchoolYearContext) — not a user selection.
  // Program and Year & Block are the user's choices (the block brings its year level).
  const selectionComplete =
    !!filterProgram && !!filterYearLevel && !!selectedBlockId && !!globalSemester && !!globalYear;

  // ── Cascade handler: Program changed ────────────────────────────────────
  function handleProgramChange(val: string) {
    setFilterProgram(val);
    setFilterYearLevel('');   // clear child
    setSelectedBlockId('');
    setBlocks([]);            // clear block list
  }

  // ── Cascade handler: Year & Block picked — fills both ────────────────────
  function handleYearBlockChange(blockId: string) {
    const block = blocks.find(b => String(b.id) === blockId);
    // Unknown id → clear both, so year level and block never disagree
    setFilterYearLevel(block?.year_level ?? '');
    setSelectedBlockId(block ? blockId : '');
    // document will re-fetch via useEffect
  }

  // ── Effect: Lazily load the program's blocks for the active term ─────────
  useEffect(() => {
    // Clear selection and list whenever parent context changes
    setSelectedBlockId('');
    setFilterYearLevel('');

    if (!filterProgram || !globalSemester || !globalYear) {
      blocksAbortRef.current?.abort();
      blocksQuery.current = '';
      setBlocks([]);
      setBlocksLoading(false);
      setBlocksError('');
      return;
    }

    blocksAbortRef.current?.abort();
    const controller = new AbortController();
    blocksAbortRef.current = controller;

    setBlocksLoading(true);
    setBlocksError('');
    setBlocks([]);

    // Every year level at once — the Year & Block list runs 1A, 1B, 2A…
    const params = new URLSearchParams({
      program_id:   filterProgram,
      semester:     globalSemester,
      academic_year: globalYear,
    });
    blocksQuery.current = params.toString();

    fetch(`/api/blocks?${params}`, { signal: controller.signal })
      .then(r => r.json().then(data => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (controller.signal.aborted) return;
        if (!ok) {
          setBlocksError(data.error || 'Failed to load blocks.');
          if (pendingRef.current) { pendingRef.current = null; notifyReports('error', data.error || 'Failed to load blocks.'); }
          return;
        }
        const list: Block[] = data.blocks || [];
        setBlocks(list);
        // Deep link: select the requested block (and its year level) once the list is in
        const pending = pendingRef.current;
        if (pending) {
          const hit = list.find(b => String(b.id) === pending.block);
          if (hit) { setFilterYearLevel(hit.year_level); setSelectedBlockId(pending.block); }
          else { pendingRef.current = null; notifyReports('error', 'That block was not found for the active semester.'); }
        }
      })
      .catch(err => {
        if (err.name !== 'AbortError') setBlocksError('Connection error loading blocks.');
      })
      .finally(() => { if (!controller.signal.aborted) setBlocksLoading(false); });

    return () => { controller.abort(); };
  }, [filterProgram, globalSemester, globalYear]);

  // ── Effect: Load document when ALL selections are complete ───────────────
  useEffect(() => {
    // Guard: all three user selections + active semester/year are required
    if (!filterProgram || !filterYearLevel || !selectedBlockId || !globalSemester || !globalYear) {
      docAbortRef.current?.abort();
      docQuery.current = '';
      setBlockDetail(null);
      setSchedules([]);
      setHasLoaded(false);
      setLoadError('');
      setLoading(false);
      return;
    }

    docAbortRef.current?.abort();
    const controller = new AbortController();
    docAbortRef.current = controller;

    setLoading(true);
    setLoadError('');
    setBlockDetail(null);
    setSchedules([]);
    setHasLoaded(false);

    // Send all required params — the API validates each one server-side
    const params = new URLSearchParams({
      block_id:   selectedBlockId,
      program_id: filterProgram,
      year_level: filterYearLevel,
      semester:   globalSemester,
    });
    docQuery.current = params.toString();

    fetch(`/api/class-program?${params}`, { signal: controller.signal })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (controller.signal.aborted) return;
        if (!ok) {
          setLoadError(data.error || 'Failed to load class program.');
          if (pendingRef.current) { pendingRef.current = null; notifyReports('error', data.error || 'Failed to load class program.'); }
          return;
        }
        setBlockDetail(data.block);
        setSchedules(data.schedules || []);
        setHasLoaded(true);
      })
      .catch(err => {
        if (err.name !== 'AbortError') setLoadError('Connection error. Please try again.');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => { controller.abort(); };
  }, [filterProgram, filterYearLevel, selectedBlockId, globalSemester, globalYear]);

  // ── Live updates: schedules, instructors or rooms changed elsewhere ───────
  // The open document and the block list reload quietly — no skeleton, the
  // selections and print settings stay. Answers for older selections are dropped.
  useRealtime(['schedule', 'workload', 'blocks', 'rooms'], () => {
    const docQ = docQuery.current;
    const blocksQ = blocksQuery.current;
    return Promise.all([
      docQ && fetch(`/api/class-program?${docQ}`)
        .then(res => (res.ok ? res.json() : null))
        .then(data => {
          if (!data || docQuery.current !== docQ) return;
          setBlockDetail(data.block);
          setSchedules(data.schedules || []);
        })
        .catch(() => {}),
      blocksQ && fetch(`/api/blocks?${blocksQ}`)
        .then(r => (r.ok ? r.json() : null))
        .then(data => { if (data && blocksQuery.current === blocksQ) setBlocks(data.blocks || []); })
        .catch(() => {}),
    ]);
  }, { enabled: !loading && !blocksLoading });

  // ── Derived display data ──────────────────────────────────────────────────
  const displayRows     = expandToDisplayRows(schedules);
  const scheduledRows   = displayRows.filter(r => r.day_pattern !== 'TBA');
  const unscheduledRows = displayRows.filter(r => r.day_pattern === 'TBA');
  const dayGroups       = groupByDay(scheduledRows, dayCombos);
  const totalUnits      = scheduledRows.reduce((s, r) => s + r.row_units, 0);
  const totalHours      = scheduledRows.reduce((s, r) => s + r.row_hours, 0);

  // Document and actions ONLY shown when all selections are complete + data loaded
  const showDocument = selectionComplete && hasLoaded && !!blockDetail;
  const showActions  = showDocument && !loading;
  // Page and document skeletons — the same time as every other page
  const showPageSkeleton = useMinLoading(booting, LOADING_DELAY);
  const showSkeleton = useMinLoading(loading, LOADING_DELAY);

  // ── Prompt state helpers ─────────────────────────────────────────────────
  function promptStep(): 'no-semester' | 'no-program' | 'no-block' | 'ready' {
    if (!globalSemester && !semLoading) return 'no-semester';
    if (!filterProgram) return 'no-program';
    if (!selectedBlockId || !filterYearLevel) return 'no-block';
    return 'ready';
  }
  const step = promptStep();

  /* Year & Block options: the program's blocks in the active term, 1A, 1B, 2A… */
  const blockOptions = [...blocks]
    .sort((a, b) =>
      yearNum(a.year_level).localeCompare(yearNum(b.year_level), undefined, { numeric: true }) ||
      a.block_name.localeCompare(b.block_name, undefined, { numeric: true }))
    .map(b => ({
      value: String(b.id),
      label: `${yearNum(b.year_level)}${b.block_name}`,
      hint: `${b.year_level}, Block ${b.block_name} · ${curriculumVersionLabel(blockCurriculumVersion(b.curriculum_version))}`,
      badge: b.subject_count ? `${b.subject_count} subjects` : undefined,
      badgeTone: 'muted' as const,
    }));

  function emptyTitle(): string {
    if (step === 'no-semester') return 'No Active Semester';
    if (blocksLoading) return 'Loading Blocks…';
    if (step === 'no-block' && blocks.length === 0 && filterProgram && !blocksError) return 'No Blocks Found';
    if (step === 'ready' && hasLoaded && schedules.length === 0) return 'No Subjects Found';
    return 'No Class Program Selected';
  }

  // ── Excel export — same builder as Reports (classProgramReport) ─────────
  async function handleExportExcel() {
    if (!blockDetail || !selectionComplete) return;
    /* Built from the database as it is now (the page follows along), with the
       term's day combinations read fresh — never an older copy on screen */
    let block = blockDetail;
    let rows = schedules;
    const query = docQuery.current;
    try {
      const fresh = await fetchClassProgram({ blockId: selectedBlockId, programId: filterProgram, yearLevel: filterYearLevel, semester: globalSemester });
      block = fresh.block;
      rows = fresh.schedules;
      if (docQuery.current === query) { setBlockDetail(fresh.block); setSchedules(fresh.schedules); }
    } catch { /* offline: what is on screen */ }
    const combos = (await fetchDayCombinations(globalSemester, globalYear, { fresh: true })).combinations.filter(c => c.is_active);
    await downloadClassProgramExcel({
      block,
      schedules: rows,
      combos: combos.length > 0 ? combos : dayCombos,
      settings: { campusName, campusAddress, campusTel, campusWebsite, preparedBy, recommendedBy, notedBy, approvedBy },
    });
  }

  // ── Deep link: run the requested Print / Excel once the document is ready ─
  // …and on screen: the skeletons are gone, so Print never catches a placeholder
  const docOnScreen = showActions && !showPageSkeleton && !showSkeleton;
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || !docOnScreen) return;
    pendingRef.current = null;
    (async () => {
      try {
        if (pending.action === 'excel') {
          await handleExportExcel();
        } else {
          await new Promise(r => setTimeout(r, 400)); // let the logos paint
          window.print();
        }
        notifyReports('done');
      } catch {
        notifyReports('error', 'Could not create the class program.');
      }
    })();
    // Runs once when the document becomes ready; the handlers read current state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docOnScreen]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="cp-print-root p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      {/* ── Page header ── wide screens: Back | actions, title under them.
          Phones: Back, title, then the three actions as one row of equal buttons. */}
      <div className="no-print mb-6 sm:mb-10 grid grid-cols-1 gap-y-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-4 sm:gap-y-0">
        <div className="min-w-0">
          <BackButton />
        </div>

        <div className="order-last sm:order-none grid grid-cols-3 gap-2 sm:flex sm:flex-shrink-0 sm:flex-wrap sm:gap-2.5" role="group" aria-label="Class program actions">
          <button
            type="button"
            disabled={!showActions}
            onClick={() => setShowSettings(s => !s)}
            aria-expanded={showSettings}
            title={showActions ? 'Signatories and campus details' : 'Select program and year & block first'}
            className={`${BTN_SECONDARY} ${showSettings ? '!border-[#1D5BD6] !text-[#164BB5] !bg-[#EFF6FF]' : ''}`}
          >
            <Settings2 className="w-4 h-4 flex-shrink-0" />
            <span className="sm:hidden">Settings</span>
            <span className="hidden sm:inline">{showSettings ? 'Hide Settings' : 'Document Settings'}</span>
          </button>
          <button
            type="button"
            disabled={!showActions}
            onClick={handleExportExcel}
            title={showActions ? 'Download as Excel' : 'Select program and year & block first'}
            className={BTN_SECONDARY}
          >
            <Download className="w-4 h-4 flex-shrink-0" />
            <span className="sm:hidden">Excel</span>
            <span className="hidden sm:inline">Export Excel</span>
          </button>
          <button
            type="button"
            disabled={!showActions}
            onClick={() => window.print()}
            title={showActions ? 'Print or save as PDF' : 'Select program and year & block first'}
            className={BTN_PRIMARY}
          >
            <Printer className="w-4 h-4 flex-shrink-0" />
            <span className="sm:hidden">Print</span>
            <span className="hidden sm:inline">Print / PDF</span>
          </button>
        </div>

        <div className="sm:col-span-2 sm:mt-9">
          <WatermarkTitle>Class Program</WatermarkTitle>
        </div>
      </div>

      <PageLoadTransition showSkeleton={showPageSkeleton} skeleton={<ClassProgramPageSkeleton />}>
      {/* ── Filter panel — Program, then one Year & Block pick (1A, 1B, 2A…) as on Faculty Workload ── */}
      <FilterBar className="no-print relative z-20">
        <div id="cp-selection" className="space-y-4">
          <p className="text-sm font-semibold text-[#0B2A5B]">Class Program Selection</p>

          {!semLoading && !globalSemester && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
              No active semester configured. Set one in Settings → School Year Management to continue.
            </div>
          )}

          {chairNoProgram && (
            <div className="rounded-xl border border-[#E2E8F0] bg-slate-50 px-4 py-3 text-sm text-slate-600">
              No program is assigned to your Department Chair account. Please contact the administrator.
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <label className={LABEL_CLS}>
                Program <span className="text-red-400">*</span>
              </label>
              {isChair ? (
                <div className="flex min-h-[48px] items-center rounded-xl border-0 bg-slate-100 px-3 py-2.5 text-sm font-medium text-slate-600 select-none">
                  <span className="truncate">
                    {lockedProgram
                      ? `${lockedProgram.code} — ${lockedProgram.name}`
                      : chairNoProgram ? 'No program assigned' : '—'}
                  </span>
                </div>
              ) : (
                <FriendlySelect
                  value={filterProgram}
                  onChange={handleProgramChange}
                  label="Program"
                  placeholder="Select Program"
                  guide={!filterProgram}
                  minPanelWidth={340}
                  showHintInTrigger
                  options={programs.map(p => ({ value: String(p.id), label: p.code, hint: p.name }))}
                />
              )}
            </div>

            <div className="min-w-0">
              <label className={LABEL_CLS}>
                Year &amp; Block <span className="text-red-400">*</span>
              </label>
              <FriendlySelect
                value={selectedBlockId}
                onChange={handleYearBlockChange}
                disabled={!filterProgram || !globalSemester || blocksLoading || (!!blocksError || blocks.length === 0)}
                label="Year & Block"
                placeholder="Select Year & Block"
                disabledText={
                  !filterProgram ? 'Select a program first'
                    : blocksLoading ? 'Loading blocks…'
                    : blocksError ? 'Could not load blocks'
                    : 'No blocks this semester'
                }
                guide={!!filterProgram && !selectedBlockId && blocks.length > 0}
                minPanelWidth={320}
                searchable
                searchPlaceholder="Search, e.g. 1A"
                options={blockOptions}
              />
              {blocksError && <p className="mt-1.5 text-xs text-red-500">{blocksError}</p>}
            </div>

            <div className="min-w-0 sm:col-span-2 lg:col-span-1">
              <label className={LABEL_CLS}>
                Semester <span className="normal-case font-normal text-slate-400">(auto)</span>
              </label>
              <div className="flex min-h-[48px] items-center rounded-xl border-0 bg-slate-100 px-3 py-2.5 text-sm font-medium text-slate-600 select-none">
                <span className="truncate">{semLoading ? 'Loading…' : (globalSemester || 'No active semester')}</span>
              </div>
            </div>
          </div>

          {loadError && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-600">
              {loadError}
            </div>
          )}
        </div>
      </FilterBar>

      {/* ── Document settings ── */}
      <AnimatePresence initial={false}>
      {showSettings && showDocument && (
        <motion.div
          key="cp-settings"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
          className="no-print overflow-hidden"
        >
        <div className="mb-6 rounded-2xl border border-[#E2E8F0] bg-white p-5 shadow-sm text-[#0B2A5B]">
          <p className="mb-1 text-sm font-semibold">Document Settings</p>
          <p className="mb-4 text-xs text-slate-400">Campus contact details and signatories for print output.</p>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Campus Information</p>
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {([
              ['Campus Name',  campusName,    setCampusName,    'e.g., Cantilan Campus'],
              ['Address',      campusAddress, setCampusAddress, 'e.g., Cantilan, Surigao del Sur'],
              ['Tel/Fax No.',  campusTel,     setCampusTel,     '086-212-5122'],
              ['Website',      campusWebsite, setCampusWebsite, 'www.nemsu.edu.ph'],
            ] as [string, string, (v: string) => void, string][]).map(([label, val, setter, ph]) => (
              <div key={label}>
                <label className="mb-1 block text-xs font-semibold text-slate-500">{label}</label>
                <input value={val} onChange={e => setter(e.target.value)} className={SF_INPUT} placeholder={ph} />
              </div>
            ))}
          </div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Signatories</p>
            {coordinatorEdited && DEFAULT_COORDINATORS[coordKey] && (
              <button
                type="button"
                onClick={resetPreparedBy}
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold text-[#164BB5] hover:bg-[#EFF6FF] transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Reset {selectedProgramCode} coordinator
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {([
              [`Prepared By (${selectedProgramCode} Coordinator) — Name`, preparedBy.name, (v: string) => setPreparedBy(s => ({ ...s, name: v })), 'Full name with credentials'],
              [`Prepared By (${selectedProgramCode} Coordinator) — Designation`, preparedBy.designation, (v: string) => setPreparedBy(s => ({ ...s, designation: v })), 'e.g., Program Coordinator - IT'],
              ['Recommending Approval — Name',          recommendedBy.name,       (v: string) => setRecommendedBy(s => ({ ...s, name: v })),       'Full name with credentials'],
              ['Recommending Approval — Designation',   recommendedBy.designation,(v: string) => setRecommendedBy(s => ({ ...s, designation: v })),'e.g., Registrar III'],
              ['Noted By — Name',                       notedBy.name,             (v: string) => setNotedBy(s => ({ ...s, name: v })),             'Full name with credentials'],
              ['Noted By — Designation',                notedBy.designation,      (v: string) => setNotedBy(s => ({ ...s, designation: v })),      'e.g., Dept. Chair, Dept. of CS'],
              ['Approved By — Name',                    approvedBy.name,          (v: string) => setApprovedBy(s => ({ ...s, name: v })),          'Full name with credentials'],
              ['Approved By — Designation',             approvedBy.designation,   (v: string) => setApprovedBy(s => ({ ...s, designation: v })),   'e.g., Campus Director'],
            ] as [string, string, (v: string) => void, string][]).map(([label, val, setter, ph]) => (
              <div key={label}>
                <label className="mb-1 block text-xs font-semibold text-slate-500">{label}</label>
                <input value={val} onChange={e => setter(e.target.value)} className={SF_INPUT} placeholder={ph} />
              </div>
            ))}
          </div>
        </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* ── Loading / Empty / Document ── */}
      {showSkeleton ? (
        // Shaped like what loads: the cards below lg, the printed page from lg (filters stay real)
        <div className="no-print" role="status" aria-live="polite" aria-label="Loading class program">
          <div className="lg:hidden"><ClassCardsSkeleton /></div>
          <div className="hidden lg:block"><DocumentSkeleton /></div>
        </div>
      ) : !showDocument ? (
        <div className="no-print rounded-2xl border border-[#E2E8F0] bg-white px-6 py-14 text-center shadow-sm">
          <p className="text-sm font-semibold text-[#0B2A5B]">{emptyTitle()}</p>
        </div>
      ) : (
        <>
        {/* Phones / tablets: the class program as cards, like My Workload */}
        <ClassProgramCards
          block={blockDetail!}
          dayGroups={dayGroups}
          unscheduledRows={unscheduledRows}
          totalUnits={totalUnits}
          totalHours={totalHours}
        />
        {/* Wide screens and print: the paper form (hidden on smaller screens by .cp-doc).
            No inner scroll box, so its header sticks while the page scrolls. */}
        <div className="cp-print-scroll cp-doc">
        <div id="cp-preview" className="cp-shell">
          <div className="page">
          {/* Page frame (officialPrintPagedHtml): the header repeats at the top of
              every printed page; the table-foot spacer keeps text off the footer */}
          <table className="op-frame">
          <thead><tr><td>
            <div className="op-top" />

            {/* Header — same structure as Faculty Workload Print */}
            <div className="hdr">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/nemlogo/NEMSU-logo.png" alt="NEMSU" />
              <div className="hdr-rep">Republic of the Philippines</div>
              <div className="hdr-univ">North Eastern Mindanao State University</div>
              <div className="hdr-dept">
                {(blockDetail!.department || '').trim() || NEMSU_OFFICIAL_DEPT}
              </div>
              <div className="hdr-wl">CLASS PROGRAM</div>
              <div className="hdr-sem">{semesterHeading(blockDetail!.semester)}</div>
              <div className="hdr-ay">A.Y {formatAy(blockDetail!.academic_year)}</div>
            </div>
          </td></tr></thead>
          <tbody><tr><td>

            {/* Block info — semester and A.Y. are already in the header above */}
            <div className="info">
              <div className="info-left" style={{ flex: '1 1 auto' }}>
                <div className="hf">
                  <span className="i-lbl">Course/Year/Section:</span>
                  <span className="i-val">
                    <strong>
                      {blockDetail!.program_code} {blockDetail!.year_level} — Block {blockDetail!.block_name}
                    </strong>
                  </span>
                </div>
                <div className="hf">
                  <span className="i-lbl">Program:</span>
                  <span className="i-val">{blockDetail!.program_name || blockDetail!.program_code}</span>
                </div>
              </div>
            </div>

            {/* Schedule table — Faculty Workload .wl language */}
            {dayGroups.length > 0 ? (
              <table className="wl cp-sticky-head">
                <colgroup>
                  <col className="t-time" />
                  <col className="t-code" />
                  <col style={{ width: '24%' }} />
                  <col className="t-course" />
                  <col className="t-units" />
                  <col className="t-hours" />
                  <col className="t-inst" />
                  <col className="t-room" />
                </colgroup>
                <thead>
                  <tr>
                    <th>TIME/DAY</th>
                    <th>Subject<br />Code</th>
                    <th>Description</th>
                    <th>Course</th>
                    <th>Units</th>
                    <th>No. of<br />Hours</th>
                    <th>Instructor/Professor</th>
                    <th>Room No.</th>
                  </tr>
                </thead>
                <tbody>
                  {dayGroups.map(group => {
                    const amRows = group.rows.filter(r => isAM(r.start_time));
                    const pmRows = group.rows.filter(r => !isAM(r.start_time));
                    const course = formatCourseLabel(blockDetail!);
                    return (
                      <Fragment key={group.pattern}>
                        <tr className="sec-hdr">
                          <td>A.M.</td>
                          <td colSpan={7}>{group.label}</td>
                        </tr>
                        {amRows.length > 0
                          ? amRows.map(row => <ClassRow key={row.key} row={row} course={course} />)
                          : <tr className="dr-empty"><td colSpan={8} /></tr>
                        }
                        <tr className="sec-hdr">
                          <td>P.M.</td>
                          <td colSpan={7} style={{ fontStyle: 'italic', textAlign: 'center' }}>Lunch Break</td>
                        </tr>
                        {pmRows.length > 0
                          ? pmRows.map(row => <ClassRow key={row.key} row={row} course={course} />)
                          : <tr className="dr-empty"><td colSpan={8} /></tr>
                        }
                      </Fragment>
                    );
                  })}
                  <tr className="tr-total">
                    <td colSpan={4} className="c-right">Total Number of Units</td>
                    <td className="c-center">{fmtNum(totalUnits)}</td>
                    <td className="c-center">{fmtNum(totalHours)}</td>
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            ) : (
              <p style={{ textAlign: 'center', padding: '16pt 0', fontSize: '8.5pt', color: '#555' }}>
                No subjects have been scheduled yet.
              </p>
            )}

            {/* Pending / Unscheduled — same .wl / .sec-hdr language */}
            {unscheduledRows.length > 0 && (
              <table className="wl" style={{ marginTop: 8 }}>
                <thead>
                  <tr className="sec-hdr">
                    <td colSpan={6}>Pending / Unscheduled Subjects</td>
                  </tr>
                  <tr>
                    <th style={{ width: '10%' }}>Subject<br />Code</th>
                    <th style={{ width: '32%' }}>Description</th>
                    <th style={{ width: '7%' }}>Units</th>
                    <th style={{ width: '7%' }}>Hours</th>
                    <th style={{ width: '32%' }}>Instructor/Professor</th>
                    <th style={{ width: '12%' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {unscheduledRows.map(row => (
                    <tr key={row.key}>
                      <td className="t-code">{row.subject_code}</td>
                      <td className="t-desc" style={{ textAlign: 'left' }}>{row.subject_name}</td>
                      <td className="t-units">{fmtNum(row.row_units)}</td>
                      <td className="t-hours">{fmtNum(row.row_hours)}</td>
                      <td className="t-inst">
                        {row.faculty_name ?? <span className="no-room">Not assigned</span>}
                      </td>
                      <td className="t-status">{row.faculty_name ? 'Assigned' : 'Unscheduled'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Signatures — Faculty Workload .sig table language */}
            <table className="sig">
              <tbody>
                <tr>
                  <td style={{ width: '50%', paddingRight: 20 }} className="lbl">Prepared by:</td>
                  <td style={{ width: '50%', paddingLeft: 20 }} className="lbl">Recommending Approval:</td>
                </tr>
                <tr className="sp"><td /><td /></tr>
                <tr>
                  <td style={{ padding: '0 20px 0 0', textAlign: 'left' }}>
                    {preparedBy.name ? <div className="nm">{preparedBy.name}</div> : <div className="nm">&nbsp;</div>}
                    {preparedBy.designation ? <div className="tt">{preparedBy.designation}</div> : null}
                  </td>
                  <td style={{ padding: '0 0 0 20px' }} className="blk">
                    {recommendedBy.name ? <div className="nm">{recommendedBy.name}</div> : <div className="nm">&nbsp;</div>}
                    {recommendedBy.designation ? <div className="tt">{recommendedBy.designation}</div> : null}
                  </td>
                </tr>
                <tr>
                  <td colSpan={2} className="lbl sec" style={{ textAlign: 'center' }}>Noted by:</td>
                </tr>
                <tr className="sp"><td colSpan={2} /></tr>
                <tr>
                  <td colSpan={2} className="blk" style={{ padding: '0 25%' }}>
                    {notedBy.name ? <div className="nm">{notedBy.name}</div> : <div className="nm">&nbsp;</div>}
                    {notedBy.designation ? <div className="tt">{notedBy.designation}</div> : null}
                  </td>
                </tr>
                <tr>
                  <td colSpan={2} className="lbl sec" style={{ textAlign: 'center' }}>Approved:</td>
                </tr>
                <tr className="sp"><td colSpan={2} /></tr>
                <tr>
                  <td colSpan={2} className="blk" style={{ padding: '0 25%' }}>
                    {approvedBy.name ? <div className="nm">{approvedBy.name}</div> : <div className="nm">&nbsp;</div>}
                    {approvedBy.designation ? <div className="tt">{approvedBy.designation}</div> : null}
                  </td>
                </tr>
              </tbody>
            </table>

          </td></tr></tbody>
          <tfoot><tr><td><div className="op-foot-space" /></td></tr></tfoot>
          </table>

            {/* Print footer — same chrome as Faculty Workload */}
            <div className="pf">
              <div className="pf-inner">
                <div className="pf-contact">
                  <div className="pf-row">{campusAddress || DEFAULT_FOOTER_CONFIG.address}</div>
                  <div className="pf-row">{campusTel || DEFAULT_FOOTER_CONFIG.phone}</div>
                  <div className="pf-row">
                    <a href={`https://${campusWebsite || DEFAULT_FOOTER_CONFIG.website}`} target="_blank" rel="noreferrer">
                      {campusWebsite || DEFAULT_FOOTER_CONFIG.website}
                    </a>
                  </div>
                </div>
                <div className="pf-logos">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/nemlogo/ISO-UKAS.png" alt="ISO-UKAS" />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/nemlogo/BAGONG-PILIPINAS-LOGO.png" alt="Bagong Pilipinas" />
                </div>
              </div>
            </div>

          </div>
        </div>
        </div>
        </>
      )}
      </PageLoadTransition>

    </div>
  );
}

// ─── ClassRow ─────────────────────────────────────────────────────────────────

function ClassRow({ row, course }: { row: DisplayRow; course: string }) {
  return (
    <tr>
      <td className="t-time">{formatTimeRange(row.start_time, row.end_time)}</td>
      <td className="t-code">{row.subject_code}</td>
      <td className="t-desc" style={{ textAlign: 'left' }}>{row.subject_name}</td>
      <td className="t-course">{course}</td>
      <td className="t-units">{row.is_continuation ? '' : fmtNum(row.row_units)}</td>
      <td className="t-hours">{fmtNum(row.row_hours)}</td>
      <td className="t-inst">{row.faculty_name ?? ''}</td>
      <td className="t-room">
        {row.room_name ? row.room_name : <span className="no-room">No room assigned</span>}
      </td>
    </tr>
  );
}

// ─── Phone / tablet cards ─────────────────────────────────────────────────────

/** "07:00", "08:30" → "7:00 – 8:30 AM"; "11:30", "13:00" → "11:30 AM – 1:00 PM" */
function cardTime(start: string | null, end: string | null): string {
  if (!start) return 'No time yet';
  const mer = (t: string) => (isAM(t) ? 'AM' : 'PM');
  if (!end) return `${fmt12(start)} ${mer(start)}`;
  return mer(start) === mer(end)
    ? `${fmt12(start)} – ${fmt12(end)} ${mer(end)}`
    : `${fmt12(start)} ${mer(start)} – ${fmt12(end)} ${mer(end)}`;
}

/** Units · Hours · Room — the small boxes at the bottom of a card */
function CardFacts({ facts }: { facts: [string, string][] }) {
  return (
    <dl className={`mt-2.5 grid ${facts.length === 2 ? 'grid-cols-2' : 'grid-cols-3'} gap-2 text-center`}>
      {facts.map(([k, v]) => (
        <div key={k} className="rounded-lg bg-[#F8FAFC] px-1.5 py-1.5 min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-[#64748B]">{k}</dt>
          <dd className="text-sm font-bold text-[#0B2A5B] truncate tabular-nums">{v || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

function CardInstructor({ name }: { name: string | null }) {
  return (
    <p className="mt-2.5 flex items-start gap-2 text-sm">
      <UserRound className="w-4 h-4 mt-0.5 flex-shrink-0 text-[#64748B]" aria-hidden="true" />
      {name
        ? <span className="font-semibold text-[#0B2A5B] break-words min-w-0">{name}</span>
        : <span className="font-semibold text-[#B91C1C]">No instructor yet</span>}
    </p>
  );
}

const CARD = 'rounded-xl border border-[#E2E8F0] bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.05)]';

/** Below lg: the block's classes as cards, grouped by days, then the total and
 *  anything still unscheduled — the same layout as the workload cards. */
function ClassProgramCards({ block, dayGroups, unscheduledRows, totalUnits, totalHours }: {
  block: BlockDetail;
  dayGroups: DayGroup[];
  unscheduledRows: DisplayRow[];
  totalUnits: number;
  totalHours: number;
}) {
  return (
    <div className="no-print lg:hidden space-y-5">
      <div className={`${CARD} flex items-start justify-between gap-3`}>
        <div className="min-w-0">
          <p className="text-base font-bold text-[#0B2A5B] break-words leading-snug">{block.program_name || block.program_code}</p>
          <p className="text-sm text-[#64748B] mt-0.5">{block.semester} · A.Y {formatAy(block.academic_year)}</p>
        </div>
        <BlockBadge course={formatCourseLabel(block)} />
      </div>

      {dayGroups.length === 0 ? (
        <p className={`${CARD} py-6 text-center text-sm text-[#64748B]`}>No subjects have been scheduled yet.</p>
      ) : dayGroups.map(group => (
        <section key={group.pattern} className="space-y-2.5">
          <h3 className="px-1 text-[13px] font-bold text-[#475569]">{group.label.replace(/\//g, ' · ')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {group.rows.map(row => (
              <div key={row.key} className={CARD}>
                <p className="text-sm font-semibold text-[#0B2A5B] tabular-nums">{cardTime(row.start_time, row.end_time)}</p>
                <p className="mt-1.5 text-base font-bold text-[#0F172A] break-words">{row.subject_code}</p>
                <p className="text-sm text-[#334155] mt-0.5 break-words">{row.subject_name}</p>
                <CardFacts facts={[
                  ['Units', row.is_continuation ? '' : fmtNum(row.row_units)],
                  ['Hours', fmtNum(row.row_hours)],
                  ['Room', row.room_name ?? ''],
                ]} />
                <CardInstructor name={row.faculty_name} />
              </div>
            ))}
          </div>
        </section>
      ))}

      {dayGroups.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
          <p className="text-sm font-bold text-[#0B2A5B]">Total Number of Units</p>
          <p className="text-right tabular-nums">
            <span className="block text-base font-bold text-[#0B2A5B]">{fmtNum(totalUnits)} <span className="text-xs font-semibold text-[#64748B]">units</span></span>
            <span className="block text-xs font-semibold text-[#64748B]">{fmtNum(totalHours)} hrs</span>
          </p>
        </div>
      )}

      {unscheduledRows.length > 0 && (
        <section className="space-y-2.5">
          <h3 className="px-1 text-[13px] font-bold text-[#475569]">Pending / Unscheduled</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {unscheduledRows.map(row => (
              <div key={row.key} className={CARD}>
                <p className="text-base font-bold text-[#0F172A] break-words">{row.subject_code}</p>
                <p className="text-sm text-[#334155] mt-0.5 break-words">{row.subject_name}</p>
                <CardFacts facts={[
                  ['Units', fmtNum(row.row_units)],
                  ['Hours', fmtNum(row.row_hours)],
                ]} />
                <CardInstructor name={row.faculty_name} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Skeletons ────────────────────────────────────────────────────────────────

/** The selection card while the page loads: title, then Program · Year & Block · Semester */
function ClassProgramPageSkeleton() {
  return (
    <div className="no-print" role="status" aria-live="polite" aria-label="Loading class program">
      <div className="bg-white rounded-2xl border border-[#E2E8F0]/70 shadow-sm p-5 mb-5 space-y-4">
        <Skeleton className="h-4 w-48 rounded" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className={`min-w-0 space-y-2 ${i === 2 ? 'sm:col-span-2 lg:col-span-1' : ''}`}>
              <Skeleton className="h-3 w-24 rounded" />
              <Skeleton className="h-12 w-full rounded-xl" />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-[#E2E8F0] bg-white px-6 py-14 shadow-sm flex justify-center">
        <Skeleton className="h-4 w-56 max-w-full rounded" />
      </div>
    </div>
  );
}

/** Phones / tablets: block heading card, a day heading, then class cards */
function ClassCardsSkeleton() {
  return (
    <div className="space-y-5">
      <div className={`${CARD} flex items-start justify-between gap-3`}>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-[70%] rounded" />
          <Skeleton className="h-3.5 w-[45%] rounded" />
        </div>
        <Skeleton className="h-6 w-16 rounded-md flex-shrink-0" />
      </div>
      <div className="space-y-2.5">
        <Skeleton className="h-3.5 w-32 rounded ml-1" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className={CARD}>
              <Skeleton className="h-3.5 w-28 rounded" />
              <Skeleton className="h-4 w-20 rounded mt-2.5" />
              <Skeleton className={`h-3.5 rounded mt-2 ${i % 2 ? 'w-[55%]' : 'w-[75%]'}`} />
              <div className="mt-3 grid grid-cols-3 gap-2">
                {Array.from({ length: 3 }, (_, c) => <Skeleton key={c} className="h-11 rounded-lg" />)}
              </div>
              <Skeleton className="h-3.5 w-40 rounded mt-3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
