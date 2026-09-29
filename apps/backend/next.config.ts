import path from "path";
import type { NextConfig } from "next";

/**
 * Backend app: API routes + uploaded files only. The browser reaches it
 * through the frontend (which forwards /api/* and /uploads/*).
 */
const securityHeaders = [
  { key: "X-Frame-Options",        value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy",        value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  // Monorepo: resolve packages/shared from the repository root.
  turbopack: { root: path.join(__dirname, "..", "..") },

  devIndicators: false,

  experimental: {
    webpackMemoryOptimizations: true,
  },

  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
