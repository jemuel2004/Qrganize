import { Montserrat, Playfair_Display } from 'next/font/google';

/** Elegant serif for watermark-style page titles (e.g. "Faculty Profiles"). */
export const watermarkFont = Playfair_Display({
  subsets: ['latin'],
  weight: ['500', '600'],
  display: 'swap',
});

/** Geometric sans for login-page headings (matches the NEMSU reference). */
export const headingFont = Montserrat({
  subsets: ['latin'],
  weight: ['600', '700'],
  display: 'swap',
});
