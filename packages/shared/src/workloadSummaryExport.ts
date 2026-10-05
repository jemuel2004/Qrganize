import ExcelJS from 'exceljs';

/*
 * SUMMARY OF FACULTY WORKLOAD as data — built once (frontend
 * lib/workloadSummaryPrint → buildWorkloadSummaryModel) and rendered two ways:
 * the print HTML and this Excel workbook. Same letterhead, sections, rows,
 * whole numbers and signatories in both.
 */

export interface WorkloadSummarySignatory { name: string; title: string }

export interface WorkloadSummaryLine {
  name: string;
  education: string;
  position: string;
  /** No. of Units, Research, Extension, Funded Research, Designation, Actual,
   *  Regular, Emergency, PRAISE, Overload — whole numbers; null prints blank */
  values: (number | null)[];
}

export interface WorkloadSummaryModel {
  /** "FIRST SEMESTER" */
  semesterHeading: string;
  /** "2026 - 2027" */
  academicYear: string;
  letterhead: { address: string; phone: string; website: string };
  sections: { label: string; rows: WorkloadSummaryLine[] }[];
  signatories: {
    preparedBy: WorkloadSummarySignatory;
    recommending: WorkloadSummarySignatory;
    approved: WorkloadSummarySignatory;
  };
}

type ImageInput = { buffer: ArrayBuffer | Uint8Array; extension: 'png' | 'jpeg' };

const FONT = 'Arial';
const HEADINGS = [
  'Name', 'Highest Education Attainment', 'Position', 'No. of Units', 'Research', 'Extension',
  'Funded Research', 'Designation / Special Assignments', 'Actual Load', 'Regular Load',
  'Emergency Load', 'PRAISE', 'Overload',
];
/* Same proportions as the printed sheet. Columns A–C and H–M are equal in total
   width, so the two signature halves mirror each other like the print. */
const COL_WIDTHS = [26, 15, 15, 8, 9, 9.5, 9, 12, 8.5, 8.5, 9.5, 8, 9.5];
const LAST_COL = COL_WIDTHS.length;
const LEFT_HALF: [number, number] = [1, 3];
const RIGHT_HALF: [number, number] = [8, LAST_COL];
/* Letters per line before Excel wraps (bold 10 pt names, 9 pt details) — checked
   against Excel's own layout: "JENELLIE ROSE GUEVARRA" (22) needs two lines */
const CHARS_PER_LINE = { name: 21, education: 17, position: 17 };

const THIN: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF222222' } };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const widthToPx = (w: number) => Math.floor(w * 7 + 5);
const PT_TO_PX = 4 / 3;
const EMU_PER_PX = 9525;

/* Letterhead group (logos close beside the centred text), sized for a sheet that
   prints fitted to the page width — about 1.4× the print sizes. Balanced like
   the print: the seal and the ISO marks are the same visible height, both centred
   on the letterhead text. */
const SEAL_PX = 92;
/** ISO-UKAS.png is square; the marks fill rows 111–404 of its 500 px height */
const ISO_MARKS = { top: 111 / 500, bottom: 405 / 500 };
const ISO_PX = Math.round(SEAL_PX / (ISO_MARKS.bottom - ISO_MARKS.top));
/** Room above the letterhead for the ISO image's empty top edge */
const TOP_SPACER_PT = 22;
const LOGO_GAP_PX = 20;
/** Half the width of the widest letterhead line (university name, 15 pt bold) */
const LETTERHEAD_HALF_TEXT_PX = 226;

/** Exact image anchor for a point `xPx` from the sheet's left edge, `yPx` below the top of 1-based `row` */
function exactAnchor(ws: ExcelJS.Worksheet, xPx: number, row: number, yPx: number): ExcelJS.Anchor {
  let left = Math.max(0, xPx);
  let col = 0;
  while (col < COL_WIDTHS.length - 1 && left >= widthToPx(COL_WIDTHS[col])) { left -= widthToPx(COL_WIDTHS[col]); col += 1; }
  let top = yPx;
  let r = row;
  while (top < 0 && r > 1) { r -= 1; top += (ws.getRow(r).height ?? 15) * PT_TO_PX; }
  for (;;) {
    const h = (ws.getRow(r).height ?? 15) * PT_TO_PX;
    if (top < h || r >= ws.rowCount) break;
    top -= h;
    r += 1;
  }
  return {
    nativeCol: col, nativeColOff: Math.round(left * EMU_PER_PX),
    nativeRow: r - 1, nativeRowOff: Math.round(Math.max(0, top) * EMU_PER_PX),
  } as unknown as ExcelJS.Anchor;
}

