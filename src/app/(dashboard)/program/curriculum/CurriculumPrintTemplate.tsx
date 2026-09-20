'use client';

/* ─────────────────────────────────────────────────────────────────────────────
   CurriculumPrintTemplate — NEMSU Official Curriculum Print
   ───────────────────────────────────────────────────────────────────────────
   Paper  : Long Bond Paper  8.5 in × 13 in  (216 mm × 330 mm), portrait
   Method : window.open() → standalone HTML document.
            Content is pre-paginated in JavaScript before writing HTML, so
            every page carries its own copy of the header and footer — no
            CSS fixed-positioning tricks, works in Chrome, Edge, and Firefox.

   Pagination constants (all in pt; 1 in = 72 pt):
     Page             : 8.5 × 13 in  = 612 × 936 pt
     Header height    : 125 pt  (~44 mm)   — top:0 .. bottom:125
     Footer height    :  52 pt  (~18 mm)   — top:884 .. bottom:936
     Header gap       :   8 pt  (below header border-bottom)
     Footer gap       :   8 pt  (above footer border-top)
     Body top         : 133 pt  (125 + 8)
     Body bottom      :  60 pt  (52 + 8)
     Usable content   : 936 − 133 − 60 = 743 pt  (conservative: 730)
     Overhead/section :  88 pt  (title row + 2 header rows + total + ev-by + gap)
     Per data row     :  14 pt  (9 pt font × 1.3 lh + 2×2 pt pad)
─────────────────────────────────────────────────────────────────────────────── */

/* ── Public types ───────────────────────────────────────────────────────── */

export interface PrintSubject {
  id: number;
  subject_code: string;
  subject_name: string;
  lecture_hours: number;
  laboratory_hours: number;
  units: number;
  prerequisites: string;
  grade: string;
}

export interface PrintGroup {
  key: string;
  yearLevel: string;
  semester: string;
  subjects: PrintSubject[];
}

/* ── Label maps ─────────────────────────────────────────────────────────── */

const YEAR_LABEL: Record<string, string> = {
  '1st Year': 'FIRST YEAR',
  '2nd Year': 'SECOND YEAR',
  '3rd Year': 'THIRD YEAR',
  '4th Year': 'FOURTH YEAR',
};

const SEM_LABEL: Record<string, string> = {
  '1st Semester': 'First Semester',
  '2nd Semester': 'Second Semester',
  'Summer':       'Summer',
};

