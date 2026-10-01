'use client';

/**
 * Reports — one place under System to print or export QRganize's official
 * documents. Every report reuses the code of its own page, so the output is
 * identical wherever it is produced:
 *   • Faculty Workload Form — same menu as Faculty Schedules.
 *   • Class Program — runs the Class Program page itself in a hidden frame
 *     (its printed form and saved signatories live there).
 *   • Curriculum — same print / Excel helpers as Curriculum Setup.
 *   • Room QR Codes — same print cards as QR Generator, plus Excel.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight, BookOpen, CalendarDays, CalendarRange, Check, ChevronDown, FileSpreadsheet, FileText,
  Loader2, Printer, QrCode, Search,
} from 'lucide-react';
import BackButton from '@/components/ui/BackButton';
import WatermarkTitle from '@/components/ui/WatermarkTitle';
import AnchoredPopover from '@/components/ui/AnchoredPopover';
import { FilterSelect } from '@/components/ui/SearchFilter';
import { EmploymentBadge } from '@/components/ui/EmploymentBadge';
import { Skeleton } from '@/components/ui/skeletons';
import { PageLoadTransition } from '@/components/ui/PageLoadTransition';
import { LOADING_DELAY, useMinLoading } from '@/hooks/useMinLoading';
import { useSchoolYear } from '@/context/SchoolYearContext';
import { useToast } from '@/context/ToastContext';
import { useRealtime } from '@/context/RealtimeContext';
import { CURRICULUM_VERSIONS, DEFAULT_CURRICULUM_VERSION, curriculumVersionLabel, type CurriculumVersion } from '@shared/curriculumVersion';
import { WorkloadPrintMenu } from '../faculty-schedules/FacultySchedulesClient';
import { downloadCurriculumExcel, groupCurriculums, printCurriculum, type CurriculumRowLike } from '../program/curriculum/curriculumReport';
import { downloadQrExcel, printRooms, type RoomQR } from '../qr-generator/qrReport';
import { downloadClassProgramExcel, fetchClassProgram, loadClassProgramDocSettings } from '../program/class-program/classProgramReport';
import { fetchDayCombinations } from '@/lib/dayCombinations';

interface FacultyOption { id: number; name: string; employment_status: string; position: string }
interface ProgramOption { id: number; code: string; name: string }
interface BlockOption { id: number; block_name: string; curriculum_version?: string; subject_count?: number }
type Busy = 'excel' | 'print' | null;

const YEAR_LEVELS = ['1st Year', '2nd Year', '3rd Year', '4th Year'];

/** Searchable faculty picker — grouped Permanent / Contractual, A–Z within each */
function FacultyPicker({ faculty, value, onChange }: {
  faculty: FacultyOption[]; value: number | null; onChange: (id: number) => void;
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
    onChange(id);
    setOpen(false);
    setQ('');
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={e => { setPanelWidth(e.currentTarget.offsetWidth); setOpen(o => !o); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`w-full h-12 px-4 rounded-xl border bg-white flex items-center gap-2 text-left transition-colors ${
          open ? 'border-[#1D5BD6] ring-2 ring-[#1D5BD6]/15' : 'border-[#D6E0EF] hover:border-[#9DB8E8]'
        }`}
      >
        <span className={`flex-1 truncate text-[15px] ${selected ? 'font-semibold text-[#0B2A5B]' : 'text-[#64748B]'}`}>
          {selected ? selected.name : 'Select faculty…'}
        </span>
        <ChevronDown className={`w-4 h-4 text-[#64748B] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

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
const LABEL = 'block text-xs font-semibold text-[#64748B] mb-1.5';
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
  const base = 'flex-1 inline-flex items-center justify-center gap-1.5 h-10 px-3 rounded-lg border text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
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
        className={`${base} bg-[#E9F5EE] border-[#B7DFC6] text-[#107C41] hover:enabled:bg-[#D5EDDF] hover:enabled:border-[#107C41]`}>
        {icon('excel', FileSpreadsheet)} {done === 'excel' ? 'Done' : 'Excel'}
      </motion.button>
      <motion.button type="button" onClick={onPrint} disabled={disabled || busy !== null} {...(disabled ? {} : press)}
        className={`${base} bg-[#EFF6FF] border-[#BFDBFE] text-[#1D5BD6] hover:enabled:bg-[#DBEAFE] hover:enabled:border-[#1D5BD6]`}>
        {icon('print', Printer)} {done === 'print' ? 'Done' : 'Print'}
      </motion.button>
    </div>
  );
}

/** One report card: icon, title, its selections, then Excel / Print.
 *  `summary` (the finished selection) highlights the card as ready. */
function ReportCard({ icon: Icon, title, text, href, children, actions, note, summary }: {
  icon: typeof Printer; title: string; text: string; href: string;
  children?: ReactNode; actions: ReactNode; note?: string; summary?: string | null;
}) {
  const reduceMotion = useReducedMotion();
  const ready = !!summary;
  return (
    <motion.section
      whileHover={reduceMotion ? undefined : { y: -3 }}
      transition={{ duration: 0.25, ease: EASE }}
      className={`${CARD} p-5 h-full flex flex-col transition-[border-color,box-shadow] duration-300 ${
        ready ? '!border-[#9DB8E8] shadow-[0_12px_28px_-20px_rgba(29,91,214,0.6)]' : 'hover:border-[#C7D5EC] hover:shadow-[0_10px_24px_-20px_rgba(11,42,91,0.45)]'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors duration-300"
          style={ready ? { backgroundColor: '#1D5BD6', color: '#FFFFFF' } : { backgroundColor: '#EFF6FF', color: '#1D5BD6' }}>
          <Icon className="w-5 h-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold text-[#0B2A5B]">{title}</h3>
          <p className="text-sm text-[#64748B] mt-0.5">{text}</p>
        </div>
      </div>
      <div className="mt-4 space-y-3 flex-1">{children}</div>
      <AnimatePresence initial={false}>
        {summary && (
          <motion.p
            key="summary"
            initial={reduceMotion ? false : { opacity: 0, height: 0, marginTop: 0 }}
            animate={{ opacity: 1, height: 'auto', marginTop: 16 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, marginTop: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="overflow-hidden"
          >
            <span className="flex items-center gap-2 rounded-lg bg-[#F4F7FC] border border-[#E3E9F3] px-3 py-2 text-sm font-semibold text-[#0B2A5B]">
              <Check className="w-4 h-4 text-[#1D5BD6] flex-shrink-0" />
              <span className="truncate">{summary}</span>
            </span>
          </motion.p>
        )}
      </AnimatePresence>
      <div className="mt-4">{actions}</div>
      <div className="mt-3 pt-3 border-t border-[#F1F5F9] flex items-center justify-between gap-2">
        <span className="text-xs text-[#94A3B8] truncate">{note}</span>
        <Link href={href} className="group inline-flex items-center gap-1 text-sm font-semibold text-[#1D5BD6] flex-shrink-0">
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
 * Excel: built right here with the Class Program page's own builder, data and
 * saved signatories (classProgramReport). Print: the printed form is the Class
 * Program page itself, so it opens in a new tab and prints automatically.
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

  useEffect(() => {
    if (!program || !year || !semester || !schoolYear) return;
    const ctrl = new AbortController();
    const params = new URLSearchParams({ program_id: program, year_level: year, semester, academic_year: schoolYear });
    fetch(`/api/blocks?${params}`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : { blocks: [] }))
      .then(d => setBlocks((d.blocks ?? []) as BlockOption[]))
      .catch(() => {})
      .finally(() => { if (!ctrl.signal.aborted) setBlocksLoading(false); });
    return () => ctrl.abort();
  }, [program, year, semester, schoolYear]);

  // Live updates: blocks added or removed elsewhere (the picked block stays picked)
  const blocksQuery = program && year && semester && schoolYear
    ? new URLSearchParams({ program_id: program, year_level: year, semester, academic_year: schoolYear }).toString()
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

  async function onExcel() {
    if (!program || !year || !block || !semester) return;
    setBusy('excel');
    try {
      const [{ block: detail, schedules }, { combinations }] = await Promise.all([
        fetchClassProgram({ blockId: block, programId: program, yearLevel: year, semester }),
        fetchDayCombinations(semester, schoolYear),
      ]);
      await downloadClassProgramExcel({
        block: detail,
        schedules,
        combos: combinations.filter(c => c.is_active),
        settings: loadClassProgramDocSettings(detail.program_code),
      });
      flashDone('excel');
      toast.success('Class Program downloaded as Excel.');
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not create the Excel file.');
    } finally {
      setBusy(null);
    }
  }

  function onPrint() {
    if (!program || !year || !block) return;
    // The Class Program page opens with this block and prints automatically
    const win = window.open(`/program/class-program?${new URLSearchParams({ program, year, block, action: 'print' })}`, '_blank');
    if (win) flashDone('print');
    else toast.error(POPUP_BLOCKED);
  }

  return (
    <ReportCard
      icon={CalendarRange}
      title="Class Program"
      text="Official class schedule per block."
      href="/program/class-program"
      note="Signatories are set on the Class Program page."
      summary={summary}
      actions={<ExportButtons busy={busy} done={done} disabled={!block} onExcel={onExcel} onPrint={onPrint} />}
    >
      <div>
        <label className={LABEL}>Program</label>
        <FilterSelect value={program} onChange={v => { setProgram(v); setYear(''); setBlock(''); setBlocks([]); }} label="Program">
          <option value="">Select program…</option>
          {programs.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
        </FilterSelect>
      </div>
      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <label className={LABEL}>Year Level</label>
          <FilterSelect value={year} onChange={v => { setYear(v); setBlock(''); setBlocks([]); setBlocksLoading(!!v); }} label="Year Level" disabled={!program}>
            <option value="">Select…</option>
            {YEAR_LEVELS.map(y => <option key={y} value={y}>{y}</option>)}
          </FilterSelect>
        </div>
        <div>
          <label className={LABEL}>Block</label>
          <FilterSelect value={block} onChange={setBlock} label="Block" disabled={!year || blocksLoading}>
            <option value="">{blocksLoading ? 'Loading…' : year && blocks.length === 0 ? 'No blocks' : 'Select…'}</option>
            {blocks.map(b => <option key={b.id} value={b.id}>Block {b.block_name}</option>)}
          </FilterSelect>
        </div>
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

  const prog = programs.find(p => String(p.id) === program);
  const groups = useMemo(() => groupCurriculums(rows ?? []), [rows]);
  const count = rows?.length ?? 0;

  async function onExcel() {
    if (!prog || count === 0) return;
    setBusy('excel');
    try {
      await downloadCurriculumExcel({ programName: prog.name, programCode: prog.code, version, groups });
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
      title="Curriculum"
      text="A program’s curriculum by version."
      href="/program/curriculum"
      note={program && rows && count === 0 ? 'No subjects in this curriculum' : undefined}
      summary={prog && count > 0 ? `${prog.code} · ${curriculumVersionLabel(version)} · ${count} subject${count !== 1 ? 's' : ''}` : null}
      actions={<ExportButtons busy={busy} done={done} disabled={!program || count === 0} onExcel={onExcel} onPrint={onPrint} />}
    >
      <div>
        <label className={LABEL}>Program</label>
        <FilterSelect value={program} onChange={v => { setProgram(v); setRows(null); }} label="Program">
          <option value="">Select program…</option>
          {programs.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
        </FilterSelect>
      </div>
      <div>
        <label className={LABEL}>Curriculum</label>
        <FilterSelect value={version} onChange={v => { setVersion(v as CurriculumVersion); setRows(null); }} label="Curriculum" disabled={!program}>
          {CURRICULUM_VERSIONS.map(v => <option key={v} value={v}>{curriculumVersionLabel(v)}</option>)}
        </FilterSelect>
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
      if (await downloadQrExcel(ready, title)) {
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
      title="Room QR Codes"
      text="QR codes to post at each room."
      href="/qr-generator"
      note={rooms.length ? `${ready.length} of ${list.length} rooms have a QR code` : undefined}
      summary={ready.length ? `${ready.length} QR code${ready.length !== 1 ? 's' : ''} · ${type === 'All' ? 'All rooms' : `${type} rooms`}` : null}
      actions={<ExportButtons busy={busy} done={done} disabled={ready.length === 0} onExcel={onExcel} onPrint={onPrint} />}
    >
      <div>
        <label className={LABEL}>Rooms</label>
        <FilterSelect value={type} onChange={v => setType(v as typeof type)} label="Rooms">
          <option value="All">All rooms</option>
          <option value="Lecture">Lecture rooms</option>
          <option value="Laboratory">Laboratory rooms</option>
        </FilterSelect>
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
      <motion.section {...rise(0)} className={`${CARD} p-5 sm:p-6 transition-[border-color,box-shadow] duration-300 ${
        picked ? '!border-[#9DB8E8] shadow-[0_12px_28px_-20px_rgba(29,91,214,0.6)]' : ''
      }`}>
        <div className="flex flex-col lg:flex-row lg:items-center gap-5 lg:gap-8">
          <div className="flex items-start gap-3.5 min-w-0 lg:flex-1">
            <span className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors duration-300"
              style={picked ? { backgroundColor: '#1D5BD6', color: '#FFFFFF' } : { backgroundColor: '#EFF6FF', color: '#1D5BD6' }}>
              <FileText className="w-5 h-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-[#0B2A5B]">Faculty Workload Form</h2>
              <p className="text-sm text-[#64748B] mt-0.5">Regular Load, Overload or Praise Load · Print or Excel</p>
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
                <span className="text-sm text-[#94A3B8]">
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
            <Skeleton className="w-11 h-11 rounded-xl flex-shrink-0" />
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
              <Skeleton className="w-11 h-11 rounded-xl flex-shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32 rounded" />
                <Skeleton className="h-3.5 w-44 max-w-full rounded" />
              </div>
            </div>
            <div className="mt-4 space-y-3">
              {Array.from({ length: 2 }, (_, f) => (
                <div key={f} className="space-y-1.5">
                  <Skeleton className="h-3 w-20 rounded" />
                  <Skeleton className="h-11 w-full rounded-xl" />
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
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
