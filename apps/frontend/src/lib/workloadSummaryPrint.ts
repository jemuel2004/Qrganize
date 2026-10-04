/**
 * SUMMARY OF FACULTY WORKLOAD — one official sheet for the whole department
 * (Faculty Schedules → Print Summary). Every number comes from the same form
 * builder as each faculty's own Actual / Regular / Overload / Praise forms, so
 * the summary always agrees with the forms it summarises.
 *
 * Permanent faculty are counted in units; Contractual faculty in hours, as on
 * the Faculty Workload page.
 */

import { buildWorkloadFormModel, type BuildRegularLoadPrintInput } from '@/lib/instructorWorkloadPrintDocument';
import { fetchWorkloadPrintData, printDocInput, type WorkloadPrintData } from '@/lib/workloadPrintData';
import { fetchDayCombinations } from '@/lib/dayCombinations';
import { escapePrintHtml as esc, formatAy, semesterHeading, DEFAULT_FOOTER_CONFIG } from '@/lib/nemsuOfficialPrintChrome';
import { openBlankPrintWindow, openPrintHtmlDocument, type OpenPrintHtmlResult } from '@/lib/openPrintHtmlDocument';
import { positionRank } from '@/lib/positionRank';
import type { WorkloadDocumentKind } from '@/lib/workloadPrintStorage';

/** Signatories of the summary, as on the paper form */
const SIGNATORIES = {
  preparedBy: { name: 'NELYNE LOURDES Y. PLAZA, Ph.D.', title: 'Department Chair, DCS' },
  recommending: { name: 'ROZETTE E. MERCADO, Ph.D.', title: 'Assistant Campus Director' },
  approved: { name: 'JUANCHO A. INTANO, Ph.D.', title: 'Campus Director' },
};

const WINDOW_FEATURES = 'width=900,height=1150';
/** Faculty workloads read at the same time */
const PARALLEL = 6;

export interface WorkloadSummaryRow {
  name: string;
  education: string;
  position: string;
  permanent: boolean;
  /** Teaching: units (Permanent) or hours (Contractual) */
  teaching: number;
  research: number;
  extension: number;
  funded: number;
  /** Designation and Special Assignment deloading */
  designation: number;
  actual: number;
  regular: number;
  praise: number;
  overload: number;
}

/** One faculty member's line — the totals of their own official forms. */
export function workloadSummaryRow(
  data: WorkloadPrintData, semester: string, academicYear: string,
  dayCombinations: BuildRegularLoadPrintInput['dayCombinations'],
): WorkloadSummaryRow {
  const permanent = data.faculty.employment_status === 'Permanent';
  const totals = (kind: WorkloadDocumentKind) =>
    buildWorkloadFormModel({ ...printDocInput(kind, data, semester, academicYear), dayCombinations }).totals
      ?? { teachingUnits: 0, units: 0, hours: 0 };
  const actual = totals('deload');
  const regular = totals('regular');
  const overload = totals('overload');
  const praise = totals('praise');

  // Deloading by kind (Permanent only — the forms count none for Contractual)
  const ded = { research: 0, extension: 0, funded: 0, designation: 0 };
  if (permanent) {
    for (const d of data.deductions) {
      const units = Number(d.deducted_units) || 0;
      const type = String(d.deduction_type ?? '');
      if (/funded/i.test(type)) ded.funded += units;
      else if (/^research/i.test(type)) ded.research += units; // Research, Research/Extension
      else if (/^extension/i.test(type)) ded.extension += units;
      else ded.designation += units; // Designation, Special Assignment, anything else
    }
  }

  return {
    name: data.faculty.name,
    education: data.faculty.educational_qualification ?? '',
    position: data.faculty.position || data.faculty.employment_status,
    permanent,
    teaching: permanent ? actual.teachingUnits : actual.hours,
    ...ded,
    actual: permanent ? actual.units : actual.hours,
    regular: permanent ? regular.units : regular.hours,
    praise: permanent ? praise.units : praise.hours,
    overload: permanent ? overload.units : overload.hours,
  };
}

/** Whole numbers only, as on the paper form (25.5 → "26"); blank for nothing unless `keepZero` */
function num(n: number, keepZero = false): string {
  const whole = Math.round(n);
  if (whole === 0) return keepZero ? '0' : '';
  return String(whole);
}

function rowCells(r: WorkloadSummaryRow): string {
  const c = (n: number, keepZero = false) => `<td class="n">${num(n, keepZero)}</td>`;
  return [
    c(r.teaching, true), c(r.research), c(r.extension), c(r.funded), c(r.designation),
    c(r.actual, true), c(r.regular, true),
    '<td class="n"></td>', // Emergency Load — not kept in QRganize
    c(r.praise), c(r.overload),
  ].join('');
}

