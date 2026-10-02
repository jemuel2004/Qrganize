'use client';

import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { resetScrollLocks } from '@/hooks/useScrollLock';

interface Props { children: React.ReactNode; }
interface State { caught: boolean; message: string; }

/** Tell System → Error Logs that this page crashed (best effort, never throws). */
function reportCrash(err: unknown, componentStack: string | null | undefined) {
  try {
    const error = err instanceof Error ? err : new Error(String(err));
    void fetch('/api/error-logs/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        page: window.location.pathname,
        message: error.message || error.name || 'Unknown error',
        stack: error.stack?.slice(0, 3000) ?? null,
        componentStack: componentStack?.slice(0, 1500) ?? null,
      }),
    }).catch(() => {});
  } catch {
    /* reporting is best effort */
  }
}

export default class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { caught: false, message: '' };
  }

  static getDerivedStateFromError(err: unknown): State {
    const message = err instanceof Error ? err.message : String(err);
    return { caught: true, message };
  }

  componentDidCatch(err: unknown, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', err, info.componentStack);
    reportCrash(err, info.componentStack);
    /* Safety reset — ensure no overlay styles are left on the body */
    if (typeof document !== 'undefined') {
      resetScrollLocks();
      document.body.style.pointerEvents = '';
    }
  }

  reset() {
    this.setState({ caught: false, message: '' });
    /* Also do a hard reload so stale UI is cleared */
    window.location.reload();
  }

  render() {
    if (this.state.caught) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center" role="alert">
          <div className="w-16 h-16 rounded-2xl bg-[#FEF2F2] border border-[#FECACA] flex items-center justify-center mb-5">
            <AlertTriangle className="w-8 h-8 text-[#DC2626]" />
          </div>
          <h2 className="text-xl font-bold text-[#0B2A5B] mb-2">Something went wrong</h2>
          <p className="text-[15px] text-[#475569] mb-1 max-w-md">
            This page stopped working. The problem was reported to the administrator.
          </p>
          {this.state.message ? (
            <p className="text-xs font-mono text-[#64748B] mb-6 max-w-md break-all">
              {this.state.message}
            </p>
          ) : <div className="mb-6" />}
          <button
            onClick={() => this.reset()}
            className="inline-flex items-center gap-2 bg-[#1D5BD6] hover:bg-[#164BB5] h-11 px-6 rounded-xl font-semibold text-[15px] transition-colors"
            style={{ color: '#FFFFFF' }}
          >
            <RefreshCw className="w-4 h-4" />
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
