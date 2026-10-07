import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { query } from '@/database/db';
import { ensureSystemSettingsTable } from '@/database/schema-guard';
import { qrLinkPath } from '@shared/qrLink';

/*
 * Room QR codes — one place that creates them.
 * A room's QR carries its unique qr_code_id (what the scanner looks up);
 * the rendered PNG is stored in qr_code_data. A room without a stored PNG is
 * "Not Generated" and cannot be scanned until the admin generates it.
 *
 * The QR holds a link — https://<site>/room/<qr_code_id> — so a phone's own
 * camera opens QRganize at that room's page. The in-app scanner reads the
 * link too, and still reads older codes that hold only JSON text.
 *
 * The link must work from any phone, so only a public https address is ever
 * used: PUBLIC_SITE_URL when set, else the live site's address as seen from
 * the browser (saved the first time the QR Generator or Room Management is
 * used there). Never localhost, a private network address or a tunnel.
 */

let columnReady = false;
/** qr_generated_at — when the current QR was issued; qr_payload — the text inside it (DDL once per cold start) */
export async function ensureRoomQrColumn() {
  if (columnReady) return;
  await query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ');
  await query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS qr_payload TEXT');
  columnReady = true;
}

export const hasQr = (qrCodeData: unknown) => typeof qrCodeData === 'string' && qrCodeData.startsWith('data:image/');

/** A QR that a phone camera opens as a link (not the older JSON text) */
export const isCameraReady = (payload: unknown) => typeof payload === 'string' && /^https?:\/\//.test(payload);

type Queryable = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

const SITE_KEY = 'qr_site_origin';

/** Hosts a phone on mobile data can't reach (or that only live for a while) */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  if (h.includes(':')) return /^(fc|fd|fe80)/.test(h); // IPv6 private / link-local
  const ip = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  // Temporary tunnels (ngrok, Cloudflare quick tunnels, localtunnel…)
  return /(^|\.)(ngrok(-free)?\.(io|app|dev)|trycloudflare\.com|loca\.lt|localtunnel\.me|serveo\.net)$/.test(h);
}

/**
 * "https://host[:port]" when a value is a public https web address a phone can
 * open — otherwise null (http, localhost, private network, tunnels, junk).
 */
export function cleanOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' || isPrivateHost(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * The site address a page sent (`site_origin`), accepted only when it is a
 * public https address AND the same as the browser's own Origin header (which
 * scripts can't fake) — so a QR link can't be pointed at another site.
 */
export function siteOriginFromRequest(req: { headers: { get(name: string): string | null } }, sent: unknown): string | null {
  const origin = cleanOrigin(sent);
  const header = req.headers.get('origin');
  if (!origin || (header && cleanOrigin(header) !== origin)) return null;
  return origin;
}

/** Where room QR links point: PUBLIC_SITE_URL when set, else the address the QR Generator was last used on. */
export async function qrSiteOrigin(): Promise<string | null> {
  const fromEnv = cleanOrigin(process.env.PUBLIC_SITE_URL);
  if (fromEnv) return fromEnv;
  try {
    await ensureSystemSettingsTable();
    const res = await query('SELECT value FROM system_settings WHERE key = $1', [SITE_KEY]);
    return cleanOrigin(res.rows[0]?.value);
  } catch {
    return null;
  }
}

/** Remember the site address the QR Generator runs on (ignored when PUBLIC_SITE_URL is set). */
export async function rememberQrSiteOrigin(origin: string | null): Promise<void> {
  if (!origin || cleanOrigin(process.env.PUBLIC_SITE_URL)) return;
  await ensureSystemSettingsTable();
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [SITE_KEY, origin],
  );
}

/** The text inside a room's QR: the scan link, or the older JSON when no site address is known yet */
function qrPayload(origin: string | null, qrCodeId: string, roomName: string): string {
  return origin
    ? `${origin}${qrLinkPath(qrCodeId)}`
    : JSON.stringify({ type: 'room', code: qrCodeId, room: roomName });
}

function renderQr(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
    errorCorrectionLevel: 'H',
  });
}

/**
 * Issue a fresh QR for a room (new id → any old printed copy stops working).
 * Pass `q` to write through an open transaction (e.g. a room it just created);
 * the caller must have run ensureRoomQrColumn() before its transaction.
 */
export async function generateRoomQr(room: { id: number; room_name: string; room_type: string }, q: Queryable = query) {
  if (q === query) await ensureRoomQrColumn();
  const qrCodeId = `QR-${room.room_type.slice(0, 3).toUpperCase()}-${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const payload = qrPayload(await qrSiteOrigin(), qrCodeId, room.room_name);
  const qrDataUrl = await renderQr(payload);
  const res = await q(
    `UPDATE rooms SET qr_code_id = $1, qr_code_data = $2, qr_payload = $3, qr_generated_at = NOW() WHERE id = $4
     RETURNING qr_generated_at`,
    [qrCodeId, qrDataUrl, payload, room.id],
  );
  return {
    qr_code_id: qrCodeId, qr_data_url: qrDataUrl, qr_generated_at: res.rows[0]?.qr_generated_at ?? null,
    camera_ready: isCameraReady(payload), qr_link: isCameraReady(payload) ? payload : null,
  };
}

/**
 * Same QR id, new picture that holds the scan link — so a phone camera opens
 * it. Copies already printed keep working in the app's scanner; reprint to
 * let phone cameras open them.
 */
export async function relinkRoomQr(room: { id: number; room_name: string; qr_code_id: string }, origin: string) {
  await ensureRoomQrColumn();
  const payload = qrPayload(origin, room.qr_code_id, room.room_name);
  const qrDataUrl = await renderQr(payload);
  await query('UPDATE rooms SET qr_code_data = $1, qr_payload = $2 WHERE id = $3', [qrDataUrl, payload, room.id]);
  return { qr_code_id: room.qr_code_id, qr_data_url: qrDataUrl, camera_ready: true, qr_link: payload };
}

export { qrCodeFromScan } from '@shared/qrLink';
