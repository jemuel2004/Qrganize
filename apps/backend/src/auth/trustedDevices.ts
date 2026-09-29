import { createHmac, randomBytes, randomUUID } from 'crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { query } from '@/database/db';
import { getClientIp } from '@/auth/clientIp';
import { parseUserAgent } from '@/auth/deviceInfo';
import { lookupIpLocation } from '@/auth/geoip';
import { ensureTrustedDeviceActivityColumns } from '@/database/schema-guard';
import { getRequiredHmacSecret } from '@/auth/authSecret';

export const TRUSTED_DEVICE_DAYS = 30;
export const TRUSTED_DEVICE_COOKIE = 'trusted_device';
export const TRUSTED_DEVICE_MAX_AGE = TRUSTED_DEVICE_DAYS * 24 * 60 * 60;
/** Skip last-active DB writes more often than this (ms). */
export const LAST_ACTIVE_TOUCH_MS = 10 * 60 * 1000;

export type AccountKind = 'user' | 'instructor';

type TrustedRow = {
  id: string;
  account_kind: AccountKind;
  account_id: number;
  token_hash: string;
  device_label: string;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};

export type TrustedDevicePublic = {
  id: string;
  device_label: string;
  device_type: string | null;
  os_name: string | null;
  browser_name: string | null;
  last_ip: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  location_label: string | null;
  last_used_at: string;
  expires_at: string;
  created_at: string;
  is_current: boolean;
  is_trusted: true;
  /** current | active | known — known means previously authenticated, may be offline */
  session_status: 'current' | 'active' | 'known';
  activity_label: string;
};

function hmacSecret(): string {
  return getRequiredHmacSecret();
}

export function hashDeviceToken(raw: string): string {
  return createHmac('sha256', hmacSecret()).update(raw).digest('hex');
}

export function trustedDeviceCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    maxAge: TRUSTED_DEVICE_MAX_AGE,
    path: '/',
  };
}

export function getTrustedDeviceToken(req: NextRequest): string | undefined {
  return req.cookies.get(TRUSTED_DEVICE_COOKIE)?.value;
}

export function setTrustedDeviceCookie(response: NextResponse, rawToken: string) {
  response.cookies.set(TRUSTED_DEVICE_COOKIE, rawToken, trustedDeviceCookieOptions());
}

export function clearTrustedDeviceCookie(response: NextResponse) {
  response.cookies.set(TRUSTED_DEVICE_COOKIE, '', { ...trustedDeviceCookieOptions(), maxAge: 0 });
}

/** @deprecated Prefer parseUserAgent().device_label — kept for callers. */
export function describeUserAgent(ua: string): string {
  return parseUserAgent(ua).device_label;
}

export async function findTrustedDevice(
  req: NextRequest,
  accountKind: AccountKind,
  accountId: number
): Promise<TrustedRow | null> {
  const raw = getTrustedDeviceToken(req);
  if (!raw) return null;
  const hash = hashDeviceToken(raw);
  const result = await query(
    `SELECT id, account_kind, account_id, token_hash, device_label, last_used_at, expires_at, revoked_at
     FROM trusted_devices
     WHERE token_hash = $1
     LIMIT 1`,
    [hash]
  ).catch(() => ({ rows: [] as TrustedRow[] }));
  const row = result.rows[0] as TrustedRow | undefined;
  if (!row || row.revoked_at) return null;
  if (row.account_kind !== accountKind || Number(row.account_id) !== Number(accountId)) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return row;
}

async function activitySnapshot(req: NextRequest) {
  const ua = req.headers.get('user-agent') ?? '';
  const device = parseUserAgent(ua);
  const ip = getClientIp(req);
  const geo = await lookupIpLocation(ip);
  return {
    ua: ua.slice(0, 500) || null,
    device,
    ip,
    geo,
  };
}

