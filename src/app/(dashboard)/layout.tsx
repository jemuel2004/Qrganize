import BodyResetEffect from '@/client/components/layout/BodyResetEffect';
import ErrorBoundary from '@/client/components/ui/ErrorBoundary';
import { ToastProvider } from '@/client/context/ToastContext';
import { SchoolYearProvider } from '@/client/context/SchoolYearContext';
import AdminShell from './AdminShell';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <SchoolYearProvider>
        <BodyResetEffect />
        <AdminShell>
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </AdminShell>
      </SchoolYearProvider>
    </ToastProvider>
  );
}
