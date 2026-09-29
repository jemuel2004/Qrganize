import ExcelJS from 'exceljs';

export interface ClassProgramSignatory {
  name: string;
  designation: string;
}

export interface ClassProgramExportRow {
  time: string;
  code: string;
  description: string;
  course: string;
  /** Blank on a subject's second+ time slot (units counted once). */
  units: number | '';
  hours: number;
  instructor: string;
  room: string;
}

export interface ClassProgramExportInput {
  department: string;
  campusLine: string;
  semesterHeading: string;
  academicYear: string;
  courseYearSection: string;
  programName: string;
  dayGroups: Array<{ label: string; am: ClassProgramExportRow[]; pm: ClassProgramExportRow[] }>;
  unscheduled: Array<{ code: string; description: string; units: number; hours: number; instructor: string; status: string }>;
  totalUnits: number;
  totalHours: number;
  preparedBy: ClassProgramSignatory;
  recommendedBy: ClassProgramSignatory;
  notedBy: ClassProgramSignatory;
  approvedBy: ClassProgramSignatory;
  /** NEMSU seal, centred above the header (optional) */
  logo?: { buffer: ArrayBuffer | Uint8Array; extension: 'png' | 'jpeg' };
}

const FONT = 'Calibri';
const LAST_COL = 8;
/** Must stay in sync with ws.columns — also used to centre the logo. */
const COL_WIDTHS = [15, 12, 34, 11, 8, 9, 26, 15];
const HEADERS = ['TIME/DAY', 'Subject Code', 'Description', 'Course', 'Units', 'No. of Hours', 'Instructor/Professor', 'Room No.'];
const THIN: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF1F2937' } };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const fill = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const HEADER_FILL = fill('FFDCE6F2');   // light blue — column headings
const BAND_FILL = fill('FFFFE699');     // yellow — day headings + Lunch Break (office format)
const TOTAL_FILL = fill('FFF2F2F2');    // light grey — totals
const NAVY = 'FF0B2A5B';
const LOGO_PX = 64;

/** Excel column width → pixels (what ExcelJS image anchors use). */
const widthToPx = (w: number) => Math.floor(w * 7 + 5);

/**
 * Class Program as a formatted .xlsx, laid out like the office's own sheet:
 * seal + header, block details, schedule by day (yellow day band, A.M. rows,
 * yellow Lunch Break band, P.M. rows), totals, pending subjects, signatures.
 * Prints on long bond (8.5×13), one page wide, headings repeated per page.
 */
