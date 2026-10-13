'use client';

/**
 * Reports — one place under System to print or export QRganize's official
 * documents. Every report reuses the code of its own page, so the output is
 * identical wherever it is produced:
 *   • Faculty Workload Form — same menu as Faculty Schedules.
 *   • Class Program — the Class Program page's own paper form and saved
 *     signatories (classProgramReport), printed right here (no new tab).
 *   • Curriculum — same print / Excel helpers as Curriculum Setup.
 *   • Room QR Codes — same print cards as QR Generator, plus Excel.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight, BookOpen, CalendarDays, CalendarRange, Check, ChevronDown, FileSpreadsheet, FileText,
  Loader2, Printer, QrCode, Search, X,
} from 'lucide-react';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import AnchoredPopover from '@/components/ui/AnchoredPopover';
import FriendlySelect from '@/components/ui/FriendlySelect';
import { blockCurriculumVersion } from '@shared/curriculumVersion';
import { EmploymentBadge } from '@/components/ui/EmploymentBadge';
import { Skeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useToast } from '@/context/ToastContext';
import { useRealtime } from '@/context/RealtimeContext';
import { CURRICULUM_VERSIONS, DEFAULT_CURRICULUM_VERSION, curriculumVersionLabel, type CurriculumVersion } from '@shared/curriculumVersion';
import WorkloadPrintMenu from '@/components/WorkloadPrintMenu';
import { downloadCurriculumExcel, fetchCurriculumGroups, groupCurriculums, printCurriculum, type CurriculumRowLike } from '../program/curriculum/curriculumReport';
import { downloadQrExcel, printRooms, type RoomQR } from '../qr-generator/qrReport';
import { buildClassProgramPrintHtml, downloadClassProgramExcel, fetchClassProgram, loadClassProgramDocSettings } from '../program/class-program/classProgramReport';
import { fetchDayCombinations } from '@/lib/dayCombinations';
import { printHtmlInPlace } from '@/lib/openPrintHtmlDocument';
import { runExport } from '@/components/ui/ExportProgress';

interface FacultyOption { id: number; name: string; employment_status: string; position: string }
interface ProgramOption { id: number; code: string; name: string }
interface BlockOption { id: number; block_name: string; year_level: string; curriculum_version?: string; subject_count?: number }
type Busy = 'excel' | 'print' | null;

/** "2nd Year" → "2" (Year & Block reads 1A, 1B, 2A… as on Faculty Workload) */
const yearNum = (yearLevel: string) => yearLevel.match(/\d+/)?.[0] ?? yearLevel;

/** Program choices for the big dropdown: code, full name under it */
const programOptions = (programs: ProgramOption[]) => programs.map(p => ({ value: String(p.id), label: p.code, hint: p.name }));

/** Searchable faculty picker — grouped Permanent / Contractual, A–Z within each.
 *  The picked faculty can be removed: the × in the box, or picking the same name again. */
