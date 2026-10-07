import ExcelJS from 'exceljs';
import { addOfficialFooter, exactAnchor, gapToPageBottom, type FooterContact, type FooterLogo } from './excelFooter';

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
  /** Official footer — same contact lines as the printed page */
  footer: FooterContact;
  /** ISO-UKAS and Bagong Pilipinas marks for the footer (optional) */
  footerLogos?: FooterLogo[];
}

/* The printed Class Program (Class Program page → Print / PDF) as a sheet:
   same seal and header lines, block details, table, signatures and footer,
   black on white. Sizes are the print's × 1.3 because the sheet is fitted to
   the page width when printed (about 0.78×), so paper matches the print. */
const FONT = 'Arial';
const LAST_COL = 8;
/** TIME/DAY · Code · Description · Course · Units · Hours · Instructor · Room (print proportions) */
const COL_WIDTHS = [17, 11, 31, 12, 8, 9.5, 26, 15.5];
const HEADERS = ['TIME/DAY', 'Subject\nCode', 'Description', 'Course', 'Units', 'No. of\nHours', 'Instructor/Professor', 'Room No.'];
/** Left / right signature halves */
const LEFT_HALF: [number, number] = [1, 4];
const RIGHT_HALF: [number, number] = [5, LAST_COL];
const INK = 'FF000000';
const NO_ROOM = 'FF444444';
const THIN: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF222222' } };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const LOGO_PX = 80;
const widthToPx = (w: number) => Math.floor(w * 7 + 5);
/** Long bond, as the print (@page 8.5in 13in) */
const PAGE = { width: 8.5, height: 13, left: 0.4, right: 0.4, top: 0.45, bottom: 0.45 };
const FOOTER_MIN_GAP_PT = 22;
const FOOTER_MAX_GAP_PT = 60;
/** Description / instructor length that wraps to a second line at the widths above
 *  (checked in Excel: "Mathematics in the Modern World", 31 letters, needs two) */
const DESC_WRAP_CHARS = 27;
const INST_WRAP_CHARS = 25;

/**
 * Class Program as a formatted .xlsx laid out exactly like its printed page:
 * seal + header, Course/Year/Section and Program, the schedule by day (A.M.
 * rows, Lunch Break, P.M. rows), total units, pending subjects, signatures
 * and the official footer. Long bond, one page wide, headings repeated.
 */
