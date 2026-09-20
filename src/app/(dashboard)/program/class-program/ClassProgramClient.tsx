'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { useSchoolYear } from '@/client/context/SchoolYearContext';
import { FilterBar, FilterSelect, SF_INPUT } from '@/components/ui/SearchFilter';
import { CardSkeleton, FiltersSkeleton } from '@/client/components/ui/skeletons';
import { LOADING_DELAY, useMinLoading } from '@/client/hooks/useMinLoading';
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
interface SessionData { day: string; start_time: string; end_time: string; session_hours: number; }
interface RawSchedule {
  ms_id: number;
  day_pattern: string | null;
  start_time: string | null;
  end_time: string | null;
  status: string;
  subject_code: string;
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  total_hours: number;
  units: number;
  faculty_name: string | null;
  room_name: string | null;
  sessions: SessionData[] | null;
}
interface BlockDetail {
  id: number; block_name: string; year_level: string; semester: string;
  academic_year: string; program_code: string; program_name: string; department: string | null;
}
interface DisplayRow {
  key: string; ms_id: number;
  subject_code: string; subject_name: string;
  row_hours: number; row_units: number;
  faculty_name: string | null; room_name: string | null;
  start_time: string | null; end_time: string | null;
  day_pattern: string;
}
interface DayGroup { pattern: string; label: string; order: number; rows: DisplayRow[]; }
interface Signatory { name: string; designation: string; }

// ─── Constants ────────────────────────────────────────────────────────────────

const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];

/** Same label style as Blocks / Faculty Workload filter rows */
const LABEL_CLS = 'block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1.5';

const ACTION_BTN =
  'inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors shadow-sm';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDayOrder(pattern: string): number {
  const p = pattern.trim().toLowerCase();
  if (['mwf', 'm/w/f', 'mon/wed/fri', 'mon-wed-fri'].includes(p)) return 0;
  if (['mon/wed', 'm/w', 'mw', 'mon-wed', 'monday/wednesday', 'monday', 'mon'].includes(p)) return 1;
  if (['tue/thu', 't/th', 'tth', 'tue-thu', 'tthu', 'tuesday/thursday', 'tuesday', 'tue'].includes(p)) return 2;
  if (['wednesday', 'wed'].includes(p)) return 3;
  if (['thursday', 'thu', 'th'].includes(p)) return 4;
  if (['fri', 'f', 'friday'].includes(p)) return 5;
  if (['sat', 's', 'saturday'].includes(p)) return 6;
  return 99;
}

function getDayLabel(pattern: string): string {
  const p = pattern.trim().toLowerCase();
  if (['mwf', 'm/w/f', 'mon/wed/fri', 'mon-wed-fri'].includes(p)) return 'Monday/Wednesday/Friday';
  if (['mon/wed', 'm/w', 'mw', 'mon-wed', 'monday/wednesday'].includes(p)) return 'Monday/Wednesday';
  if (['monday', 'mon'].includes(p)) return 'Monday';
  if (['tue/thu', 't/th', 'tth', 'tue-thu', 'tthu', 'tuesday/thursday'].includes(p)) return 'Tuesday/Thursday';
  if (['tuesday', 'tue'].includes(p)) return 'Tuesday';
  if (['wednesday', 'wed'].includes(p)) return 'Wednesday';
  if (['thursday', 'thu', 'th'].includes(p)) return 'Thursday';
  if (['fri', 'f', 'friday'].includes(p)) return 'Friday';
  if (['sat', 's', 'saturday'].includes(p)) return 'Saturday';
  return pattern;
}

function isAM(t: string | null): boolean {
  if (!t) return true;
  return parseInt(t.split(':')[0], 10) < 12;
}

