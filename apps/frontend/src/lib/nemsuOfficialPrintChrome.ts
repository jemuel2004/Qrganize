/**
 * Shared NEMSU official print chrome — source of truth from Faculty Workload Print.
 * Used by Workload (HTML string) and Class Program (React print surface).
 * Paper: long bond 8.5 × 13 in portrait.
 */

import {
  footerCss,
  footerHtml,
  DEFAULT_FOOTER_CONFIG,
  type FooterConfig,
} from '@/app/(dashboard)/workload/InstructorWorkloadFooter';

export const NEMSU_OFFICIAL_DEPT = 'Department of Computer Studies';
export { DEFAULT_FOOTER_CONFIG, footerCss, footerHtml };
export type { FooterConfig };

export function semesterHeading(semester: string): string {
  const s = (semester || '').trim();
  if (/^1st(\s+Semester)?$/i.test(s)) return 'FIRST SEMESTER';
  if (/^2nd(\s+Semester)?$/i.test(s)) return 'SECOND SEMESTER';
  if (/^summer$/i.test(s)) return 'SUMMER';
  return s.toUpperCase();
}

export function formatAy(year: string): string {
  return (year || '').replace(/(\d{4})-(\d{4})/, '$1 - $2');
}

/**
 * Typography + table + signature rules — single source of truth.
 * Used by Workload print window (unscoped) and Class Program (scoped under .cp-shell).
 */
function officialPrintTypographyAndTableCss(): string {
  return `
.page { padding: 0.44in 0.5in 0.75in; }

.hdr { text-align: center; margin-bottom: 4px; line-height: 1.28; }
.hdr img { width: 60px; height: 60px; object-fit: contain; display: block; margin: 0 auto 3px; }
.hdr-rep  { font-size: 8pt; }
.hdr-univ { font-size: 9.5pt; font-weight: bold; }
.hdr-dept { font-size: 11.5pt; font-weight: bold; margin-top: 1px; }
.hdr-wl   { font-size: 10pt; font-weight: bold; letter-spacing: .04em; }
.hdr-sem  { font-size: 10pt; font-weight: bold; }
.hdr-ay   { font-size: 8.5pt; }

.info { display: flex; margin: 5px 0 4px; font-size: 8.5pt; }
.info-left  { flex: 0 0 56%; display: flex; flex-direction: column; gap: 2.5px; }
.info-right { flex: 1; display: flex; flex-direction: column; gap: 2.5px; }
.hf { display: flex; align-items: baseline; }
.i-lbl { flex-shrink: 0; white-space: nowrap; color: #000; }
.i-val { color: #000; margin-left: 4px; overflow-wrap: break-word; }
.course-line { font-size: 8.5pt; margin: 2px 0 5px; }
.course-ul { font-weight: bold; text-decoration: underline; }

.wl { width: 100%; border-collapse: collapse; font-size: 8pt; page-break-inside: avoid; }
.wl th, .wl td { border: 1px solid #222; padding: 2px 3px; vertical-align: middle; }
.wl thead th { background: #fff; font-weight: bold; text-align: center; font-size: 7.5pt; line-height: 1.15; }
.sec-hdr td { background: #fff; font-weight: bold; font-size: 8.5pt; padding: 2px 5px; letter-spacing: .02em; }
.t-time   { width: 15%; text-align: center; font-size: 7.5pt; padding: 2px 2px; line-height: 1.2; }
.t-time-a, .t-time-b { white-space: nowrap; }
.t-code   { width: 9%;  text-align: center; font-weight: bold; font-size: 7.5pt; }
.t-desc   { width: 29%; text-align: center; padding: 2px 3px; }
.t-course { width: 10%; text-align: center; }
.t-stu    { width: 8%;  text-align: center; }
.t-units  { width: 7%;  text-align: center; }
.t-hours  { width: 8%;  text-align: center; }
.t-room   { width: 14%; text-align: center; font-size: 7.5pt; }
.t-inst   { width: 22%; text-align: left; font-size: 7.5pt; padding: 2px 3px; }
.t-status { width: 12%; text-align: center; font-size: 7.5pt; }
.no-room  { font-style: italic; color: #444; font-size: 7pt; }
.dr-empty td { background: #fff; height: 14px; }
.tr-total td { font-weight: bold; background: #fff; padding: 2px 3px; }
.tr-total .c-right { text-align: right; }
.tr-total .c-center { text-align: center; }

.sig { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 8.5pt; page-break-inside: avoid; }
.sig td { border: none; padding: 0; vertical-align: top; }
.sig .lbl { font-size: 8.5pt; font-weight: normal; }
.sig .sp  { height: 22px; }
.sig .blk { text-align: center; }
.sig .nm  { font-weight: bold; font-size: 8.5pt; line-height: 1.2; }
.sig .tt  { font-size: 8pt; margin-top: 3px; line-height: 1.2; }
.sig .sec { padding-top: 16px; }
.sig .cfm-wrap {
  display: inline-block;
  position: relative;
  font-weight: bold;
  font-size: 8.5pt;
  line-height: 1.2;
  white-space: nowrap;
}
.sig .cfm-ghost {
  visibility: hidden;
  display: block;
  height: 0;
  overflow: hidden;
}
.sig .cfm-lbl {
  position: absolute;
  left: 0;
  top: 0;
  font-weight: normal;
  font-size: 8.5pt;
  white-space: nowrap;
  transform: translateX(-5.4em);
}
`.trim();
}

