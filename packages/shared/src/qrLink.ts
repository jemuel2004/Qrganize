/*
 * Room QR content. A room's QR holds a web link — https://<site>/room/<qr_code_id>
 * — so a phone's own camera (iPhone Camera, Google Lens) opens QRganize at that
 * room. Codes printed before hold JSON text ({"type":"room","code":…}); the
 * in-app scanner still reads those. Every reader goes through qrCodeFromScan.
 */

/** Path of a room's page — what the QR link opens */
export const qrLinkPath = (qrCodeId: string) => `/room/${encodeURIComponent(qrCodeId)}`;

/** The room code from what a scanner read: a /room/<code> link, the older JSON text, or the bare code */
export function qrCodeFromScan(raw: string): string {
  const text = String(raw ?? '').trim();
  const link = text.match(/\/room\/([^/?#\s]+)/);
  if (link) {
    try { return decodeURIComponent(link[1]); } catch { return link[1]; }
  }
  if (text.startsWith('{')) {
    try {
      const code = (JSON.parse(text) as { code?: unknown }).code;
      if (typeof code === 'string' && code.trim()) return code.trim();
    } catch { /* not JSON — use as is */ }
  }
  return text;
}

/** A room code as issued (QR-LEC-…): letters, digits and dashes */
export const isQrCode = (code: string) => /^[A-Za-z0-9-]{4,64}$/.test(code);
