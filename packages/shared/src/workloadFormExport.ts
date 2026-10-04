import ExcelJS from 'exceljs';

/*
 * Official NEMSU Faculty Workload form as data — computed once (frontend
 * lib/instructorWorkloadPrintDocument → buildWorkloadFormModel) and rendered
 * two ways: the print HTML and this Excel workbook. Same sections, rows,
 * summary and signatories in both.
 */

export type WorkloadFormRow =
  /** A scheduled class line */
  | {
      kind: 'load';
      time: string; code: string; description: string; boldDescription: boolean;
      course: string; students: string; units: string; hours: string; room: string;
    }
  /** A Praise Load record (Other section — no time/course) */
  | { kind: 'praise'; code: string; description: string; units: string; hours: string }
  /** An empty template time slot */
  | { kind: 'blank'; time: string };

export interface WorkloadFormSection {
  label: string;
  rows: WorkloadFormRow[];
}

/** One summary cell; after the label (TIME/DAY + Subject Code), cells map to
 *  Description, Course, Students, Units, Hours, Room in order. */
export interface WorkloadFormCell {
  text?: string;
  center?: boolean;
  bold?: boolean;
  labelPad?: boolean;
  colspan?: number;
}

export interface WorkloadFormSummaryRow {
  bold: boolean;
  cells: WorkloadFormCell[];
}

export interface WorkloadFormSignatory {
  name: string;
  title: string;
}

export interface WorkloadFormModel {
  title: string;
  department: string;
  semesterHeading: string;
  /** "2025 - 2026" */
  academicYear: string;
  faculty: {
    name: string; yearsInService: string; status: string;
    qualification: string; major: string; eligibility: string; position: string;
  };
  sections: WorkloadFormSection[];
  summary: WorkloadFormSummaryRow[];
  signatures: {
    preparedBy: WorkloadFormSignatory;
    conformed: WorkloadFormSignatory;
    certifiedCorrect: WorkloadFormSignatory;
    recommending: [WorkloadFormSignatory, WorkloadFormSignatory];
    approved: WorkloadFormSignatory;
  };
  footer: { address: string; phone: string; website: string };
  /** The form's totals as numbers — what its No. of Units / Total No. of Units lines print:
   *  teaching units, units with deloading or Praise records, and hours. */
  totals?: { teachingUnits: number; units: number; hours: number };
}

const FONT = 'Arial';
const LAST_COL = 7;
/** TIME/DAY · Code · Description · Course · Units · Hours · Room (as the reference form) */
const COL_WIDTHS = [20, 12, 38, 12, 9.5, 10, 15];
/** Description length that wraps to a second line at the column width above */
const DESC_WRAP_CHARS = 40;
/** Summary label spans TIME/DAY + Subject Code, as on the printed form */
const SUMMARY_LABEL_COLS = 2;
/** Summary cells after the label follow the print form's Description, Course,
 *  Students, Units, Hours, Room — mapped to Excel columns (no Students column). */
const SUMMARY_COLS: (number | null)[] = [3, 4, null, 5, 6, 7];
/** Faculty details and two-column signature rows split after this column */
const HALF_SPLIT_COL = 3;

/** "2025 - 2026" → "2025–2026" */
const ayRange = (ay: string) => ay.replace(/\s*[-–]\s*/, '–');
/** Placeholder dashes print as blank */
const blankIfDash = (v: string) => (/^[\s\-—–]*$/.test(v) ? '' : v);
/* Colours of the printed form (frontend nemsuOfficialPrintChrome .wl CSS):
   white cells, black ink (every time label, filled or empty), #222 grid;
   no-room #444 italic */
const PRINT_BORDER = 'FF222222';
const PRINT_NO_ROOM = 'FF444444';
const THIN: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: PRINT_BORDER } };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const LOGO_PX = 60;
const widthToPx = (w: number) => Math.floor(w * 7 + 5);

/* Long bond page (8.5×13 in) minus margins, in points — used to push the
   official footer to the bottom of the printed page. */
const PAGE = { width: 8.5, height: 13, left: 0.45, right: 0.45, top: 0.4, bottom: 0.45 };
/** Visible height of each footer mark (frame grows to cover transparent padding) */
const FOOTER_MARK_PX = 32;
const FOOTER_LOGO_GAP_PX = 16;
/** Space between the Approved block and the footer rule */
const FOOTER_MIN_GAP_PT = 22;
const FOOTER_MAX_GAP_PT = 44;

type ImageInput = {
  buffer: ArrayBuffer | Uint8Array;
  extension: 'png' | 'jpeg';
  /** Share of the image height the mark actually fills (rest is transparent padding); default 1 */
  visibleHeight?: number;
};

