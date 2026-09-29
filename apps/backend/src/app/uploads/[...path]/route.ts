import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { findUploadedFile } from '@/services/uploadStorage';

/*
 * Serves uploaded files (profile photos, system logo) from the upload folder —
 * UPLOAD_DIR in production (e.g. a Render persistent disk), public/uploads
 * locally. Files added after the build are served too. The frontend forwards
 * /uploads/* here. Same public access as the files had under public/.
 */

const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await params;
  const file = findUploadedFile(`/uploads/${parts.map(p => decodeURIComponent(p)).join('/')}`);
  const type = file ? TYPES[path.extname(file).toLowerCase()] : undefined;
  if (!file || !type) return new NextResponse('Not found', { status: 404 });
  const data = await fs.readFile(file);
  return new NextResponse(new Uint8Array(data), {
    headers: {
      'Content-Type': type,
      // Uploads are replaced in place (…?t= busts caches), so revalidate each time
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
