/**
 * Cross-browser print launcher for standalone HTML documents.
 *
 * Capability-based fallback (no device-brand branches):
 * 1. Popup / new window opened from the user gesture
 * 2. Same-origin hidden iframe + contentWindow.print()
 * 3. Dedicated printable route (sessionStorage HTML) or HTML download
 *
 * Call openBlankPrintWindow() synchronously inside the click handler before any await.
 */

import {
  storeWorkloadPrintHtml,
  peekWorkloadPrintHtml,
} from '@/lib/workloadPrintStorage';

export type OpenPrintHtmlResult = {
  ok: boolean;
  method?: 'window' | 'iframe' | 'printable_route' | 'download';
  /** UI should offer “Open Printable Version” (common when popup was blocked). */
  offerPrintableFallback: boolean;
  reason?: 'blocked' | 'print_unavailable';
};

const DEFAULT_FEATURES = 'width=860,height=1150';

function supportsWindowPrint(target: Window = window): boolean {
  try {
    return typeof target.print === 'function';
  } catch {
    return false;
  }
}

/** Prefer capability checks over UA brand detection. */
function isRestrictedEmbeddedBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  /* Known in-app browsers that often block popups and/or print() */
  return /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|WV\)/i.test(ua)
    || (/; wv\)/i.test(ua) && /Android/i.test(ua));
}

function waitForDocumentReady(target: Window): Promise<void> {
  const doc = target.document;
  const images = Array.from(doc.images);

  const imagesReady = Promise.all(
    images.map(
      img =>
        new Promise<void>(resolve => {
          if (img.complete) {
            resolve();
            return;
          }
          const done = () => resolve();
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }),
    ),
  );

  const fontsReady =
    doc.fonts && typeof doc.fonts.ready?.then === 'function'
      ? doc.fonts.ready.then(() => undefined).catch(() => undefined)
      : Promise.resolve();

  const timeout = new Promise<void>(resolve => {
    setTimeout(resolve, 2500);
  });

  return Promise.race([Promise.all([imagesReady, fontsReady]).then(() => undefined), timeout]).then(
    () => new Promise<void>(resolve => setTimeout(resolve, 50)),
  );
}

async function invokePrint(target: Window): Promise<boolean> {
  if (!supportsWindowPrint(target)) return false;
  try {
    await waitForDocumentReady(target);
    target.focus();
    target.print();
    return true;
  } catch (e) {
    console.error('[openPrintHtmlDocument] print() failed:', e);
    return false;
  }
}

function writeHtml(target: Window, html: string): boolean {
  try {
    target.document.open();
    target.document.write(html);
    target.document.close();
    return true;
  } catch (e) {
    console.error('[openPrintHtmlDocument] document.write failed:', e);
    return false;
  }
}

function downloadPrintHtml(html: string, filename: string): boolean {
  try {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  } catch (e) {
    console.error('[openPrintHtmlDocument] download failed:', e);
    return false;
  }
}

async function printViaIframe(html: string): Promise<OpenPrintHtmlResult> {
  if (!supportsWindowPrint()) {
    return {
      ok: false,
      reason: 'print_unavailable',
      offerPrintableFallback: true,
    };
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('title', 'Print document');
  /*
   * Full-viewport off-screen frame — more reliable than 1×1 on several Android
   * WebViews (including some Huawei/Samsung builds). Never use display:none.
   */
  iframe.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'width:100vw',
    'height:100vh',
    'border:0',
    'opacity:0',
    'pointer-events:none',
    'z-index:-1',
  ].join(';');

  document.body.appendChild(iframe);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    setTimeout(() => {
      try {
        iframe.remove();
      } catch {
        /* ignore */
      }
    }, 1500);
  };

  const win = iframe.contentWindow;
  const doc = iframe.contentDocument ?? win?.document;
  if (!win || !doc) {
    cleanup();
    return { ok: false, reason: 'blocked', offerPrintableFallback: true };
  }

  if (!writeHtml(win, html)) {
    cleanup();
    return { ok: false, reason: 'blocked', offerPrintableFallback: true };
  }

  try {
    win.onafterprint = cleanup;
  } catch {
    /* ignore */
  }
  setTimeout(cleanup, 60_000);

  const printed = await invokePrint(win);
  return {
    ok: printed,
    method: printed ? 'iframe' : undefined,
    reason: printed ? undefined : 'print_unavailable',
    /* Soft offer: iframe print often no-ops on restricted WebViews */
    offerPrintableFallback: true,
  };
}