/** Width / height of a PNG (IHDR); 1 when unknown. */
function imageRatio(img: ImageInput): number {
  const b = img.buffer instanceof Uint8Array ? img.buffer : new Uint8Array(img.buffer);
  if (img.extension !== 'png' || b.length < 24) return 1;
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const w = u32(16);
  const h = u32(20);
  return w > 0 && h > 0 ? w / h : 1;
}

const EMU_PER_PX = 9525;
const PT_TO_PX = 4 / 3;

/**
 * Exact image anchor (native col/row + EMU offsets) for a point `xPx` from the
 * sheet's left edge and `yPx` below the top of 1-based `row`. ExcelJS's own
 * fractional anchors assume ~10000 EMU per width unit, far off from Excel's
 * real column pixels, which misplaces images — so offsets are computed here.
 */
function exactAnchor(ws: ExcelJS.Worksheet, xPx: number, row: number, yPx: number): ExcelJS.Anchor {
  let left = Math.max(0, xPx);
  let col = 0;
  while (col < COL_WIDTHS.length - 1 && left >= widthToPx(COL_WIDTHS[col])) { left -= widthToPx(COL_WIDTHS[col]); col += 1; }
  let top = Math.max(0, yPx);
  let r = row;
  for (;;) {
    const h = (ws.getRow(r).height ?? 15) * PT_TO_PX;
    if (top < h || r >= ws.rowCount) break;
    top -= h;
    r += 1;
  }
  return {
    nativeCol: col, nativeColOff: Math.round(left * EMU_PER_PX),
    nativeRow: r - 1, nativeRowOff: Math.round(top * EMU_PER_PX),
  } as unknown as ExcelJS.Anchor;
}

/** The official Faculty Workload form as a formatted .xlsx (long bond, one page),
 *  ending with the official footer (contact lines + accreditation logos). */
