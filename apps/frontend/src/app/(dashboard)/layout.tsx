import BodyResetEffect from '@/components/layout/BodyResetEffect';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import { ToastProvider } from '@/context/ToastContext';
import { SchoolYearProvider } from '@/context/SchoolYearContext';
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
