import ExcelJS from 'exceljs';
import { pageFooter } from './excelFooter';

/*
 * Room QR codes as a formatted .xlsx — one row per room with its QR image,
 * ready to print or keep on file. Used by QR Generator and Reports.
 */

export interface RoomQrRow {
  room_name: string;
  room_type: string;
  building: string | null;
  capacity: number | null;
  qr_code_id: string | null;
  /** PNG data URL of the QR (as stored for the room) */
  qr_data_url: string;
}

const FONT = 'Arial';
const COL_WIDTHS = [22, 14, 14, 10, 30, 18]; // Room · Type · Building · Capacity · QR ID · QR Code
const QR_PX = 110;
const EMU_PER_PX = 9525;
const THIN: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FF222222' } };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };

export async function buildRoomQrWorkbook(rows: RoomQrRow[], title = 'Room QR Codes'): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Room QR Codes', {
    pageSetup: {
      paperSize: 9 as ExcelJS.PaperSize, // A4
      orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      horizontalCentered: true,
    },
    // Candara 10 page footer, like every exported sheet
    headerFooter: { oddFooter: pageFooter(`${title} — North Eastern Mindanao State University`) },
  });
  ws.columns = COL_WIDTHS.map(width => ({ width }));
  const last = COL_WIDTHS.length;
  const font = (extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT, size: 10, ...extra });

  const heading = (text: string, size: number, bold = true) => {
    const r = ws.addRow([text]);
    ws.mergeCells(r.number, 1, r.number, last);
    r.getCell(1).font = font({ size, bold, color: { argb: 'FF0B2A5B' } });
    r.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    r.height = size + 8;
  };
  heading('North Eastern Mindanao State University', 11);
  heading(title, 14);
  ws.addRow([]).height = 6;

  const head = ws.addRow(['Room', 'Type', 'Building', 'Capacity', 'QR ID', 'QR Code']);
  head.eachCell(c => {
    c.font = font({ bold: true, color: { argb: 'FF0B2A5B' } });
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF9' } };
    c.border = BORDER;
  });
  head.height = 20;
  ws.pageSetup.printTitlesRow = `${head.number}:${head.number}`;

  const qrColPx = Math.floor(COL_WIDTHS[last - 1] * 7 + 5);
  for (const r of rows) {
    const row = ws.addRow([r.room_name, r.room_type, r.building ?? '', r.capacity ?? '', r.qr_code_id ?? '', '']);
    row.height = (QR_PX + 12) * 0.75; // px → pt
    row.eachCell({ includeEmpty: true }, (c, n) => {
      if (n > last) return;
      c.font = font({ bold: n === 1, size: n === 5 ? 8 : 10 });
      c.alignment = { horizontal: n === 1 ? 'left' : 'center', vertical: 'middle', wrapText: true, indent: n === 1 ? 1 : 0 };
      c.border = BORDER;
    });
    const base64 = r.qr_data_url.includes(',') ? r.qr_data_url.split(',')[1] : r.qr_data_url;
    const id = wb.addImage({ base64, extension: 'png' });
    // Exact anchor (ExcelJS's fractional anchors misplace images) — centred in the QR cell
    ws.addImage(id, {
      tl: {
        nativeCol: last - 1, nativeColOff: Math.max(0, Math.round(((qrColPx - QR_PX) / 2) * EMU_PER_PX)),
        nativeRow: row.number - 1, nativeRowOff: 6 * EMU_PER_PX,
      } as unknown as ExcelJS.Anchor,
      ext: { width: QR_PX, height: QR_PX },
    });
  }

  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
