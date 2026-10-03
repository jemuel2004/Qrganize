'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, Download, FileSpreadsheet, Loader2, Printer } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { useRealtime } from '@/context/RealtimeContext';
import {
  buildWorkloadFormModel,
  printRegularLoadDocument,
  type PrintDeduction, type PrintDocumentResult, type PrintFaculty, type PrintPraise, type PrintWorkloadLoad,
} from '@/lib/instructorWorkloadPrintDocument';
import type { WorkloadDocumentKind } from '@/lib/workloadPrintStorage';
import { fetchDayCombinations } from '@/lib/dayCombinations';

type PrintKind = WorkloadDocumentKind;

/** One faculty member's workload — what every official form is built from. */
export interface WorkloadPrintData {
  faculty: PrintFaculty;
  loads: (PrintWorkloadLoad & { semester?: string; academic_year?: string })[];
  praise: PrintPraise[];
  deductions: PrintDeduction[];
}

async function fetchWorkloadPrintData(facultyId: number, semester: string, academicYear: string): Promise<WorkloadPrintData> {
  const qs = new URLSearchParams();
  if (semester) qs.set('semester', semester);
  if (academicYear) qs.set('academic_year', academicYear);
  const res = await fetch(`/api/workload/${facultyId}?${qs}`);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'Unable to load workload.');
  return { faculty: d.faculty, loads: d.loads ?? [], praise: d.praise ?? [], deductions: d.deductions ?? [] };
}

function termLoadsOf(data: WorkloadPrintData | null, semester: string, academicYear: string) {
  return (data?.loads ?? []).filter(l =>
    (!semester || !l.semester || l.semester === semester) &&
    (!academicYear || !l.academic_year || l.academic_year === academicYear));
}

/** Same load selection as the Faculty Workload page's print, per official form. */
function printLoadSets(data: WorkloadPrintData | null, semester: string, academicYear: string) {
  const isP = data?.faculty.employment_status === 'Permanent';
  const termLoads = termLoadsOf(data, semester, academicYear);
  const isSplit = (l: PrintWorkloadLoad) => l.load_category === 'Regular' && (
    isP ? (Number(l.split_overload_units) || 0) > 0.001 : (Number(l.split_overload_hours) || 0) > 0.001);
  const overloadLoads = termLoads.filter(l => l.load_category === 'Overload');
  const splitLoads    = termLoads.filter(l => isSplit(l) && !l.split_is_praise);
  // Praise: whole subjects + a lone Lec/Lab portion moved to Praise
  const praiseLoads   = termLoads.filter(l => l.load_category === 'Praise' || (isSplit(l) && l.split_is_praise));
  return {
    termLoads,
    counts: {
      regular:  termLoads.filter(l => l.load_category === 'Regular').length,
      overload: overloadLoads.length + splitLoads.length,
      praise:   praiseLoads.length + (data?.praise.length ?? 0),
      // Actual Load: every subject once — Regular, Overload and Praise
      deload:   termLoads.length,
    } satisfies Record<PrintKind, number>,
    loadsFor: (kind: PrintKind) =>
      kind === 'overload' ? [...overloadLoads, ...splitLoads]
        : kind === 'praise' ? praiseLoads
        : termLoads, // Regular (the form keeps only Regular subjects) and Actual Load (every subject)
  };
}

/** Input for one official form — Actual Load is every schedule of the faculty on one form. */
function printDocInput(kind: PrintKind, data: WorkloadPrintData, semester: string, academicYear: string) {
  return {
    faculty: data.faculty,
    loads: printLoadSets(data, semester, academicYear).loadsFor(kind),
    praise: kind === 'praise' ? data.praise : [],
    deductions: kind === 'regular' || kind === 'deload' ? data.deductions : [],
    semester,
    academicYear,
    documentKind: kind,
  };
}

/** Trigger styles: 'soft' (Faculty Schedules, Reports), 'primary' (My Workload), 'modal' (Faculty Workload form). */
type Look = 'soft' | 'primary' | 'modal';

/**
 * "Print" (or "Excel") button that first asks which official form to make —
 * Actual Load, Regular Load, Overload or Praise Load — then prints it (or, with
 * `mode="excel"`, downloads the same form as a formatted .xlsx). Forms with no
 * subjects are shown but can't be picked.
 *
 * Give `facultyId` and the menu loads that faculty's workload when it opens; give
 * `data` when the page already has it (Faculty Workload form, My Workload).
 */
