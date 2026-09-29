/**
 * Stable segment wrapper — no enter animation.
 * Route skeletons + PageLoadTransition own loading visuals; stacking
 * qr-page-enter here caused redundant motion and layout jump.
 */
export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col min-w-0 w-full">
      {children}
    </div>
  );
}