function FacultyPicker({ faculty, value, onChange }: {
  faculty: FacultyOption[]; value: number | null; onChange: (id: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [panelWidth, setPanelWidth] = useState(420); // matches the trigger, measured on open
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selected = faculty.find(f => f.id === value) ?? null;

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const match = faculty
      .filter(f => !term || f.name.toLowerCase().includes(term) || f.position.toLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [
      { label: 'Permanent', items: match.filter(f => f.employment_status === 'Permanent') },
      { label: 'Contractual', items: match.filter(f => f.employment_status !== 'Permanent') },
    ].filter(g => g.items.length > 0);
  }, [faculty, q]);
  const firstMatch = groups[0]?.items[0] ?? null;

  function pick(id: number) {
    // Picking the faculty already picked unselects them
    onChange(id === value ? null : id);
    setOpen(false);
    setQ('');
  }
  function clear() {
    onChange(null);
    setOpen(false);
    setQ('');
    triggerRef.current?.focus();
  }

  return (
    <>
      <div className="relative">
        <button
          ref={triggerRef}
          type="button"
          onClick={e => { setPanelWidth(e.currentTarget.offsetWidth); setOpen(o => !o); }}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={`w-full h-12 pl-4 ${selected ? 'pr-[5.25rem]' : 'pr-11'} rounded-xl border bg-white flex items-center gap-2 text-left transition-colors ${
            open ? 'border-[#1D5BD6] ring-2 ring-[#1D5BD6]/15' : 'border-[#D6E0EF] hover:border-[#9DB8E8]'
          }`}
        >
          <span className={`flex-1 truncate text-[15px] ${selected ? 'font-semibold text-[#0B2A5B]' : 'text-[#64748B]'}`}>
            {selected ? selected.name : 'Select faculty…'}
          </span>
        </button>
        {/* Remove the picked faculty — beside the arrow, inside the box */}
        <AnimatePresence initial={false}>
          {selected && (
            <motion.button
              key="clear"
              type="button"
              onClick={clear}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.18, ease: EASE }}
              aria-label={`Remove ${selected.name}`}
              title="Remove"
              className="absolute right-10 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg flex items-center justify-center text-[#64748B] hover:text-[#B91C1C] hover:bg-[#FEF2F2] transition-colors"
            >
              <X className="w-[18px] h-[18px]" aria-hidden />
            </motion.button>
          )}
        </AnimatePresence>
        <ChevronDown
          aria-hidden
          className={`pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[#64748B] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </div>

      <AnchoredPopover
        open={open}
        onClose={() => { setOpen(false); setQ(''); }}
        anchorRef={triggerRef}
        panelRef={panelRef}
        width={panelWidth}
        maxHeight={400}
        label="Select faculty"
        onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); setQ(''); triggerRef.current?.focus(); } }}
      >
        <div className="flex flex-col max-h-[400px]">
          <div className="p-2.5 border-b border-[#F1F5F9]">
            <label className="flex items-center gap-2 h-10 px-3 rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] focus-within:border-[#1D5BD6]">
              <Search className="w-4 h-4 text-[#94A3B8]" />
              <input
                autoFocus
                value={q}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && firstMatch) { e.preventDefault(); pick(firstMatch.id); } }}
                placeholder="Search name or position"
                className="flex-1 bg-transparent outline-none text-sm text-[#0B2A5B] placeholder:text-[#94A3B8]"
                aria-label="Search faculty"
              />
            </label>
          </div>
          <div className="overflow-y-auto py-1" role="listbox" aria-label="Faculty">
            {groups.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-[#94A3B8]">No faculty match “{q}”.</p>
            ) : groups.map(g => (
              <div key={g.label}>
                <p className="sticky top-0 z-[1] bg-white px-4 pt-2.5 pb-1 text-[11px] font-bold uppercase tracking-wider text-[#64748B]">
                  {g.label} <span className="font-semibold text-[#94A3B8]">· {g.items.length}</span>
                </p>
                {g.items.map(f => {
                  const on = f.id === value;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      role="option"
                      aria-selected={on}
                      title={on ? 'Click again to unselect' : undefined}
                      onClick={() => pick(f.id)}
                      className={`w-full px-4 py-2 flex items-center gap-3 text-left transition-colors ${on ? 'bg-[#EFF6FF]' : 'hover:bg-[#F8FAFC]'}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm ${on ? 'font-bold text-[#1D5BD6]' : 'font-semibold text-[#0B2A5B]'}`}>{f.name}</span>
                        <span className="block truncate text-xs text-[#94A3B8]">{f.position || '—'}</span>
                      </span>
                      {on && <Check className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </AnchoredPopover>
    </>
  );
}

const EASE = [0.4, 0, 0.2, 1] as const;

const CARD = 'rounded-2xl border border-[#E3E9F3] bg-white shadow-[0_1px_3px_rgba(11,42,91,0.06)]';
const LABEL = 'block text-sm font-semibold text-[#475569] mb-1.5';
/** Each report's colour — the same colour tiles as Settings */
const TONE = { workload: '#1D5BD6', classProgram: '#0284C7', curriculum: '#4F46E5', qr: '#12408F' } as const;
const WHITE = { color: '#FFFFFF' } as const;

/** Tinted card face + soft corner circle (Settings tile look) */
const tileFace = (tone: string, ready: boolean, angle = 160) => ({
  background: `linear-gradient(${angle}deg, ${tone}17 0%, #FFFFFF 45%)`,
  borderColor: ready ? `${tone}80` : `${tone}2E`,
});
function TileCircle({ tone }: { tone: string }) {
  return <span aria-hidden className="pointer-events-none absolute -right-10 -top-10 w-36 h-36 rounded-full" style={{ backgroundColor: `${tone}0F` }} />;
}
function TileIcon({ tone, icon: Icon }: { tone: string; icon: typeof Printer }) {
  return (
    <span className="relative w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-[0_8px_18px_-8px_rgba(11,42,91,0.45)]"
      style={{ background: `linear-gradient(135deg, ${tone} 0%, #0B2A5B 140%)` }}>
      <Icon className="w-6 h-6" style={WHITE} aria-hidden />
    </span>
  );
}
const POPUP_BLOCKED = 'Pop-up blocked. Allow pop-ups for this site and try again.';

/* ─── Shared pieces ─────────────────────────────────────────────────────── */

/** Briefly remembers which action just finished, for the "Done" check */
function useDone(): [Busy, (a: Exclude<Busy, null>) => void] {
  const [done, setDone] = useState<Busy>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const flash = useCallback((a: Exclude<Busy, null>) => {
    setDone(a);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(null), 1800);
  }, []);
  return [done, flash];
}

