import * as XLSX from 'xlsx';
import type { WorkloadSheetInput } from '@shared/workloadImport';

/** Form columns A–H; side notes further right are not read */
const LAST_COLUMN = 7;
const LAST_ROW = 149;

/**
 * Every worksheet as displayed text (A–H, first 150 rows). A merged area
 * keeps its text in its first cell only — the same as the sheet looks.
 */
export function readWorkloadWorkbook(filePath: string): WorkloadSheetInput[] {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const hidden = new Map((wb.Workbook?.Sheets ?? []).map(s => [s.name ?? '', !!s.Hidden]));
  return wb.SheetNames.map(name => {
    const ws = wb.Sheets[name];
    if (!ws?.['!ref']) return { name, hidden: hidden.get(name) ?? false, rows: [] };
    const range = XLSX.utils.decode_range(ws['!ref']);
    range.s = { r: 0, c: 0 };
    range.e = { r: Math.min(range.e.r, LAST_ROW), c: Math.min(range.e.c, LAST_COLUMN) };
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '', raw: false, blankrows: true, range });
    return { name, hidden: hidden.get(name) ?? false, rows };
  });
}