function sectionHtml(label: string, rows: WorkloadSummaryRow[]): string {
  if (rows.length === 0) return '';
  return `
<tr class="sec"><td colspan="13">${esc(label)}</td></tr>
${rows.map(r => `<tr>
  <td class="nm">${esc(r.name.toUpperCase())}</td>
  <td class="ed">${esc(r.education)}</td>
  <td class="ps">${esc(r.position)}</td>
  ${rowCells(r)}
</tr>`).join('\n')}`;
}

export function buildWorkloadSummaryHtml(input: {
  rows: WorkloadSummaryRow[]; semester: string; academicYear: string; origin: string;
}): string {
  const permanent = input.rows.filter(r => r.permanent)
    .sort((a, b) => positionRank(a.position) - positionRank(b.position) || a.name.localeCompare(b.name));
  const contractual = input.rows.filter(r => !r.permanent).sort((a, b) => a.name.localeCompare(b.name));
  const title = `Summary of Faculty Workload — ${input.semester} ${input.academicYear}`;
  const sig = (label: string, s: { name: string; title: string }) => `
    <div class="sig-blk">
      <div class="sig-lbl">${esc(label)}</div>
      <div class="sig-nm">${esc(s.name)}</div>
      <div class="sig-tt">${esc(s.title)}</div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
/* Zero page margins: the browser then has no room to print its date / title /
   about:blank lines. The frame's spacer rows give every page its margins. */
@page { size: 8.5in 13in portrait; margin: 0; }
body { font-family: Arial, sans-serif; font-size: 8pt; color: #000; background: #fff; }
.frame { width: 100%; border-collapse: collapse; }
.frame > thead { display: table-header-group; }
.frame > tfoot { display: table-footer-group; }
.frame > * > tr > td { padding: 0 0.4in; border: none; }
.frame-top { height: 0.45in; }
.frame-bottom { height: 0.5in; }
.sheet { max-width: 7.7in; margin: 0 auto; }

/* Logos close beside the text, the whole group centred — as on the reference */
.lh { display: flex; align-items: center; justify-content: center; gap: 14px; }
.lh .logo { width: 74px; height: 74px; object-fit: contain; flex-shrink: 0; }
.lh .iso { height: 60px; width: auto; object-fit: contain; flex-shrink: 0; }
.lh-text { text-align: center; line-height: 1.3; }
.lh-rep { font-size: 8pt; }
.lh-univ { font-size: 11.5pt; font-weight: bold; }
.lh-sub { font-size: 8pt; }

.ttl { text-align: center; margin: 14px 0 10px; line-height: 1.35; }
.ttl-1 { font-size: 10.5pt; font-weight: bold; letter-spacing: .05em; }
.ttl-2 { font-size: 9.5pt; font-weight: bold; }
.ttl-3 { font-size: 8.5pt; }

table.sum { width: 100%; border-collapse: collapse; font-size: 7.5pt; table-layout: fixed; }
.sum th, .sum td { border: 1px solid #222; padding: 3px 3px; vertical-align: middle; }
.sum thead { display: table-header-group; }
.sum thead th { font-size: 6.2pt; font-weight: bold; text-align: center; line-height: 1.2; hyphens: manual; padding: 3px 2px; }
.sum tr { page-break-inside: avoid; }
.sum .sec td { font-weight: bold; font-size: 8pt; letter-spacing: .04em; padding: 3px 5px; }
.sum .nm { font-weight: bold; font-size: 7.3pt; }
.sum .ed { font-size: 6.8pt; text-align: center; }
.sum .ps { font-size: 6.8pt; text-align: center; }
.sum .n { text-align: center; }
.note { font-size: 7pt; margin-top: 4px; }

.sigs { margin-top: 26px; page-break-inside: avoid; }
.sig-row { display: flex; justify-content: space-between; gap: 40px; }
.sig-row.center { justify-content: center; margin-top: 22px; }
.sig-blk { width: 45%; }
.sig-row.center .sig-blk { width: auto; text-align: center; }
.sig-lbl { font-size: 8.5pt; margin-bottom: 26px; }
.sig-nm { font-weight: bold; font-size: 9pt; }
.sig-tt { font-size: 8pt; font-style: italic; }

@media print { * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
<table class="frame">
<thead><tr><td><div class="frame-top"></div></td></tr></thead>
<tfoot><tr><td><div class="frame-bottom"></div></td></tr></tfoot>
<tbody><tr><td>
<div class="sheet">
  <div class="lh">
    <img class="logo" src="${input.origin}/nemlogo/NEMSU-logo.png" alt="NEMSU">
    <div class="lh-text">
      <div class="lh-rep">Republic of the Philippines</div>
      <div class="lh-univ">North Eastern Mindanao State University</div>
      <div class="lh-sub">${esc(DEFAULT_FOOTER_CONFIG.address)}</div>
      <div class="lh-sub">Tel. No. ${esc(DEFAULT_FOOTER_CONFIG.phone)}</div>
      <div class="lh-sub">${esc(DEFAULT_FOOTER_CONFIG.website)}</div>
    </div>
    <img class="iso" src="${input.origin}/nemlogo/ISO-UKAS.png" alt="ISO certified">
  </div>

  <div class="ttl">
    <div class="ttl-1">SUMMARY OF FACULTY WORKLOAD</div>
    <div class="ttl-2">${esc(semesterHeading(input.semester))}</div>
    <div class="ttl-3">A.Y. ${esc(formatAy(input.academicYear))}</div>
  </div>

  <table class="sum">
    <colgroup>
      <col style="width:16%"><col style="width:9.5%"><col style="width:9.5%">
      <col style="width:6%"><col style="width:6.5%"><col style="width:7%"><col style="width:6.5%"><col style="width:8%">
      <col style="width:6%"><col style="width:6%"><col style="width:7%"><col style="width:5.5%"><col style="width:6.5%">
    </colgroup>
    <thead>
      <tr>
        <th>Name</th><th>Highest Education Attainment</th><th>Position</th><th>No. of<br>Units</th>
        <th>Research</th><th>Extension</th><th>Funded<br>Research</th><th>Designation /<br>Special<br>Assign&shy;ments</th>
        <th>Actual<br>Load</th><th>Regular<br>Load</th><th>Emergency<br>Load</th><th>PRAISE</th><th>Overload</th>
      </tr>
    </thead>
    <tbody>
      ${sectionHtml('PERMANENT', permanent)}
      ${sectionHtml('CONTRACTUAL', contractual)}
    </tbody>
  </table>
  ${contractual.length > 0 ? '<p class="note">Permanent faculty in units; Contractual faculty in hours.</p>' : ''}

  <div class="sigs">
    <div class="sig-row">
      ${sig('Prepared by:', SIGNATORIES.preparedBy)}
      ${sig('Recommending Approval:', SIGNATORIES.recommending)}
    </div>
    <div class="sig-row center">
      ${sig('Approved:', SIGNATORIES.approved)}
    </div>
  </div>
</div>
</td></tr></tbody>
</table>
</body>
</html>`;
}

