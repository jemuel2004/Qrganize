import { watermarkFont } from '@/lib/fonts';

/**
 * Large, faded, centered page title with thin fading rules on each side —
 * reads like a watermark behind the page content. Still a real <h1> for
 * screen readers and page structure.
 */
export default function WatermarkTitle({ children }: { children: string }) {
  return (
    <div className="flex items-center justify-center gap-4 sm:gap-6 select-none pointer-events-none">
      <span
        aria-hidden
        className="h-px w-10 sm:w-24 flex-shrink-0"
        style={{ background: 'linear-gradient(90deg, transparent, var(--watermark-rule))' }}
      />
      <h1
        className={`${watermarkFont.className} qr-watermark-title text-3xl sm:text-5xl font-medium tracking-wide text-center leading-tight`}
      >
        {children}
      </h1>
      <span
        aria-hidden
        className="h-px w-10 sm:w-24 flex-shrink-0"
        style={{ background: 'linear-gradient(90deg, var(--watermark-rule), transparent)' }}
      />
    </div>
  );
}
