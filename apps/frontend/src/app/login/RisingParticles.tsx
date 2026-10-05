import type { CSSProperties } from 'react';

/** Same numbers on the server and in the browser (no hydration mismatch) */
function seeded(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Small glowing particles rising slowly up a panel, each swaying a little and
 * fading in and out. Clipped to the panel (never changes the page size);
 * hidden for "reduce motion". Styles: .qrfx-particle* in loginEffects.ts.
 */
export default function RisingParticles({ count, tone, seed, sizeScale = 1, strong = false }: {
  count: number;
  /** light = white-blue sparks (blue campus panel); blue = royal-blue (light sign-in side) */
  tone: 'light' | 'blue';
  seed: number;
  /** Bigger particles (e.g. 1.5 on phones, where they float over the card) */
  sizeScale?: number;
  /** Stronger glow, so they stand out on white */
  strong?: boolean;
}) {
  const rand = seeded(seed);
  const particles = Array.from({ length: count }, (_, i) => {
    const size = (3 + rand() * 5) * sizeScale;
    const dur = 10 + rand() * 10;
    return {
      key: i,
      style: {
        left: `${r2(rand() * 100)}%`,
        width: `${r2(size)}px`,
        height: `${r2(size)}px`,
        // Negative delay: already on their way up when the page opens
        '--dur': `${r2(dur)}s`,
        '--delay': `${r2(-rand() * dur)}s`,
        '--dx': `${r2(rand() * 60 - 30)}px`,
        '--o': `${r2(0.45 + rand() * 0.45)}`,
        '--sway': `${r2(2.5 + rand() * 2.5)}s`,
      } as CSSProperties,
    };
  });
  return (
    <div aria-hidden className={`qrfx-particles ${strong ? 'qrfx-particles-strong' : ''}`}>
      {particles.map(p => (
        <span key={p.key} className="qrfx-particle" style={p.style}>
          <i className={`qrfx-particle-dot qrfx-particle-${tone}`} />
        </span>
      ))}
    </div>
  );
}
