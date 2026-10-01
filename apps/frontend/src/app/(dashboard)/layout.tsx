import BodyResetEffect from '@/components/layout/BodyResetEffect';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import { ToastProvider } from '@/context/ToastContext';
import { SchoolYearProvider } from '@/context/SchoolYearContext';
import { RealtimeProvider } from '@/context/RealtimeContext';
import AdminShell from './AdminShell';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      {/* Live updates: pages re-fetch when data they show changes elsewhere */}
      <RealtimeProvider>
        <SchoolYearProvider>
          <BodyResetEffect />
          <AdminShell>
            <ErrorBoundary>
              {children}
            </ErrorBoundary>
          </AdminShell>
        </SchoolYearProvider>
      </RealtimeProvider>
    </ToastProvider>
  );
}
