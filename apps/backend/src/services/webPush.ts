import crypto from 'crypto';
import { generateVAPIDKeys, sendNotification, WebPushError } from 'web-push';
import { query } from '@/database/db';
import { ensurePushTables } from '@/database/pushSchema';
import { qrSiteOrigin } from '@/services/roomQr';

/*
 * Web Push to faculty devices (browser / operating-system notifications that
 * arrive even when QRganize is closed). Payloads are encrypted for each device
 * (RFC 8291) and signed with the server's VAPID key. The private key never
 * leaves the server: browsers only get the public key to subscribe with.
 *
 * Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set (recommended in
 * production), else they are made once and kept in push_vapid_keys. Changing
 * them stops existing devices until they turn reminders on again — the app
 * re-subscribes a device by itself when it notices the new key.
 */

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** 'sent'; 'gone' = the device is no longer subscribed (forget it); 'retry' = try again later */
export type PushOutcome = 'sent' | 'gone' | 'retry';

/**
 * Push services of the browsers QRganize supports. A device's endpoint must be
 * one of these — the server never sends to any other address.
 */
const PUSH_HOST_SUFFIXES = [
  '.googleapis.com',       // Chrome, Edge on Android, Samsung Internet, Opera
  '.mozilla.com',          // Firefox
  '.push.apple.com',       // Safari on Mac, iPhone and iPad (Home Screen app)
  '.notify.windows.com',   // Edge on Windows
];

export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username && !url.password
      && (url.port === '' || url.port === '443')
      && PUSH_HOST_SUFFIXES.some(suffix => `.${url.hostname.toLowerCase()}`.endsWith(suffix));
  } catch {
    return false;
  }
}

/** A device's encryption keys as browsers send them: p256dh = 65-byte P-256 key, auth = 16 bytes */
export function validPushKeys(p256dh: unknown, auth: unknown): boolean {
  const b64url = /^[A-Za-z0-9_-]+={0,2}$/;
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || !b64url.test(p256dh) || !b64url.test(auth)) return false;
  const key = Buffer.from(p256dh, 'base64url');
  return key.length === 65 && key[0] === 0x04 && Buffer.from(auth, 'base64url').length === 16;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let keysPromise: Promise<VapidKeys> | null = null;

/** The server's VAPID keys (environment first, else made once and stored). */
export function vapidKeys(): Promise<VapidKeys> {
  if (!keysPromise) {
    keysPromise = loadVapidKeys().catch(err => {
      keysPromise = null; // retry on the next call
      throw err;
    });
  }
  return keysPromise;
}

async function loadVapidKeys(): Promise<VapidKeys> {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (publicKey && privateKey) return { publicKey, privateKey };

  await ensurePushTables();
  const made = generateVAPIDKeys();
  // Two servers starting together keep whichever key was stored first
  await query(
    `INSERT INTO push_vapid_keys (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`,
    [made.publicKey, made.privateKey],
  );
  const row = (await query(`SELECT public_key, private_key FROM push_vapid_keys WHERE id = 1`)).rows[0] as
    { public_key: string; private_key: string };
  return { publicKey: row.public_key, privateKey: row.private_key };
}

/** The public key browsers subscribe with (safe to share) */
export async function vapidPublicKey(): Promise<string> {
  return (await vapidKeys()).publicKey;
}

/** Who sends the pushes (push services may contact it): VAPID_SUBJECT, else the live site's address */
async function vapidSubject(): Promise<string> {
  const fromEnv = process.env.VAPID_SUBJECT?.trim();
  if (fromEnv && /^(mailto:|https:\/\/)/i.test(fromEnv)) return fromEnv;
  return (await qrSiteOrigin()) ?? 'mailto:class-reminders@qrganize.local';
}

/** Push "topic": a newer message with the same topic replaces one still waiting for an offline device */
export function pushTopic(key: string): string {
  return crypto.createHash('sha256').update(key).digest('base64url').slice(0, 32);
}

/**
 * Send one push. Never throws: the outcome says whether to keep the device.
 * `ttlSeconds` is how long the push service may hold it for a device that is
 * offline — a class reminder must not arrive after its class has started.
 */
export async function sendPush(
  target: PushTarget,
  payload: Record<string, unknown>,
  opts: { ttlSeconds: number; topic?: string; urgency?: 'high' | 'normal' },
): Promise<PushOutcome> {
  try {
    const keys = await vapidKeys();
    await sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
      {
        TTL: Math.max(0, Math.floor(opts.ttlSeconds)),
        urgency: opts.urgency ?? 'high',
        topic: opts.topic,
        contentEncoding: 'aes128gcm',
        timeout: 10_000,
        vapidDetails: { subject: await vapidSubject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
      },
    );
    return 'sent';
  } catch (err) {
    if (err instanceof WebPushError) {
      // 404 / 410: unsubscribed or expired. 400 / 401 / 403: not a subscription
      // these keys can use (e.g. made with an older key) — either way it is gone.
      if ([400, 401, 403, 404, 410].includes(err.statusCode)) return 'gone';
      console.warn(`[push] ${new URL(target.endpoint).hostname} answered ${err.statusCode}`);
      return 'retry';
    }
    console.warn('[push] send failed:', (err as Error).message);
    return 'retry';
  }
}
