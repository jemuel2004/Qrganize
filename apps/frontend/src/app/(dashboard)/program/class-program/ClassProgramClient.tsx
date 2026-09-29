'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, Printer, RotateCcw, Settings2 } from 'lucide-react';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useDayCombinations } from '@/lib/dayCombinations';
import {
  DEFAULT_COORDINATORS, EMPTY_SIGNATORY, downloadClassProgramExcel, expandToDisplayRows, fmtNum,
  formatCourseLabel, formatTimeRange, groupByDay, isAM, programKey,
  type BlockDetail, type DisplayRow, type RawSchedule, type Signatory,
} from './classProgramReport';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import { FilterBar, FilterSelect, SF_INPUT } from '@/components/ui/SearchFilter';
import { CardSkeleton, FiltersSkeleton } from '@/components/ui/skeletons';
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

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface Program { id: number; code: string; name: string; department?: string; }
interface Block {
  id: number; block_name: string; year_level: string; semester: string;
  academic_year: string; program_id: number; program_code: string; program_name: string;
  subject_count: number; unassigned_count: number; assigned_count: number; scheduled_count: number;
  curriculum_version?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];

/** Same label style as Blocks / Faculty Workload filter rows */
const LABEL_CLS = 'block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5';

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60';
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
`;

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ClassProgramPage() {
  const { semester: globalSemester, schoolYear: globalYear, loading: semLoading } = useSchoolYear();
  const { active: dayCombos } = useDayCombinations(globalSemester, globalYear);

  // ── Abort controllers ─────────────────────────────────────────────────────
  const blocksAbortRef = useRef<AbortController | null>(null);
  const docAbortRef    = useRef<AbortController | null>(null);

  // ── Programs (loaded once — just need the list for the dropdown) ──────────
  const [programs, setPrograms] = useState<Program[]>([]);
  const [isChair, setIsChair] = useState(false);
  const [chairProgramId, setChairProgramId] = useState<number | null>(null);
  const [chairNoProgram, setChairNoProgram] = useState(false);

  // Single source of truth for Program → Year Level → Block cascade.
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
  // Program, Year Level, and Block are the three required user choices.
  const selectionComplete =
    !!filterProgram && !!filterYearLevel && !!selectedBlockId && !!globalSemester && !!globalYear;

  // ── Cascade handler: Program changed ────────────────────────────────────
  function handleProgramChange(val: string) {
    setFilterProgram(val);
    setFilterYearLevel('');   // clear child
    setSelectedBlockId('');   // clear grandchild
    setBlocks([]);            // clear block list
  }

  // ── Cascade handler: Year Level changed ──────────────────────────────────
  function handleYearLevelChange(val: string) {
    setFilterYearLevel(val);
    setSelectedBlockId('');   // clear child
    // blocks will re-fetch via useEffect
  }

  // ── Cascade handler: Block changed ───────────────────────────────────────
  function handleBlockChange(val: string) {
    setSelectedBlockId(val);
    // document will re-fetch via useEffect
  }

  // ── Effect: Lazily load blocks when parent filters are complete ──────────
  useEffect(() => {
    // Clear selection and list whenever parent context changes
    setSelectedBlockId('');

    if (!filterProgram || !filterYearLevel || !globalSemester || !globalYear) {
      blocksAbortRef.current?.abort();
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

    const params = new URLSearchParams({
      program_id:   filterProgram,
      year_level:   filterYearLevel,
      semester:     globalSemester,
      academic_year: globalYear,
    });

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
        // Deep link: select the requested block once the list is in
        const pending = pendingRef.current;
        if (pending) {
          if (list.some(b => String(b.id) === pending.block)) setSelectedBlockId(pending.block);
          else { pendingRef.current = null; notifyReports('error', 'That block was not found for the active semester.'); }
        }
      })
      .catch(err => {
        if (err.name !== 'AbortError') setBlocksError('Connection error loading blocks.');
      })
      .finally(() => { if (!controller.signal.aborted) setBlocksLoading(false); });

    return () => { controller.abort(); };
  }, [filterProgram, filterYearLevel, globalSemester, globalYear]);

  // ── Effect: Load document when ALL selections are complete ───────────────
  useEffect(() => {
    // Guard: all three user selections + active semester/year are required
    if (!filterProgram || !filterYearLevel || !selectedBlockId || !globalSemester || !globalYear) {
      docAbortRef.current?.abort();
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
  const showSkeleton = useMinLoading(loading, LOADING_DELAY);

  // ── Prompt state helpers ─────────────────────────────────────────────────
  function promptStep(): 'no-semester' | 'no-program' | 'no-year' | 'no-block' | 'ready' {
    if (!globalSemester && !semLoading) return 'no-semester';
    if (!filterProgram) return 'no-program';
    if (!filterYearLevel) return 'no-year';
    if (!selectedBlockId) return 'no-block';
    return 'ready';
  }
  const step = promptStep();

  function emptyTitle(): string {
    if (step === 'no-semester') return 'No Active Semester';
    if (blocksLoading) return 'Loading Blocks…';
    if (step === 'no-block' && blocks.length === 0 && filterProgram && filterYearLevel) return 'No Blocks Found';
    if (step === 'ready' && hasLoaded && schedules.length === 0) return 'No Subjects Found';
    return 'No Class Program Selected';
  }

  // ── Excel export — same builder as Reports (classProgramReport) ─────────
  async function handleExportExcel() {
    if (!blockDetail || !selectionComplete) return;
    await downloadClassProgramExcel({
      block: blockDetail,
      schedules,
      combos: dayCombos,
      settings: { campusName, campusAddress, preparedBy, recommendedBy, notedBy, approvedBy },
    });
  }

  // ── Deep link: run the requested Print / Excel once the document is ready ─
  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || !showActions) return;
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
  }, [showActions]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="cp-print-root p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      {/* ── Page header (same structure as Master Schedule) ── */}
      <div className="no-print mb-2 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <BackButton />
        </div>

        <div className="flex flex-shrink-0 flex-wrap gap-2.5" role="group" aria-label="Class program actions">
          <button
            type="button"
            disabled={!showActions}
            onClick={() => setShowSettings(s => !s)}
            aria-expanded={showSettings}
            title={showActions ? 'Signatories and campus details' : 'Select program, year level, and block first'}
            className={`${BTN_SECONDARY} ${showSettings ? '!border-[#1D5BD6] !text-[#164BB5] !bg-[#EFF6FF]' : ''}`}
          >
            <Settings2 className="w-4 h-4" /> {showSettings ? 'Hide Settings' : 'Document Settings'}
          </button>
          <button
            type="button"
            disabled={!showActions}
            onClick={handleExportExcel}
            title={showActions ? 'Download as Excel' : 'Select program, year level, and block first'}
            className={BTN_SECONDARY}
          >
            <Download className="w-4 h-4" /> Export Excel
          </button>
          <button
            type="button"
            disabled={!showActions}
            onClick={() => window.print()}
            title={showActions ? 'Print or save as PDF' : 'Select program, year level, and block first'}
            className={BTN_PRIMARY}
          >
            <Printer className="w-4 h-4" /> Print / PDF
          </button>
        </div>
      </div>
      <div className="no-print mt-4 sm:mt-7 mb-10">
        <WatermarkTitle>Class Program</WatermarkTitle>
      </div>

      {/* ── Filter panel (same FilterBar as Master Schedule) ── */}
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0">
              <label className={LABEL_CLS}>
                Program <span className="text-red-400">*</span>
              </label>
              {isChair ? (
                <div className="flex min-h-[42px] items-center rounded-xl border-0 bg-slate-100 px-3 py-2.5 text-sm font-medium text-slate-600 select-none">
                  <span className="truncate">
                    {lockedProgram
                      ? `${lockedProgram.code} — ${lockedProgram.name}`
                      : chairNoProgram ? 'No program assigned' : '—'}
                  </span>
                </div>
              ) : (
                <FilterSelect value={filterProgram} onChange={handleProgramChange} label="Program" className="min-h-[42px]">
                  <option value="">— Select Program —</option>
                  {programs.map(p => (
                    <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                  ))}
                </FilterSelect>
              )}
            </div>

            <div className="min-w-0">
              <label className={LABEL_CLS}>
                Year Level <span className="text-red-400">*</span>
              </label>
              <FilterSelect
                value={filterYearLevel}
                onChange={handleYearLevelChange}
                disabled={!filterProgram}
                label="Year Level"
                className="min-h-[42px]"
              >
                <option value="">— Select Year Level —</option>
                {YEAR_LEVELS.map(y => <option key={y} value={y}>{y}</option>)}
              </FilterSelect>
            </div>

            <div className="min-w-0">
              <label className={LABEL_CLS}>
                Block / Section <span className="text-red-400">*</span>
              </label>
              <FilterSelect
                value={selectedBlockId}
                onChange={handleBlockChange}
                disabled={!filterProgram || !filterYearLevel || !globalSemester || blocksLoading}
                label="Block / Section"
                className="min-h-[42px]"
              >
                <option value="">
                  {blocksLoading ? '— Loading blocks… —'
                    : blocksError ? '— Error loading blocks —'
                    : blocks.length === 0 && filterProgram && filterYearLevel ? '— No blocks found —'
                    : '— Select Block —'}
                </option>
                {blocks.map(b => (
                  <option key={b.id} value={b.id}>
                    Block {b.block_name} ({b.curriculum_version === 'new' ? 'New Curriculum' : 'Old Curriculum'})
                    {b.subject_count ? ` · ${b.subject_count} subjects` : ''}
                  </option>
                ))}
              </FilterSelect>
              {blocksError && <p className="mt-1.5 text-xs text-red-500">{blocksError}</p>}
              {!blocksError && filterProgram && filterYearLevel && globalSemester && !blocksLoading && blocks.length === 0 && (
                <p className="mt-1.5 text-xs text-slate-400">
                  No blocks found for {filterYearLevel} in {globalSemester}.
                </p>
              )}
            </div>

            <div className="min-w-0">
              <label className={LABEL_CLS}>
                Semester <span className="normal-case font-normal text-slate-400">(auto)</span>
              </label>
              <div className="flex min-h-[42px] items-center rounded-xl border-0 bg-slate-100 px-3 py-2.5 text-sm font-medium text-slate-600 select-none">
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
        <div className="no-print space-y-4" role="status" aria-live="polite" aria-label="Loading class program">
          <FiltersSkeleton fields={2} />
          <CardSkeleton className="min-h-[320px]" />
        </div>
      ) : !showDocument ? (
        <div className="no-print rounded-2xl border border-[#E2E8F0] bg-white px-6 py-14 text-center shadow-sm">
          <p className="text-sm font-semibold text-[#0B2A5B]">{emptyTitle()}</p>
        </div>
      ) : (
        <div className="cp-print-scroll max-lg:overflow-auto max-lg:max-h-[75vh] lg:overflow-visible">
        {/* Wide screens: no inner scroll box, so the header sticks while the page scrolls.
            Smaller screens: the preview scrolls sideways, so it gets its own scroll area
            and the header sticks inside it. */}
        <div id="cp-preview" className="cp-shell">
          <div className="page">

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
      )}

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