export async function touchTrustedDevice(id: string, req?: NextRequest) {
  await ensureTrustedDeviceActivityColumns().catch(() => {});

  if (!req) {
    await query(
      `UPDATE trusted_devices
       SET last_used_at = NOW(),
           expires_at = NOW() + ($2 * INTERVAL '1 day')
       WHERE id = $1 AND revoked_at IS NULL`,
      [id, TRUSTED_DEVICE_DAYS]
    ).catch(() => {});
    return;
  }

  const existing = await query(
    `SELECT last_used_at FROM trusted_devices WHERE id = $1 AND revoked_at IS NULL`,
    [id]
  ).catch(() => ({ rows: [] as Array<{ last_used_at?: Date }> }));
  const last = existing.rows[0]?.last_used_at
    ? new Date(existing.rows[0].last_used_at).getTime()
    : 0;
  if (last && Date.now() - last < LAST_ACTIVE_TOUCH_MS) {
    return;
  }

  const snap = await activitySnapshot(req);
  const locationLabel =
    snap.geo.kind === 'unavailable' ? null : snap.geo.label;
  await query(
    `UPDATE trusted_devices
     SET last_used_at = NOW(),
         expires_at = NOW() + ($2 * INTERVAL '1 day'),
         last_ip = COALESCE($3, last_ip),
         city = COALESCE($4, city),
         region = COALESCE($5, region),
         country = COALESCE($6, country),
         location_label = COALESCE($7, location_label),
         device_label = COALESCE($8, device_label),
         device_type = COALESCE($9, device_type),
         os_name = COALESCE($10, os_name),
         browser_name = COALESCE($11, browser_name)
     WHERE id = $1 AND revoked_at IS NULL`,
    [
      id,
      TRUSTED_DEVICE_DAYS,
      snap.ip,
      snap.geo.city,
      snap.geo.region,
      snap.geo.country,
      locationLabel,
      snap.device.device_label,
      snap.device.device_type,
      snap.device.os_name,
      snap.device.browser_name,
    ]
  ).catch(() => {});
}

export async function registerTrustedDevice(params: {
  req: NextRequest;
  response: NextResponse;
  accountKind: AccountKind;
  accountId: number;
}): Promise<void> {
  await ensureTrustedDeviceActivityColumns().catch(() => {});

  const existing = await findTrustedDevice(params.req, params.accountKind, params.accountId);
  if (existing) {
    const raw = getTrustedDeviceToken(params.req);
    await touchTrustedDevice(existing.id, params.req);
    if (raw) setTrustedDeviceCookie(params.response, raw);
    return;
  }

  const raw = randomBytes(32).toString('base64url');
  const hash = hashDeviceToken(raw);
  const snap = await activitySnapshot(params.req);

  await query(
    `INSERT INTO trusted_devices
       (id, account_kind, account_id, token_hash, device_label, user_agent, ip_at_registration,
        last_ip, device_type, os_name, browser_name, city, region, country, location_label, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             NOW() + ($16 * INTERVAL '1 day'))`,
    [
      randomUUID(),
      params.accountKind,
      params.accountId,
      hash,
      snap.device.device_label,
      snap.ua,
      snap.ip,
      snap.ip,
      snap.device.device_type,
      snap.device.os_name,
      snap.device.browser_name,
      snap.geo.city,
      snap.geo.region,
      snap.geo.country,
      snap.geo.label,
      TRUSTED_DEVICE_DAYS,
    ]
  );
  setTrustedDeviceCookie(params.response, raw);
}

export async function listTrustedDevices(accountKind: AccountKind, accountId: number) {
  const result = await query(
    `SELECT id, device_label, last_used_at, expires_at, created_at
     FROM trusted_devices
     WHERE account_kind = $1 AND account_id = $2 AND revoked_at IS NULL
       AND expires_at > NOW()
     ORDER BY last_used_at DESC`,
    [accountKind, accountId]
  );
  return result.rows as Array<{
    id: string;
    device_label: string;
    last_used_at: string;
    expires_at: string;
    created_at: string;
  }>;
}

export async function revokeTrustedDevice(
  req: NextRequest,
  accountKind: AccountKind,
  accountId: number,
  deviceId: string
): Promise<{ revoked: boolean; wasCurrent: boolean }> {
  const result = await query(
    `UPDATE trusted_devices
     SET revoked_at = NOW()
     WHERE id = $1 AND account_kind = $2 AND account_id = $3 AND revoked_at IS NULL
     RETURNING id, token_hash`,
    [deviceId, accountKind, accountId]
  );
  const row = result.rows[0] as { id: string; token_hash: string } | undefined;
  if (!row) return { revoked: false, wasCurrent: false };
  const raw = getTrustedDeviceToken(req);
  const wasCurrent = Boolean(raw && hashDeviceToken(raw) === row.token_hash);
  return { revoked: true, wasCurrent };
}

export async function revokeOtherTrustedDevices(
  req: NextRequest,
  accountKind: AccountKind,
  accountId: number
) {
  const raw = getTrustedDeviceToken(req);
  const currentHash = raw ? hashDeviceToken(raw) : null;
  if (!currentHash) {
    await revokeAllTrustedDevices(accountKind, accountId);
    return;
  }
  await query(
    `UPDATE trusted_devices
     SET revoked_at = NOW()
     WHERE account_kind = $1 AND account_id = $2 AND revoked_at IS NULL
       AND token_hash <> $3`,
    [accountKind, accountId, currentHash]
  );
}