/** Excel (green) + Print (royal blue) — the same colours as everywhere else */
function ExportButtons({ busy, done = null, disabled, onExcel, onPrint }: {
  busy: Busy; done?: Busy; disabled: boolean; onExcel: () => void; onPrint: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const base = 'flex-1 inline-flex items-center justify-center gap-2 h-11 px-3 rounded-xl border text-base font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
  const icon = (kind: Exclude<Busy, null>, Idle: typeof Printer) => (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={busy === kind ? 'busy' : done === kind ? 'done' : 'idle'}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
        transition={{ duration: 0.18, ease: EASE }}
        className="inline-flex"
      >
        {busy === kind ? <Loader2 className="w-4 h-4 animate-spin" /> : done === kind ? <Check className="w-4 h-4" /> : <Idle className="w-4 h-4" />}
      </motion.span>
    </AnimatePresence>
  );
  const press = reduceMotion ? {} : { whileHover: { y: -1 }, whileTap: { scale: 0.96 } };
  return (
    <div className="flex gap-2">
      <motion.button type="button" onClick={onExcel} disabled={disabled || busy !== null} {...(disabled ? {} : press)}
        className={`${base} bg-[#E9F5EE] border-[#B7DFC6] text-[#107C41] hover:enabled:bg-[#D5EDDF] hover:enabled:border-[#107C41] [html:not(.light)_&]:bg-[#123524]! [html:not(.light)_&]:border-[#1F5E3A]! [html:not(.light)_&]:text-[#86EFAC]!`}>
        {icon('excel', FileSpreadsheet)} {done === 'excel' ? 'Done' : 'Excel'}
      </motion.button>
      <motion.button type="button" onClick={onPrint} disabled={disabled || busy !== null} {...(disabled ? {} : press)}
        className={`${base} bg-[#EFF6FF] border-[#BFDBFE] text-[#1D5BD6] hover:enabled:bg-[#DBEAFE] hover:enabled:border-[#1D5BD6] [html:not(.light)_&]:bg-[#13284D]! [html:not(.light)_&]:border-[#24467F]! [html:not(.light)_&]:text-[#93C5FD]!`}>
        {icon('print', Printer)} {done === 'print' ? 'Done' : 'Print'}
      </motion.button>
    </div>
  );
}

/** One report card: icon, title, its selections, then Excel / Print. The
 *  summary (the finished selection) has a kept place, so the buttons line up
 *  across the cards; a ready card takes a stronger border in its colour. */
function ReportCard({ icon, tone, title, text, href, children, actions, note, summary }: {
  icon: typeof Printer; tone: string; title: string; text: string; href: string;
  children?: ReactNode; actions: ReactNode; note?: string; summary?: string | null;
}) {
  const reduceMotion = useReducedMotion();
  const ready = !!summary;
  return (
    <motion.section
      whileHover={reduceMotion ? undefined : { y: -3, boxShadow: `0 18px 36px -20px ${tone}99` }}
      transition={{ duration: 0.25, ease: EASE }}
      className="qr-stat-tint relative overflow-hidden rounded-2xl border p-5 h-full flex flex-col transition-[border-color] duration-300"
      style={tileFace(tone, ready)}
    >
      <TileCircle tone={tone} />
      <div className="relative flex items-start gap-3.5">
        <TileIcon tone={tone} icon={icon} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[17px] font-bold leading-tight text-[#0B2A5B]">{title}</h3>
          <p className="text-sm text-[#64748B] mt-1">{text}</p>
        </div>
      </div>
      <div className="relative mt-5 space-y-3 flex-1">{children}</div>
      {/* One fixed height in every card, so Excel / Print line up across the row */}
      <div className="relative mt-4 h-[46px]">
        <AnimatePresence initial={false}>
          {summary && (
            <motion.p
              key="summary"
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
              transition={{ duration: 0.25, ease: EASE }}
              className="h-full flex items-center gap-2 rounded-xl border px-3 text-sm font-semibold text-[#0B2A5B]"
              style={{ backgroundColor: `${tone}0D`, borderColor: `${tone}33` }}
            >
              <Check className="w-4 h-4 flex-shrink-0 [html:not(.light)_&]:text-[#93C5FD]!" style={{ color: tone }} />
              <span className="truncate">{summary}</span>
            </motion.p>
          )}
        </AnimatePresence>
      </div>
      <div className="relative mt-3">{actions}</div>
      <div className="relative mt-4 pt-3 border-t border-[#E9EEF6] [html:not(.light)_&]:border-white/10 flex items-center justify-between gap-3">
        <span className="text-sm text-[#64748B] min-w-0 truncate" title={note}>{note}</span>
        <Link href={href} className="group inline-flex items-center gap-1 text-sm font-semibold flex-shrink-0 [html:not(.light)_&]:text-[#93C5FD]!" style={{ color: tone }}>
          Open page <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
    </motion.section>
  );
}

function usePrograms(): { programs: ProgramOption[]; loading: boolean } {
  const [programs, setPrograms] = useState<ProgramOption[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch('/api/programs', { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : { programs: [] }))
      .then(d => setPrograms((d.programs ?? []) as ProgramOption[]))
      .catch(() => {})
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, []);
  // Live updates: a program was added elsewhere
  useRealtime(['programs'], () => fetch('/api/programs')
    .then(r => (r.ok ? r.json() : null))
    .then(d => { if (d && Array.isArray(d.programs)) setPrograms(d.programs as ProgramOption[]); })
    .catch(() => {}), { enabled: !loading });
  return { programs, loading };
}

/* ─── Class Program ─────────────────────────────────────────────────────── */

/**
 * Excel and Print are both built right here with the Class Program page's own
 * builders, data and saved signatories (classProgramReport) — Print opens the
 * print dialog on this page, without going to the Class Program page.
 */
function ClassProgramReport({ programs, semester, schoolYear }: {
  programs: ProgramOption[]; semester: string; schoolYear: string;
}) {
  const toast = useToast();
  const [program, setProgram] = useState('');
  const [year, setYear] = useState('');
  const [block, setBlock] = useState('');
  const [blocks, setBlocks] = useState<BlockOption[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [done, flashDone] = useDone();
  const progCode = programs.find(p => String(p.id) === program)?.code ?? '';
  const blockName = blocks.find(b => String(b.id) === block)?.block_name;
  const summary = blockName ? `${progCode} · ${year} · Block ${blockName}` : null;

  // Every year level at once — the Year & Block list runs 1A, 1B, 2A…
  useEffect(() => {
    if (!program || !semester || !schoolYear) return;
    const ctrl = new AbortController();
    const params = new URLSearchParams({ program_id: program, semester, academic_year: schoolYear });
    fetch(`/api/blocks?${params}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : { blocks: [] }))
      .then(d => setBlocks((d.blocks ?? []) as BlockOption[]))
      .catch(() => {})
      .finally(() => { if (!ctrl.signal.aborted) setBlocksLoading(false); });
    return () => ctrl.abort();
  }, [program, semester, schoolYear]);

  // Live updates: blocks added or removed elsewhere (the picked block stays picked)
  const blocksQuery = program && semester && schoolYear
    ? new URLSearchParams({ program_id: program, semester, academic_year: schoolYear }).toString()
    : '';
  const shownBlocksQuery = useRef('');
  useEffect(() => { shownBlocksQuery.current = blocksQuery; }, [blocksQuery]);
  useRealtime(['blocks'], () => {
    if (!blocksQuery) return;
    return fetch(`/api/blocks?${blocksQuery}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && shownBlocksQuery.current === blocksQuery) setBlocks((d.blocks ?? []) as BlockOption[]); })
      .catch(() => {});
  }, { enabled: !blocksLoading });

  /** The block's class program as the database has it now */
  async function load() {
    const [{ block: detail, schedules }, { combinations }] = await Promise.all([
      fetchClassProgram({ blockId: block, programId: program, yearLevel: year, semester }),
      fetchDayCombinations(semester, schoolYear, { fresh: true }),
    ]);
    return { detail, schedules, combos: combinations.filter(c => c.is_active), settings: loadClassProgramDocSettings(detail.program_code) };
  }

  async function onExcel() {
    if (!program || !year || !block || !semester) return;
    setBusy('excel');
    try {
      await runExport({ kind: 'excel', detail: summary ?? 'Class Program' }, async () => {
        const d = await load();
        await downloadClassProgramExcel({ block: d.detail, schedules: d.schedules, combos: d.combos, settings: d.settings });
      });
      flashDone('excel');
      toast.success('Class Program downloaded as Excel.');
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not create the Excel file.');
    } finally {
      setBusy(null);
    }
  }

  async function onPrint() {
    if (!program || !year || !block || !semester) return;
    setBusy('print');
    try {
      // The paper form, printed from this page (no new tab)
      const html = await runExport({ kind: 'print', detail: summary ?? 'Class Program' }, async () => {
        const d = await load();
        return buildClassProgramPrintHtml({
          block: d.detail, schedules: d.schedules, combos: d.combos, settings: d.settings, origin: window.location.origin,
        });
      });
      const result = await printHtmlInPlace(html);
      if (result.ok) flashDone('print');
      else toast.error('Printing is not available in this browser. Try Chrome or Edge.');
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not prepare the class program.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <ReportCard
      icon={CalendarRange}
      tone={TONE.classProgram}
      title="Class Program"
      text="Official class schedule per block."
      href="/program/class-program"
      note="Signatories are set on its page."
      summary={summary}
      actions={<ExportButtons busy={busy} done={done} disabled={!block} onExcel={onExcel} onPrint={onPrint} />}
    >
      <div>
        <label className={LABEL}>Program</label>
        <FriendlySelect
          value={program}
          onChange={v => { setProgram(v); setYear(''); setBlock(''); setBlocks([]); setBlocksLoading(!!v); }}
          label="Program"
          placeholder="Select program…"
          minPanelWidth={320}
          showHintInTrigger
          options={programOptions(programs)}
        />
      </div>
      <div>
        <label className={LABEL}>Year &amp; Block</label>
        <FriendlySelect
          value={block}
          onChange={v => { setBlock(v); setYear(blocks.find(b => String(b.id) === v)?.year_level ?? ''); }}
          label="Year & Block"
          placeholder="Select year & block…"
          disabled={!program || blocksLoading || blocks.length === 0}
          disabledText={!program ? 'Select a program first' : blocksLoading ? 'Loading blocks…' : 'No blocks this semester'}
          minPanelWidth={300}
          searchable
          searchPlaceholder="Search, e.g. 1A"
          options={[...blocks]
            .sort((a, b) => yearNum(a.year_level).localeCompare(yearNum(b.year_level), undefined, { numeric: true })
              || a.block_name.localeCompare(b.block_name, undefined, { numeric: true }))
            .map(b => ({
              value: String(b.id),
              label: `${yearNum(b.year_level)}${b.block_name}`,
              hint: `${b.year_level}, Block ${b.block_name} · ${curriculumVersionLabel(blockCurriculumVersion(b.curriculum_version))}`,
              badge: b.subject_count ? `${b.subject_count} subjects` : undefined,
              badgeTone: 'muted' as const,
            }))}
        />
      </div>
    </ReportCard>
  );
}

/* ─── Curriculum ────────────────────────────────────────────────────────── */

function CurriculumReport({ programs }: { programs: ProgramOption[] }) {
  const toast = useToast();
  const [program, setProgram] = useState('');
  const [version, setVersion] = useState<CurriculumVersion>(DEFAULT_CURRICULUM_VERSION);
  const [rows, setRows] = useState<CurriculumRowLike[] | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [done, flashDone] = useDone();

  // Load ahead so Print opens straight from the click (pop-ups need the click)
  useEffect(() => {
    if (!program) return;
    const ctrl = new AbortController();
    fetch(`/api/curriculum?${new URLSearchParams({ program_id: program, curriculum_version: version })}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : { curriculums: [] }))
      .then(d => setRows((d.curriculums ?? []) as CurriculumRowLike[]))
      .catch(() => {});
    return () => ctrl.abort();
  }, [program, version]);
  // Live: subjects changed elsewhere — Print (which can't wait for a fresh read) stays current
  useRealtime(['curriculum'], () => {
    if (!program) return;
    const picked = `${program}|${version}`;
    return fetch(`/api/curriculum?${new URLSearchParams({ program_id: program, curriculum_version: version })}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && picked === `${program}|${version}`) setRows((d.curriculums ?? []) as CurriculumRowLike[]); })
      .catch(() => {});
  });

  const prog = programs.find(p => String(p.id) === program);
  const groups = useMemo(() => groupCurriculums(rows ?? []), [rows]);
  const count = rows?.length ?? 0;

  async function onExcel() {
    if (!prog || count === 0) return;
    setBusy('excel');
    try {
      await runExport({ kind: 'excel', detail: `${prog.code} · ${curriculumVersionLabel(version)}` }, async () => {
        // Read from the database at this moment, not the list loaded when the program was picked
        const fresh = await fetchCurriculumGroups({ programId: program, version });
        await downloadCurriculumExcel({ programName: prog.name, programCode: prog.code, version, groups: fresh });
      });
      flashDone('excel');
      toast.success('Curriculum downloaded as Excel.');
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not generate the Excel file.');
    } finally {
      setBusy(null);
    }
  }
  async function onPrint() {
    if (!prog || count === 0) return;
    if (await printCurriculum(groups, prog.name, version)) flashDone('print');
    else toast.error(POPUP_BLOCKED);
  }

  return (
    <ReportCard
      icon={BookOpen}
      tone={TONE.curriculum}
      title="Curriculum"
      text="A program’s curriculum by version."
      href="/program/curriculum"
      note={program && rows && count === 0 ? 'No subjects in this curriculum' : undefined}
      summary={prog && count > 0 ? `${prog.code} · ${curriculumVersionLabel(version)} · ${count} subject${count !== 1 ? 's' : ''}` : null}
      actions={<ExportButtons busy={busy} done={done} disabled={!program || count === 0} onExcel={onExcel} onPrint={onPrint} />}
    >
      <div>
        <label className={LABEL}>Program</label>
        <FriendlySelect
          value={program}
          onChange={v => { setProgram(v); setRows(null); }}
          label="Program"
          placeholder="Select program…"
          minPanelWidth={320}
          showHintInTrigger
          options={programOptions(programs)}
        />
      </div>
      <div>
        <label className={LABEL}>Curriculum</label>
        <FriendlySelect
          value={version}
          onChange={v => { setVersion(v as CurriculumVersion); setRows(null); }}
          label="Curriculum"
          disabled={!program}
          disabledText="Select a program first"
          options={CURRICULUM_VERSIONS.map(v => ({ value: v, label: curriculumVersionLabel(v) }))}
        />
      </div>
    </ReportCard>
  );
}

