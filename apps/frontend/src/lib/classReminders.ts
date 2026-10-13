/*
 * Class reminders on this device (Web Push) — the browser side. The server
 * decides what to send and when (backend services/classPush.ts). Here: what
 * this browser can do, asking for notification permission (only after the
 * faculty member taps to turn reminders on — never by itself, and never again
 * once they answered), subscribing this device and telling the server, and
 * removing it again (turning off, signing out).
 */

export interface ReminderSettings {
  enabled: boolean;
  lead_minutes: number;
  devices: number;
  public_key: string | null;
}

/** What this browser can do */
export type ReminderSupport =
  | 'supported'
  /** iPhone / iPad: only QRganize added to the Home Screen can get notifications */
  | 'ios-home-screen'
  /** Facebook / Messenger / Instagram's own browser cannot show notifications */
  | 'in-app-browser'
  /** Not on the secure (https) address */
  | 'insecure'
  | 'unsupported';

export function reminderSupport(): ReminderSupport {
  if (typeof window === 'undefined') return 'unsupported';
  const ua = navigator.userAgent;
  if (/FBAN|FBAV|FB_IAB|FBIOS|Messenger|Instagram|Line\/|MicroMessenger/i.test(ua)) return 'in-app-browser';
  if (!window.isSecureContext) return 'insecure';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const homeScreenApp = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !homeScreenApp) return 'ios-home-screen';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'supported';
}

/** Notification permission for QRganize in this browser */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Thrown when the browser's notification permission is not granted */
export class NotificationsBlockedError extends Error {
  constructor() {
    super('Notifications are blocked for QRganize in this browser.');
    this.name = 'NotificationsBlockedError';
  }
}

const SW_URL = '/sw.js';
const API = '/api/instructor/class-reminders';
/** Which faculty member set this device up (so a lost registration can be renewed for them only) */
const OWNER_KEY = 'qrganize:reminder-device';

function rememberOwner(facultyId: number | null) {
  try { if (facultyId) localStorage.setItem(OWNER_KEY, String(facultyId)); } catch { /* private mode */ }
}
function forgetOwner() {
  try { localStorage.removeItem(OWNER_KEY); } catch { /* private mode */ }
}
function ownerIs(facultyId: number | null): boolean {
  try { return !!facultyId && localStorage.getItem(OWNER_KEY) === String(facultyId); } catch { return false; }
}

/** base64url → bytes (the server's public key) */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(key: ArrayBuffer | null, publicKey: string): boolean {
  if (!key) return false;
  const a = new Uint8Array(key);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function api(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
}

async function errorText(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null) as { error?: unknown } | null;
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

/** This faculty member's reminder settings */
export async function loadReminderSettings(): Promise<ReminderSettings> {
  const res = await api('', 'GET');
  if (!res.ok) throw new Error(await errorText(res, 'Could not load your class reminder settings.'));
  return res.json() as Promise<ReminderSettings>;
}

export async function saveReminderSettings(change: { enabled?: boolean; lead_minutes?: number }): Promise<ReminderSettings> {
  const res = await api('', 'PUT', change);
  if (!res.ok) throw new Error(await errorText(res, 'Could not save your class reminder settings.'));
  return res.json() as Promise<ReminderSettings>;
}

/** This device's push subscription, if it has one */
export async function deviceSubscription(): Promise<PushSubscription | null> {
  if (reminderSupport() !== 'supported') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

/**
 * Turn reminders on for this device. Call it straight from a tap: the browser
 * asks for permission only if it never asked before (and nothing waits before
 * that question, so Safari allows it). Throws NotificationsBlockedError when
 * permission is not given, else an Error with plain words.
 */
export async function enableOnThisDevice(publicKey: string, facultyId: number | null): Promise<void> {
  let permission = Notification.permission;
  if (permission === 'default') permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new NotificationsBlockedError();

  await navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' });
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // Made with an older server key: it cannot receive anything any more
  if (sub && !sameKey(sub.options.applicationServerKey, publicKey)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });

  const res = await api('/devices', 'POST', sub.toJSON());
  if (!res.ok) throw new Error(await errorText(res, 'Could not set up reminders on this device.'));
  rememberOwner(facultyId);
}

/** A sample reminder to this device (so the faculty member sees one arrive) */
export async function sendTestReminder(): Promise<void> {
  const sub = await deviceSubscription();
  if (!sub) throw new Error('Reminders are not set up on this device yet.');
  const res = await api('/test', 'POST', { endpoint: sub.endpoint });
  if (!res.ok) throw new Error(await errorText(res, 'Could not send a test reminder.'));
}

/** This device stops getting reminders. Never throws. */
export async function disableOnThisDevice(): Promise<void> {
  try {
    const sub = await deviceSubscription();
    if (sub) {
      await api('/devices', 'DELETE', { endpoint: sub.endpoint }).catch(() => null);
      await sub.unsubscribe().catch(() => false);
    }
  } catch { /* nothing to undo */ }
  forgetOwner();
}

/** Signing out: this device stops getting the account's reminders — without holding the sign-out up */
export function releaseReminderDevice(): Promise<void> {
  return Promise.race([
    disableOnThisDevice(),
    new Promise<void>(resolve => window.setTimeout(resolve, 1500)),
  ]);
}

/**
 * Does this device get this faculty member's reminders? Tidies up on the way:
 * a device still set up for another account is cleared (it changed hands), a
 * subscription made with an old server key is renewed, and one the server
 * lost is registered again — only if this faculty member set this device up.
 */
export async function checkThisDevice(publicKey: string | null, facultyId: number | null): Promise<boolean> {
  if (notificationPermission() !== 'granted') return false;
  const sub = await deviceSubscription();
  if (!sub) return false;
  const res = await api('/devices/status', 'POST', { endpoint: sub.endpoint });
  if (!res.ok) return false;
  const status = await res.json() as { registered?: boolean; cleared?: boolean };
  const mine = status.registered === true || (!status.cleared && ownerIs(facultyId));
  if (!mine) {
    await sub.unsubscribe().catch(() => false);
    forgetOwner();
    return false;
  }
  if (publicKey && (status.registered !== true || !sameKey(sub.options.applicationServerKey, publicKey))) {
    await enableOnThisDevice(publicKey, facultyId);
  }
  return true;
}
