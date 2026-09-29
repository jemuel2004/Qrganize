'use client';

import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { resetScrollLocks } from '@/hooks/useScrollLock';

interface Props { children: React.ReactNode; }
interface State { caught: boolean; message: string; }

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
        <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center">
          <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-5">
            <AlertTriangle className="w-8 h-8 text-red-400" />
          </div>
          <h2 className="text-xl font-bold text-white mb-2">Something went wrong</h2>
          <p className="text-sm text-slate-400 mb-1 max-w-md">
            An unexpected error occurred. The page may have stopped responding.
          </p>
          {this.state.message ? (
            <p className="text-xs font-mono text-slate-600 mb-6 max-w-md break-all">
              {this.state.message}
            </p>
          ) : null}
          <button
            onClick={() => this.reset()}
            className="inline-flex items-center gap-2 bg-[#1D5BD6] hover:bg-[#2E7DD1] text-white px-5 py-2.5 rounded-xl font-semibold text-sm transition-colors"
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