function fmt12(t: string): string {
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h}:00` : `${h}:${m.toString().padStart(2, '0')}`;
}

function formatTimeRange(start: string | null, end: string | null): string {
  if (!start) return '';
  if (!end) return fmt12(start);
  return `${fmt12(start)}-${fmt12(end)}`;
}

function expandToDisplayRows(schedules: RawSchedule[]): DisplayRow[] {
  return schedules.map(s => ({
    key:          String(s.ms_id),
    ms_id:        s.ms_id,
    subject_code: s.subject_code,
    subject_name: s.subject_name,
    row_hours:    parseFloat(String(s.total_hours)) || 0,
    row_units:    parseFloat(String(s.units))       || 0,
    faculty_name: s.faculty_name,
    room_name:    s.room_name,
    start_time:   s.start_time,
    end_time:     s.end_time,
    day_pattern:  s.day_pattern ?? 'TBA',
  }));
}

function groupByDay(rows: DisplayRow[]): DayGroup[] {
  const map = new Map<string, DisplayRow[]>();
  for (const row of rows) {
    if (!map.has(row.day_pattern)) map.set(row.day_pattern, []);
    map.get(row.day_pattern)!.push(row);
  }
  return [...map.entries()]
    .map(([pattern, r]) => ({
      pattern,
      label: getDayLabel(pattern),
      order: getDayOrder(pattern),
      rows: r.sort((a, b) => (a.start_time ?? '').localeCompare(b.start_time ?? '')),
    }))
    .sort((a, b) => a.order - b.order || a.pattern.localeCompare(b.pattern));
}

function fmtNum(n: number): string {
  return n.toFixed(n % 1 === 0 ? 0 : 1);
}

/** Course label for print rows — same convention as Faculty Workload Course column. */
function formatCourseLabel(block: BlockDetail): string {
  const yearNum = (String(block.year_level).match(/\d+/) ?? [''])[0] || block.year_level;
  return [block.program_code, `${yearNum}${block.block_name}`].filter(Boolean).join(' ').trim();
}

// ─── Print CSS — Faculty Workload official chrome + Class Program preview ─────

const PRINT_CSS = `
${officialPrintEmbeddedDocumentCss()}
${officialPrintPreviewShellCss()}
`;

// ─── Main Component ───────────────────────────────────────────────────────────

export default function ClassProgramPage() {
  const { semester: globalSemester, schoolYear: globalYear, loading: semLoading } = useSchoolYear();

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
        if (meData.user?.role === 'department_chair') {
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
  const LS_KEY = 'cp_doc_settings';
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw) as Record<string, string>;
    } catch { /* ignore */ }
    return null;
  }
  const saved = loadSettings();
  const [campusName,    setCampusName]    = useState(saved?.campusName    ?? 'Cantilan Campus');
  const [campusAddress, setCampusAddress] = useState(saved?.campusAddress ?? 'Cantilan, Surigao del Sur');
  const [campusTel,     setCampusTel]     = useState(saved?.campusTel     ?? '086-212-5122');
  const [campusWebsite, setCampusWebsite] = useState(saved?.campusWebsite ?? 'www.nemsu.edu.ph');
  const [preparedBy,    setPreparedBy]    = useState<Signatory>({
    name:        saved?.preparedByName   ?? 'JOEL S. GRACIA, MSCS',
    designation: saved?.preparedByDesig  ?? 'Program Coordinator - CS',
  });
  const [recommendedBy, setRecommendedBy] = useState<Signatory>({
    name:        saved?.recommendedByName  ?? 'RAMONALIZA A. ESPENIDO, MST-SS',
    designation: saved?.recommendedByDesig ?? 'Registrar III',
  });
  const [notedBy, setNotedBy] = useState<Signatory>({
    name:        saved?.notedByName  ?? 'ENGR. NELYNE LOURDES Y. PLAZA, Ph.D.',
    designation: saved?.notedByDesig ?? 'Dept. Chair, Dept. of Computer Studies',
  });
  const [approvedBy, setApprovedBy] = useState<Signatory>({
    name:        saved?.approvedByName  ?? 'JUANCHO A. INTANO, Ph.D.',
    designation: saved?.approvedByDesig ?? 'Campus Director',
  });
  const [showSettings,  setShowSettings]  = useState(false);

  // Persist to localStorage whenever any setting changes
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        campusName, campusAddress, campusTel, campusWebsite,
        preparedByName:      preparedBy.name,
        preparedByDesig:     preparedBy.designation,
        recommendedByName:   recommendedBy.name,
        recommendedByDesig:  recommendedBy.designation,
        notedByName:         notedBy.name,
        notedByDesig:        notedBy.designation,
        approvedByName:      approvedBy.name,
        approvedByDesig:     approvedBy.designation,
      }));
    } catch { /* ignore */ }
  }, [campusName, campusAddress, campusTel, campusWebsite,
      preparedBy, recommendedBy, notedBy, approvedBy]);

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
        if (!ok) { setBlocksError(data.error || 'Failed to load blocks.'); return; }
        setBlocks(data.blocks || []);
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
        if (!ok) { setLoadError(data.error || 'Failed to load class program.'); return; }
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
  const dayGroups       = groupByDay(scheduledRows);
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

  // ── Excel export ─────────────────────────────────────────────────────────
  async function handleExportExcel() {
    if (!blockDetail || !selectionComplete) return;
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const C7 = ['', '', '', '', '', '', ''];
    const HDR = ['Time', 'Subject Code', 'Description', 'No. of Units', 'No. of Hours', 'Instructor/Professor', 'Rm. #'];
    const ws_data: (string | number)[][] = [];
    ws_data.push(['Republic of the Philippines']);
    ws_data.push(['North Eastern Mindanao State University']);
    ws_data.push([`${campusName} — ${campusAddress}`]);
    ws_data.push(['CLASS PROGRAM']);
    ws_data.push([`${blockDetail.semester}  A.Y. ${blockDetail.academic_year}`]);
    ws_data.push([`Course/Year/Sec: ${blockDetail.program_code} ${blockDetail.year_level} — Block ${blockDetail.block_name}`]);
    ws_data.push([...C7]);
    ws_data.push(HDR);
    for (const g of dayGroups) {
      const am = g.rows.filter(r => isAM(r.start_time));
      const pm = g.rows.filter(r => !isAM(r.start_time));
      ws_data.push([`A.M.`, g.label, '', '', '', '', '']);
      if (am.length) { for (const r of am) ws_data.push([formatTimeRange(r.start_time, r.end_time), r.subject_code, r.subject_name, r.row_units, r.row_hours, r.faculty_name || '', r.room_name || 'No room assigned']); }
      else ws_data.push([...C7]);
      ws_data.push(['Lunch Break', ...C7.slice(1)]);
      ws_data.push(['P.M.', ...C7.slice(1)]);
      if (pm.length) { for (const r of pm) ws_data.push([formatTimeRange(r.start_time, r.end_time), r.subject_code, r.subject_name, r.row_units, r.row_hours, r.faculty_name || '', r.room_name || 'No room assigned']); }
      else ws_data.push([...C7]);
    }
    ws_data.push(['', '', 'Total Number of Units', totalUnits, totalHours, '', '']);
    const ws = XLSX.utils.aoa_to_sheet(ws_data);
    ws['!cols'] = [{ wch: 18 }, { wch: 14 }, { wch: 36 }, { wch: 13 }, { wch: 13 }, { wch: 28 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Class Program');
    XLSX.writeFile(wb, `ClassProgram_${blockDetail.program_code}_Block${blockDetail.block_name}_${blockDetail.semester.replace(/\s+/g, '_')}.xlsx`);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      {/* ── Page header (same structure as Master Schedule) ── */}
      <div className="no-print mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-[#1E3A5F]">Class Program</h1>
        </div>

        <div className="flex flex-shrink-0 flex-wrap gap-2.5" role="group" aria-label="Class program actions">
          <button
            type="button"
            disabled={!showActions}
            onClick={() => window.print()}
            title={showActions ? 'Print or save as PDF' : 'Select program, year level, and block first'}
            className={[
              ACTION_BTN,
              showActions
                ? 'bg-[#3C91E6] text-white hover:bg-[#2E7DD1]'
                : 'cursor-not-allowed border border-[#E2E8F0] bg-slate-100 text-slate-400',
            ].join(' ')}
          >
            Print / PDF
          </button>
          <button
            type="button"
            disabled={!showActions}
            onClick={handleExportExcel}
            title={showActions ? 'Export to Excel' : 'Select program, year level, and block first'}
            className={[
              ACTION_BTN,
              showActions
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'cursor-not-allowed border border-[#E2E8F0] bg-slate-100 text-slate-400',
            ].join(' ')}
          >
            Export Excel
          </button>
          <button
            type="button"
            disabled={!showActions}
            onClick={() => setShowSettings(s => !s)}
            title={showActions ? 'Document settings' : 'Select program, year level, and block first'}
            className={[
              ACTION_BTN,
              showActions
                ? 'border border-[#E2E8F0] bg-white text-[#1E3A5F] hover:bg-[#F8FAFC]'
                : 'cursor-not-allowed border border-[#E2E8F0] bg-white text-slate-400',
            ].join(' ')}
          >
            {showSettings ? 'Hide Settings' : 'Document Settings'}
          </button>
        </div>
      </div>

      {/* ── Filter panel (same FilterBar as Master Schedule) ── */}
      <FilterBar className="no-print relative z-20">
        <div id="cp-selection" className="space-y-4">
          <p className="text-sm font-semibold text-[#1E3A5F]">Class Program Selection</p>

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
      {showSettings && showDocument && (
        <div className="no-print mb-6 rounded-2xl border border-[#E2E8F0] bg-white p-5 shadow-sm text-[#1E3A5F]">
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
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Signatories</p>
          <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {([
              ['Prepared By — Name',                    preparedBy.name,          (v: string) => setPreparedBy(s => ({ ...s, name: v })),          'Full name with credentials'],
              ['Prepared By — Designation',             preparedBy.designation,   (v: string) => setPreparedBy(s => ({ ...s, designation: v })),   'e.g., Program Coordinator - CS'],
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
      )}

      {/* ── Loading / Empty / Document ── */}
      {showSkeleton ? (
        <div className="no-print space-y-4" role="status" aria-live="polite" aria-label="Loading class program">
          <FiltersSkeleton fields={2} />
          <CardSkeleton className="min-h-[320px]" />
        </div>
      ) : !showDocument ? (
        <div className="no-print rounded-2xl border border-[#E2E8F0] bg-white px-6 py-14 text-center shadow-sm">
          <p className="text-sm font-semibold text-[#1E3A5F]">{emptyTitle()}</p>
        </div>
      ) : (
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

            {/* Block info — Class Program equivalent of faculty .info block */}
            <div className="info">
              <div className="info-left">
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
              <div className="info-right">
                <div className="hf">
                  <span className="i-lbl">Semester:</span>
                  <span className="i-val">{blockDetail!.semester}</span>
                </div>
                <div className="hf">
                  <span className="i-lbl">A.Y.:</span>
                  <span className="i-val">{formatAy(blockDetail!.academic_year)}</span>
                </div>
              </div>
            </div>

            {/* Schedule table — Faculty Workload .wl language */}
            {dayGroups.length > 0 ? (
              <table className="wl">
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
                  <td style={{ width: '50%', paddingLeft: 20 }} className="blk lbl">Recommending Approval:</td>
                </tr>
                <tr className="sp"><td /><td /></tr>
                <tr>
                  <td style={{ padding: '0 20px 0 0' }} className="blk">
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
      <td className="t-units">{fmtNum(row.row_units)}</td>
      <td className="t-hours">{fmtNum(row.row_hours)}</td>
      <td className="t-inst">{row.faculty_name ?? ''}</td>
      <td className="t-room">
        {row.room_name ? row.room_name : <span className="no-room">No room assigned</span>}
      </td>
    </tr>
  );
}