export async function buildClassProgramWorkbook(input: ClassProgramExportInput): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Class Program', {
    pageSetup: {
      paperSize: 14 as ExcelJS.PaperSize, // Folio / long bond 8.5×13
      orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.45, bottom: 0.6, header: 0.25, footer: 0.3 },
      horizontalCentered: true,
    },
    // Footer: block on the left, page count on the right ('&' is Excel's code prefix, so double it)
    headerFooter: { oddFooter: `&L&8Class Program — ${input.courseYearSection.replace(/&/g, '&&')}&R&8Page &P of &N` },
    properties: { defaultRowHeight: 18 },
  });
  ws.columns = COL_WIDTHS.map(width => ({ width }));

  const font = (extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT, size: 11, ...extra });

  /** One merged, aligned line across columns [from, to]. */
  function line(
    text: string,
    opts: {
      from?: number; to?: number; bold?: boolean; italic?: boolean; size?: number; color?: string;
      align?: 'left' | 'center' | 'right'; row?: ExcelJS.Row; height?: number;
    } = {},
  ): ExcelJS.Row {
    const row = opts.row ?? ws.addRow([]);
    const from = opts.from ?? 1;
    const to = opts.to ?? LAST_COL;
    if (to > from) ws.mergeCells(row.number, from, row.number, to);
    const cell = row.getCell(from);
    cell.value = text;
    cell.font = font({ bold: opts.bold, italic: opts.italic, size: opts.size, color: opts.color ? { argb: opts.color } : undefined });
    cell.alignment = { horizontal: opts.align ?? 'center', vertical: 'middle', wrapText: true };
    if (opts.height) row.height = opts.height;
    return row;
  }
  const blank = (height = 8) => { const r = ws.addRow([]); r.height = height; return r; };
  const border = (row: ExcelJS.Row) => {
    for (let c = 1; c <= LAST_COL; c++) row.getCell(c).border = BORDER;
  };
  const paint = (row: ExcelJS.Row, f: ExcelJS.Fill) => {
    for (let c = 1; c <= LAST_COL; c++) row.getCell(c).fill = f;
  };

  // ── Seal ──────────────────────────────────────────────────────────────────
  if (input.logo) {
    const logoRow = ws.addRow([]);
    logoRow.height = LOGO_PX * 0.78; // points
    const totalPx = COL_WIDTHS.reduce((s, w) => s + widthToPx(w), 0);
    let leftPx = (totalPx - LOGO_PX) / 2;
    let col = 0;
    while (col < COL_WIDTHS.length && leftPx > widthToPx(COL_WIDTHS[col])) {
      leftPx -= widthToPx(COL_WIDTHS[col]);
      col += 1;
    }
    const imageId = wb.addImage({ buffer: input.logo.buffer as ExcelJS.Buffer, extension: input.logo.extension });
    ws.addImage(imageId, {
      tl: { col: col + leftPx / widthToPx(COL_WIDTHS[col] ?? 10), row: logoRow.number - 1 + 0.05 },
      ext: { width: LOGO_PX, height: LOGO_PX },
    });
  }

  // ── Header ────────────────────────────────────────────────────────────────
  line('Republic of the Philippines', { size: 10 });
  line('North Eastern Mindanao State University', { bold: true, size: 12, color: NAVY });
  if (input.department) line(input.department, { bold: true, size: 12 });
  if (input.campusLine) line(input.campusLine, { size: 10, italic: true });
  blank(6);
  line('CLASS PROGRAM', { bold: true, size: 15, color: NAVY, height: 22 });
  line(input.semesterHeading, { bold: true, size: 12 });
  line(`A.Y. ${input.academicYear}`, { size: 11 });
  blank(10);

  // ── Block details: label and value in one cell, value right after the label ──
  const detail = (label: string, value: string, boldValue: boolean) => {
    const row = ws.addRow([]);
    ws.mergeCells(row.number, 1, row.number, LAST_COL);
    const cell = row.getCell(1);
    cell.value = {
      richText: [
        { text: `${label} `, font: font({ bold: true }) as ExcelJS.Font },
        { text: value, font: font({ bold: boldValue, color: boldValue ? { argb: NAVY } : undefined }) as ExcelJS.Font },
      ],
    };
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
    row.height = 18;
  };
  detail('Course/Year/Section:', input.courseYearSection, true);
  detail('Program:', input.programName, false);
  blank(8);

  // ── Schedule table ────────────────────────────────────────────────────────
  const head = ws.addRow(HEADERS);
  head.eachCell(cell => {
    cell.font = font({ bold: true, size: 10.5 });
    cell.fill = HEADER_FILL;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  head.height = 32;
  border(head);
  // No freeze pane: Excel/WPS freezes are sheet-wide, so a frozen heading would
  // also sit over the signatures. On paper the heading repeats on every page.
  ws.pageSetup.printTitlesRow = `${head.number}:${head.number}`;

  const dataRow = (r: ClassProgramExportRow) => {
    const row = ws.addRow([r.time, r.code, r.description, r.course, r.units, r.hours, r.instructor, r.room]);
    for (let c = 1; c <= LAST_COL; c++) {
      const cell = row.getCell(c);
      cell.font = font({ bold: c === 2, size: 10.5, italic: c === 8 && r.room === 'No room assigned', color: c === 8 && r.room === 'No room assigned' ? { argb: 'FF6B7280' } : undefined });
      cell.alignment = { horizontal: c === 3 || c === 7 ? 'left' : 'center', vertical: 'middle', wrapText: true, indent: c === 3 || c === 7 ? 1 : 0 };
    }
    // Room for two wrapped lines when the title is long
    row.height = r.description.length > 34 || r.instructor.length > 26 ? 30 : 20;
    border(row);
  };
  /** Yellow band: A.M. / P.M. in column A, day name or Lunch Break across the rest. */
  const band = (left: string, rest: string, opts: { italic?: boolean } = {}) => {
    const row = ws.addRow([left, rest]);
    ws.mergeCells(row.number, 2, row.number, LAST_COL);
    row.getCell(1).font = font({ bold: true });
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    row.getCell(2).font = font({ bold: true, italic: opts.italic });
    row.getCell(2).alignment = { horizontal: 'center', vertical: 'middle' };
    row.height = 19;
    paint(row, BAND_FILL);
    border(row);
  };
  const emptyRow = () => { const r = ws.addRow([]); r.height = 16; border(r); };

  if (input.dayGroups.length === 0) {
    const r = line('No subjects have been scheduled yet.', { italic: true, height: 24 });
    border(r);
  }
  for (const g of input.dayGroups) {
    band('A.M.', g.label);
    if (g.am.length) g.am.forEach(dataRow); else emptyRow();
    band('P.M.', 'Lunch Break', { italic: true });
    if (g.pm.length) g.pm.forEach(dataRow); else emptyRow();
  }

  const total = ws.addRow(['Total Number of Units', '', '', '', input.totalUnits, input.totalHours]);
  ws.mergeCells(total.number, 1, total.number, 4);
  total.getCell(1).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
  for (let c = 1; c <= LAST_COL; c++) total.getCell(c).font = font({ bold: true });
  total.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
  total.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
  total.height = 21;
  paint(total, TOTAL_FILL);
  border(total);
  for (let c = 1; c <= LAST_COL; c++) {
    total.getCell(c).border = { ...BORDER, top: { style: 'double', color: { argb: 'FF1F2937' } } };
  }

  // ── Pending / unscheduled ─────────────────────────────────────────────────
  if (input.unscheduled.length > 0) {
    blank(12);
    const title = line('Pending / Unscheduled Subjects', { bold: true, align: 'left', height: 20 });
    paint(title, TOTAL_FILL);
    border(title);
    const h = ws.addRow(['Subject Code', 'Description', '', '', 'Units', 'No. of Hours', 'Instructor/Professor', 'Status']);
    ws.mergeCells(h.number, 2, h.number, 4);
    h.eachCell(cell => {
      cell.font = font({ bold: true, size: 10.5 });
      cell.fill = HEADER_FILL;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    h.height = 28;
    border(h);
    for (const u of input.unscheduled) {
      const row = ws.addRow([u.code, u.description, '', '', u.units, u.hours, u.instructor, u.status]);
      ws.mergeCells(row.number, 2, row.number, 4);
      for (let c = 1; c <= LAST_COL; c++) {
        const cell = row.getCell(c);
        cell.font = font({ bold: c === 1, size: 10.5 });
        cell.alignment = { horizontal: c === 2 || c === 7 ? 'left' : 'center', vertical: 'middle', wrapText: true, indent: c === 2 || c === 7 ? 1 : 0 };
      }
      row.height = 20;
      border(row);
    }
  }

  // ── Signatures (matches the office's signed form) ─────────────────────────
  blank(18);
  const labels = line('Prepared by:', { to: 3, align: 'left' });
  line('Recommending Approval:', { row: labels, from: 5, align: 'left' });
  blank(22);
  const names = line(input.preparedBy.name, { to: 3, align: 'left', bold: true });
  line(input.recommendedBy.name, { row: names, from: 5, align: 'center', bold: true });
  const titles = line(input.preparedBy.designation, { to: 3, align: 'left' });
  line(input.recommendedBy.designation, { row: titles, from: 5, align: 'center' });
  blank(16);
  line('Noted by:');
  blank(22);
  line(input.notedBy.name, { bold: true });
  line(input.notedBy.designation);
  blank(16);
  line('Approved:');
  blank(22);
  line(input.approvedBy.name, { bold: true });
  line(input.approvedBy.designation);

  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
