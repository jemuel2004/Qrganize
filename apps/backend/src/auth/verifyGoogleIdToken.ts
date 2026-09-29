import { OAuth2Client } from 'google-auth-library';
import { sanitizeGooglePictureUrl } from '@shared/instructorAvatar';

export type GoogleIdentity = {
  sub: string;
  email: string;
  picture: string | null;
};

export type GoogleVerifyFailure = {
  error: string;
  status: number;
};

function googleClientId(): string | undefined {
  return process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || undefined;
}

export function isGoogleIdentity(
  value: GoogleIdentity | GoogleVerifyFailure
): value is GoogleIdentity {
  return 'sub' in value && 'email' in value;
}

/**
 * Verifies a Google Identity Services ID token (JWT).
 * Checks signature, issuer, audience (Client ID), and expiration via google-auth-library.
 * Never log `idToken`.
 */
export async function verifyGoogleIdToken(
  idToken: unknown
): Promise<GoogleIdentity | GoogleVerifyFailure> {
  const clientId = googleClientId();
  if (!clientId) {
    return { error: 'Google Sign-In is not configured on the server.', status: 503 };
  }
  if (typeof idToken !== 'string' || !idToken.trim()) {
    return { error: 'Google credential is required.', status: 400 };
  }

  try {
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({
      idToken: idToken.trim(),
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) {
      return { error: 'Invalid Google credential.', status: 401 };
    }
    if (payload.email_verified !== true) {
      return {
        error: 'Google did not confirm this email address. Please use a verified Google account.',
        status: 401,
      };
    }
    const email = (payload.email ?? '').trim().toLowerCase();
    if (!email) {
      return { error: 'Invalid Google credential.', status: 401 };
    }
    return {
      sub: payload.sub,
      email,
      picture: sanitizeGooglePictureUrl(payload.picture),
    };
  } catch {
    return { error: 'Invalid or expired Google credential.', status: 401 };
  }
}
