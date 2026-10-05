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
// Types only — the Excel builder (exceljs) loads when a download is asked for
import type { WorkloadSummaryLine, WorkloadSummaryModel } from '@shared/workloadSummaryExport';

export interface SummarySignatory { name: string; title: string }
export interface SummarySignatories { preparedBy: SummarySignatory; recommending: SummarySignatory; approved: SummarySignatory }

/** Signatories of the summary, as on the paper form — the starting point until someone edits them */
export const DEFAULT_SUMMARY_SIGNATORIES: SummarySignatories = {
  preparedBy: { name: 'NELYNE LOURDES Y. PLAZA, Ph.D.', title: 'Department Chair, DCS' },
  recommending: { name: 'ROZETTE E. MERCADO, Ph.D.', title: 'Assistant Campus Director' },
  approved: { name: 'JUANCHO A. INTANO, Ph.D.', title: 'Campus Director' },
};

/* Edited signatories are kept in this browser (like the Class Program's) */
const SIGNATORIES_KEY = 'qrganize:summary-signatories:v1';
const SIGNATORY_KEYS = ['preparedBy', 'recommending', 'approved'] as const;

export function loadSummarySignatories(): SummarySignatories {
  try {
    const saved = JSON.parse(localStorage.getItem(SIGNATORIES_KEY) ?? 'null') as Partial<SummarySignatories> | null;
    if (!saved) return DEFAULT_SUMMARY_SIGNATORIES;
    const pick = (k: typeof SIGNATORY_KEYS[number]): SummarySignatory => ({
      name: typeof saved[k]?.name === 'string' ? saved[k]!.name : DEFAULT_SUMMARY_SIGNATORIES[k].name,
      title: typeof saved[k]?.title === 'string' ? saved[k]!.title : DEFAULT_SUMMARY_SIGNATORIES[k].title,
    });
    return { preparedBy: pick('preparedBy'), recommending: pick('recommending'), approved: pick('approved') };
  } catch {
    return DEFAULT_SUMMARY_SIGNATORIES;
  }
}

export function saveSummarySignatories(s: SummarySignatories) {
  try {
    const clean = Object.fromEntries(SIGNATORY_KEYS.map(k => [k, { name: s[k].name.trim(), title: s[k].title.trim() }]));
    localStorage.setItem(SIGNATORIES_KEY, JSON.stringify(clean));
  } catch { /* private mode / storage full — the names still print this time */ }
}

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

/** Whole numbers only, as on the paper form (25.5 → 26); nothing → blank unless `keepZero` */
function whole(n: number, keepZero = false): number | null {
  const w = Math.round(n);
  return w === 0 && !keepZero ? null : w;
}

/**
 * The summary as data — the print sheet and the Excel file are both drawn from
 * it, so they always show the same rows, numbers and names.
 */
export function buildWorkloadSummaryModel(input: {
  rows: WorkloadSummaryRow[]; semester: string; academicYear: string; signatories?: SummarySignatories;
}): WorkloadSummaryModel {
  const line = (r: WorkloadSummaryRow): WorkloadSummaryLine => ({
    name: r.name,
    education: r.education,
    position: r.position,
    values: [
      whole(r.teaching, true), whole(r.research), whole(r.extension), whole(r.funded), whole(r.designation),
      whole(r.actual, true), whole(r.regular, true),
      null, // Emergency Load — not kept in QRganize
      whole(r.praise), whole(r.overload),
    ],
  });
  const permanent = input.rows.filter(r => r.permanent)
    .sort((a, b) => positionRank(a.position) - positionRank(b.position) || a.name.localeCompare(b.name));
  const contractual = input.rows.filter(r => !r.permanent).sort((a, b) => a.name.localeCompare(b.name));
  const signers = input.signatories ?? DEFAULT_SUMMARY_SIGNATORIES;
  const clean = (s: SummarySignatory) => ({ name: s.name.trim(), title: s.title.trim() });
  return {
    semesterHeading: semesterHeading(input.semester),
    academicYear: formatAy(input.academicYear),
    letterhead: { address: DEFAULT_FOOTER_CONFIG.address, phone: DEFAULT_FOOTER_CONFIG.phone, website: DEFAULT_FOOTER_CONFIG.website },
    sections: [
      { label: 'PERMANENT', rows: permanent.map(line) },
      { label: 'CONTRACTUAL', rows: contractual.map(line) },
    ],
    signatories: { preparedBy: clean(signers.preparedBy), recommending: clean(signers.recommending), approved: clean(signers.approved) },
  };
}

function sectionHtml(label: string, rows: WorkloadSummaryLine[]): string {
  if (rows.length === 0) return '';
  return `
<tr class="sec"><td colspan="13">${esc(label)}</td></tr>
${rows.map(r => `<tr>
  <td class="nm">${esc(r.name.toUpperCase())}</td>
  <td class="ed">${esc(r.education)}</td>
  <td class="ps">${esc(r.position)}</td>
  ${r.values.map(v => `<td class="n">${v ?? ''}</td>`).join('')}
</tr>`).join('\n')}`;
}

