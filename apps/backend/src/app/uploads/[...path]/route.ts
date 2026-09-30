import { NextResponse } from 'next/server';
import { readUpload } from '@/services/uploadStorage';

/*
 * Serves uploaded files (profile photos, system logo) — from the database
 * (uploaded_files), falling back to bundled files under public/uploads.
 * The frontend forwards /uploads/* here. Same public access as the files
 * had under public/.
 */

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await params;
  const file = await readUpload(`/uploads/${parts.map(p => decodeURIComponent(p)).join('/')}`);
  if (!file || !file.contentType.startsWith('image/')) return new NextResponse('Not found', { status: 404 });
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      'Content-Type': file.contentType,
      // Uploads are replaced in place (…?t= busts caches), so revalidate each time
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