/** Prefix every selector in a CSS ruleset string with `scope` (e.g. `.cp-shell`). */
function scopeCssSelectors(css: string, scope: string): string {
  return css.replace(/(^|})\s*([^@{}][^{]*)\{/g, (_match, brace: string, selectorList: string) => {
    const scoped = selectorList
      .split(',')
      .map(sel => {
        const t = sel.trim();
        if (!t) return t;
        if (t.startsWith(scope)) return t;
        return `${scope} ${t}`;
      })
      .join(', ');
    return `${brace}\n${scoped}{`;
  });
}

/**
 * Core page / header / table / signature CSS shared by official print docs.
 * Intended for isolated print HTML windows (e.g. Faculty Workload document.write).
 * Do NOT inject this into the live SPA — it resets `*` and `body` globally.
 * For Class Program in-page preview, use officialPrintEmbeddedDocumentCss() instead.
 */
export function officialPrintDocumentCss(): string {
  return `
* { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: 8.5in 13in portrait; margin: 0; }
body { font-family: Arial, sans-serif; font-size: 8.5pt; color: #000; background: #fff; }
${officialPrintTypographyAndTableCss()}

@media print {
  .wl { page-break-inside: avoid; }
  .sig { page-break-inside: avoid; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #fff !important; color: #000 !important; }
  .wl th, .wl td, .wl thead th, .sec-hdr td { background: #fff !important; }
}
${footerCss()}
`.trim();
}

export type OfficialPrintHeaderInput = {
  logoSrc: string;
  department?: string;
  title: string;
  semesterHeading: string;
  academicYear: string;
};

/** Centered institutional header — identical structure to Faculty Workload Print. */
export function officialPrintHeaderHtml(input: OfficialPrintHeaderInput): string {
  const dept = (input.department || '').trim() || NEMSU_OFFICIAL_DEPT;
  const ay = formatAy(input.academicYear);
  return `
<div class="hdr">
  <img src="${input.logoSrc}" alt="NEMSU">
  <div class="hdr-rep">Republic of the Philippines</div>
  <div class="hdr-univ">North Eastern Mindanao State University</div>
  <div class="hdr-dept">${escapePrintHtml(dept)}</div>
  <div class="hdr-wl">${escapePrintHtml(input.title)}</div>
  <div class="hdr-sem">${escapePrintHtml(input.semesterHeading)}</div>
  <div class="hdr-ay">A.Y ${escapePrintHtml(ay)}</div>
</div>`.trim();
}

export function escapePrintHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** On-page preview shell for Class Program (document visible on screen + print). */
export function officialPrintPreviewShellCss(): string {
  return `
@media print {
  .no-print { display: none !important; }
  body, html { background: white !important; margin: 0 !important; padding: 0 !important; }
  /* The app shell is a fixed-height scroll box on screen; on paper it must
     flow so every page of the document prints, not just the visible part. */
  .dashboard-layout-root, .dashboard-main-scroll {
    height: auto !important; overflow: visible !important; display: block !important;
  }
  .cp-print-root { padding: 0 !important; margin: 0 !important; max-width: none !important; }
  .cp-print-scroll { overflow: visible !important; }
  @page { size: 8.5in 13in portrait; margin: 0; }
  .cp-shell {
    display: block !important;
    padding: 0 !important; max-width: none !important; box-shadow: none !important;
    border: none !important; border-radius: 0 !important; background: white !important;
  }
  .cp-shell .page { padding: 0.44in 0.5in 0.75in !important; }
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  .cp-shell .wl tbody tr { page-break-inside: avoid; }
  .cp-shell, .cp-shell * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    background: #fff !important;
    color: #000 !important;
  }
  .cp-shell .wl th, .cp-shell .wl td, .cp-shell .wl thead th, .cp-shell .sec-hdr td {
    background: #fff !important;
  }
}
@media screen {
  .cp-shell {
    display: block;
    max-width: 760px;
    margin: 0 auto 32px;
    background: white;
    box-shadow: 0 2px 24px rgba(0,0,0,0.18);
    border-radius: 2px;
  }
  .cp-shell .page { padding: 0.44in 0.5in 0.75in; }
  .cp-shell .pf {
    position: relative;
    bottom: auto;
    left: auto;
    right: auto;
    margin-top: 28pt;
  }
}
`.trim();
}

/**
 * Same typography / table / footer CSS as Instructor Workload Print,
 * scoped under `.cp-shell` so it cannot leak into the live SPA chrome.
 * Derived from officialPrintTypographyAndTableCss() + footerCss() — no duplicated sizes.
 */
export function officialPrintEmbeddedDocumentCss(): string {
  const scopedChrome = scopeCssSelectors(officialPrintTypographyAndTableCss(), '.cp-shell');
  const scopedFooter = scopeCssSelectors(footerCss(), '.cp-shell');

  return `
.cp-shell, .cp-shell * { box-sizing: border-box; }
.cp-shell {
  font-family: Arial, sans-serif;
  font-size: 8.5pt;
  color: #000;
  background: #fff;
}
/* The app's global "th, td" size (large screen text) must not reach the paper
   form; cells inherit the form's own sizes unless a column class sets one. */
.cp-shell td, .cp-shell th { font-size: inherit; }
${scopedChrome}
${scopedFooter}

@media print {
  .cp-shell .wl { page-break-inside: avoid; }
  .cp-shell .sig { page-break-inside: avoid; }
  .cp-shell .pf {
    position: fixed;
    bottom: 0.1in; left: 0; right: 0;
  }
}
`.trim();
}