export function buildWorkloadSummaryHtml(m: WorkloadSummaryModel, origin: string): string {
  const title = `Summary of Faculty Workload — ${m.semesterHeading} ${m.academicYear}`;
  const signers = m.signatories;
  // Every block has the same shape; a blank name keeps its line so it can be signed by hand
  const sig = (label: string, s: SummarySignatory, cls = '') => `
    <div class="sig-blk ${cls}">
      <div class="sig-lbl">${esc(label)}</div>
      <div class="sig-nm">${s.name.trim() ? esc(s.name.trim()) : '&nbsp;'}</div>
      <div class="sig-tt">${s.title.trim() ? esc(s.title.trim()) : '&nbsp;'}</div>
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

/* Logos close beside the text, the whole group centred — as on the reference.
   Balanced: the seal and the ISO marks are the same visible height, and both
   sit centred on the letterhead text. */
.lh { display: flex; align-items: center; justify-content: center; gap: 14px; }
.lh .logo { width: 66px; height: 66px; object-fit: contain; flex-shrink: 0; }
/* ISO-UKAS.png is square with empty space above and below the marks (they fill
   rows 111–404 of 500): crop to exactly the marks, 66 px tall like the seal */
.lh .iso { width: 112px; height: 66px; object-fit: cover; object-position: 50% 54%; flex-shrink: 0; }
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

/* Signatories: three blocks of the same width and shape — Prepared by and
   Recommending Approval split the width evenly, Approved sits centred below.
   In each block the label starts at its left edge and the name and title are
   centred under the space left for the signature. */
.sigs { margin-top: 30px; page-break-inside: avoid;
  display: grid; grid-template-columns: 1fr 1fr; column-gap: 0.7in; row-gap: 28px; }
.sig-blk { min-width: 0; }
.sig-blk.approved { grid-column: 1 / -1; justify-self: center; width: calc((100% - 0.7in) / 2); }
.sig-lbl { font-size: 8.5pt; }
.sig-nm { margin-top: 30px; font-weight: bold; font-size: 9pt; text-align: center; }
.sig-tt { margin-top: 1px; font-size: 8pt; font-style: italic; text-align: center; }

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
    <img class="logo" src="${origin}/nemlogo/NEMSU-logo.png" alt="NEMSU">
    <div class="lh-text">
      <div class="lh-rep">Republic of the Philippines</div>
      <div class="lh-univ">North Eastern Mindanao State University</div>
      <div class="lh-sub">${esc(m.letterhead.address)}</div>
      <div class="lh-sub">Tel. No. ${esc(m.letterhead.phone)}</div>
      <div class="lh-sub">${esc(m.letterhead.website)}</div>
    </div>
    <img class="iso" src="${origin}/nemlogo/ISO-UKAS.png" alt="ISO certified">
  </div>

  <div class="ttl">
    <div class="ttl-1">SUMMARY OF FACULTY WORKLOAD</div>
    <div class="ttl-2">${esc(m.semesterHeading)}</div>
    <div class="ttl-3">A.Y. ${esc(m.academicYear)}</div>
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
      ${m.sections.map(sec => sectionHtml(sec.label, sec.rows)).join("")}
    </tbody>
  </table>

  <div class="sigs">
    ${sig('Prepared by:', signers.preparedBy)}
    ${sig('Recommending Approval:', signers.recommending)}
    ${sig('Approved:', signers.approved, 'approved')}
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

type SummaryOptions = {
  facultyIds: number[];
  semester: string;
  academicYear: string;
  /** Names on the footer (defaults to the ones saved in this browser) */
  signatories?: SummarySignatories;
  onProgress?: (done: number, total: number) => void;
};

/** Reads every faculty's workload (a few at a time) and builds the summary model */
async function loadSummaryModel(opts: SummaryOptions): Promise<{ model: WorkloadSummaryModel; faculty: number }> {
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
  const model = buildWorkloadSummaryModel({
    rows, semester: opts.semester, academicYear: opts.academicYear,
    signatories: opts.signatories ?? loadSummarySignatories(),
  });
  return { model, faculty: rows.length };
}

/**
 * Downloads the summary as an Excel workbook — the same sheet as the print
 * (letterhead and logos, columns, sections, whole numbers, signatories).
 */
export async function downloadWorkloadSummaryExcel(opts: SummaryOptions): Promise<{ faculty: number }> {
  const [{ model, faculty }, { buildWorkloadSummaryWorkbook }, seal, iso] = await Promise.all([
    loadSummaryModel(opts),
    import('@shared/workloadSummaryExport'),
    // The file still downloads if a logo can't be read
    fetch('/nemlogo/NEMSU-logo.png').then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
    fetch('/nemlogo/ISO-UKAS.png').then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
  ]);
  const buffer = await buildWorkloadSummaryWorkbook(model, {
    seal: seal ? { buffer: seal, extension: 'png' } : undefined,
    iso: iso ? { buffer: iso, extension: 'png' } : undefined,
  });
  const url = URL.createObjectURL(new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `Summary_of_Faculty_Workload_${opts.semester.replace(/\s+/g, '_')}_${opts.academicYear.replace(/\s+/g, '')}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { faculty };
}

/**
 * Builds and prints the summary for these faculty. Call it straight from the click
 * handler: the print window opens before anything is loaded, so pop-up blockers allow it.
 */
export async function printWorkloadSummary(opts: SummaryOptions): Promise<OpenPrintHtmlResult & { faculty: number }> {
  const preOpened = openBlankPrintWindow(WINDOW_FEATURES);
  try {
    preOpened?.document.write('<p style="font-family:Arial,sans-serif;padding:24px;color:#0B2A5B">Preparing the Summary of Faculty Workload…</p>');
  } catch { /* the window may not be writable yet */ }
  try {
    const { model, faculty } = await loadSummaryModel(opts);
    const html = buildWorkloadSummaryHtml(model, window.location.origin);
    const result = await openPrintHtmlDocument(html, {
      windowFeatures: WINDOW_FEATURES,
      preOpenedWindow: preOpened,
      printablePath: '/workload/print',
      downloadFilename: 'summary-of-faculty-workload.html',
    });
    return { ...result, faculty };
  } catch (err) {
    try { preOpened?.close(); } catch { /* already closed */ }
    throw err;
  }
}
