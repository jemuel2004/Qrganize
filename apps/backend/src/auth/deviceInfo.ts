/**
 * Parse User-Agent into display-friendly device fields.
 * Never use these as authentication secrets — trusted-device tokens remain authoritative.
 */

export type DeviceInfo = {
  device_type: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  os_name: string;
  browser_name: string;
  device_label: string;
};

export function parseUserAgent(uaRaw: string | null | undefined): DeviceInfo {
  const ua = uaRaw ?? '';

  const device_type: DeviceInfo['device_type'] =
    /iPad|Tablet|PlayBook/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))
      ? 'tablet'
      : /Mobi|iPhone|Android.*Mobile|webOS|BlackBerry|IEMobile/i.test(ua)
        ? 'mobile'
        : ua
          ? 'desktop'
          : 'unknown';

  const os_name =
    /iPhone/i.test(ua) ? 'iOS' :
    /iPad/i.test(ua) ? 'iPadOS' :
    /Android/i.test(ua) ? 'Android' :
    /Mac OS X|Macintosh/i.test(ua) ? 'macOS' :
    /Windows/i.test(ua) ? 'Windows' :
    /CrOS/i.test(ua) ? 'Chrome OS' :
    /Linux/i.test(ua) ? 'Linux' :
    'Unknown OS';

  const browser_name =
    /Edg\//i.test(ua) ? 'Edge' :
    /OPR\/|Opera/i.test(ua) ? 'Opera' :
    /Chrome\//i.test(ua) && !/Edg\//i.test(ua) ? 'Chrome' :
    /Firefox\//i.test(ua) ? 'Firefox' :
    /Safari\//i.test(ua) && !/Chrome\//i.test(ua) ? 'Safari' :
    'Unknown Browser';

  const friendlyOs =
    os_name === 'Windows' ? 'Windows PC' :
    os_name === 'macOS' ? 'Mac' :
    os_name === 'iOS' ? 'iPhone' :
    os_name === 'iPadOS' ? 'iPad' :
    os_name === 'Android' ? (device_type === 'tablet' ? 'Android Tablet' : 'Android Phone') :
    os_name === 'Linux' ? 'Linux' :
    os_name === 'Chrome OS' ? 'Chromebook' :
    'Device';

  return {
    device_type,
    os_name,
    browser_name,
    device_label: `${friendlyOs} — ${browser_name}`,
  };
}
