import fs from 'fs';
import path from 'path';
import { Reader } from '@maxmind/geoip2-node';
import { isLoopbackIp, isPrivateIp } from '@/auth/clientIp';

export type GeoLocation = {
  city: string | null;
  region: string | null;
  country: string | null;
  label: string;
  kind: 'local' | 'private' | 'geo' | 'unavailable';
};

type CityReader = {
  city: (ip: string) => {
    city?: { names?: { en?: string } };
    subdivisions?: Array<{ names?: { en?: string } }>;
    country?: { names?: { en?: string }; isoCode?: string };
  };
};

let readerPromise: Promise<CityReader | null> | null = null;
let warnedMissing = false;

function geoipDbPath(): string {
  const fromEnv = (process.env.GEOIP_DB_PATH || '').trim();
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.join(process.cwd(), fromEnv);
  return path.join(process.cwd(), 'data', 'geoip', 'GeoLite2-City.mmdb');
}

async function getReader(): Promise<CityReader | null> {
  if (!readerPromise) {
    readerPromise = (async () => {
      const dbPath = geoipDbPath();
      try {
        if (!fs.existsSync(dbPath)) {
          if (!warnedMissing) {
            warnedMissing = true;
            console.warn(
              `[geoip] Local database not found at ${dbPath}. ` +
                `Login continues without location. See data/geoip/README.md.`
            );
          }
          return null;
        }
        return (await Reader.open(dbPath)) as CityReader;
      } catch (err) {
        console.warn('[geoip] Failed to open database:', (err as Error).message);
        return null;
      }
    })();
  }
  return readerPromise;
}

function buildLabel(city: string | null, region: string | null, country: string | null): string {
  // Prefer "City, Country" or "Region, Country" when all three would be long.
  if (city && country) return `${city}, ${country}`;
  if (region && country && region !== country) return `${region}, ${country}`;
  if (country) return country;
  if (city) return city;
  if (region) return region;
  return 'Location unavailable';
}

/**
 * Resolve an approximate location for an IP using a local GeoLite2 City DB.
 * Never throws — login must not fail because GeoIP is unavailable.
 */
export async function lookupIpLocation(ip: string | null | undefined): Promise<GeoLocation> {
  if (!ip) {
    return { city: null, region: null, country: null, label: 'Location unavailable', kind: 'unavailable' };
  }
  if (isLoopbackIp(ip)) {
    return { city: null, region: null, country: null, label: 'Local development', kind: 'local' };
  }
  if (isPrivateIp(ip)) {
    return { city: null, region: null, country: null, label: 'Private network', kind: 'private' };
  }

  try {
    const reader = await getReader();
    if (!reader) {
      return { city: null, region: null, country: null, label: 'Location unavailable', kind: 'unavailable' };
    }
    const response = reader.city(ip);
    const city = response.city?.names?.en?.trim() || null;
    const region = response.subdivisions?.[0]?.names?.en?.trim() || null;
    const country = response.country?.names?.en?.trim() || null;
    if (!city && !region && !country) {
      return { city: null, region: null, country: null, label: 'Unknown location', kind: 'unavailable' };
    }
    return {
      city,
      region,
      country,
      label: buildLabel(city, region, country),
      kind: 'geo',
    };
  } catch {
    return { city: null, region: null, country: null, label: 'Location unavailable', kind: 'unavailable' };
  }
}
