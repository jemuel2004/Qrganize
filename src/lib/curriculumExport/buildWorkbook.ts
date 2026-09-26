import ExcelJS from 'exceljs';
import {
  buildCurriculumExportSheet,
  type CurriculumExportInput,
} from './model';

export interface ExportLogo {
  buffer: Uint8Array;
  extension: 'png' | 'jpeg' | 'gif';
}

const FONT = 'Times New Roman';
const NAVY = '1E3A5F';
const LINE = '111827';
const HEADER_FILL = 'E8EEF4';
const TOTAL_FILL = 'F3F4F6';
const LAST_COL = 7;
/** Must stay in sync with `ws.columns` — used to center the seal across A:G. */
export const TABLE_COL_WIDTHS = [16, 44, 8, 8, 13, 24, 10];
const LOGO_PX = 72;
const THIN: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: `FF${LINE}` } };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };

function styleCells(
  row: ExcelJS.Row,
  start: number,
  end: number,
  apply: (cell: ExcelJS.Cell) => void,
) {
  for (let col = start; col <= end; col++) apply(row.getCell(col));
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Excel column-width → pixel approximation used by ExcelJS image anchors. */
export function excelWidthToPx(width: number): number {
  return Math.floor(width * 7 + 5);
}

/** 0-based `tl.col` so an image of `imagePx` sits in the middle of the given columns. */
export function centeredImageCol(colWidths: number[], imagePx: number): number {
  const pixels = colWidths.map(excelWidthToPx);
  const total = pixels.reduce((sum, px) => sum + px, 0);
  let remaining = Math.max(0, (total - imagePx) / 2);
  for (let index = 0; index < pixels.length; index++) {
    if (remaining <= pixels[index]) return index + remaining / pixels[index];
    remaining -= pixels[index];
  }
  return 0;
}

export async function buildCurriculumWorkbook(
  input: CurriculumExportInput,
  logo?: ExportLogo | null,
): Promise<Buffer> {
  const model = buildCurriculumExportSheet(input);
  const lastRow = model.lastRow;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'QRganize';
  wb.created = new Date();
  wb.modified = new Date();

  const ws = wb.addWorksheet(model.name, {
    properties: { defaultRowHeight: 16, dyDescent: 0.15 },
    views: [{ state: 'normal', showGridLines: false, zoomScale: 100, activeCell: 'A1' }],
    pageSetup: {
      paperSize: 5,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalDpi: 96,
      verticalDpi: 96,
      horizontalCentered: true,
      printArea: `A1:G${lastRow}`,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.25 },
    },
    headerFooter: {
      oddFooter: `&L${input.programName || 'Curriculum'}&CNorth Eastern Mindanao State University&RPage &P of &N`,
    },
  });

  ws.columns = TABLE_COL_WIDTHS.map(width => ({ width }));

  model.rows.forEach((row, index) => {
    const excelRow = ws.getRow(index + 1);
    row.values.forEach((value, col) => {
      if (value === '' || value == null) return;
      const cell = excelRow.getCell(col + 1);
      if (row.formulas?.[col]) {
        cell.value = { formula: row.formulas[col] as string, result: asNumber(value) };
        cell.numFmt = '0.00';
      } else if (row.kind === 'subject' && (col === 2 || col === 3 || col === 4)) {
        cell.value = asNumber(value);
        cell.numFmt = '0.00';
      } else if (row.kind === 'subject' && col === 0) {
        cell.value = String(value);
        cell.numFmt = '@';
      } else {
        cell.value = value;
      }
    });

    excelRow.font = { name: FONT, size: 10, color: { argb: 'FF111827' } };

    switch (row.kind) {
      case 'logo':
        excelRow.height = logo ? 32 : 6;
        styleCells(excelRow, 1, LAST_COL, cell => {
          cell.border = {};
          cell.fill = { type: 'pattern', pattern: 'none' };
          cell.value = null;
        });
        break;
      case 'republic':
        excelRow.height = 14;
        excelRow.font = { name: FONT, size: 9, italic: true, color: { argb: 'FF475569' } };
        excelRow.alignment = { horizontal: 'center', vertical: 'middle' };
        break;
      case 'university':
        excelRow.height = 22;
        excelRow.font = { name: FONT, size: 16, bold: true, color: { argb: `FF${NAVY}` } };
        excelRow.alignment = { horizontal: 'center', vertical: 'middle' };
        break;
      case 'program':
        excelRow.height = 18;
        excelRow.font = { name: FONT, size: 12, bold: true, color: { argb: `FF${NAVY}` } };
        excelRow.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        break;
      case 'version':
        excelRow.height = 16;
        excelRow.font = { name: FONT, size: 11, bold: true, color: { argb: 'FF334155' } };
        excelRow.alignment = { horizontal: 'center', vertical: 'middle' };
        break;
      case 'section':
        excelRow.height = 20;
        excelRow.font = { name: FONT, size: 12, bold: true, color: { argb: `FF${NAVY}` } };
        excelRow.alignment = { horizontal: 'left', vertical: 'middle' };
        break;
      case 'header1':
      case 'header2':
        excelRow.height = row.kind === 'header1' ? 18 : 16;
        excelRow.font = { name: FONT, size: 9, bold: true, color: { argb: `FF${NAVY}` } };
        styleCells(excelRow, 1, LAST_COL, cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${HEADER_FILL}` } };
          cell.border = BORDER;
          cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
          cell.font = { name: FONT, size: 9, bold: true, color: { argb: `FF${NAVY}` } };
        });
        break;
      case 'subject':
        excelRow.height = 18;
        styleCells(excelRow, 1, LAST_COL, cell => { cell.border = BORDER; });
        excelRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(2).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        excelRow.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(4).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(5).alignment = { horizontal: 'center', vertical: 'middle' };
        excelRow.getCell(6).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        excelRow.getCell(7).alignment = { horizontal: 'center', vertical: 'middle' };
        break;
      case 'total':
        excelRow.height = 18;
        excelRow.font = { name: FONT, size: 10, bold: true, color: { argb: `FF${NAVY}` } };
        styleCells(excelRow, 1, LAST_COL, cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${TOTAL_FILL}` } };
          cell.border = BORDER;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
          cell.font = { name: FONT, size: 10, bold: true, color: { argb: `FF${NAVY}` } };
        });
        excelRow.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
        break;
      case 'eval':
        excelRow.height = 18;
        excelRow.font = { name: FONT, size: 9, italic: true, color: { argb: 'FF475569' } };
        excelRow.alignment = { horizontal: 'left', vertical: 'middle' };
        break;
      case 'footer':
        excelRow.height = 16;
        excelRow.font = { name: FONT, size: 8, color: { argb: 'FF64748B' } };
        excelRow.alignment = { horizontal: 'center', vertical: 'middle' };
        break;
      default:
        excelRow.height = 10;
    }
  });

  for (const merge of model.merges) {
    if (merge.e.r >= lastRow || merge.e.c >= LAST_COL) continue;
    ws.mergeCells(merge.s.r + 1, merge.s.c + 1, merge.e.r + 1, merge.e.c + 1);
  }

  if (logo && logo.buffer.byteLength > 0 && logo.buffer.byteLength < 1_500_000) {
    const logoRows = model.rows
      .map((row, index) => (row.kind === 'logo' ? index : -1))
      .filter(index => index >= 0);
    const top = logoRows[0] ?? 0;
    const imageId = wb.addImage({
      buffer: Buffer.from(logo.buffer) as unknown as ExcelJS.Buffer,
      extension: logo.extension,
    });
    const col = centeredImageCol(TABLE_COL_WIDTHS, LOGO_PX);
    ws.addImage(imageId, {
      tl: { col, row: top + 0.18 },
      ext: { width: LOGO_PX, height: LOGO_PX },
      editAs: 'oneCell',
    });
  }

  ws.pageSetup.printArea = `A1:G${lastRow}`;
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