export async function buildWorkloadFormWorkbook(
  m: WorkloadFormModel,
  logo?: ImageInput,
  footerLogos: ImageInput[] = [],
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Faculty Workload', {
    pageSetup: {
      paperSize: 14 as ExcelJS.PaperSize, // Folio / long bond 8.5×13
      orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1,
      margins: { left: PAGE.left, right: PAGE.right, top: PAGE.top, bottom: PAGE.bottom, header: 0.2, footer: 0.2 },
      horizontalCentered: true,
    },
  });
  ws.columns = COL_WIDTHS.map(width => ({ width }));
  const font = (extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT, size: 9, ...extra });

  function line(text: string, opts: {
    from?: number; to?: number; bold?: boolean; size?: number;
    align?: 'left' | 'center' | 'right'; row?: ExcelJS.Row; height?: number;
  } = {}): ExcelJS.Row {
    const row = opts.row ?? ws.addRow([]);
    const from = opts.from ?? 1;
    const to = opts.to ?? LAST_COL;
    if (to > from) ws.mergeCells(row.number, from, row.number, to);
    const cell = row.getCell(from);
    cell.value = text;
    cell.font = font({ bold: opts.bold, size: opts.size });
    cell.alignment = { horizontal: opts.align ?? 'center', vertical: 'middle', wrapText: true };
    if (opts.height) row.height = opts.height;
    return row;
  }
  const blank = (height = 8) => { const r = ws.addRow([]); r.height = height; return r; };
  const border = (row: ExcelJS.Row) => { for (let c = 1; c <= LAST_COL; c++) row.getCell(c).border = BORDER; };

  // ── Seal + header (same lines as the printed form) ────────────────────────
  if (logo) {
    const logoRow = ws.addRow([]);
    logoRow.height = LOGO_PX * 0.78;
    const totalPx = COL_WIDTHS.reduce((s, w) => s + widthToPx(w), 0);
    const imageId = wb.addImage({ buffer: logo.buffer as ExcelJS.Buffer, extension: logo.extension });
    ws.addImage(imageId, {
      tl: exactAnchor(ws, (totalPx - LOGO_PX) / 2, logoRow.number, 2),
      ext: { width: LOGO_PX, height: LOGO_PX },
    });
  }
  line('Republic of the Philippines', { size: 8 });
  line('North Eastern Mindanao State University', { bold: true, size: 10 });
  line(m.department, { bold: true, size: 12 });
  line(m.title, { bold: true, size: 10.5 });
  line(m.semesterHeading, { bold: true, size: 10.5 });
  line(`A.Y. ${ayRange(m.academicYear)}`, { size: 9 });
  blank(8);

  // ── Faculty details: two columns, label + value in one cell ───────────────
  const detail = (row: ExcelJS.Row, from: number, to: number, label: string, value: string, boldValue: boolean) => {
    ws.mergeCells(row.number, from, row.number, to);
    const cell = row.getCell(from);
    cell.value = {
      richText: [
        { text: `${label} `, font: font() as ExcelJS.Font },
        { text: blankIfDash(value), font: font({ bold: boldValue }) as ExcelJS.Font },
      ],
    };
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
  };
  const pairs: [string, string, boolean, string, string][] = [
    ['Name:', m.faculty.name, true, "Educt'l Qualification:", m.faculty.qualification],
    ['Years in Service:', m.faculty.yearsInService, false, 'Major:', m.faculty.major],
    ['Status:', m.faculty.status, true, 'Eligibility/PRC:', m.faculty.eligibility],
  ];
  for (const [l1, v1, b1, l2, v2] of pairs) {
    const row = ws.addRow([]);
    detail(row, 1, HALF_SPLIT_COL, l1, v1, b1);
    detail(row, HALF_SPLIT_COL + 1, LAST_COL, l2, v2, false);
    row.height = 14;
  }
  blank(4);

  // ── Workload table ────────────────────────────────────────────────────────
  const head = ws.addRow(['TIME/DAY', 'Subject\nCode', 'Description', 'Course', 'Units', 'No. of\nHours', 'Room No.']);
  head.eachCell(cell => {
    cell.font = font({ bold: true, size: 8.5 });
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  head.height = 26;
  border(head);
  ws.pageSetup.printTitlesRow = `${head.number}:${head.number}`;

  /* Same template as the printed form (the model is shared): every day-group
     section ("MW/Morning", "MW/Afternoon", …) with all its time rows. Classes
     fill their rows; empty template rows and empty sections stay, blank. */
  const DESC_COL = 3;
  const ROOM_COL = 7;
  for (const section of m.sections) {
    const sec = line(section.label, { bold: true, align: 'left', size: 9, height: 15 });
    sec.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    border(sec);
    for (const r of section.rows) {
      if (r.kind === 'blank') {
        // Empty time slot — same time text as a filled row; only the other cells stay empty
        const row = ws.addRow([r.time]);
        row.getCell(1).font = font({ size: 8.5 });
        row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
        row.height = 15;
        border(row);
        continue;
      }
      const values = r.kind === 'load'
        ? [r.time, r.code, r.description, r.course, r.units, r.hours, r.room.trim() || 'No room']
        : ['', r.code, r.description, '', r.units, r.hours, ''];
      const row = ws.addRow(values);
      for (let c = 1; c <= LAST_COL; c++) {
        const cell = row.getCell(c);
        cell.font = font({
          size: c === DESC_COL ? 9 : 8.5,
          bold: c === 2 || (c === DESC_COL && r.kind === 'load' && r.boldDescription),
          ...(c === ROOM_COL && r.kind === 'load' && !r.room.trim() ? { color: { argb: PRINT_NO_ROOM }, italic: true, size: 7 } : {}),
        });
        // Time stays on one line; Description wraps
        cell.alignment = {
          horizontal: c === DESC_COL ? 'left' : 'center', vertical: 'middle',
          wrapText: c !== 1, indent: c === DESC_COL ? 1 : 0,
        };
      }
      row.height = r.description.length > DESC_WRAP_CHARS ? 26 : 16;
      border(row);
    }
  }

  // ── Summary rows (label over TIME/DAY + Code; values as on the print form) ─
  for (const s of m.summary) {
    const row = ws.addRow([]);
    ws.mergeCells(row.number, 1, row.number, SUMMARY_LABEL_COLS);
    const [label, ...rest] = s.cells;
    row.getCell(1).value = label?.text ?? '';
    row.getCell(1).font = font({ bold: s.bold || label?.bold, size: 8.5 });
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    let logical = 0;
    for (const c of rest) {
      const span = Math.max(1, c.colspan ?? 1);
      const cols = SUMMARY_COLS.slice(logical, logical + span).filter((x): x is number => x != null);
      logical += span;
      if (cols.length === 0) continue;
      const from = cols[0];
      const to = cols[cols.length - 1];
      if (to > from) ws.mergeCells(row.number, from, row.number, to);
      const cell = row.getCell(from);
      cell.value = c.text ?? '';
      cell.font = font({ bold: s.bold || c.bold, size: 8.5 });
      cell.alignment = { horizontal: c.center ? 'center' : 'left', vertical: 'middle', wrapText: true };
    }
    row.height = 15;
    border(row);
  }

  // ── Signatures (same people and layout as the printed form) ───────────────
  const sg = m.signatures;
  blank(10);
  const lbl = line('Prepared by:', { to: HALF_SPLIT_COL,align: 'left', size: 8.5 });
  line('Conformed:', { row: lbl, from: HALF_SPLIT_COL + 1,align: 'left', size: 8.5 });
  blank(20);
  const nm = line(sg.preparedBy.name, { to: HALF_SPLIT_COL,bold: true, size: 8.5 });
  line(sg.conformed.name, { row: nm, from: HALF_SPLIT_COL + 1,bold: true, size: 8.5 });
  const tt = line(sg.preparedBy.title, { to: HALF_SPLIT_COL,size: 8 });
  line(sg.conformed.title, { row: tt, from: HALF_SPLIT_COL + 1,size: 8 });
  blank(12);
  line('Certified Correct:', { size: 8.5 });
  blank(20);
  line(sg.certifiedCorrect.name, { bold: true, size: 8.5 });
  line(sg.certifiedCorrect.title, { size: 8 });
  blank(12);
  line('Recommending Approval:', { align: 'left', size: 8.5 });
  blank(20);
  const rn = line(sg.recommending[0].name, { to: HALF_SPLIT_COL,bold: true, size: 8.5 });
  line(sg.recommending[1].name, { row: rn, from: HALF_SPLIT_COL + 1,bold: true, size: 8.5 });
  const rt = line(sg.recommending[0].title, { to: HALF_SPLIT_COL,size: 8 });
  line(sg.recommending[1].title, { row: rt, from: HALF_SPLIT_COL + 1,size: 8 });
  blank(12);
  line('Approved:', { size: 8.5 });
  blank(20);
  line(sg.approved.name, { bold: true, size: 8.5 });
  line(sg.approved.title, { size: 8 });

  // ── Official footer, pushed to the bottom of the page ─────────────────────
  const DEFAULT_ROW_PT = 15;
  const FOOTER_LINE_PT = 4;
  const FOOTER_TEXT_PT = 14;
  const footerPt = FOOTER_LINE_PT + FOOTER_TEXT_PT * 3;
  const sheetWidthPx = COL_WIDTHS.reduce((s, w) => s + widthToPx(w), 0);
  // Printed scale when fitting the columns to the page width (px → pt = 0.75)
  const scale = Math.min(1, ((PAGE.width - PAGE.left - PAGE.right) * 72) / (sheetWidthPx * 0.75));
  const pageHeightPt = ((PAGE.height - PAGE.top - PAGE.bottom) * 72) / scale;
  let usedPt = 0;
  for (let r = 1; r <= ws.rowCount; r++) usedPt += ws.getRow(r).height ?? DEFAULT_ROW_PT;
  // At least a clear gap after Approved; when the page is full, fit-to-page scales instead
  // A modest gap after Approved — reaches toward the page bottom, but never
  // opens a large empty band (fit-to-page scales down long forms instead)
  blank(Math.min(FOOTER_MAX_GAP_PT, Math.max(FOOTER_MIN_GAP_PT, Math.floor(pageHeightPt - usedPt - footerPt))));

  const rule = ws.addRow([]);
  rule.height = FOOTER_LINE_PT;
  for (let c = 1; c <= LAST_COL; c++) rule.getCell(c).border = { top: { style: 'thin', color: { argb: 'FF555555' } } };

  const contact: { text: string; link?: string }[] = [
    { text: `📍  ${m.footer.address}` },
    { text: `☎  ${m.footer.phone}` },
    { text: `🌐  ${m.footer.website}`, link: `https://${m.footer.website}` },
  ];
  const firstTextRow = ws.rowCount + 1;
  for (const c of contact) {
    const row = ws.addRow([]);
    row.height = FOOTER_TEXT_PT;
    ws.mergeCells(row.number, 1, row.number, HALF_SPLIT_COL);
    const cell = row.getCell(1);
    cell.value = c.link ? { text: c.text, hyperlink: c.link } : c.text;
    cell.font = font({ size: 8, color: c.link ? { argb: 'FF1D4ED8' } : undefined, underline: !!c.link });
    cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  }

  // Logos on the right, vertically centred on the three contact lines
  // Logos on the right: equal visible height, each centred on the three contact lines
  if (footerLogos.length > 0) {
    const textPx = FOOTER_TEXT_PT * 3 * PT_TO_PX;
    const frames = footerLogos.map(img => {
      const height = Math.round(Math.min(textPx, FOOTER_MARK_PX / Math.min(1, Math.max(0.2, img.visibleHeight ?? 1))));
      return { img, height, width: Math.round(height * imageRatio(img)) };
    });
    let x = sheetWidthPx - frames.reduce((s, f) => s + f.width, 0) - FOOTER_LOGO_GAP_PX * (frames.length - 1) - 4;
    for (const f of frames) {
      const id = wb.addImage({ buffer: f.img.buffer as ExcelJS.Buffer, extension: f.img.extension });
      ws.addImage(id, { tl: exactAnchor(ws, x, firstTextRow, (textPx - f.height) / 2), ext: { width: f.width, height: f.height } });
      x += f.width + FOOTER_LOGO_GAP_PX;
    }
  }
  ws.pageSetup.printArea = `A1:H${ws.rowCount}`;

  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
