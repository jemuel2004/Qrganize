import path from "path";
import type { NextConfig } from "next";

/**
 * Where the backend app runs. The browser only ever talks to the frontend;
 * /api/* and /uploads/* are forwarded here, so cookies and the CSP stay same-origin.
 */
const BACKEND_URL = (process.env.BACKEND_URL || "http://localhost:4000").replace(/\/$/, "");

/** Content-Security-Policy value (no page may be framed; only Google sign-in may be embedded). */
function contentSecurityPolicy(frameSrc = "https://accounts.google.com", frameAncestors = "'none'") {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://accounts.google.com",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com",
    "img-src 'self' data: blob: https://www.gstatic.com https://accounts.google.com https://*.googleusercontent.com",
    "media-src 'self' blob:",
    "connect-src 'self' https://accounts.google.com",
    "font-src 'self'",
    `frame-src ${frameSrc}`,
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

const securityHeaders = [
  { key: 'X-Frame-Options',        value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'Referrer-Policy',        value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    // Only allow camera for QR scanner page; everything else denied.
    value: 'camera=(self), microphone=(), geolocation=(), payment=()',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  {
    key: 'Content-Security-Policy',
    // Tailored for Next.js App Router + QR scanner camera access:
    //   • default-src 'self'  — block everything not explicitly allowed
    //   • script-src 'self' 'unsafe-eval'  — Next.js HMR + html5-qrcode need eval in dev;
    //     recharts/d3 also need it. Acceptable because JS is server-rendered & CSP nonces
    //     would require Edge runtime rewrites.
    //   • style-src 'self' 'unsafe-inline'  — Tailwind emits inline styles via className
    //   • img-src 'self' data: blob: + Google hosts — QR data-URLs, /uploads/ photos, verified Google avatars
    //   • media-src 'self' blob:  — Camera feed for QR scanner
    //   • connect-src 'self'  — All API calls are same-origin
    //   • frame-ancestors 'none'  — Redundant with X-Frame-Options but defence-in-depth
    //   • base-uri 'self'  — Prevent base tag injection
    //   • form-action 'self'  — Restrict form submissions to same origin
    //   • object-src 'none'  — Block Flash / plugins entirely
    value: contentSecurityPolicy(),
  },
];

const nextConfig: NextConfig = {
  // Monorepo: resolve packages/shared from the repository root.
  turbopack: { root: path.join(__dirname, "..", "..") },

  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
      { source: "/uploads/:path*", destination: `${BACKEND_URL}/uploads/:path*` },
    ];
  },

  /*
   * Next.js 16 blocks /_next/* (client JS, RSC, HMR) from any host other than
   * the one the dev server started with (localhost). Opening the app through
   * ngrok therefore serves HTML but never hydrates — buttons look real but
   * do not run React handlers. This list is ignored in production.
   */
  allowedDevOrigins: [
    '*.ngrok-free.dev',
    '*.ngrok-free.app',
    '*.ngrok.app',
    '*.ngrok.io',
    // Phones on the same Wi-Fi opening http://<this PC's IP>:3000 — no DNS or
    // tunnel needed (some routers/ISPs block ngrok domains outright).
    '192.168.*.*',
    '10.*.*.*',
  ],

  devIndicators: false,

  experimental: {
    webpackMemoryOptimizations: true,
    // Forwarded API calls (e.g. curriculum import, reports) may take longer than the 30s default.
    proxyTimeout: 120_000,
    /*
     * Tells Next.js / webpack to barrel-optimize these packages so only the
     * named exports that are actually imported end up in the bundle.
     * lucide-react ships 1 000+ icons; optimizePackageImports ensures only
     * the ~50 used in QRganize are included in the client JS.
     * recharts is also listed so its sub-packages are tree-shaken correctly.
     */
    optimizePackageImports: ['lucide-react', 'recharts'],
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