/** The Summary of Faculty Workload as a formatted .xlsx (long bond, fitted to the page width). */
export async function buildWorkloadSummaryWorkbook(
  m: WorkloadSummaryModel,
  logos: { seal?: ImageInput; iso?: ImageInput } = {},
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Summary of Faculty Workload', {
    pageSetup: {
      paperSize: 14 as ExcelJS.PaperSize, // Folio / long bond 8.5×13
      orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.45, bottom: 0.5, header: 0.2, footer: 0.2 },
      horizontalCentered: true,
    },
    views: [{ showGridLines: false }],
  });
  ws.columns = COL_WIDTHS.map(width => ({ width }));
  const font = (extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT, size: 10, ...extra });

  function line(text: string, opts: {
    from?: number; to?: number; bold?: boolean; italic?: boolean; size?: number;
    align?: 'left' | 'center'; row?: ExcelJS.Row; height?: number;
  } = {}): ExcelJS.Row {
    const row = opts.row ?? ws.addRow([]);
    const from = opts.from ?? 1;
    const to = opts.to ?? LAST_COL;
    if (to > from) ws.mergeCells(row.number, from, row.number, to);
    const cell = row.getCell(from);
    cell.value = text;
    cell.font = font({ bold: opts.bold, italic: opts.italic, size: opts.size });
    cell.alignment = { horizontal: opts.align ?? 'center', vertical: 'middle', wrapText: true };
    if (opts.height) row.height = opts.height;
    return row;
  }
  const blank = (height: number) => { const r = ws.addRow([]); r.height = height; return r; };
  const border = (row: ExcelJS.Row) => { for (let c = 1; c <= LAST_COL; c++) row.getCell(c).border = BORDER; };

  // ── Letterhead: seal · centred text · ISO marks ──────────────────────────
  const top = blank(TOP_SPACER_PT).number;
  line('Republic of the Philippines', { size: 10.5, height: 15 });
  line('North Eastern Mindanao State University', { bold: true, size: 15, height: 21 });
  line(m.letterhead.address, { size: 10.5, height: 15 });
  line(`Tel. No. ${m.letterhead.phone}`, { size: 10.5, height: 15 });
  line(m.letterhead.website, { size: 10.5, height: 15 });
  // Middle of the five text lines, measured from the top of the spacer row
  const textMiddlePx = (TOP_SPACER_PT + (15 * 4 + 21) / 2) * PT_TO_PX;
  const centre = COL_WIDTHS.reduce((s, w) => s + widthToPx(w), 0) / 2;
  if (logos.seal) {
    const id = wb.addImage({ buffer: logos.seal.buffer as ExcelJS.Buffer, extension: logos.seal.extension });
    ws.addImage(id, {
      tl: exactAnchor(ws, centre - LETTERHEAD_HALF_TEXT_PX - LOGO_GAP_PX - SEAL_PX, top, textMiddlePx - SEAL_PX / 2),
      ext: { width: SEAL_PX, height: SEAL_PX },
    });
  }
  if (logos.iso) {
    // Centre the visible marks (not the whole square image) on the text
    const marksMiddle = ((ISO_MARKS.top + ISO_MARKS.bottom) / 2) * ISO_PX;
    const id = wb.addImage({ buffer: logos.iso.buffer as ExcelJS.Buffer, extension: logos.iso.extension });
    ws.addImage(id, {
      tl: exactAnchor(ws, centre + LETTERHEAD_HALF_TEXT_PX + LOGO_GAP_PX, top, textMiddlePx - marksMiddle),
      ext: { width: ISO_PX, height: ISO_PX },
    });
  }

  // ── Title ────────────────────────────────────────────────────────────────
  blank(16);
  line('SUMMARY OF FACULTY WORKLOAD', { bold: true, size: 14, height: 19 });
  line(m.semesterHeading, { bold: true, size: 12.5, height: 17 });
  line(`A.Y. ${m.academicYear}`, { size: 11, height: 15 });
  blank(12);

  // ── Table (headings repeat on every printed page) ──────────────────────────
  const head = ws.addRow(HEADINGS);
  head.eachCell(cell => {
    cell.font = font({ bold: true, size: 8.5 });
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  head.height = 40;
  border(head);
  ws.pageSetup.printTitlesRow = `${head.number}:${head.number}`;

  for (const section of m.sections) {
    if (section.rows.length === 0) continue;
    const sec = line(section.label, { bold: true, size: 11, align: 'left', height: 17 });
    sec.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    border(sec);
    for (const r of section.rows) {
      const row = ws.addRow([r.name.toUpperCase(), r.education, r.position, ...r.values.map(v => (v == null ? '' : v))]);
      for (let c = 1; c <= LAST_COL; c++) {
        const cell = row.getCell(c);
        cell.font = font({ bold: c === 1, size: c === 2 || c === 3 ? 9 : 10 });
        cell.alignment = { horizontal: c === 1 ? 'left' : 'center', vertical: 'middle', wrapText: c <= 3 };
      }
      const lines = Math.max(
        Math.ceil(r.name.length / CHARS_PER_LINE.name),
        Math.ceil(r.education.length / CHARS_PER_LINE.education),
        Math.ceil(r.position.length / CHARS_PER_LINE.position),
        1,
      );
      row.height = Math.max(17, lines * 12.5 + 4);
      border(row);
    }
  }

  // ── Signatories: Prepared by | Recommending Approval, then Approved centred ─
  const sg = m.signatories;
  const signer = (s: WorkloadSummarySignatory, nameRow: ExcelJS.Row, titleRow: ExcelJS.Row, span: [number, number]) => {
    line(s.name.trim(), { row: nameRow, from: span[0], to: span[1], bold: true, size: 12 });
    line(s.title.trim(), { row: titleRow, from: span[0], to: span[1], italic: true, size: 11 });
  };
  blank(26);
  const labels = line('Prepared by:', { from: LEFT_HALF[0], to: LEFT_HALF[1], align: 'left', size: 11, height: 16 });
  line('Recommending Approval:', { row: labels, from: RIGHT_HALF[0], to: RIGHT_HALF[1], align: 'left', size: 11 });
  blank(28);
  const names = ws.addRow([]); names.height = 17;
  const titles = ws.addRow([]); titles.height = 15;
  signer(sg.preparedBy, names, titles, LEFT_HALF);
  signer(sg.recommending, names, titles, RIGHT_HALF);
  blank(24);
  // Approved: the same block shape, centred on the page (label at the block's left edge)
  line('Approved:', { from: 3, to: 7, align: 'left', size: 11, height: 16 });
  blank(28);
  const aName = ws.addRow([]); aName.height = 17;
  const aTitle = ws.addRow([]); aTitle.height = 15;
  signer(sg.approved, aName, aTitle, [1, LAST_COL]);

  ws.pageSetup.printArea = `A1:${String.fromCharCode(64 + LAST_COL)}${ws.rowCount}`;
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
