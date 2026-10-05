import type { CSSProperties } from 'react';
import SystemLogo from '@/components/ui/SystemLogo';

/**
 * The seal on the login page, always moving by itself: it floats gently up and
 * down and, every few seconds, flips over like a coin. Both faces show the
 * seal (the back face is pre-turned, so it never reads mirrored). Still for
 * "reduce motion". Styles: .qrfx-float / .qrfx-flip / .qrfx-face in loginEffects.ts.
 */
export default function FlippingLogo({ size, faceClassName = '' }: {
  size: number;
  /** Extra classes on each face (e.g. its shadow — it turns with the seal) */
  faceClassName?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className="qrfx-float flex-shrink-0"
      style={{ width: size, height: size, perspective: size * 6, '--float': `${Math.max(3, Math.round(size * 0.07))}px` } as CSSProperties}
    >
      <div className="qrfx-flip relative w-full h-full">
        <div className={`qrfx-face absolute inset-0 ${faceClassName}`}><SystemLogo size={size} /></div>
        <div className={`qrfx-face qrfx-face-back absolute inset-0 ${faceClassName}`}><SystemLogo size={size} /></div>
      </div>
    </div>
  );
}