export async function revokeAllTrustedDevices(accountKind: AccountKind, accountId: number) {
  await query(
    `UPDATE trusted_devices
     SET revoked_at = NOW()
     WHERE account_kind = $1 AND account_id = $2 AND revoked_at IS NULL`,
    [accountKind, accountId]
  );
}

export async function revokeTrustedDeviceByCookie(req: NextRequest) {
  const raw = getTrustedDeviceToken(req);
  if (!raw) return;
  await query(
    `UPDATE trusted_devices SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashDeviceToken(raw)]
  ).catch(() => {});
}

export async function bumpAuthVersion(accountKind: AccountKind, accountId: number) {
  if (accountKind === 'instructor') {
    await query(
      `UPDATE instructor_accounts SET auth_version = auth_version + 1, updated_at = NOW() WHERE id = $1`,
      [accountId]
    );
  } else {
    await query(
      `UPDATE users SET auth_version = auth_version + 1, updated_at = NOW() WHERE id = $1`,
      [accountId]
    );
  }
}

export async function revokeAccountAccess(accountKind: AccountKind, accountId: number) {
  await bumpAuthVersion(accountKind, accountId);
  await revokeAllTrustedDevices(accountKind, accountId);
}

export async function revokeInstructorAccessByFacultyId(facultyId: number) {
  const result = await query(
    `SELECT id FROM instructor_accounts WHERE faculty_id = $1`,
    [facultyId]
  );
  const accountId = Number(result.rows[0]?.id);
  if (!accountId) return;
  await revokeAccountAccess('instructor', accountId);
}

export function jwtAuthVersion(payload: Record<string, unknown>): number {
  return payload.av == null ? 1 : Number(payload.av);
}

export async function getAuthVersion(accountKind: AccountKind, accountId: number): Promise<number> {
  try {
    if (accountKind === 'instructor') {
      const result = await query(`SELECT auth_version FROM instructor_accounts WHERE id = $1`, [accountId]);
      return Number(result.rows[0]?.auth_version ?? 1);
    }
    const result = await query(`SELECT auth_version FROM users WHERE id = $1`, [accountId]);
    return Number(result.rows[0]?.auth_version ?? 1);
  } catch (err) {
    if ((err as { code?: string }).code === '42703') return 1;
    throw err;
  }
}

type LiveSession = { live: boolean; reason?: 'missing' | 'inactive' | 'version' };

export async function evaluateSession(payload: Record<string, unknown>): Promise<LiveSession> {
  const role = String(payload.role ?? '');
  const accountId = Number(payload.id);
  if (!accountId || !role) return { live: false, reason: 'missing' };
  const jwtAv = jwtAuthVersion(payload);

  try {
    if (role === 'instructor') {
      const result = await query(
        `SELECT ia.auth_version, ia.is_active AS account_active, f.is_active AS faculty_active
         FROM instructor_accounts ia
         JOIN faculty f ON f.id = ia.faculty_id
         WHERE ia.id = $1`,
        [accountId]
      );
      const row = result.rows[0] as
        | { auth_version?: number; account_active?: boolean; faculty_active?: boolean }
        | undefined;
      if (!row) return { live: false, reason: 'missing' };
      if (row.account_active === false || row.faculty_active === false) {
        return { live: false, reason: 'inactive' };
      }
      if (Number(row.auth_version ?? 1) !== jwtAv) return { live: false, reason: 'version' };
      return { live: true };
    }

    const result = await query(
      `SELECT auth_version, is_active FROM users WHERE id = $1`,
      [accountId]
    );
    const row = result.rows[0] as { auth_version?: number; is_active?: boolean } | undefined;
    if (!row) return { live: false, reason: 'missing' };
    if (row.is_active === false) return { live: false, reason: 'inactive' };
    if (Number(row.auth_version ?? 1) !== jwtAv) return { live: false, reason: 'version' };
    return { live: true };
  } catch (err) {
    if ((err as { code?: string }).code === '42703') return { live: true };
    throw err;
  }
}

export async function listTrustedDevicesForAccount(
  req: NextRequest,
  accountKind: AccountKind,
  accountId: number
): Promise<TrustedDevicePublic[]> {
  await ensureTrustedDeviceActivityColumns().catch(() => {});

  const currentHash = (() => {
    const raw = getTrustedDeviceToken(req);
    return raw ? hashDeviceToken(raw) : null;
  })();

  // Throttled last-active update for the current device when the list is viewed.
  if (currentHash) {
    const current = await query(
      `SELECT id FROM trusted_devices
       WHERE token_hash = $1 AND account_kind = $2 AND account_id = $3
         AND revoked_at IS NULL AND expires_at > NOW()`,
      [currentHash, accountKind, accountId]
    ).catch(() => ({ rows: [] as Array<{ id: string }> }));
    if (current.rows[0]?.id) {
      await touchTrustedDevice(String(current.rows[0].id), req);
    }
  }

  const result = await query(
    `SELECT id, device_label, device_type, os_name, browser_name, user_agent,
            COALESCE(last_ip, ip_at_registration) AS last_ip,
            city, region, country, location_label,
            last_used_at, expires_at, created_at, token_hash
     FROM trusted_devices
     WHERE account_kind = $1 AND account_id = $2 AND revoked_at IS NULL
       AND expires_at > NOW()
     ORDER BY last_used_at DESC`,
    [accountKind, accountId]
  );

  const rows = result.rows as Array<{
    id: string;
    device_label: string;
    device_type: string | null;
    os_name: string | null;
    browser_name: string | null;
    user_agent: string | null;
    last_ip: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    location_label: string | null;
    last_used_at: string;
    expires_at: string;
    created_at: string;
    token_hash: string;
  }>;

  return Promise.all(
    rows.map(async ({ token_hash, user_agent, ...row }) => {
      let {
        device_label,
        device_type,
        os_name,
        browser_name,
        city,
        region,
        country,
        location_label,
      } = row;
      const { last_ip } = row;

      // Backfill display fields for devices registered before activity columns existed.
      if ((!device_type || !os_name || !browser_name || !device_label || device_label === 'Unknown device') && user_agent) {
        const parsed = parseUserAgent(user_agent);
        device_type = device_type || parsed.device_type;
        os_name = os_name || parsed.os_name;
        browser_name = browser_name || parsed.browser_name;
        if (!device_label || device_label === 'Unknown device') {
          device_label = parsed.device_label;
        }
      }

      if (!location_label) {
        if (city || country) {
          location_label = [city, country].filter(Boolean).join(', ');
        } else if (last_ip) {
          const geo = await lookupIpLocation(last_ip);
          location_label = geo.label;
          city = city || geo.city;
          region = region || geo.region;
          country = country || geo.country;
          if (geo.kind !== 'unavailable') {
            await query(
              `UPDATE trusted_devices
               SET location_label = COALESCE(location_label, $2),
                   city = COALESCE(city, $3),
                   region = COALESCE(region, $4),
                   country = COALESCE(country, $5),
                   device_type = COALESCE(device_type, $6),
                   os_name = COALESCE(os_name, $7),
                   browser_name = COALESCE(browser_name, $8),
                   device_label = CASE
                     WHEN device_label IS NULL OR device_label = 'Unknown device' THEN $9
                     ELSE device_label
                   END
               WHERE id = $1`,
              [
                row.id,
                geo.label,
                geo.city,
                geo.region,
                geo.country,
                device_type,
                os_name,
                browser_name,
                device_label,
              ]
            ).catch(() => {});
          }
        } else {
          location_label = 'Location unavailable';
        }
      }

      const isCurrent = Boolean(currentHash && token_hash === currentHash);
      const lastMs = new Date(row.last_used_at).getTime();
      const ageMs = Number.isFinite(lastMs) ? Date.now() - lastMs : Number.POSITIVE_INFINITY;
      let session_status: 'current' | 'active' | 'known' = 'known';
      let activity_label = 'Known device';
      if (isCurrent) {
        session_status = 'current';
        activity_label = ageMs < 2 * 60 * 1000 ? 'Active now · Current session' : 'Current session';
      } else if (ageMs < 15 * 60 * 1000) {
        session_status = 'active';
        activity_label = 'Recently active';
      } else {
        session_status = 'known';
        activity_label = 'Offline · Previously signed in';
      }

      return {
        id: row.id,
        device_label,
        device_type,
        os_name,
        browser_name,
        last_ip,
        city,
        region,
        country,
        location_label,
        last_used_at: row.last_used_at,
        expires_at: row.expires_at,
        created_at: row.created_at,
        is_current: isCurrent,
        is_trusted: true as const,
        session_status,
        activity_label,
      };
    })
  );
}

export async function getTrustedDeviceForAccount(
  req: NextRequest,
  accountKind: AccountKind,
  accountId: number,
  deviceId: string
): Promise<TrustedDevicePublic | null> {
  const list = await listTrustedDevicesForAccount(req, accountKind, accountId);
  return list.find(d => d.id === deviceId) ?? null;
}

export function accountKindFromRole(role: string | undefined): AccountKind {
  return role === 'instructor' ? 'instructor' : 'user';
}
