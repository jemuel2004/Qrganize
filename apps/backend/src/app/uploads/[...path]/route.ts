import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/auth/auth';
import { readUpload } from '@/services/uploadStorage';

/*
 * Serves uploaded files (profile photos, system logo) — from the database
 * (uploaded_files), falling back to bundled files under public/uploads.
 * The frontend forwards /uploads/* here. The system logo stays public (the
 * sign-in page shows it); profile photos are for signed-in users only.
 */

const notFound = () => new NextResponse('Not found', { status: 404 });

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await params;
  let decoded: string[];
  try {
    decoded = parts.map(p => decodeURIComponent(p));
  } catch {
    return notFound(); // malformed escape in the address
  }
  if (decoded[0] === 'profiles' && !(await getAuthUser(req))) {
    return new NextResponse('Sign in to view this file', { status: 401 });
  }
  const file = await readUpload(`/uploads/${decoded.join('/')}`);
  if (!file || !file.contentType.startsWith('image/')) return notFound();
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      'Content-Type': file.contentType,
      // Uploads are replaced in place (…?t= busts caches), so revalidate each time.
      // Profile photos are personal: browsers may keep them, shared caches may not.
      'Cache-Control': `${decoded[0] === 'profiles' ? 'private' : 'public'}, max-age=0, must-revalidate`,
      'X-Content-Type-Options': 'nosniff',
      // Opened on its own, an upload can never run anything
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
