'use client';

import { useEffect, useRef, useState } from 'react';
import { Printer, ArrowLeft, AlertTriangle } from 'lucide-react';
import { takeWorkloadPrintHtml } from '@/lib/workloadPrintStorage';

/**
 * Dedicated printable document viewer.
 * Renders the official HTML (from sessionStorage) in a same-origin iframe
 * and exposes a simple Print control — used when popup/iframe launch fails.
 */
export default function WorkloadPrintFallbackClient({
  backHref,
  backLabel = 'Back to Workload',
}: {
  backHref: string;
  backLabel?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    const stored = takeWorkloadPrintHtml();
    if (!stored) {
      setMissing(true);
      return;
    }
    setHtml(stored);
  }, []);

  async function handlePrint() {
    const win = iframeRef.current?.contentWindow;
    if (!win || typeof win.print !== 'function') {
      window.alert(
        'This browser does not expose a print dialog. Use your browser menu (Share → Print) or open this page in Chrome or Safari.',
      );
      return;
    }
    setPrinting(true);
    try {
      const doc = win.document;
      const images = Array.from(doc.images);
      await Promise.race([
        Promise.all(
          images.map(
            img =>
              new Promise<void>(resolve => {
                if (img.complete) resolve();
                else {
                  img.addEventListener('load', () => resolve(), { once: true });
                  img.addEventListener('error', () => resolve(), { once: true });
                }
              }),
          ),
        ),
        new Promise<void>(r => setTimeout(r, 2500)),
      ]);
      if (doc.fonts?.ready) {
        await Promise.race([
          doc.fonts.ready.then(() => undefined).catch(() => undefined),
          new Promise<void>(r => setTimeout(r, 1000)),
        ]);
      }
      win.focus();
      win.print();
    } catch {
      window.alert(
        'Unable to open the print dialog. Use your browser menu to print, or open this page in Chrome or Safari.',
      );
    } finally {
      setPrinting(false);
    }
  }

  if (missing) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <div className="flex items-start gap-3 text-amber-700">
            <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <h1 className="text-base font-semibold text-slate-900">Printable document unavailable</h1>
              <p className="text-sm text-slate-600 mt-2 leading-relaxed">
                No print document was found for this session. Return to Workload and tap Print again.
              </p>
            </div>
          </div>
          <a
            href={backHref}
            className="mt-5 inline-flex items-center justify-center gap-2 w-full min-h-11 rounded-xl bg-slate-900 text-white text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            {backLabel}
          </a>
        </div>
      </div>
    );
  }

  if (!html) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center text-sm text-slate-600">
        Preparing printable document…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-200 flex flex-col workload-print-fallback">
      <div className="workload-print-fallback-chrome sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 bg-slate-900 text-white shadow">
        <a
          href={backHref}
          className="inline-flex items-center gap-1.5 text-sm text-slate-200 hover:text-white min-h-10 px-2"
        >
          <ArrowLeft className="w-4 h-4" />
          {backLabel}
        </a>
        <button
          type="button"
          onClick={handlePrint}
          disabled={printing}
          className="inline-flex items-center justify-center gap-2 min-h-11 px-4 rounded-xl bg-white text-slate-900 text-sm font-semibold disabled:opacity-60"
        >
          <Printer className="w-4 h-4" />
          Print
        </button>
      </div>
      <p className="workload-print-fallback-chrome text-center text-xs text-slate-600 px-3 py-2 bg-slate-100 border-b border-slate-200">
        If the print dialog does not open, use your browser menu → Print, or open this page in Chrome / Safari.
      </p>
      <iframe
        ref={iframeRef}
        title="Workload printable document"
        srcDoc={html}
        className="flex-1 w-full bg-white border-0 min-h-[calc(100vh-6.5rem)]"
      />
    </div>
  );
}
