/**
 * Same-origin session stash for the official workload print HTML.
 * Used by the dedicated printable route fallback — no instructor IDs in the URL.
 */

/** Which official workload form — Actual Load ('deload') is every schedule of the faculty on one form. */
export type WorkloadDocumentKind = 'regular' | 'overload' | 'praise' | 'deload';

const STORAGE_KEY = 'qrganize:workload-print-html:v1';
const MAX_AGE_MS = 15 * 60 * 1000;

type StoredPrintPayload = {
  html: string;
  savedAt: number;
  kind?: WorkloadDocumentKind;
};

export function storeWorkloadPrintHtml(
  html: string,
  kind?: WorkloadDocumentKind,
): void {
  if (typeof sessionStorage === 'undefined') return;
  const payload: StoredPrintPayload = {
    html,
    savedAt: Date.now(),
    kind,
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error('[workloadPrintStorage] Failed to stash print HTML:', e);
  }
}

/** Read and clear stored print HTML (one-shot). */
export function takeWorkloadPrintHtml(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPrintPayload;
    if (!parsed?.html || typeof parsed.html !== 'string') return null;
    if (Date.now() - (parsed.savedAt || 0) > MAX_AGE_MS) return null;
    return parsed.html;
  } catch {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Peek without clearing — useful before opening the printable route. */
export function peekWorkloadPrintHtml(): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as StoredPrintPayload;
    return Boolean(parsed?.html) && Date.now() - (parsed.savedAt || 0) <= MAX_AGE_MS;
  } catch {
    return false;
  }
}