export default function WorkloadPrintMenu({
  facultyId, data, semester, academicYear, mode = 'print', phoneStretch = false, look = 'soft',
  printablePath = '/workload/print', onPrinted,
}: {
  facultyId?: number;
  data?: WorkloadPrintData | null;
  semester: string; academicYear: string;
  mode?: 'print' | 'excel';
  /** Phones: fill half the row, and open the menu toward the side that has room */
  phoneStretch?: boolean;
  look?: Look;
  /** Signed-in page that prints the stashed form when the popup is blocked */
  printablePath?: string;
  /** The page shows its own print message ("Open Printable Version"); without it the menu shows one */
  onPrinted?: (result: PrintDocumentResult) => void;
}) {
  const isExcel = mode === 'excel';
  const ready = data !== undefined;
  const toast = useToast();
  const reduceMotion = useReducedMotion();
  const ease = [0.4, 0, 0.2, 1] as const;
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<WorkloadPrintData | null>(null);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState('');
  const [printing, setPrinting] = useState<PrintKind | null>(null);
  const workload = ready ? data ?? null : fetched;

  // Close on outside click, or on Escape wherever focus is — caught before a
  // surrounding pop-up (the Faculty Workload form) sees it, so only the menu closes
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  async function fetchWorkload() {
    if (facultyId == null) return;
    setLoadingData(true);
    setError('');
    try {
      setFetched(await fetchWorkloadPrintData(facultyId, semester, academicYear));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load workload.');
    } finally {
      setLoadingData(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    setError('');
    if (next && !ready && !fetched && !loadingData) fetchWorkload();
  }

  // Live updates (fetch mode): this faculty's loads may have changed — a closed
  // menu reads them again on the next open, an open one refreshes its counts now.
  useRealtime(['workload', 'schedule'], () => {
    if (ready || facultyId == null) return;
    if (!open) { setFetched(null); return; }
    if (loadingData) return;
    return fetchWorkloadPrintData(facultyId, semester, academicYear).then(setFetched).catch(() => {});
  });

  const { counts } = printLoadSets(workload, semester, academicYear);
  const options: { kind: PrintKind; label: string; count: number; dot: string }[] = [
    { kind: 'deload',   label: 'Actual Load',  count: counts.deload,   dot: 'var(--load-actual)' },
    { kind: 'regular',  label: 'Regular Load', count: counts.regular,  dot: 'var(--load-regular)' },
    { kind: 'overload', label: 'Overload',     count: counts.overload, dot: 'var(--load-overload)' },
    { kind: 'praise',   label: 'Praise Load',  count: counts.praise,   dot: 'var(--load-praise)' },
  ];

  async function handlePrint(kind: PrintKind) {
    if (!workload) return;
    setPrinting(kind);
    setError('');
    const docInput = printDocInput(kind, workload, semester, academicYear);
    if (isExcel) {
      // Same official form as Print, as a spreadsheet
      try {
        const { buildWorkloadFormWorkbook } = await import('@shared/workloadFormExport');
        const png = (path: string) => fetch(path).then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
        const [logo, iso, bagong] = await Promise.all([
          png('/nemlogo/NEMSU-logo.png'),
          png('/nemlogo/ISO-UKAS.png'),
          png('/nemlogo/BAGONG-PILIPINAS-LOGO.png'),
        ]);
        const { combinations: dayCombinations } = await fetchDayCombinations(semester, academicYear);
        const buffer = await buildWorkloadFormWorkbook(
          buildWorkloadFormModel({ ...docInput, dayCombinations }),
          logo ? { buffer: logo, extension: 'png' } : undefined,
          // visibleHeight: how much of each square PNG the mark fills, so both print at the same height
          [{ b: iso, visibleHeight: 0.57 }, { b: bagong, visibleHeight: 0.74 }]
            .filter((l): l is { b: ArrayBuffer; visibleHeight: number } => !!l.b)
            .map(l => ({ buffer: l.b, extension: 'png' as const, visibleHeight: l.visibleHeight })),
        );
        const label = options.find(o => o.kind === kind)?.label ?? 'Workload';
        const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `Faculty_Workload_${label.replace(/\s+/g, '_')}_${workload.faculty.name.replace(/[^A-Za-z0-9]+/g, '_')}_${semester.replace(/\s+/g, '_')}_${academicYear}.xlsx`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setOpen(false);
        toast.success(`${label} downloaded as Excel.`);
      } catch {
        setError('Could not create the Excel file. Please try again.');
      } finally {
        setPrinting(null);
      }
      return;
    }
    try {
      const result = await printRegularLoadDocument({ ...docInput, printablePath });
      if (onPrinted) {
        setOpen(false);
        onPrinted(result);
      } else if (!result.ok) {
        setError('Printing is not supported directly in this browser. Try Chrome or Safari.');
      } else {
        setOpen(false);
      }
    } finally {
      setPrinting(null);
    }
  }

  const triggerLook = look === 'primary'
    ? `h-11 px-4 gap-2 rounded-xl text-[15px] font-semibold shadow-lg shadow-[#1D5BD6]/20 ${open ? 'bg-[#164BB5]' : 'bg-[#1D5BD6] hover:bg-[#164BB5]'}`
    : look === 'modal'
      ? `w-full sm:w-auto min-h-11 px-4 gap-2 rounded-xl text-sm font-medium text-white ${open ? 'bg-white/20' : 'bg-white/10 hover:bg-white/20'}`
      : `gap-1.5 ${phoneStretch ? 'w-full sm:w-auto h-11 sm:h-9 text-[15px] sm:text-[13px]' : 'h-9 text-[13px]'} px-3 rounded-lg border font-semibold ${
        isExcel
          // Excel's own green
          ? open ? 'bg-[#107C41] border-[#107C41] text-white' : 'bg-[#E9F5EE] border-[#B7DFC6] text-[#107C41] hover:bg-[#D5EDDF] hover:border-[#107C41]'
          // Print in the system's royal blue
          : open ? 'bg-[#1D5BD6] border-[#1D5BD6] text-white' : 'bg-[#EFF6FF] border-[#BFDBFE] text-[#1D5BD6] hover:bg-[#DBEAFE] hover:border-[#1D5BD6]'
      }`;
  // Menu opens toward the side that has room (Excel sits on the left on phones)
  const alignLeft = phoneStretch && isExcel;

  return (
    <div
      ref={wrapRef}
      className={`relative ${phoneStretch ? 'flex-1 sm:flex-none' : look === 'modal' ? 'w-full sm:w-auto' : ''}`}
    >
      <motion.button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        whileTap={reduceMotion ? undefined : { scale: 0.95 }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={isExcel ? 'Download workload as Excel' : 'Print workload'}
        className={`group inline-flex items-center justify-center transition-colors ${triggerLook}`}
        // White set inline — the light-mode rule repaints `text-white` as dark ink
        style={look === 'primary' ? { color: '#FFFFFF' } : undefined}
      >
        {isExcel
          ? <FileSpreadsheet className="w-4 h-4 transition-transform duration-200 group-hover:translate-y-px" />
          : <Printer className="w-4 h-4 transition-transform duration-200 group-hover:-translate-y-px" />}
        {isExcel ? 'Excel' : 'Print'}
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: reduceMotion ? 0 : 0.2, ease }} className="inline-flex">
          <ChevronDown className="w-3.5 h-3.5" />
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={reduceMotion ? false : { opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: reduceMotion ? 0 : 0.2, ease } }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97, transition: { duration: 0.15, ease } }}
            style={{ transformOrigin: alignLeft ? 'top left' : 'top right' }}
            className={`absolute ${alignLeft ? 'left-0 sm:left-auto sm:right-0' : 'right-0'} top-full mt-2 z-20 w-64 max-w-[calc(100vw-2rem)] bg-white border border-[#E2E8F0] rounded-xl shadow-[0_16px_40px_-12px_rgba(11,42,91,0.35)] p-1.5 text-left`}
          >
            <p className="px-2.5 pt-1.5 pb-2 text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">
              {isExcel ? 'Download official form (Excel)' : 'Print official form'}
            </p>
            {loadingData || (ready && !workload) ? (
              <div className="flex items-center gap-2 px-2.5 py-3 text-[13px] text-[#64748B]">
                <Loader2 className="w-4 h-4 animate-spin text-[#1D5BD6]" /> Loading workload…
              </div>
            ) : !workload ? (
              <div className="px-2.5 py-2 space-y-2">
                <p className="text-[12px] text-red-700">{error || 'Unable to load workload.'}</p>
                <button type="button" onClick={fetchWorkload} className="text-[12px] font-semibold text-[#1D5BD6] hover:underline">
                  Try again
                </button>
              </div>
            ) : (
              <>
                {options.map((o, i) => {
                  const empty = o.count === 0;
                  return (
                    <motion.button
                      key={o.kind}
                      type="button"
                      role="menuitem"
                      disabled={empty || printing !== null}
                      onClick={() => handlePrint(o.kind)}
                      initial={reduceMotion ? false : { opacity: 0, x: 6 }}
                      animate={{ opacity: 1, x: 0, transition: { duration: reduceMotion ? 0 : 0.2, ease, delay: reduceMotion ? 0 : 0.04 * i } }}
                      className="group w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[13px] transition-colors enabled:hover:bg-[#F4F7FC] disabled:cursor-not-allowed"
                    >
                      <span className="w-2.5 h-2.5 rounded-[3px] flex-shrink-0" style={{ backgroundColor: o.dot, opacity: empty ? 0.35 : 1 }} aria-hidden="true" />
                      <span className={`font-semibold ${empty ? 'text-[#94A3B8]' : 'text-[#0B2A5B]'}`}>{o.label}</span>
                      <span className="ml-auto text-[11px] tabular-nums text-[#94A3B8]">
                        {empty ? 'None' : `${o.count} item${o.count === 1 ? '' : 's'}`}
                      </span>
                      {printing === o.kind
                        ? <Loader2 className={`w-3.5 h-3.5 animate-spin ${isExcel ? 'text-[#107C41]' : 'text-[#1D5BD6]'}`} />
                        : isExcel
                          ? <Download className={`w-3.5 h-3.5 transition-colors ${empty ? 'text-[#CBD5E1]' : 'text-[#94A3B8] group-hover:text-[#107C41]'}`} />
                          : <Printer className={`w-3.5 h-3.5 transition-colors ${empty ? 'text-[#CBD5E1]' : 'text-[#94A3B8] group-hover:text-[#1D5BD6]'}`} />}
                    </motion.button>
                  );
                })}
                {error && <p className="px-2.5 pt-1.5 pb-1 text-[12px] text-red-700">{error}</p>}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