export async function buildClassProgramWorkbook(input: ClassProgramExportInput): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Class Program', {
    pageSetup: {
      paperSize: 14 as ExcelJS.PaperSize, // Folio / long bond 8.5×13
      orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: PAGE.left, right: PAGE.right, top: PAGE.top, bottom: PAGE.bottom, header: 0.2, footer: 0.2 },
      horizontalCentered: true,
    },
    views: [{ showGridLines: false }],
  });
  ws.columns = COL_WIDTHS.map(width => ({ width }));

  const font = (extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT, size: 10.5, color: { argb: INK }, ...extra });

  /** One merged, aligned line across columns [from, to]. */
  function line(
    text: string,
    opts: {
      from?: number; to?: number; bold?: boolean; italic?: boolean; size?: number;
      align?: 'left' | 'center' | 'right'; row?: ExcelJS.Row; height?: number;
    } = {},
  ): ExcelJS.Row {
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
  const blank = (height = 8) => { const r = ws.addRow([]); r.height = height; return r; };
  const border = (row: ExcelJS.Row) => {
    for (let c = 1; c <= LAST_COL; c++) row.getCell(c).border = BORDER;
  };

  // ── Seal + header (the print's .hdr lines) ────────────────────────────────
  if (input.logo) {
    const logoRow = ws.addRow([]);
    logoRow.height = LOGO_PX * 0.75 + 4; // px → pt, plus a little air
    const totalPx = COL_WIDTHS.reduce((s, w) => s + widthToPx(w), 0);
    const imageId = wb.addImage({ buffer: input.logo.buffer as ExcelJS.Buffer, extension: input.logo.extension });
    ws.addImage(imageId, {
      tl: exactAnchor(ws, COL_WIDTHS, (totalPx - LOGO_PX) / 2, logoRow.number, 2),
      ext: { width: LOGO_PX, height: LOGO_PX },
    });
  }
  line('Republic of the Philippines', { size: 10.5, height: 15 });
  line('North Eastern Mindanao State University', { bold: true, size: 12.5, height: 17 });
  if (input.department) line(input.department, { bold: true, size: 15, height: 20 });
  line('CLASS PROGRAM', { bold: true, size: 13, height: 18 });
  line(input.semesterHeading, { bold: true, size: 13, height: 18 });
  line(`A.Y ${input.academicYear}`, { size: 11, height: 15 });
  blank(10);

  // ── Block details: label, then the value right after it ────────────────────
  const detail = (label: string, value: string, boldValue: boolean) => {
    const row = ws.addRow([]);
    ws.mergeCells(row.number, 1, row.number, LAST_COL);
    const cell = row.getCell(1);
    cell.value = {
      richText: [
        { text: `${label} `, font: font({ size: 11 }) as ExcelJS.Font },
        { text: value, font: font({ size: 11, bold: boldValue }) as ExcelJS.Font },
      ],
    };
    cell.alignment = { horizontal: 'left', vertical: 'middle' };
    row.height = 16;
  };
  detail('Course/Year/Section:', input.courseYearSection, true);
  detail('Program:', input.programName, false);
  blank(5);

  // ── Schedule table ────────────────────────────────────────────────────────
  const head = ws.addRow(HEADERS);
  head.eachCell(cell => {
    cell.font = font({ bold: true, size: 10 });
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  head.height = 28;
  border(head);
  // No freeze pane (it would also sit over the signatures); on paper the heading repeats per page
  ws.pageSetup.printTitlesRow = `${head.number}:${head.number}`;

  const dataRow = (r: ClassProgramExportRow) => {
    const noRoom = !r.room.trim() || r.room === 'No room assigned';
    const row = ws.addRow([r.time, r.code, r.description, r.course, r.units, r.hours, r.instructor, noRoom ? 'No room assigned' : r.room]);
    for (let c = 1; c <= LAST_COL; c++) {
      const cell = row.getCell(c);
      cell.font = font({
        size: c === 3 || c === 4 || c === 5 || c === 6 ? 10.5 : 10,
        bold: c === 2,
        ...(c === 8 && noRoom ? { italic: true, size: 9, color: { argb: NO_ROOM } } : {}),
      });
      // Description and instructor read left; everything else centred (as printed)
      cell.alignment = {
        horizontal: c === 3 || c === 7 ? 'left' : 'center', vertical: 'middle',
        wrapText: c !== 1 && c !== 4, indent: c === 3 || c === 7 ? 1 : 0,
      };
    }
    row.height = r.description.length > DESC_WRAP_CHARS || r.instructor.length > INST_WRAP_CHARS ? 28 : 17;
    border(row);
  };
  /** Day heading / Lunch Break: A.M. or P.M. in TIME/DAY, the text across the rest */
  const band = (left: string, rest: string, opts: { italic?: boolean; center?: boolean } = {}) => {
    const row = ws.addRow([left, rest]);
    ws.mergeCells(row.number, 2, row.number, LAST_COL);
    row.getCell(1).font = font({ bold: true, size: 11 });
    row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    row.getCell(2).font = font({ bold: true, italic: opts.italic, size: 11 });
    row.getCell(2).alignment = { horizontal: opts.center ? 'center' : 'left', vertical: 'middle', indent: opts.center ? 0 : 1 };
    row.height = 17;
    border(row);
  };
  const emptyRow = () => { const r = ws.addRow([]); r.height = 15; border(r); };

  if (input.dayGroups.length === 0) {
    const r = line('No subjects have been scheduled yet.', { size: 11, height: 26 });
    border(r);
  }
  for (const g of input.dayGroups) {
    band('A.M.', g.label);
    if (g.am.length) g.am.forEach(dataRow); else emptyRow();
    band('P.M.', 'Lunch Break', { italic: true, center: true });
    if (g.pm.length) g.pm.forEach(dataRow); else emptyRow();
  }

  const total = ws.addRow(['Total Number of Units', '', '', '', input.totalUnits, input.totalHours]);
  ws.mergeCells(total.number, 1, total.number, 4);
  ws.mergeCells(total.number, 7, total.number, LAST_COL);
  for (let c = 1; c <= LAST_COL; c++) total.getCell(c).font = font({ bold: true, size: 10.5 });
  total.getCell(1).alignment = { horizontal: 'right', vertical: 'middle', indent: 1 };
  total.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
  total.getCell(6).alignment = { horizontal: 'center', vertical: 'middle' };
  total.height = 18;
  border(total);

  // ── Pending / unscheduled (the print's second table) ──────────────────────
  if (input.unscheduled.length > 0) {
    blank(10);
    const title = line('Pending / Unscheduled Subjects', { bold: true, size: 11, align: 'left', height: 17 });
    title.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
    border(title);
    const h = ws.addRow(['Subject\nCode', 'Description', '', '', 'Units', 'Hours', 'Instructor/Professor', 'Status']);
    ws.mergeCells(h.number, 2, h.number, 4);
    h.eachCell(cell => {
      cell.font = font({ bold: true, size: 10 });
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    h.height = 28;
    border(h);
    for (const u of input.unscheduled) {
      const row = ws.addRow([u.code, u.description, '', '', u.units, u.hours, u.instructor, u.status]);
      ws.mergeCells(row.number, 2, row.number, 4);
      for (let c = 1; c <= LAST_COL; c++) {
        if (c === 3 || c === 4) continue; // inside the merged Description — styling them would restyle it
        const cell = row.getCell(c);
        cell.font = font({ bold: c === 1, size: 10 });
        cell.alignment = { horizontal: c === 2 || c === 7 ? 'left' : 'center', vertical: 'middle', wrapText: true, indent: c === 2 || c === 7 ? 1 : 0 };
      }
      row.height = u.description.length > 44 || u.instructor.length > INST_WRAP_CHARS ? 28 : 17;
      border(row);
    }
  }

  // ── Signatures (the print's .sig table) ───────────────────────────────────
  blank(14);
  const labels = line('Prepared by:', { from: LEFT_HALF[0], to: LEFT_HALF[1], align: 'left', size: 11, height: 16 });
  line('Recommending Approval:', { row: labels, from: RIGHT_HALF[0], to: RIGHT_HALF[1], align: 'left', size: 11 });
  blank(26);
  const names = line(input.preparedBy.name, { from: LEFT_HALF[0], to: LEFT_HALF[1], align: 'left', bold: true, size: 11, height: 16 });
  line(input.recommendedBy.name, { row: names, from: RIGHT_HALF[0], to: RIGHT_HALF[1], bold: true, size: 11 });
  const titles = line(input.preparedBy.designation, { from: LEFT_HALF[0], to: LEFT_HALF[1], align: 'left', size: 10.5, height: 15 });
  line(input.recommendedBy.designation, { row: titles, from: RIGHT_HALF[0], to: RIGHT_HALF[1], size: 10.5 });
  blank(18);
  line('Noted by:', { size: 11, height: 16 });
  blank(26);
  line(input.notedBy.name, { bold: true, size: 11, height: 16 });
  line(input.notedBy.designation, { size: 10.5, height: 15 });
  blank(18);
  line('Approved:', { size: 11, height: 16 });
  blank(26);
  line(input.approvedBy.name, { bold: true, size: 11, height: 16 });
  line(input.approvedBy.designation, { size: 10.5, height: 15 });

  // ── Official footer (Candara 10), at the bottom of the page ───────────────
  blank(gapToPageBottom(ws, COL_WIDTHS, PAGE, FOOTER_MIN_GAP_PT, FOOTER_MAX_GAP_PT));
  addOfficialFooter(wb, ws, { colWidths: COL_WIDTHS, textToCol: 3, contact: input.footer, logos: input.footerLogos });

  ws.pageSetup.printArea = `A1:H${ws.rowCount}`;
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
