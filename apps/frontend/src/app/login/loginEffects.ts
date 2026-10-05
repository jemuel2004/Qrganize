/*
 * Login page effects (the user asked for some life on the login screen — glows
 * at the sides). Royal blue / navy only, slow and soft, and all motion stops
 * for people who turn on "reduce motion". Kept with the page (rendered in a
 * <style> tag) instead of globals.css.
 */
export const LOGIN_FX_CSS = `
@keyframes qrfx-drift-a { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(-48px, 36px) scale(1.1); } }
@keyframes qrfx-drift-b { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(40px, -32px) scale(0.92); } }
@keyframes qrfx-breathe { 0%, 100% { opacity: 0.55; transform: scale(0.985); } 50% { opacity: 0.9; transform: scale(1.025); } }
@keyframes qrfx-sweep { 0% { transform: translateX(-140%) skewX(-18deg); } 55%, 100% { transform: translateX(320%) skewX(-18deg); } }
@keyframes qrfx-seam { 0% { top: -140px; opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } 100% { top: 100%; opacity: 0; } }
@keyframes qrfx-shine { from { transform: translateX(-140%) skewX(-20deg); } to { transform: translateX(340%) skewX(-20deg); } }

/* The seal (FlippingLogo.tsx): floats up and down all the time, and flips over
   like a coin — slow and calm: 12s loop, each flip ~2.4s, ~3.6s rest between */
@keyframes qrfx-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(calc(-1 * var(--float, 5px))); } }
@keyframes qrfx-flip {
  0%, 30% { transform: rotateY(0deg); }
  50%, 80% { transform: rotateY(180deg); }
  100% { transform: rotateY(360deg); }
}
.qrfx-float { animation: qrfx-float 5.5s ease-in-out infinite; }
.qrfx-flip { transform-style: preserve-3d; animation: qrfx-flip 12s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
.qrfx-face { border-radius: 9999px; -webkit-backface-visibility: hidden; backface-visibility: hidden; }
.qrfx-face-back { transform: rotateY(180deg); }

/* Glowing particles rising slowly up a panel (RisingParticles.tsx): the outer
   span rises and fades, the inner dot sways and carries the glow */
@keyframes qrfx-rise {
  0% { transform: translate3d(0, 0, 0); opacity: 0; }
  12% { opacity: var(--o, 0.8); }
  75% { opacity: calc(var(--o, 0.8) * 0.7); }
  100% { transform: translate3d(var(--dx, 0px), -108vh, 0); opacity: 0; }
}
@keyframes qrfx-sway { from { transform: translateX(-7px); } to { transform: translateX(7px); } }
.qrfx-particles { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.qrfx-particle {
  position: absolute; bottom: -12px; display: block; opacity: 0;
  animation: qrfx-rise var(--dur, 14s) linear var(--delay, 0s) infinite;
  will-change: transform, opacity;
}
.qrfx-particle-dot {
  display: block; width: 100%; height: 100%; border-radius: 9999px;
  animation: qrfx-sway var(--sway, 3s) ease-in-out infinite alternate;
}
.qrfx-particle-light {
  background: radial-gradient(circle, rgba(255, 255, 255, 1) 0%, rgba(214, 228, 250, 0.85) 45%, rgba(214, 228, 250, 0) 75%);
  box-shadow: 0 0 10px 2px rgba(191, 211, 245, 0.6);
}
.qrfx-particle-blue {
  background: radial-gradient(circle, rgba(120, 165, 245, 1) 0%, rgba(29, 91, 214, 0.65) 45%, rgba(29, 91, 214, 0) 75%);
  box-shadow: 0 0 10px 2px rgba(29, 91, 214, 0.35);
}
/* Phones: particles float over the white card too — a stronger glow so they show */
.qrfx-particles-strong .qrfx-particle-blue {
  background: radial-gradient(circle, rgba(140, 180, 250, 1) 0%, rgba(29, 91, 214, 0.85) 50%, rgba(29, 91, 214, 0) 78%);
  box-shadow: 0 0 14px 4px rgba(29, 91, 214, 0.45);
}

/* Soft blue lights drifting behind the sign-in card */
.qrfx-orb { position: absolute; border-radius: 9999px; filter: blur(72px); pointer-events: none; }
.qrfx-orb-a { animation: qrfx-drift-a 22s ease-in-out infinite; }
.qrfx-orb-b { animation: qrfx-drift-b 27s ease-in-out infinite; }
/* Faint dot texture, fading out from the card's corner */
.qrfx-dots {
  position: absolute; inset: 0; pointer-events: none;
  background-image: radial-gradient(rgba(11, 42, 91, 0.11) 1px, transparent 1px);
  background-size: 22px 22px;
  -webkit-mask-image: radial-gradient(55% 55% at 72% 32%, #000 0%, transparent 75%);
  mask-image: radial-gradient(55% 55% at 72% 32%, #000 0%, transparent 75%);
}

/* Halo around the card — breathes slowly, brightens while someone types */
.qrfx-halo {
  position: absolute; inset: -26px; border-radius: 44px; pointer-events: none;
  background: radial-gradient(62% 58% at 50% 50%, rgba(29, 91, 214, 0.30), rgba(29, 91, 214, 0) 72%);
  filter: blur(22px);
  animation: qrfx-breathe 6s ease-in-out infinite;
}
/* A brighter layer fades in while someone types in the card */
.qrfx-halo::after {
  content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: radial-gradient(62% 58% at 50% 50%, rgba(29, 91, 214, 0.38), rgba(29, 91, 214, 0) 72%);
  opacity: 0; transition: opacity 0.4s ease;
}
.qrfx-stage:focus-within .qrfx-halo::after { opacity: 1; }

/* Campus name: always one straight line. Same look as before (13px, wide
   0.14em spacing); only where the row is too narrow does the text shrink to fit
   (container units). Measured: the name is ~40.7em wide with that spacing,
   plus 36px for the pin and its gap. */
.qr-campus-row { container-type: inline-size; }
.qr-campus { white-space: nowrap; letter-spacing: 0.14em; font-size: clamp(9px, calc((100cqi - 40px) / 41), 13px); }

/* The login page always keeps room for a scrollbar, so nothing shifts or
   re-wraps when the page becomes scrollable (e.g. the Faculty card is taller) */
html:has(.qrfx-login) { scrollbar-gutter: stable; }

/* Glowing seam between the two halves, with a light that travels down it.
   The strip clips its own light, so the light can never make the page taller
   (it used to poke past the bottom, flashing a scrollbar every few seconds). */
.qrfx-seam {
  position: absolute; top: 0; bottom: 0; left: 50%; width: 40px; margin-left: -20px;
  overflow: hidden; pointer-events: none; z-index: 10;
  background: linear-gradient(180deg, transparent, rgba(29, 91, 214, 0.32) 18%, rgba(29, 91, 214, 0.32) 82%, transparent) center / 1px 100% no-repeat;
}
.qrfx-seam::after {
  content: ''; position: absolute; left: 50%; margin-left: -2.5px; width: 5px; height: 140px; border-radius: 9999px;
  background: linear-gradient(180deg, transparent, rgba(80, 140, 240, 0.95), transparent);
  box-shadow: 0 0 16px 3px rgba(29, 91, 214, 0.55);
  animation: qrfx-seam 6s ease-in-out infinite;
}

/* A soft band of light that sweeps across the campus panel now and then */
.qrfx-sweep { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
.qrfx-sweep::before {
  content: ''; position: absolute; top: -10%; bottom: -10%; left: 0; width: 32%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.22), transparent);
  animation: qrfx-sweep 10s ease-in-out infinite;
}

/* Sign In: a light passes over it on hover, and its glow grows */
.qrfx-shine { position: relative; overflow: hidden; }
.qrfx-shine::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 38%; pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.38), transparent);
  transform: translateX(-140%) skewX(-20deg);
}
.qrfx-shine:not(:disabled):hover::after { animation: qrfx-shine 0.85s ease; }
.qrfx-shine:not(:disabled):hover { box-shadow: 0 16px 32px -12px rgba(29, 91, 214, 0.85); }

@media (prefers-reduced-motion: reduce) {
  .qrfx-float, .qrfx-flip, .qrfx-orb-a, .qrfx-orb-b, .qrfx-halo, .qrfx-sweep::before, .qrfx-shine:not(:disabled):hover::after { animation: none !important; }
  .qrfx-seam::after, .qrfx-particles { display: none; }
}
`;