/* ─── Room QR Codes ─────────────────────────────────────────────────────── */

function RoomQrReport({ rooms }: { rooms: RoomQR[] }) {
  const toast = useToast();
  const [type, setType] = useState<'All' | 'Lecture' | 'Laboratory'>('All');
  const [busy, setBusy] = useState<Busy>(null);
  const [done, flashDone] = useDone();

  const isLab = (t: string) => t === 'Laboratory' || t === 'Computer Lab';
  const list = rooms.filter(r => type === 'All' || (type === 'Laboratory' ? isLab(r.room_type) : !isLab(r.room_type)));
  const ready = list.filter(r => r.generated && r.qr_data_url);
  const title = type === 'All' ? 'Room QR Codes' : `${type} Room QR Codes`;

  async function onExcel() {
    setBusy('excel');
    try {
      const saved = await runExport({ kind: 'excel', detail: title }, async () => {
        // The rooms and QR codes as the database has them now
        const latest = await fetch('/api/rooms/qr-codes', { cache: 'no-store' })
          .then(r => (r.ok ? r.json() : null))
          .then(d => (Array.isArray(d?.rooms) ? d.rooms as RoomQR[] : null))
          .catch(() => null);
        const rows = latest
          ? latest.filter(r => (type === 'All' || (type === 'Laboratory' ? isLab(r.room_type) : !isLab(r.room_type))) && r.generated && r.qr_data_url)
          : ready;
        return downloadQrExcel(rows, title);
      });
      if (saved) {
        flashDone('excel');
        toast.success('Room QR codes downloaded as Excel.');
      }
    } catch {
      toast.error('Could not create the Excel file.');
    } finally {
      setBusy(null);
    }
  }
  function onPrint() {
    if (printRooms(ready, title)) flashDone('print');
    else toast.error(POPUP_BLOCKED);
  }

  return (
    <ReportCard
      icon={QrCode}
      tone={TONE.qr}
      title="Room QR Codes"
      text="QR codes to post at each room."
      href="/qr-generator"
      note={rooms.length ? `${ready.length} of ${list.length} rooms have a QR code` : undefined}
      summary={ready.length ? `${ready.length} QR code${ready.length !== 1 ? 's' : ''} · ${type === 'All' ? 'All rooms' : `${type} rooms`}` : null}
      actions={<ExportButtons busy={busy} done={done} disabled={ready.length === 0} onExcel={onExcel} onPrint={onPrint} />}
    >
      <div>
        <label className={LABEL}>Rooms</label>
        <FriendlySelect
          value={type}
          onChange={v => setType(v as typeof type)}
          label="Rooms"
          options={([
            ['All', 'All rooms', rooms.length],
            ['Lecture', 'Lecture rooms', rooms.filter(r => !isLab(r.room_type)).length],
            ['Laboratory', 'Laboratory rooms', rooms.filter(r => isLab(r.room_type)).length],
          ] as const).map(([value, label, n]) => ({ value, label, badge: String(n), badgeTone: 'blue' as const }))}
        />
      </div>
    </ReportCard>
  );
}

