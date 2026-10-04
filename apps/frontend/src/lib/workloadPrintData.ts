/**
 * One faculty member's workload as the official forms read it, and which subjects
 * go on which form. Shared by the per-faculty Print menu and the Summary of
 * Faculty Workload, so both always count the same subjects.
 */

import type {
  PrintDeduction, PrintFaculty, PrintPraise, PrintWorkloadLoad,
} from '@/lib/instructorWorkloadPrintDocument';
import type { WorkloadDocumentKind } from '@/lib/workloadPrintStorage';

/** One faculty member's workload — what every official form is built from. */
export interface WorkloadPrintData {
  faculty: PrintFaculty;
  loads: (PrintWorkloadLoad & { semester?: string; academic_year?: string })[];
  praise: PrintPraise[];
  deductions: PrintDeduction[];
}

export async function fetchWorkloadPrintData(facultyId: number, semester: string, academicYear: string): Promise<WorkloadPrintData> {
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
export function printLoadSets(data: WorkloadPrintData | null, semester: string, academicYear: string) {
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
    } satisfies Record<WorkloadDocumentKind, number>,
    loadsFor: (kind: WorkloadDocumentKind) =>
      kind === 'overload' ? [...overloadLoads, ...splitLoads]
        : kind === 'praise' ? praiseLoads
        : termLoads, // Regular (the form keeps only Regular subjects) and Actual Load (every subject)
  };
}

/** Input for one official form — Actual Load is every schedule of the faculty on one form. */
export function printDocInput(kind: WorkloadDocumentKind, data: WorkloadPrintData, semester: string, academicYear: string) {
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
