import type { NextRequest } from 'next/server';

/**
 * Server-side client IP extraction.
 *
 * Trust proxy headers only when TRUST_PROXY=true (or when deployed on a
 * known platform that always sets them). Blindly trusting x-forwarded-for
 * lets a client spoof their IP.
 */
export function trustProxyHeaders(): boolean {
  const flag = (process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  // Common hosted platforms that terminate TLS and set forwarding headers.
  if (process.env.VERCEL === '1') return true;
  return false;
}

export function isLoopbackIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = ip.trim().toLowerCase();
  return (
    v === '127.0.0.1' ||
    v === '::1' ||
    v === '0:0:0:0:0:0:0:1' ||
    v === 'localhost' ||
    v.startsWith('::ffff:127.0.0.1')
  );
}

export function isPrivateIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = normalizeIp(ip);
  if (!v) return false;
  if (isLoopbackIp(v)) return true;
  if (v.startsWith('10.')) return true;
  if (v.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(v)) return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true;
  return false;
}

export function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (!ip) return null;
  // Strip brackets around IPv6 literals: [::1]
  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'));
  }
  // Strip port from IPv4 host:port
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.split(':')[0];
  }
  // Normalize IPv4-mapped IPv6
  if (ip.toLowerCase().startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  if (ip.length > 64) return null;
  return ip;
}

/**
 * Extract the client IP for security/activity logging.
 * Never use a client-supplied IP from request JSON/body.
 */
export function getClientIp(req: NextRequest): string | null {
  if (trustProxyHeaders()) {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim();
      const normalized = normalizeIp(first);
      if (normalized) return normalized;
    }
    const real = normalizeIp(req.headers.get('x-real-ip'));
    if (real) return real;
  }

  // NextRequest has no reliable remoteAddress in the App Router edge/node
  // hybrid; without trusted proxies, prefer loopback in development.
  if (process.env.NODE_ENV !== 'production') {
    return '127.0.0.1';
  }
  return null;
}
