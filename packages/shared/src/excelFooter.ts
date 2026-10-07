import ExcelJS from 'exceljs';

/*
 * The footer of every exported Excel sheet, in one place — Candara 10.
 *
 * Official forms (Faculty Workload, Class Program) end with the NEMSU footer
 * as on the printed page: a rule, the three contact lines on the left and the
 * accreditation logos on the right. The other sheets print a page footer
 * (document name · Page X of N) at the bottom of every page.
 */

export const FOOTER_FONT = { name: 'Candara', size: 10 } as const;

/** Excel header/footer code for Candara 10 */
const PAGE_FOOTER_FONT = '&"Candara,Regular"&10';

/** Page footer printed on every page: document name on the left, page count on the right. */
export function pageFooter(left: string, opts: { center?: string; pageNumbers?: boolean } = {}): string {
  const esc = (s: string) => s.replace(/&/g, '&&'); // '&' starts an Excel code
  let out = `&L${PAGE_FOOTER_FONT}${esc(left)}`;
  if (opts.center) out += `&C${PAGE_FOOTER_FONT}${esc(opts.center)}`;
  if (opts.pageNumbers !== false) out += `&R${PAGE_FOOTER_FONT}Page &P of &N`;
  return out;
}

export interface FooterContact { address: string; phone: string; website: string }

export interface FooterLogo {
  buffer: ArrayBuffer | Uint8Array;
  extension: 'png' | 'jpeg';
  /** Share of the image height the mark actually fills (the rest is transparent padding); default 1 */
  visibleHeight?: number;
}

/** Long bond page and margins, in inches */
export interface PageBox { width: number; height: number; left: number; right: number; top: number; bottom: number }

const EMU_PER_PX = 9525;
const PT_TO_PX = 4 / 3;
const DEFAULT_ROW_PT = 15;
const widthToPx = (w: number) => Math.floor(w * 7 + 5);

/** Height of the rule row and of each contact line (pt) */
const RULE_PT = 6;
const LINE_PT = 16;
/** Whole footer height (pt): rule + three contact lines */
export const OFFICIAL_FOOTER_PT = RULE_PT + LINE_PT * 3;
/** Visible height of each logo mark (px) — the frame grows to cover transparent padding */
const MARK_PX = 36;
const LOGO_GAP_PX = 18;

/** Width / height of a PNG (IHDR); 1 when unknown. */
function imageRatio(img: FooterLogo): number {
  const b = img.buffer instanceof Uint8Array ? img.buffer : new Uint8Array(img.buffer);
  if (img.extension !== 'png' || b.length < 24) return 1;
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const w = u32(16);
  const h = u32(20);
  return w > 0 && h > 0 ? w / h : 1;
}

/**
 * Exact image anchor (native col/row + EMU offsets) for a point `xPx` from the
 * sheet's left edge and `yPx` below the top of 1-based `row`. ExcelJS's own
 * fractional anchors misplace images, so the offsets are computed here.
 */
export function exactAnchor(ws: ExcelJS.Worksheet, colWidths: number[], xPx: number, row: number, yPx: number): ExcelJS.Anchor {
  let left = Math.max(0, xPx);
  let col = 0;
  while (col < colWidths.length - 1 && left >= widthToPx(colWidths[col])) { left -= widthToPx(colWidths[col]); col += 1; }
  let top = Math.max(0, yPx);
  let r = row;
  for (;;) {
    const h = (ws.getRow(r).height ?? DEFAULT_ROW_PT) * PT_TO_PX;
    if (top < h || r >= ws.rowCount) break;
    top -= h;
    r += 1;
  }
  return {
    nativeCol: col, nativeColOff: Math.round(left * EMU_PER_PX),
    nativeRow: r - 1, nativeRowOff: Math.round(top * EMU_PER_PX),
  } as unknown as ExcelJS.Anchor;
}

/**
 * Space (pt) to leave before the footer so it lands at the bottom of a
 * one-page sheet printed fitted to the page width — clamped, so a full page
 * keeps a small gap (fit-to-page scales long sheets instead).
 */
export function gapToPageBottom(ws: ExcelJS.Worksheet, colWidths: number[], page: PageBox, minPt: number, maxPt: number): number {
  const sheetWidthPx = colWidths.reduce((s, w) => s + widthToPx(w), 0);
  // Printed scale when the columns are fitted to the page width (px → pt = 0.75)
  const scale = Math.min(1, ((page.width - page.left - page.right) * 72) / (sheetWidthPx * 0.75));
  const pageHeightPt = ((page.height - page.top - page.bottom) * 72) / scale;
  let usedPt = 0;
  for (let r = 1; r <= ws.rowCount; r++) usedPt += ws.getRow(r).height ?? DEFAULT_ROW_PT;
  return Math.min(maxPt, Math.max(minPt, Math.floor(pageHeightPt - usedPt - OFFICIAL_FOOTER_PT)));
}

/**
 * The official NEMSU footer at the end of a sheet: a thin rule across the
 * page, the address / phone / website on the left (Candara 10, one per line,
 * website as a link) and the logos on the right, each centred on the lines.
 */
export function addOfficialFooter(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  opts: {
    colWidths: number[];
    /** The contact lines span columns 1…textToCol */
    textToCol: number;
    contact: FooterContact;
    logos?: FooterLogo[];
  },
): void {
  const lastCol = opts.colWidths.length;
  const rule = ws.addRow([]);
  rule.height = RULE_PT;
  for (let c = 1; c <= lastCol; c++) rule.getCell(c).border = { top: { style: 'thin', color: { argb: 'FF555555' } } };

  const lines: { text: string; link?: string }[] = [
    { text: `📍  ${opts.contact.address}` },
    { text: `☎  ${opts.contact.phone}` },
    { text: `🌐  ${opts.contact.website}`, link: `https://${opts.contact.website}` },
  ];
  const firstLine = ws.rowCount + 1;
  for (const l of lines) {
    const row = ws.addRow([]);
    row.height = LINE_PT;
    ws.mergeCells(row.number, 1, row.number, opts.textToCol);
    const cell = row.getCell(1);
    cell.value = l.link ? { text: l.text, hyperlink: l.link } : l.text;
    cell.font = { ...FOOTER_FONT, color: { argb: l.link ? 'FF0000EE' : 'FF111111' }, underline: !!l.link };
    cell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  }

  const logos = opts.logos ?? [];
  if (logos.length === 0) return;
  // Every mark the same visible height, centred on the three lines, flush right
  const textPx = LINE_PT * 3 * PT_TO_PX;
  const frames = logos.map(img => {
    const height = Math.round(Math.min(textPx, MARK_PX / Math.min(1, Math.max(0.2, img.visibleHeight ?? 1))));
    return { img, height, width: Math.round(height * imageRatio(img)) };
  });
  const sheetWidthPx = opts.colWidths.reduce((s, w) => s + widthToPx(w), 0);
  let x = sheetWidthPx - frames.reduce((s, f) => s + f.width, 0) - LOGO_GAP_PX * (frames.length - 1) - 6;
  for (const f of frames) {
    const id = wb.addImage({ buffer: f.img.buffer as ExcelJS.Buffer, extension: f.img.extension });
    ws.addImage(id, {
      tl: exactAnchor(ws, opts.colWidths, x, firstLine, (textPx - f.height) / 2),
      ext: { width: f.width, height: f.height },
    });
    x += f.width + LOGO_GAP_PX;
  }
}
