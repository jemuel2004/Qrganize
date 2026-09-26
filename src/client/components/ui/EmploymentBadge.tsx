/*
 * Permanent vs Contractual faculty colors — backed by the --permanent /
 * --contractual tokens in globals.css (brand blue / slate) so both themes stay
 * in sync. Color is keyed off the stored `employment_status`, so Temporary
 * Permanent staff (stored as Contractual, hour-based) read as Contractual.
 */

export type EmploymentStatus = 'Permanent' | 'Contractual';

export const EMPLOYMENT_COLORS: Record<EmploymentStatus, { fg: string; bg: string }> = {
  Permanent:   { fg: 'var(--permanent)',   bg: 'var(--permanent-bg)' },
  Contractual: { fg: 'var(--contractual)', bg: 'var(--contractual-bg)' },
};

export function employmentColors(status: string | null | undefined) {
  return status === 'Permanent' ? EMPLOYMENT_COLORS.Permanent : EMPLOYMENT_COLORS.Contractual;
}

export function EmploymentBadge({
  status,
  label,
  className = '',
}: {
  status: string | null | undefined;
  /** Text to show instead of the status itself (e.g. the position). */
  label?: string;
  className?: string;
}) {
  const isPermanent = status === 'Permanent';
  const { fg, bg } = employmentColors(status);
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border whitespace-nowrap ${className}`}
      style={{ color: fg, backgroundColor: bg, borderColor: `color-mix(in srgb, ${fg} 35%, transparent)` }}
    >
      {label ?? (isPermanent ? 'Permanent' : 'Contractual')}
    </span>
  );
}