/* ── Utility helpers ────────────────────────────────────────────────────── */

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtU(u: number): string {
  const n = parseFloat(String(u ?? 0));
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtH(h: number): string {
  return String(Number(h ?? 0));
}

/* ── Pagination ─────────────────────────────────────────────────────────── */

const ROW_H  = 14;   // pt per data row (conservative)
const SEC_OH = 88;   // pt overhead per section (title + hdrs + total + ev-by + gap)
const CONT_H = 730;  // pt of usable body height per page (conservative)

function estimateSectionHeight(g: PrintGroup): number {
  return SEC_OH + g.subjects.length * ROW_H;
}

function paginate(groups: PrintGroup[]): PrintGroup[][] {
  const pages: PrintGroup[][] = [];
  let current: PrintGroup[]   = [];
  let used = 0;

  for (const g of groups) {
    const h = estimateSectionHeight(g);
    if (current.length > 0 && used + h > CONT_H) {
      pages.push(current);
      current = [];
      used    = 0;
    }
    current.push(g);
    used += h;
  }

  if (current.length > 0) pages.push(current);
  return pages;
}

/* ── Inline SVG assets (no network dependency, no broken-image fallback) ── */

/* Location pin — 7 × 10 pt */
const ICO_PIN = `<svg xmlns="http://www.w3.org/2000/svg" width="7" height="10" viewBox="0 0 7 10" style="display:inline-block;vertical-align:middle;margin-right:3pt;flex-shrink:0"><path d="M3.5 0C1.57 0 0 1.57 0 3.5 0 6.13 3.5 10 3.5 10S7 6.13 7 3.5C7 1.57 5.43 0 3.5 0zm0 4.75A1.25 1.25 0 1 1 3.5 2.25 1.25 1.25 0 0 1 3.5 4.75z" fill="#000"/></svg>`;

/* Telephone handset — 9 × 9 pt */
const ICO_PHONE = `<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 9 9" style="display:inline-block;vertical-align:middle;margin-right:3pt;flex-shrink:0"><path d="M2 .5C1.6.5 1.2.7.9 1L.5 1.4C.1 1.8.1 2.5.4 3.2 1 4.6 2.2 5.9 3.7 6.6c.6.3 1.3.2 1.7-.2l.4-.4c.4-.4.4-1.1 0-1.5L5.3 3.9c-.4-.4-1-.3-1.4.1l-.3.3C3 4 2.5 3.5 2.2 2.9l.3-.3C2.9 2.2 3 1.6 2.6 1.2L2 .5z" fill="#000"/></svg>`;

/* Globe / website — 9 × 9 pt */
const ICO_GLOBE = `<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 9 9" style="display:inline-block;vertical-align:middle;margin-right:3pt;flex-shrink:0"><circle cx="4.5" cy="4.5" r="4" stroke="#000" stroke-width="0.75" fill="none"/><ellipse cx="4.5" cy="4.5" rx="1.8" ry="4" stroke="#000" stroke-width="0.75" fill="none"/><line x1="0.5" y1="4.5" x2="8.5" y2="4.5" stroke="#000" stroke-width="0.75"/><line x1="1" y1="2.5" x2="8" y2="2.5" stroke="#000" stroke-width="0.5"/><line x1="1" y1="6.5" x2="8" y2="6.5" stroke="#000" stroke-width="0.5"/></svg>`;


/* ── Print CSS ──────────────────────────────────────────────────────────── */

/*
 * Column widths (usable content width = 612 − 2 × 46 = 520 pt):
 *   Course Code   13 % ≈  68 pt
 *   Title         35 % ≈ 182 pt
 *   Lec            7 % ≈  36 pt
 *   Lab            7 % ≈  36 pt
 *   Credit Units   9 % ≈  47 pt
 *   Pre-requisite 20 % ≈ 104 pt
 *   Grade          9 % ≈  47 pt
 */
const CSS = `
@page { size: 8.5in 13in; margin: 0; }

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html {
  background: #fff;
  color-scheme: light;
}

body {
  font-family: 'Times New Roman', Times, serif;
  font-size: 9pt;
  color: #000;
  background: #fff;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  width: 8.5in;
}

@media print {
  html, body        { background: #fff !important; }
  .pg, .ph, .pb, .pf { background: #fff !important; }
}

/* ── Page box: one per physical page ─── */
.pg {
  position: relative;
  width: 8.5in;
  height: 13in;
  overflow: hidden;
  background: #fff;
}
.pg + .pg {
  break-before: page;
  page-break-before: always;
}

/* ── Header — spans full page width, padded internally ─── */
.ph {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 125pt;
  padding: 10pt 46pt 0;
  text-align: center;
  background: #fff;
}
.ph img.logo {
  height: 52pt; width: auto;
  display: block; margin: 0 auto 3pt;
  object-fit: contain;
}
.ph .rep {
  font-size: 9pt; font-style: italic; font-weight: normal;
  margin-bottom: 1pt; line-height: 1.3;
}
.ph .uni {
  font-size: 14pt; font-weight: bold;
  margin-bottom: 2pt; line-height: 1.2;
}
.ph .prg {
  font-size: 11pt; font-weight: bold;
  text-transform: uppercase; letter-spacing: 0.3pt;
  line-height: 1.2;
}
.ph .cur {
  font-size: 9pt; font-weight: 600;
  margin-top: 2pt; line-height: 1.2;
  letter-spacing: 0.2pt;
}

/* ── Footer — spans full page width, padded internally ─── */
.pf {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 52pt;
  background: #fff;
  border-top: 0.75pt solid #000;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8pt;
  padding: 0 46pt;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* Left: contact info */
.pf-lft {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1pt;
  font-size: 7.5pt;
  line-height: 1.65;
  flex: 0 0 auto;
}
.pf-row {
  display: flex;
  align-items: center;
  white-space: nowrap;
}

/* Right: accreditation logos */
.pf-rgt {
  display: flex;
  align-items: center;
  gap: 7pt;
  flex: 0 0 auto;
}
.pf-rgt img {
  height: 30pt;
  width: auto;
  object-fit: contain;
  display: block;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* ── Page body — between header and footer ─── */
.pb {
  position: absolute;
  top: 133pt;   /* header 125pt + gap 8pt */
  bottom: 60pt; /* footer 52pt  + gap 8pt */
  left: 46pt; right: 46pt;
  overflow: hidden;
  background: #fff;
}

/* ── Semester section ─── */
.sec { margin-bottom: 8pt; }

/* ── Curriculum table ─── */
.ct {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 9pt;
}
.ct th, .ct td {
  border: 0.75pt solid #000;
  padding: 2pt 3.5pt;
  vertical-align: middle;
  overflow: hidden;
}

/* Section heading row (colspan=7 merged cell) */
.shd {
  text-align: center;
  font-weight: bold;
  font-size: 10pt;
  padding: 3pt 4pt;
  background: #fff;
}

/* Column header cells */
.chd {
  text-align: center;
  font-weight: bold;
  font-size: 8.5pt;
  line-height: 1.25;
  background: #fff;
}

/* Data row alignment per column */
.ct tbody td:nth-child(1) { text-align: left; }
.ct tbody td:nth-child(2) { text-align: left; white-space: normal; }
.ct tbody td:nth-child(3),
.ct tbody td:nth-child(4),
.ct tbody td:nth-child(5) { text-align: center; white-space: nowrap; }
.ct tbody td:nth-child(6) { text-align: center; }
.ct tbody td:nth-child(7) { text-align: center; white-space: nowrap; }

/* TOTAL row */
.ct tfoot td {
  font-weight: bold;
  font-size: 9pt;
  background: #fff;
}
.ct tfoot td:nth-child(2) { text-align: right; padding-right: 5pt; }
.ct tfoot td:nth-child(3),
.ct tfoot td:nth-child(4),
.ct tfoot td:nth-child(5) { text-align: center; }

/* Evaluated by */
.evby { font-size: 9pt; margin-top: 4pt; }
`;

/* ── Section HTML builder ────────────────────────────────────────────────── */

function buildSection(group: PrintGroup): string {
  const yl = YEAR_LABEL[group.yearLevel] ?? group.yearLevel.toUpperCase();
  const sl = SEM_LABEL[group.semester]   ?? group.semester;

  const totalLec   = group.subjects.reduce((s, c) => s + Number(c.lecture_hours   ?? 0), 0);
  const totalLab   = group.subjects.reduce((s, c) => s + Number(c.laboratory_hours ?? 0), 0);
  const totalUnits = group.subjects.reduce((s, c) => s + parseFloat(String(c.units ?? 0)), 0);

  const rows = group.subjects
    .map(c => `<tr>
      <td>${esc(c.subject_code)}</td>
      <td>${esc(c.subject_name)}</td>
      <td>${fmtH(Number(c.lecture_hours))}</td>
      <td>${fmtH(Number(c.laboratory_hours))}</td>
      <td>${fmtU(parseFloat(String(c.units)))}</td>
      <td>${esc(c.prerequisites ?? '')}</td>
      <td>${esc(c.grade ?? '')}</td>
    </tr>`)
    .join('');

  return `
  <div class="sec">
    <table class="ct">
      <colgroup>
        <col style="width:13%"><col style="width:35%">
        <col style="width:7%"><col style="width:7%">
        <col style="width:9%"><col style="width:20%"><col style="width:9%">
      </colgroup>
      <thead>
        <tr><td colspan="7" class="shd">${esc(yl)} - ${esc(sl)}</td></tr>
        <tr>
          <th class="chd" rowspan="2">Course Code</th>
          <th class="chd" rowspan="2">Descriptive Title</th>
          <th class="chd" colspan="2">No. of Hours</th>
          <th class="chd" rowspan="2">Credit<br>Units</th>
          <th class="chd" rowspan="2">Pre-requisite(s)</th>
          <th class="chd" rowspan="2">Grade</th>
        </tr>
        <tr>
          <th class="chd">Lec</th>
          <th class="chd">Lab</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td></td>
          <td>TOTAL</td>
          <td>${totalLec  || 0}</td>
          <td>${totalLab  || 0}</td>
          <td>${fmtU(parseFloat(totalUnits.toFixed(2)))}</td>
          <td></td><td></td>
        </tr>
      </tfoot>
    </table>
    <p class="evby">Evaluated by: ________________________________</p>
  </div>`;
}

/* ── Page HTML builder ───────────────────────────────────────────────────── */

function buildPage(
  groups:      PrintGroup[],
  programName: string,
  curriculumLabel: string,
  logo:        string,
  isoLogo:     string,
  bagong:      string,
): string {
  const hdr = `<div class="ph">
    <img class="logo" src="${logo}" alt="NEMSU Logo" onerror="this.style.display='none'">
    <p class="rep">Republic of the Philippines</p>
    <p class="uni">North Eastern Mindanao State University</p>
    <p class="prg">${esc(programName)}</p>
    <p class="cur">${esc(curriculumLabel)}</p>
  </div>`;

  /* Footer: left=contact info, right=logos */
  const ftr = `<div class="pf">
    <div class="pf-lft">
      <div class="pf-row">${ICO_PIN}Cantilan, Surigao del Sur 8317</div>
      <div class="pf-row">${ICO_PHONE}086-212-2723</div>
      <div class="pf-row">${ICO_GLOBE}www.nemsu.edu.ph</div>
    </div>
    <div class="pf-rgt">
      <img src="${isoLogo}" alt="ISO UKAS"        onerror="this.style.display='none'">
      <img src="${bagong}"  alt="Bagong Pilipinas" onerror="this.style.display='none'">
    </div>
  </div>`;

  const body = groups.map(buildSection).join('');

  return `<div class="pg">${hdr}<div class="pb">${body}</div>${ftr}</div>`;
}

/* ── Full document builder ──────────────────────────────────────────────── */

function buildDocument(groups: PrintGroup[], programName: string, curriculumLabel: string, origin: string): string {
  const logo    = `${origin}/nemlogo/NEMSU-logo.png`;
  const isoLogo = `${origin}/nemlogo/ISO-UKAS.png`;
  const bagong  = `${origin}/nemlogo/BAGONG-PILIPINAS-LOGO.png`;

  const pages    = paginate(groups);
  const pagesHTML = pages
    .map(pg => buildPage(pg, programName, curriculumLabel, logo, isoLogo, bagong))
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="light">
<title>${esc(programName)} — ${esc(curriculumLabel)}</title>
<style>${CSS}</style>
</head>
<body>
${pagesHTML}
<script>
var _p=false;
function _dp(){if(_p)return;_p=true;window.focus();window.print();}
window.addEventListener('load',function(){setTimeout(_dp,350);});
setTimeout(_dp,1500);
<\/script>
</body>
</html>`;
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Opens the NEMSU curriculum print document in a new window.
 * Returns true on success, false if the browser blocked the pop-up.
 */
export function openCurriculumPrint(
  groups:      PrintGroup[],
  programName: string,
  curriculumLabel = 'New Curriculum',
): boolean {
  if (groups.length === 0) return false;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const html   = buildDocument(groups, programName, curriculumLabel, origin);

  const pw = window.open('', '_blank', 'width=900,height=700,scrollbars=yes,resizable=yes');
  if (!pw) return false;

  pw.document.open();
  pw.document.write(html);
  pw.document.close();

  return true;
}