function openPrintableRoute(path: string, preOpened: Window | null): boolean {
  if (!peekWorkloadPrintHtml() && typeof sessionStorage !== 'undefined') {
    /* Caller should have stored HTML already; still allow navigation. */
  }
  if (preOpened && !preOpened.closed) {
    try {
      preOpened.location.href = path;
      return true;
    } catch {
      /* fall through */
    }
  }
  try {
    const w = window.open(path, '_blank', 'noopener,noreferrer');
    if (w) return true;
  } catch {
    /* fall through */
  }
  /* Programmatic anchor — still requires a user gesture to avoid popup block */
  try {
    const a = document.createElement('a');
    a.href = path;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a blank print shell immediately (call first inside the click handler).
 */
export function openBlankPrintWindow(
  features: string = DEFAULT_FEATURES,
): Window | null {
  try {
    return window.open('', '_blank', features);
  } catch {
    return null;
  }
}

/**
 * Open the dedicated printable route using a fresh user gesture (fallback button).
 */
export function openWorkloadPrintableVersion(printablePath: string): boolean {
  if (!peekWorkloadPrintHtml()) {
    return false;
  }
  if (openPrintableRoute(printablePath, null)) {
    return true;
  }
  /* Same-tab navigation last — preserves access when popups are fully blocked */
  try {
    window.location.assign(printablePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param html Full HTML document string (existing official template output).
 */
export async function openPrintHtmlDocument(
  html: string,
  options?: {
    windowFeatures?: string;
    preOpenedWindow?: Window | null;
    /** Auth-gated printable page path, e.g. /workload/print */
    printablePath?: string;
    /** Optional filename if download fallback is used */
    downloadFilename?: string;
    documentKind?: 'regular' | 'overload' | 'praise';
  },
): Promise<OpenPrintHtmlResult> {
  const features = options?.windowFeatures ?? DEFAULT_FEATURES;
  const printablePath = options?.printablePath;
  const downloadFilename = options?.downloadFilename ?? 'workload-print.html';

  if (printablePath) {
    storeWorkloadPrintHtml(html, options?.documentKind);
  }

  let win: Window | null = options?.preOpenedWindow ?? null;
  if (!win) {
    try {
      win = window.open('', '_blank', features);
    } catch {
      win = null;
    }
  }

  /* 1) Popup / new window */
  if (win && !win.closed) {
    if (writeHtml(win, html)) {
      const printed = await invokePrint(win);
      return {
        ok: true,
        method: 'window',
        /*
         * Document remains open for browser-menu print even if print() was a
         * no-op — still offer dedicated route when embedded / print missing.
         */
        offerPrintableFallback: !printed || isRestrictedEmbeddedBrowser(),
      };
    }
    try {
      win.close();
    } catch {
      /* ignore */
    }
    win = null;
  }

  /* 2) Iframe print (skip when print API missing or heavily restricted WebView) */
  if (supportsWindowPrint() && !isRestrictedEmbeddedBrowser()) {
    const iframeResult = await printViaIframe(html);
    if (iframeResult.ok) {
      return iframeResult;
    }
  }

  /* 3) Dedicated printable route (normal page — most reliable on mobile) */
  if (printablePath) {
    const opened = openPrintableRoute(printablePath, null);
    if (opened) {
      return {
        ok: true,
        method: 'printable_route',
        offerPrintableFallback: false,
      };
    }
  }

  /* 4) Download printable HTML so the user can open it elsewhere */
  if (downloadPrintHtml(html, downloadFilename)) {
    return {
      ok: true,
      method: 'download',
      offerPrintableFallback: Boolean(printablePath),
    };
  }

  return {
    ok: false,
    reason: 'blocked',
    offerPrintableFallback: Boolean(printablePath),
  };
}