export default function ReportsClient() {
  const reduceMotion = useReducedMotion();
  const { schoolYear, semester, loading: termLoading } = useSchoolYear();
  const [faculty, setFaculty] = useState<FacultyOption[]>([]);
  const [facultyLoading, setFacultyLoading] = useState(true);
  const [facultyId, setFacultyId] = useState<number | null>(null);
  const { programs, loading: programsLoading } = usePrograms();
  const [rooms, setRooms] = useState<RoomQR[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);

  const loadFaculty = useCallback((signal?: AbortSignal) => fetch('/api/faculty', { signal })
    .then(r => (r.ok ? r.json() : { faculty: [] }))
    .then(d => setFaculty(((d.faculty ?? []) as Record<string, unknown>[]).map(f => ({
      id: Number(f.id), name: String(f.name ?? ''), employment_status: String(f.employment_status ?? ''), position: String(f.position ?? ''),
    })))), []);
  const loadRooms = useCallback((signal?: AbortSignal) => fetch('/api/rooms/qr-codes', { signal, cache: 'no-store' })
    .then(r => (r.ok ? r.json() : { rooms: [] }))
    .then(d => setRooms((d.rooms ?? []) as RoomQR[])), []);

  useEffect(() => {
    const ctrl = new AbortController();
    loadFaculty(ctrl.signal)
      .catch(() => {})
      .finally(() => { if (!ctrl.signal.aborted) setFacultyLoading(false); });
    return () => ctrl.abort();
  }, [loadFaculty]);

  useEffect(() => {
    const ctrl = new AbortController();
    loadRooms(ctrl.signal)
      .catch(() => {})
      .finally(() => { if (!ctrl.signal.aborted) setRoomsLoading(false); });
    return () => ctrl.abort();
  }, [loadRooms]);

  // Live updates: the pickers follow faculty and room changes made elsewhere
  // (reports themselves are always built from fresh data when generated)
  useRealtime(['faculty'], () => loadFaculty().catch(() => {}), { enabled: !facultyLoading });
  useRealtime(['rooms'], () => loadRooms().catch(() => {}), { enabled: !roomsLoading });

  /* One skeleton for the whole page until the term, faculty, programs and rooms
     are in — otherwise the cards filled in one by one and the "Set the active
     school year first" message flashed while the term was still loading. */
  const showSkeleton = useMinLoading(termLoading || facultyLoading || programsLoading || roomsLoading, LOADING_DELAY);

  const picked = faculty.find(f => f.id === facultyId) ?? null;
  const termReady = !!semester && !!schoolYear;

  const rise = (i: number) => ({
    initial: reduceMotion ? false : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.3, ease: EASE, delay: reduceMotion ? 0 : i * 0.05 } },
  });

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full min-w-0">
      <BackButton />
      <div className="mt-4 sm:mt-7 mb-6">
        <WatermarkTitle>Reports</WatermarkTitle>
      </div>

      <PageLoadTransition showSkeleton={showSkeleton} skeleton={<ReportsSkeleton />}>
      {/* Active term */}
      <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
        <span className="inline-flex items-center gap-2 h-9 px-3.5 rounded-xl border border-[#D6E0EF] bg-white font-semibold text-[#0B2A5B]">
          <CalendarDays className="w-4 h-4 text-[#1D5BD6]" /> {semester || 'Semester'} · A.Y. {schoolYear || '—'}
        </span>
        <span className="text-[#64748B]">Reports use the active term set in Settings.</span>
      </div>

      {/* Faculty Workload Form */}
      <motion.section {...rise(0)}
        className={`qr-stat-tint relative overflow-hidden rounded-2xl border p-5 sm:p-6 transition-[border-color,box-shadow] duration-300 ${
          picked ? 'shadow-[0_14px_32px_-22px_rgba(29,91,214,0.7)]' : ''
        }`}
        style={tileFace(TONE.workload, !!picked, 115)}
      >
        <TileCircle tone={TONE.workload} />
        <div className="relative flex flex-col lg:flex-row lg:items-center gap-5 lg:gap-8">
          <div className="flex items-start gap-3.5 min-w-0 lg:flex-1">
            <TileIcon tone={TONE.workload} icon={FileText} />
            <div className="min-w-0">
              <h2 className="text-lg font-bold leading-tight text-[#0B2A5B]">Faculty Workload Form</h2>
              <p className="text-sm text-[#64748B] mt-1">Actual Load, Regular Load, Overload or Praise Load · Print or Excel</p>
            </div>
          </div>

          <div className="w-full lg:w-[440px] flex-shrink-0">
            <FacultyPicker faculty={faculty} value={facultyId} onChange={setFacultyId} />
            <div className="mt-3 min-h-[36px] flex flex-wrap items-center justify-between gap-3">
              {picked && termReady ? (
                <>
                  <span className="flex items-center gap-2 min-w-0 text-sm">
                    <span className="font-semibold text-[#0B2A5B] truncate">{picked.name}</span>
                    <EmploymentBadge status={picked.employment_status} />
                  </span>
                  <span className="flex items-center gap-2">
                    <WorkloadPrintMenu key={`excel-${picked.id}`} mode="excel" facultyId={picked.id} semester={semester} academicYear={schoolYear} />
                    <WorkloadPrintMenu key={`print-${picked.id}`} facultyId={picked.id} semester={semester} academicYear={schoolYear} />
                  </span>
                </>
              ) : (
                <span className="text-sm text-[#64748B]">
                  {termReady ? 'Choose a faculty member to print or download.' : 'Set the active school year and semester in Settings first.'}
                </span>
              )}
            </div>
          </div>
        </div>
      </motion.section>

      {/* Class Program · Curriculum · Room QR Codes — print or export right here */}
      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <motion.div {...rise(1)}><ClassProgramReport programs={programs} semester={semester} schoolYear={schoolYear} /></motion.div>
        <motion.div {...rise(2)}><CurriculumReport programs={programs} /></motion.div>
        <motion.div {...rise(3)}><RoomQrReport rooms={rooms} /></motion.div>
      </div>
      </PageLoadTransition>
    </div>
  );
}

