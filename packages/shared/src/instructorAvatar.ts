/**
 * Instructor profile-picture priority:
 *   custom upload → verified Google picture → system default (null)
 *
 * Google picture URLs are only accepted from a verified ID-token `picture`
 * claim that points at Google's own hosts. Arbitrary frontend URLs are rejected.
 */

const CUSTOM_PREFIX = '/uploads/profiles/';
const GOOGLE_PICTURE_MAX_LEN = 1000;

export function getProfileInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  const trimmed = name.trim();
  return (trimmed.slice(0, 2) || '?').toUpperCase();
}

export function customProfilePicturePath(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const pathOnly = raw.split('?')[0];
  if (!pathOnly.startsWith(CUSTOM_PREFIX)) return null;
  if (pathOnly.includes('..') || pathOnly.includes('\\')) return null;
  return pathOnly;
}

export function sanitizeGooglePictureUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > GOOGLE_PICTURE_MAX_LEN) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const trusted =
      host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com');
    if (!trusted) return null;
    if (url.pathname.includes('..')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function resolveInstructorProfilePicture(input: {
  customPicture?: unknown;
  googleVerified?: unknown;
  googlePicture?: unknown;
}): string | null {
  const custom = customProfilePicturePath(input.customPicture);
  if (custom) return custom;
  if (input.googleVerified === true) {
    return sanitizeGooglePictureUrl(input.googlePicture);
  }
  return null;
}
