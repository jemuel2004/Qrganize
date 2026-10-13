import { watermarkFont } from '@/lib/fonts';

/**
 * Large, faded, centered page title with thin fading rules on each side —
 * reads like a watermark behind the page content. Still a real <h1> for
 * screen readers and page structure.
 */
/** Full strength: navy in light mode, near-white in dark (`!` so it beats the watermark rule in globals.css) */
const STRONG =
  'opacity-100! [html.light_&]:bg-[linear-gradient(180deg,#0B2A5B_0%,#12408F_100%)]! [html:not(.light)_&]:bg-[linear-gradient(180deg,#F1F5F9_0%,#CBD5E1_100%)]!';

export default function WatermarkTitle({ children, strong = false }: {
  children: string;
  /** Full-strength, easy-to-read title instead of the faded watermark (Settings) */
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-center gap-3 sm:gap-6 select-none min-w-0 pointer-events-none">
      <span
        aria-hidden
        className="h-px w-6 sm:w-24 flex-shrink-0"
        style={{ background: 'linear-gradient(90deg, transparent, var(--watermark-rule))' }}
      />
      <h1
        className={`${watermarkFont.className} qr-watermark-title ${strong ? STRONG : ''} text-[26px] min-[420px]:text-3xl sm:text-5xl font-medium min-w-0 tracking-wide text-center leading-tight`}
      >
        {children}
      </h1>
      <span
        aria-hidden
        className="h-px w-6 sm:w-24 flex-shrink-0"
        style={{ background: 'linear-gradient(90deg, var(--watermark-rule), transparent)' }}
      />
    </div>
  );
}