/** Reports page skeleton — term chip, the Workload Form card, three report cards. */
function ReportsSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading reports">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-64 rounded-xl" />
        <Skeleton className="h-4 w-56 rounded" />
      </div>
      <div className={`${CARD} p-5 sm:p-6`}>
        <div className="flex flex-col lg:flex-row lg:items-center gap-5 lg:gap-8">
          <div className="flex items-start gap-3.5 lg:flex-1">
            <Skeleton className="w-12 h-12 rounded-2xl flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-48 rounded" />
              <Skeleton className="h-3.5 w-64 max-w-full rounded" />
            </div>
          </div>
          <div className="w-full lg:w-[440px] flex-shrink-0 space-y-3">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-4 w-60 rounded" />
          </div>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={`${CARD} p-5 flex flex-col`}>
            <div className="flex items-start gap-3">
              <Skeleton className="w-12 h-12 rounded-2xl flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32 rounded" />
                <Skeleton className="h-3.5 w-44 max-w-full rounded" />
              </div>
            </div>
            <div className="mt-5 space-y-3">
              {Array.from({ length: 2 }, (_, f) => (
                <div key={f} className="space-y-1.5">
                  <Skeleton className="h-3 w-20 rounded" />
                  <Skeleton className="h-11 w-full rounded-xl" />
                </div>
              ))}
            </div>
            <Skeleton className="mt-4 h-[46px] w-full rounded-xl" />
            <div className="mt-3 flex gap-2">
              <Skeleton className="h-11 flex-1 rounded-xl" />
              <Skeleton className="h-11 flex-1 rounded-xl" />
            </div>
            <div className="mt-3 pt-3 border-t border-[#F1F5F9] flex justify-between">
              <Skeleton className="h-3 w-28 rounded" />
              <Skeleton className="h-3.5 w-20 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