/** Run `work` over `items`, a few at a time; results keep the input order. */
async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>, onDone: () => void): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
      onDone();
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return out;
}

/**
 * Builds and prints the summary for these faculty. Call it straight from the click
 * handler: the print window opens before anything is loaded, so pop-up blockers allow it.
 */
export async function printWorkloadSummary(opts: {
  facultyIds: number[];
  semester: string;
  academicYear: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<OpenPrintHtmlResult & { faculty: number }> {
  const preOpened = openBlankPrintWindow(WINDOW_FEATURES);
  try {
    preOpened?.document.write('<p style="font-family:Arial,sans-serif;padding:24px;color:#0B2A5B">Preparing the Summary of Faculty Workload…</p>');
  } catch { /* the window may not be writable yet */ }
  try {
    const { combinations } = await fetchDayCombinations(opts.semester, opts.academicYear);
    let done = 0;
    opts.onProgress?.(0, opts.facultyIds.length);
    const data = await inBatches(
      opts.facultyIds,
      id => fetchWorkloadPrintData(id, opts.semester, opts.academicYear),
      () => opts.onProgress?.(++done, opts.facultyIds.length),
    );
    const rows = data
      .map(d => workloadSummaryRow(d, opts.semester, opts.academicYear, combinations))
      // Faculty with nothing this term stay off the summary
      .filter(r => r.teaching > 0.001 || r.actual > 0.001 || r.praise > 0.001 || r.overload > 0.001);
    const html = buildWorkloadSummaryHtml({ rows, semester: opts.semester, academicYear: opts.academicYear, origin: window.location.origin });
    const result = await openPrintHtmlDocument(html, {
      windowFeatures: WINDOW_FEATURES,
      preOpenedWindow: preOpened,
      printablePath: '/workload/print',
      downloadFilename: 'summary-of-faculty-workload.html',
    });
    return { ...result, faculty: rows.length };
  } catch (err) {
    try { preOpened?.close(); } catch { /* already closed */ }
    throw err;
  }
}
